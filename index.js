const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

/* ── X (Twitter) → #twitter-posts mirror ─────────────────────────────────────
   Polls @bloxpumpcasino every 5 min and posts every NEW tweet into the Discord
   twitter-posts channel. Tweets are read from public Nitter RSS mirrors (no X
   API key needed) with several instances tried in order, since individual
   instances come and go. The last-posted tweet id persists in tweet-state.json
   so a bot restart never re-posts old tweets; on the very first run it only
   records the newest id (no back-fill spam). Retweets are skipped.
   Channel: TWITTER_CHANNEL_ID in .env, else the first text channel whose name
   contains "twitter". */
const X_USER = process.env.X_USER || 'bloxpumpcasino';
const X_POLL_MS = 5 * 60 * 1000;
const X_STATE_FILE = path.join(__dirname, 'tweet-state.json');
const X_RSS_SOURCES = [
  `https://nitter.net/${X_USER}/rss`,
  `https://xcancel.com/${X_USER}/rss`,
  `https://nitter.privacyredirect.com/${X_USER}/rss`,
];

function readTweetState() {
  try { return JSON.parse(fs.readFileSync(X_STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeTweetState(state) {
  try { fs.writeFileSync(X_STATE_FILE, JSON.stringify(state)); } catch (e) { console.warn('[x] could not save state:', e.message); }
}

const decodeXml = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

/** GET a URL with node's https module (following up to 3 redirects). Some Nitter
 *  mirrors serve an EMPTY 200 to undici/fetch (TLS fingerprinting) but answer
 *  plain node https normally — do not "modernise" this back to fetch(). */
function httpGet(url, hops = 3) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': '*/*' },
      timeout: 15_000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).href, hops - 1));
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Fetch the RSS feed from the first mirror that answers with items.
 *  Returns [{ id, text, isRetweet }] newest-first, or null if every source failed. */
async function fetchTweets() {
  for (const url of X_RSS_SOURCES) {
    try {
      const res = await httpGet(url);
      if (res.status !== 200) continue;
      const xml = res.body;
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
        const id = (item.match(/\/status\/(\d+)/) || [])[1];
        const title = decodeXml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
        const creator = decodeXml((item.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || [])[1]).trim();
        return id ? { id, text: title.trim(), isRetweet: creator !== '' && creator.toLowerCase() !== `@${X_USER.toLowerCase()}` } : null;
      }).filter(Boolean);
      if (items.length) return items;
    } catch { /* try the next mirror */ }
  }
  return null;
}

function findTwitterChannel() {
  for (const guild of client.guilds.cache.values()) {
    if (process.env.TWITTER_CHANNEL_ID) {
      const byId = guild.channels.cache.get(process.env.TWITTER_CHANNEL_ID);
      if (byId) return byId;
    }
    const byName = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && /twitter/i.test(c.name),
    );
    if (byName) return byName;
  }
  return null;
}

async function pollTweets() {
  const tweets = await fetchTweets();
  if (!tweets) { console.warn('[x] all RSS mirrors failed this round'); return; }

  const state = readTweetState();
  const newestId = tweets[0].id;
  // First run ever: just remember where the timeline is — no back-fill spam.
  if (!state.lastId) { writeTweetState({ lastId: newestId }); return; }

  const fresh = tweets
    .filter((t) => !t.isRetweet && BigInt(t.id) > BigInt(state.lastId))
    .reverse(); // oldest first so the channel reads chronologically
  if (!fresh.length) return;

  const channel = findTwitterChannel();
  if (!channel) { console.warn('[x] no twitter channel found (set TWITTER_CHANNEL_ID in .env)'); return; }

  for (const t of fresh) {
    const url = `https://x.com/${X_USER}/status/${t.id}`;
    const embed = new EmbedBuilder()
      .setColor(0x1d9bf0)
      .setAuthor({ name: `@${X_USER} posted on X` })
      .setDescription(t.text.slice(0, 4000) + `\n\n${url}`)
      .setFooter({ text: 'BloxPump • X updates' })
      .setTimestamp();
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('View on X').setURL(url).setStyle(ButtonStyle.Link),
    );
    try {
      await channel.send({ embeds: [embed], components: [button] });
    } catch (e) {
      console.warn('[x] could not post tweet', t.id, '-', e.message);
      return; // keep lastId unchanged so this tweet is retried next round
    }
    writeTweetState({ lastId: t.id }); // advance per tweet — a later failure never re-posts this one
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  pollTweets();
  setInterval(pollTweets, X_POLL_MS);
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

  if (message.content.toLowerCase() === '!rain') {
    const embed = new EmbedBuilder()
      .setColor(0x00bfff)
      .setTitle('🌧️  It\'s Raining on BloxPump!')
      .setDescription(
        '> A rain event is now **live** — free coins are dropping for everyone!\n\n' +
        '**How it works:**\n' +
        '┣ Head over to **BloxPump.com**\n' +
        '┣ Join the rain before time runs out\n' +
        '┗ Free coins are split between all participants\n\n' +
        '⚡ **Don\'t miss out — rains end fast!**'
      )
      .setFooter({ text: 'BloxPump • Free Coin Rains' })
      .setTimestamp();

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Join the Rain')
        .setURL('https://bloxpump.com')
        .setStyle(ButtonStyle.Link)
        .setEmoji('🌧️')
    );

    await message.channel.send({ embeds: [embed], components: [button] });
  }
});

// X_TEST=1 node index.js → print the parsed tweet feed and exit (no Discord login).
if (process.env.X_TEST === '1') {
  fetchTweets().then((t) => { console.log(JSON.stringify(t, null, 1)); process.exit(0); });
} else {
  client.login(process.env.BOT_TOKEN);
}
