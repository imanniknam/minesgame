// One-off: point the bot at the deployed app. Usage:
//   BOT_TOKEN=... APP_URL=https://x.vercel.app WEBHOOK_SECRET=... node scripts/setup-bot.js
const { BOT_TOKEN, APP_URL, WEBHOOK_SECRET } = process.env;
if (!BOT_TOKEN || !APP_URL || !WEBHOOK_SECRET) throw new Error('BOT_TOKEN, APP_URL, WEBHOOK_SECRET required');

const call = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());
  console.log(method, r.ok ? 'ok' : r);
  if (!r.ok) process.exitCode = 1;
};

await call('setWebhook', { url: `${APP_URL}/bot`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true });
await call('setMyCommands', { commands: [{ command: 'start', description: 'Play Mines' }] });
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: APP_URL } } });
await call('setMyDescription', { description: 'Mines mini game: open tiles, dodge 2 bombs, cash out anytime. Free virtual coins only.' });
