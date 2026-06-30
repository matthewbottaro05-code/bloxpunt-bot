const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase() === '!rules') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setDescription(
        '**1. Treat Others with Respect**\n' +
        'Every member of this server is valued. Please interact with kindness, courtesy, and respect. Behavior involving cursing, bullying, discrimination, or shaming is not tolerated.\n\n' +
        '**2. No Promotions or Spam**\n' +
        'This is an official channel of CrownCoins Casino. Discussions, images, self-promotion, spam, or irrelevant links to other casinos or sites are not allowed.\n\n' +
        '**3. Maintain a Friendly Environment**\n' +
        'Keep interactions G-rated and avoid using profanity. Refrain from discussing sensitive topics like politics, religion, or inappropriate content. Avoid initiating hostile behavior, such as arguments, boycotts, petitions, conspiracy theories, or venting frustrations.\n\n' +
        '**4. Prohibited Content**\n' +
        'Posting prohibited content is not allowed. This includes scams, hacks, phishing attempts, viruses, cheats, exploits, pornography, explicit material, personal conversations, or the personal information of others.'
      );

    await message.channel.send({ embeds: [embed] });
  }
});

client.login(process.env.BOT_TOKEN);
