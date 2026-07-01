# Expense Tracker — Telegram Bot

An interactive Telegram bot that lets you add expenses/income to your Expense
Tracker directly from chat (guided menu with buttons), without opening the app.

It runs as a single **Vercel serverless function** (`api/telegram.js`) that
receives Telegram webhook updates and writes to Firestore via `firebase-admin`.
It is fully separate from the GitHub Pages site, so it does not affect that build.

## How the conversation works

1. `/menu` (or `/start`) → shows **➕ Add Expense** / **💵 Add Income** buttons
2. Bot asks for the **amount** (you type a number)
3. Bot shows **category** buttons
4. Bot shows your **wallet** buttons (pulled live from Firestore)
5. Bot asks for an optional **note** (type it, or tap **Skip**)
6. Record is saved and the wallet balance is updated — same as adding in the app

`/cancel` aborts the current entry. Only the owner chat id can use the bot.

## Deploy

### 1. Push the code
Commit this `telegram-bot/` folder to your repo.

### 2. Create a Vercel project
- Go to https://vercel.com → **Add New → Project** → import this repo
- **Set the Root Directory to `telegram-bot`** (important — keeps it separate
  from the Next.js site)
- Framework preset: **Other**. Deploy.

### 3. Add Environment Variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|------|-------|
| `TELEGRAM_BOT_TOKEN` | your BotFather token |
| `TELEGRAM_CHAT_ID` | `933747525` (your chat id) |
| `FIREBASE_USER_UID` | `iV8EuXz1hRMVfBOVzvlNuoePDm23` |
| `FIREBASE_SERVICE_ACCOUNT` | the full service-account JSON (one line) |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you invent (e.g. a UUID) |

Redeploy after adding them so they take effect.

### 4. Register the webhook (run locally, once)

```bash
cd telegram-bot
TELEGRAM_BOT_TOKEN=<token> \
WEBHOOK_URL=https://<your-project>.vercel.app/api/telegram \
TELEGRAM_WEBHOOK_SECRET=<same secret as above> \
node set-webhook.mjs
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 5. Test
In Telegram, send **/menu** to your bot and tap **➕ Add Expense**.

## Notes
- Categories mirror `data/default-data.ts`. If you add custom categories in the
  app later, update the `CATEGORIES` array in `api/telegram.js`.
- Conversation state is stored in a `telegramSessions/{chatId}` Firestore doc
  and deleted when an entry completes or is cancelled.
