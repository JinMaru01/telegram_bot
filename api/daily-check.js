import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const UID = process.env.FIREBASE_USER_UID;
const APP_URL = "https://jinmaru01.github.io/exspense_tracker/";

function getDb() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return getFirestore();
}

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
// Reject anything else so the endpoint can't be triggered publicly.
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → allow (e.g. first-time testing)
  return req.headers["authorization"] === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).send("unauthorized");

  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const snapshot = await db
    .collection(`users/${UID}/expenses`)
    .where("date", ">=", Timestamp.fromDate(startOfDay))
    .where("date", "<", Timestamp.fromDate(endOfDay))
    .limit(1)
    .get();

  if (!snapshot.empty) {
    return res.status(200).json({ ok: true, reminded: false, reason: "records exist today" });
  }

  const message =
    `📝 *Expense Reminder*\n\n` +
    `You haven't logged any expense today (${now.toDateString()}).\n\n` +
    `Tap a button below to add one now, or open the app 👇\n\n` +
    `👉 [Open Expense Tracker](${APP_URL})`;

  // Same buttons as the bot's main menu — taps are handled by /api/telegram.
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "➕ Add Expense", callback_data: "new:expense" },
        { text: "💵 Add Income", callback_data: "new:income" },
      ],
      [{ text: "📊 Dashboard", callback_data: "dash:menu" }],
    ],
  };

  const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "Markdown",
      reply_markup: replyMarkup,
    }),
  });
  const result = await tgRes.json();

  if (!result.ok) {
    console.error("Telegram error:", result);
    return res.status(500).json({ ok: false, error: result });
  }
  return res.status(200).json({ ok: true, reminded: true });
}
