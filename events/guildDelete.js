const { post } = require('../functions/dbots');

module.exports = (client, guild) => {
	client.channels.get('326587514494124053').send({embed: {
		author: {
			name: `${guild.name}`,
			icon_url: guild.iconURL
		},
		color: 0xf44242,
		footer: {
			text: `${client.guilds.size} guilds`
		}
	}});

	setTimeout(() => {
		post(client);
	}, 1000);
};