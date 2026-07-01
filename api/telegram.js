import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// ---- Config from environment ----
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const UID = process.env.FIREBASE_USER_UID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// Categories mirror data/default-data.ts (categories are client-side defaults, not in Firestore)
const CATEGORIES = [
  "Food & Dining", "Transportation", "Shopping", "Groceries",
  "Entertainment", "Bills & Utilities", "Healthcare", "Education",
  "Travel", "Income/Deposit",
];

// Icons mirror data/default-data.ts for nicer dashboard output
const CATEGORY_ICONS = {
  "Food & Dining": "🍽️", "Transportation": "🚗", "Shopping": "🛍️",
  "Groceries": "🥦", "Entertainment": "🎬", "Bills & Utilities": "💡",
  "Healthcare": "🏥", "Education": "📚", "Travel": "✈️",
  "Transfer": "💸", "Income/Deposit": "💰", "Fees/Withdrawal": "🏧",
};

// Live FX rates (USD base), cached in module scope across warm invocations.
// Falls back to static rates if the API is unavailable — mirrors lib/exchange-rate-api.ts.
const FALLBACK_RATES = { USD: 1, KHR: 4100, EUR: 0.92, GBP: 0.79, JPY: 149.5, CNY: 7.24 };
const RATES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let ratesCache = { table: FALLBACK_RATES, ts: 0 };

async function getRates() {
  if (Date.now() - ratesCache.ts < RATES_TTL_MS) return ratesCache.table;
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data = await res.json();
    if (data && data.rates && typeof data.rates.USD === "number") {
      ratesCache = { table: data.rates, ts: Date.now() };
    }
  } catch (err) {
    console.error("FX fetch failed, using fallback:", err);
  }
  return ratesCache.table;
}

const convertWith = (rates, amount, from, to) =>
  (amount / (rates[from] || 1)) * (rates[to] || 1);
const formatCurrency = (amount, code) =>
  code === "KHR"
    ? `៛${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Firebase (lazy, reused across warm invocations) ----
function getDb() {
  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return getFirestore();
}

// ---- Telegram helpers ----
async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const sendMessage = (chatId, text, replyMarkup) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", reply_markup: replyMarkup });

const answerCallback = (id, text) =>
  tg("answerCallbackQuery", { callback_query_id: id, text: text || "" });

// ---- Keyboards ----
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "➕ Add Expense", callback_data: "new:expense" },
        { text: "💵 Add Income", callback_data: "new:income" },
      ],
      [{ text: "📊 Dashboard", callback_data: "dash:menu" }],
    ],
  };
}

function dashboardKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "This Month", callback_data: "dash:show:thisMonth:USD" },
        { text: "Last Month", callback_data: "dash:show:lastMonth:USD" },
      ],
      [
        { text: "All Time", callback_data: "dash:show:all:USD" },
        { text: "📅 Custom Range", callback_data: "dash:custom" },
      ],
    ],
  };
}

function categoryKeyboard() {
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(CATEGORIES.slice(i, i + 2).map((c, j) => ({
      text: c,
      callback_data: `cat:${i + j}`, // send index to stay within Telegram's 64-byte callback limit
    })));
  }
  return { inline_keyboard: rows };
}

function walletKeyboard(wallets) {
  const rows = wallets.map((w) => [{
    text: `${w.name} (${w.currency})`,
    callback_data: `wal:${w.id}`,
  }]);
  return { inline_keyboard: rows };
}

const skipKeyboard = { inline_keyboard: [[{ text: "⏭ Skip", callback_data: "desc:skip" }]] };

// ---- Session state (Firestore, keyed by chat id) ----
const sessionRef = (db, chatId) => db.doc(`telegramSessions/${chatId}`);
const getSession = async (db, chatId) => (await sessionRef(db, chatId).get()).data() || {};
const setSession = (db, chatId, data) => sessionRef(db, chatId).set(data, { merge: true });
const clearSession = (db, chatId) => sessionRef(db, chatId).delete();

async function loadWallets(db) {
  const snap = await db.collection(`users/${UID}/wallets`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function fmt(amount, currency) {
  return currency === "KHR"
    ? `៛${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${Number(amount).toFixed(2)}`;
}

// ---- Commit the record to Firestore (mirrors useFirebaseData.addExpense / addIncome) ----
async function commitRecord(db, chatId, draft) {
  const walletSnap = await db.doc(`users/${UID}/wallets/${draft.walletId}`).get();
  if (!walletSnap.exists) return "Wallet not found.";
  const wallet = walletSnap.data();

  if (draft.type === "expense" && wallet.balance < draft.amount) {
    return `Insufficient balance in "${wallet.name}". Available: ${fmt(wallet.balance, wallet.currency)}`;
  }

  const newBalance = draft.type === "expense"
    ? wallet.balance - draft.amount
    : wallet.balance + draft.amount;

  const batch = db.batch();
  batch.set(db.collection(`users/${UID}/expenses`).doc(), {
    amount: draft.amount,
    category: draft.category,
    wallet: wallet.name,
    description: draft.description || (draft.type === "income" ? "Income" : draft.category),
    date: Timestamp.now(),
    currency: wallet.currency,
    type: draft.type,
  });
  batch.update(db.doc(`users/${UID}/wallets/${draft.walletId}`), { balance: newBalance });
  await batch.commit();
  return null;
}

// ---- Dashboard ----
// Resolve a period key (or explicit range) into [start, end] Date bounds. null = all time.
function periodRange(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === "thisMonth") {
    return [new Date(y, m, 1), new Date(y, m + 1, 0, 23, 59, 59, 999)];
  }
  if (period === "lastMonth") {
    return [new Date(y, m - 1, 1), new Date(y, m, 0, 23, 59, 59, 999)];
  }
  if (period && period.startsWith("range:")) {
    const [, from, to] = period.split(":");
    return [new Date(`${from}T00:00:00`), new Date(`${to}T23:59:59.999`)];
  }
  return null; // all time
}

function periodLabel(period, start, end) {
  if (period === "thisMonth") return "This Month";
  if (period === "lastMonth") return "Last Month";
  if (period && period.startsWith("range:")) {
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(start)} → ${fmt(end)}`;
  }
  return "All Time";
}

async function computeDashboard(db, period, display) {
  const range = periodRange(period);
  let query = db.collection(`users/${UID}/expenses`);
  if (range) {
    query = query
      .where("date", ">=", Timestamp.fromDate(range[0]))
      .where("date", "<=", Timestamp.fromDate(range[1]));
  }
  const snap = await query.get();
  const rates = await getRates();

  let income = 0, expense = 0, transfer = 0;
  const catTotals = {};
  snap.forEach((doc) => {
    const e = doc.data();
    const value = convertWith(rates, e.amount || 0, e.currency || "USD", display);
    if (e.type === "income") income += value;
    else if (e.type === "transfer") transfer += value;
    else {
      expense += value;
      catTotals[e.category] = (catTotals[e.category] || 0) + value;
    }
  });

  const cats = Object.entries(catTotals)
    .map(([name, total]) => ({ name, total, pct: expense > 0 ? (total / expense) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  const start = range ? range[0] : null;
  const end = range ? range[1] : null;
  const net = income - expense;

  let text =
    `📊 *Dashboard — ${periodLabel(period, start, end)}*\n` +
    `_in ${display}_\n\n` +
    `🟢 Income:    ${formatCurrency(income, display)}\n` +
    `🔴 Expenses:  ${formatCurrency(expense, display)}\n` +
    `🔵 Transfers: ${formatCurrency(transfer, display)}\n` +
    `${net >= 0 ? "⬆️" : "⬇️"} Net:       ${formatCurrency(Math.abs(net), display)}\n`;

  if (cats.length) {
    text += `\n*Top Categories*\n`;
    for (const c of cats) {
      text += `${CATEGORY_ICONS[c.name] || "•"} ${c.name} — ${formatCurrency(c.total, display)} (${c.pct.toFixed(0)}%)\n`;
    }
  } else {
    text += `\n_No expenses in this period._\n`;
  }

  return text;
}

function dashboardResultKeyboard(period, display) {
  const other = display === "USD" ? "KHR" : "USD";
  return {
    inline_keyboard: [
      [{ text: `Show in ${other}`, callback_data: `dash:show:${period}:${other}` }],
      [{ text: "⬅️ Periods", callback_data: "dash:menu" }],
    ],
  };
}

// ---- Main handler ----
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("ok");
  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }

  const db = getDb();
  const update = req.body;
  const cb = update.callback_query;
  const msg = update.message;
  const chatId = String(cb ? cb.message.chat.id : msg ? msg.chat.id : "");

  // Ignore anything that isn't from the owner
  if (!chatId || chatId !== OWNER_CHAT_ID) {
    if (chatId) await sendMessage(chatId, "⛔ This bot is private.");
    return res.status(200).send("ok");
  }

  try {
    if (cb) await handleCallback(db, chatId, cb);
    else if (msg && msg.text) await handleText(db, chatId, msg.text.trim());
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "⚠️ Something went wrong. Send /menu to start over.");
  }
  return res.status(200).send("ok");
}

async function handleText(db, chatId, text) {
  if (text === "/start" || text === "/menu") {
    await clearSession(db, chatId);
    return sendMessage(chatId, "What would you like to record?", menuKeyboard());
  }
  if (text === "/add") {
    await setSession(db, chatId, { step: "amount", draft: { type: "expense" }, updatedAt: Date.now() });
    return sendMessage(chatId, "💸 *Add Expense*\n\nEnter the amount:");
  }
  if (text === "/cancel") {
    await clearSession(db, chatId);
    return sendMessage(chatId, "❌ Cancelled. Send /menu to start again.");
  }
  if (text === "/dashboard") {
    await clearSession(db, chatId);
    return sendMessage(chatId, "📊 Choose a period:", dashboardKeyboard());
  }

  const session = await getSession(db, chatId);

  if (session.step === "amount") {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
    if (!amount || amount <= 0) return sendMessage(chatId, "Please enter a valid number, e.g. `12.50`");
    await setSession(db, chatId, { step: "category", draft: { ...session.draft, amount } });
    return sendMessage(chatId, "Choose a category:", categoryKeyboard());
  }

  if (session.step === "description") {
    await finish(db, chatId, { ...session.draft, description: text });
    return;
  }

  if (session.step === "dashRange") {
    const m = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|-|→)?\s*(\d{4}-\d{2}-\d{2})/);
    if (!m) return sendMessage(chatId, "Please use the format `YYYY-MM-DD to YYYY-MM-DD`");
    const [, from, to] = m;
    if (new Date(from) > new Date(to)) return sendMessage(chatId, "Start date must be before end date.");
    await clearSession(db, chatId);
    const period = `range:${from}:${to}`;
    const dashText = await computeDashboard(db, period, "USD");
    return sendMessage(chatId, dashText, dashboardResultKeyboard(period, "USD"));
  }

  return sendMessage(chatId, "Send /menu to add a record.");
}

async function handleCallback(db, chatId, cb) {
  const data = cb.data || "";
  const session = await getSession(db, chatId);

  if (data.startsWith("new:")) {
    const type = data.slice(4); // expense | income
    await setSession(db, chatId, { step: "amount", draft: { type }, updatedAt: Date.now() });
    await answerCallback(cb.id);
    const label = type === "income" ? "💵 *Add Income*" : "💸 *Add Expense*";
    return sendMessage(chatId, `${label}\n\nEnter the amount:`);
  }

  if (data.startsWith("cat:")) {
    const category = CATEGORIES[Number(data.slice(4))];
    await setSession(db, chatId, { step: "wallet", draft: { ...session.draft, category } });
    await answerCallback(cb.id, category);
    const wallets = await loadWallets(db);
    if (!wallets.length) {
      await clearSession(db, chatId);
      return sendMessage(chatId, "You have no wallets yet. Create one in the app first.");
    }
    return sendMessage(chatId, "Choose a wallet:", walletKeyboard(wallets));
  }

  if (data.startsWith("wal:")) {
    const walletId = data.slice(4);
    const wallets = await loadWallets(db);
    const wallet = wallets.find((w) => w.id === walletId);
    await setSession(db, chatId, {
      step: "description",
      draft: { ...session.draft, walletId, currency: wallet?.currency || "USD" },
    });
    await answerCallback(cb.id);
    return sendMessage(chatId, "Add a note/description, or skip:", skipKeyboard);
  }

  if (data === "desc:skip") {
    await answerCallback(cb.id);
    await finish(db, chatId, { ...session.draft, description: "" });
    return;
  }

  if (data === "dash:menu") {
    await answerCallback(cb.id);
    return sendMessage(chatId, "📊 Choose a period:", dashboardKeyboard());
  }

  if (data === "dash:custom") {
    await setSession(db, chatId, { step: "dashRange", updatedAt: Date.now() });
    await answerCallback(cb.id);
    return sendMessage(chatId, "📅 Send the range as `YYYY-MM-DD to YYYY-MM-DD`\ne.g. `2026-06-01 to 2026-06-30`");
  }

  if (data.startsWith("dash:show:")) {
    const rest = data.slice("dash:show:".length);
    const idx = rest.lastIndexOf(":");
    const period = rest.slice(0, idx);
    const display = rest.slice(idx + 1);
    await answerCallback(cb.id, "Loading…");
    const text = await computeDashboard(db, period, display);
    return sendMessage(chatId, text, dashboardResultKeyboard(period, display));
  }

  return answerCallback(cb.id);
}

async function finish(db, chatId, draft) {
  const error = await commitRecord(db, chatId, draft);
  await clearSession(db, chatId);
  if (error) return sendMessage(chatId, `⚠️ ${error}`);
  const verb = draft.type === "income" ? "Income" : "Expense";
  return sendMessage(
    chatId,
    `✅ *${verb} saved!*\n\n` +
    `Amount: ${fmt(draft.amount, draft.currency)}\n` +
    `Category: ${draft.category}\n` +
    (draft.description ? `Note: ${draft.description}\n` : "") +
    `\nSend /menu to add another.`,
    menuKeyboard()
  );
}
