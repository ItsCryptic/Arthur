const ffmpeg = require('fluent-ffmpeg');
const ytdl = require('ytdl-core');
const moment = require('moment');
const fs = require('fs');
const request = require('request');

const soundcloud = require('../../struct/soundcloud');
const Music = require('../../struct/Music');
const { timeString } = require('../../struct/Util');

const YTRegex = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/embed\/)([A-z0-9_-]{11})([&?].*)?$/;

async function youtube(id, message, msg, client) {
	let info;

	try {
		info = await ytdl.getInfo(id);
	} catch (e) {
		return msg.edit(message.__('song_not_found')).catch(() => {});
	}

	if (!info) return msg.edit(message.__('song_not_found')).catch(() => {});

	if (info.videoDetails.isLiveContent) return msg.edit(message.__('livestream')).catch(() => {});
	if (info.videoDetails.lengthSeconds > 1200) return msg.edit(message.__('too_long', { minutes: 20 })).catch(() => {});

	msg.edit(message.__('downloading_with_time', { seconds: (parseInt(info.videoDetails.lengthSeconds) / 13).toFixed(1) })).catch(() => {});
	let title = info.videoDetails.title;

	let ytdlStream;

	try {
		ytdlStream = ytdl.downloadFromInfo(info, { quality: 'highestaudio', requestOptions: { maxRedirects: 10 } });
	} catch (e) {
		client.errorLog('Error retrieving ytdl stream in mp3', e);
		return msg.edit(message.__('song_not_found')).catch(() => {});
	}

	finish(ytdlStream, title, parseInt(info.videoDetails.lengthSeconds), message, msg, client, info.videoDetails.thumbnail.thumbnails[0].url, `https://youtu.be/${id}`).catch((e) => {
		client.errorLog('Error finishing mp3 from YT source', e);
		return msg.edit(message.__('song_not_found')).catch(() => {});
	});
}

async function finish(stream, title, length, message, msg, client, thumbnail, url) {
	title = title.replace(/[^A-z0-9]/g, '_');

	let index = client.processing.length;
	let filePath = `${__dirname}/../../../media/temp/${message.id}.mp3`;
	client.processing.push(moment().format('h:mm:ss A') + ' - MP3');

	ffmpeg(stream, {priority: 20})
		.duration(length + 1)
		.audioBitrate(128)
		.on('end', () => {
			const options = {
				url: 'https://file.io',
				method: 'POST',
				headers: {
					'User-Agent': 'Arthur Discord Bot (github.com/nikbrandt/Arthur)'
				},
				formData: {
					file: {
						value: fs.createReadStream(filePath),
						options: {
							filename: title + '.mp3'
						}
					}
				}
			};

			request(options, (err, res, body) => {
				if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
				client.processing.splice(index, 1);

				if (err) {
					console.log(err);
					console.log(body);
					return message.channel.send(message.__('error', { err }));
				}

				msg.delete().catch(() => {});

				try {
					body = JSON.parse(body);
				} catch (e) {
					client.errorLog('Error parsing upload API body in mp3', e);
					return message.channel.send(message.__('error', { err: e }));
				}

				if (err) message.channel.send(message.__('error', { err }));

				message.channel.send(message.__('song_converted', { user: message.author.toString() }), {
					embed: {
						title: title,
						description: message.__('description', { url: body.link, songURL: url, length: timeString(length, message) }),
						thumbnail: {
							url: thumbnail
						},
						color: 0x42f45c,
						footer: {
							text: message.__('footer', { tag: message.author.tag })
						}
					}
				});
			});
		})
		.audioCodec('libmp3lame')
		.save(filePath)
		.on('error', err => {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
			client.processing.splice(index, 1);

			msg.delete().catch(() => {});

			client.errorLog('Error converting to mp3', err);
			message.channel.send(message.__('error', { err }));
		});
}

exports.run = async (message, args, suffix, client) => {
	if (!args[0]) return message.channel.send(message.__('no_args'));
	let msg = await message.channel.send(message.__('downloading'));

	let id;

	if (soundcloud.regex.test(args[0])) {
		let info;

		try {
			info = await soundcloud.getInfo(args[0]);
		} catch (e) {
			return msg.edit(message.__('song_not_found')).catch(() => {});
		}

		let stream = soundcloud(info.id);
		let title = info.title;
		let length = Math.round(info.duration / 1000);
		let thumbnail = info.artwork_url;

		finish(stream, title, length, message, msg, client, thumbnail, args[0]).catch(client.errorLog.simple);
	} else if (!YTRegex.test(args[0])) {
		id = await Music.attemptYTSearch(suffix, message.client.errorLog);
		if (!id) return message.channel.send(message.__('no_results'));

		youtube(id, message, msg, client).catch(client.errorLog.simple);
	} else {
		id = args[0].match(YTRegex)[4];
		youtube(id, message, msg, client).catch(client.errorLog.simple);
	}
};

exports.config = {
	enabled: true,
	permLevel: 1,
	perms: ['EMBED_LINKS', 'ATTACH_FILES'],
	cooldown: 10000,
	category: 'other'
};
