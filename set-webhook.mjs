// Registers (or clears) the Telegram webhook so updates are delivered to your Vercel function.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... WEBHOOK_URL=https://<project>.vercel.app/api/telegram \
//   TELEGRAM_WEBHOOK_SECRET=<secret> node set-webhook.mjs
//
//   node set-webhook.mjs --delete    # remove the webhook

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

if (process.argv.includes("--delete")) {
  console.log(await api("deleteWebhook", { drop_pending_updates: true }));
  process.exit(0);
}

if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL");
  process.exit(1);
}

const result = await api("setWebhook", {
  url: WEBHOOK_URL,
  secret_token: SECRET || undefined,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
console.log(result);

console.log("\nCurrent webhook info:");
console.log(await api("getWebhookInfo", {}));
