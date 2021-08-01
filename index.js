const fs = require('fs');

const sqlog = fs.createWriteStream('../media/sql.log');

const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
let sql;

exports.broadcastEval = broadcastEval; // such that the post() function below has it defined

const config = require('../media/config');
const { post } = require('./functions/dbots');
const { errorLog } = require('./functions/eventLoader');
errorLog.shardID = 'Manager';

const test = !!(process.argv[2] && process.argv[2] === 'test');

if (!test) {
	let tempItems = fs.readdirSync('../media/temp');
	if (tempItems) tempItems.forEach(i => {
		fs.unlinkSync(`../media/temp/${i}`);
	});
}

const { ShardingManager } = require('discord.js');
const manager = new ShardingManager('./bot.js', {
	token: test ? config.testToken : config.token,
	shardArgs: test ? [ 'test' ] : []
});

sqlite.open({
	filename: test ? '../media/database/db.sqlite' : '/mnt/ramdisk/database/db.sqlite',
	driver: sqlite3.cached.Database
}).then(db => {
	sql = db;

	manager.spawn().catch(errorLog.simple);
}).catch(errorLog.simple);

let stopwatchUserObject = {};

let commandStatsObject = JSON.parse(fs.readFileSync('../media/stats/commands.json'));
let dailyStatsObject = JSON.parse(fs.readFileSync('../media/stats/daily.json'));
let weeklyStatsObject = JSON.parse(fs.readFileSync('../media/stats/weekly.json'));

let queue = new Map();
let queueID = 0;

manager.on('shardCreate', shard => {
	console.log(`Launched shard ${shard.id}`);

	shard.on('ready', () => {
		shard.send({
			action: 'uptime',
			uptime: Date.now() - Math.floor(process.uptime() * 1000),
			id: shard.id
		}).catch(errorLog.simple);
	});

	shard.on('message', message => {
		switch (message.action) {
			case 'sql': {
				let timeline = {start: Date.now()};
				let { id, query, args, type } = message;

				sql[type](query, args).then(result => {
					timeline.sqlFinished = Date.now() - timeline.start;
					sqlThen(shard, id, result, timeline);
				}).catch(error => {
					timeline.sqlFinished = Date.now() - timeline.start;
					timeline.error = true;
					sqlCatch(shard, id, error, timeline);
				});

				break;
			}

			case 'stopwatch': {
				let { id } = message;

				if (stopwatchUserObject[id]) {
					shard.send({ action: 'stopwatch', id: id, start: stopwatchUserObject[id] }).catch(() => {});
					delete stopwatchUserObject[id];
				} else {
					stopwatchUserObject[id] = Date.now();
					shard.send({ action: 'stopwatch', id: id }).catch(() => {});
				}

				break;
			}

			case 'broadcastEval': {
				let { script, id } = message;
				let internalID = queueID++;

				queue.set(internalID, {
					shards: 0,
					returnShard: shard,
					returnID: id,
					results: {}
				});

				manager.shards.forEach(shard => {
					sendWhenReady(shard, {
						action: 'eval',
						script: script,
						id: internalID
					}, () => {
						shard.emit({
							action: 'eval',
							error: 'Shard took too long to become ready.',
							id: internalID
						})
					});
				});

				break;
			}

			case 'eval': {
				let { error, result, id } = message;

				if (!queue.has(id)) return;
				let queueObj = queue.get(id);

				if (error) {
					queue.delete(id);

					if (queueObj.internal) return queueObj.internal.reject(error);

					return queueObj.returnShard.send({
						action: 'broadcastEval',
						error: error,
						id: queueObj.returnID
					}).catch(errorLog.simple);
				}

				queueObj.shards++;
				queueObj.results[shard.id] = result;

				if (queueObj.shards < manager.shards.size) return;

				let results = [];
				for (let i = 0; i < queueObj.shards; i++) {
					results.push(queueObj.results[i]);
				}

				if (queueObj.internal) queueObj.internal.resolve(results);
				else queueObj.returnShard.send({
					action: 'broadcastEval',
					result: results,
					id: queueObj.returnID
				}).catch(errorLog.simple);

				queue.delete(id);

				break;
			}

			case 'updateStats': {
				addValues(message.commands, commandStatsObject);
				addValues(message.daily, dailyStatsObject);
				addValues(message.weekly, weeklyStatsObject);

				break;
			}

			case 'getStats': {
				switch (message.type) {
					case 'commands':
						shard.send({ action: 'stats', id: message.id, value: commandStatsObject }).catch(errorLog.simple);
						break;
					case 'daily':
						shard.send({ action: 'stats', id: message.id, value: dailyStatsObject[message.arg] }).catch(errorLog.simple);
						break;
					case 'weekly':
						shard.send({ action: 'stats', id: message.id, value: weeklyStatsObject[message.arg] }).catch(errorLog.simple);
						break;
				}

				break;
			}

			case 'restart': {
				process.exit();
				break;
			}
		}
	});
});

function sendWhenReady(shard, message, error, retry = 0) {
	if (retry > 20) return error();

	if (shard.ready) shard.send(message);
	else setTimeout(() => {
		sendWhenReady(shard, message, error, ++retry);
	}, 1000);
}

function addValues(from, to) {
	for (let key in from) {
		if (typeof from[key] !== 'number') {
			if (!to[key]) to[key] = {};
			addValues(from[key], to[key]);
		} else {
			if (!to[key]) to[key] = from[key];
			else to[key] += from[key];
		}
	}
}

function sqlThen(shard, id, result, timeline) {
	shard.send({
		action: 'sql',
		id: id,
		result: result
	}).catch(errorLog.simple).then(() => {
		handleSQLTimeline(timeline);
	});
}

function sqlCatch(shard, id, error, timeline) {
	errorLog('SQL error', error);

	shard.send({
		action: 'sql',
		id: id,
		error: error
	}).catch(errorLog.simple).then(() => {
		handleSQLTimeline(timeline);
	});
}

function handleSQLTimeline(timeline) {
	timeline.finished = Date.now() - timeline.start;
	if (timeline.finished < 1000) return;

	sqlog.write(`SQL rec at ${timeline.start}, finished ${timeline.sqlFinished} ms later, sent off ${timeline.finished - timeline.sqlFinished} ms later, total ${timeline.finished} ms.\n`);
}


function broadcastEval(script) {
	return new Promise((resolve, reject) => {
		let id = queueID++;

		queue.set(id, {
			shards: 0,
			results: {},
			internal: { resolve, reject }
		});

		manager.shards.forEach(shard => {
			shard.send({
				action: 'eval',
				script: script,
				id: id
			}).catch(reject);
		});
	});
}

setInterval(() => {
	fs.writeFileSync('../media/stats/commands.json', JSON.stringify(commandStatsObject));
	fs.writeFileSync('../media/stats/daily.json', JSON.stringify(dailyStatsObject));
	fs.writeFileSync('../media/stats/weekly.json', JSON.stringify(weeklyStatsObject));
}, 30000);

if (!test) setInterval(() => {
	post().catch(errorLog.simple);
}, 1000 * 60 * 2);
