import dashboardHtml from "./dashboard_html.js";

const TIME_ZONE = "Asia/Bangkok";
const CURRENCY = "KHR";
const EXCHANGE_RATE = 4000; // 1 USD = 4000 KHR

const QUICK_EXPENSE_CATS = [
    { name: "Food", icon: "🍔" },
    { name: "Coffee", icon: "☕" },
    { name: "Transport", icon: "🚗" },
    { name: "Taxi", icon: "🚕" },
    { name: "Shopping", icon: "🛍️" },
    { name: "Bills", icon: "💡" },
    { name: "Rent", icon: "🏠" },
    { name: "Other", icon: "✨" }
];

const QUICK_INCOME_CATS = [
    { name: "Salary", icon: "💼" },
    { name: "Freelance", icon: "💻" },
    { name: "Gift", icon: "🎁" },
    { name: "Investment", icon: "📈" },
    { name: "Bonus", icon: "💰" },
    { name: "Other", icon: "✨" }
];

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET") {
            if (url.pathname === "/dashboard") {
                return new Response(dashboardHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }

            if (url.pathname === "/api/data") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                await ensureTables(env.DB);
                const summary = await getFinancialSummary(env.DB, userId, "all");
                const categories = await getCategoryRows(env.DB, userId, "month", 10);

                const daily = [];
                for (let i = 6; i >= 0; i--) {
                    const d = dateDaysAgo(i);
                    const dayRow = await env.DB.prepare(
                        `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total
                         FROM expenses
                         WHERE user_id = ? AND type = 'expense' AND date = ?`
                    )
                    .bind(userId, d)
                    .first();
                    daily.push({
                        date: d,
                        total: Number(dayRow?.total || 0),
                    });
                }

                const recentRows = await env.DB.prepare(
                    `SELECT id, amount, category, type, currency, date, created_at
                     FROM expenses
                     WHERE user_id = ?
                     ORDER BY date DESC, id DESC
                     LIMIT 10`
                )
                .bind(userId)
                .all();

                const settingsRow = await env.DB.prepare(
                    "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
                )
                .bind(userId)
                .first();
                const budgetKhr = settingsRow?.monthly_budget || 0;

                const monthSummary = await getFinancialSummary(env.DB, userId, "month");
                const monthExpenseKhr = monthSummary?.totalExpenseInKhr || 0;

                const lbRow = await env.DB.prepare(
                    "SELECT id, reminder_time, frequency, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
                ).bind(userId).first();

                return json({
                    summary,
                    categories,
                    daily,
                    recent: recentRows.results || [],
                    budgetKhr,
                    monthExpenseKhr,
                    lunchboxReminder: lbRow || null
                });
            }

            if (url.pathname === "/api/history") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
                const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));
                const offset = (page - 1) * limit;

                const type = url.searchParams.get("type");
                const search = url.searchParams.get("search")?.trim();

                let query = "SELECT id, amount, category, type, currency, date, created_at FROM expenses WHERE user_id = ?";
                let countQuery = "SELECT COUNT(*) as count FROM expenses WHERE user_id = ?";
                const params = [userId];
                const countParams = [userId];

                if (type && (type === "income" || type === "expense")) {
                    query += " AND type = ?";
                    countQuery += " AND type = ?";
                    params.push(type);
                    countParams.push(type);
                }

                if (search) {
                    query += " AND (category LIKE ? OR CAST(amount AS TEXT) LIKE ?)";
                    countQuery += " AND (category LIKE ? OR CAST(amount AS TEXT) LIKE ?)";
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern);
                    countParams.push(searchPattern, searchPattern);
                }

                query += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?";
                params.push(limit, offset);

                const countRow = await env.DB.prepare(countQuery).bind(...countParams).first();
                const total = Number(countRow?.count || 0);

                const { results } = await env.DB.prepare(query).bind(...params).all();

                return json({
                    transactions: results || [],
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                });
            }

            return json({ ok: true, service: "cashflow-bot" });
        }

        if (request.method === "POST") {
            if (url.pathname === "/api/delete") {
                const userId = url.searchParams.get("user_id");
                const txId = url.searchParams.get("id");
                if (!userId || !txId) {
                    return json({ error: "Missing parameters" }, 400);
                }

                const result = await env.DB.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?")
                    .bind(userId, txId)
                    .run();

                return json({ ok: true, changes: result.meta?.changes || 0 });
            }

            if (url.pathname === "/webhook") {
                if (!env.TELEGRAM_BOT_TOKEN) {
                    return json({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN" }, 500);
                }

                if (env.WEBHOOK_SECRET) {
                    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
                    const expectedSecret = env.WEBHOOK_SECRET.trim();
                    if (secret && secret !== expectedSecret) {
                        console.warn(`Webhook secret token mismatch: received="${secret}", expected="${expectedSecret}"`);
                    }
                }

                const bodyText = await request.text();
                let update;
                try {
                    update = JSON.parse(bodyText);
                } catch (e) {
                    console.error("Failed to parse update JSON:", e);
                    return json({ ok: false, error: "Invalid JSON" }, 400);
                }

                console.log("Incoming Telegram update:", JSON.stringify(update));
                await handleUpdateSafely(update, env, url.origin);

                return json({ ok: true });
            }

            return json({ ok: false, error: "Not found" }, 404);
        }

        return json({ ok: false, error: "Not found" }, 404);
    },

    async scheduled(event, env) {
        try {
            await processDueReminders(env);
        } catch (error) {
            console.error("Scheduled reminder check failed:", error);
        }

        try {
            const now = new Date();
            // Monday at 01:00 UTC (8:00 AM ICT)
            if (event.cron === "0 1 * * 1" || (now.getUTCDay() === 1 && now.getUTCHours() === 1 && now.getUTCMinutes() === 0)) {
                await sendWeeklyScheduledReports(env);
            }
        } catch (error) {
            console.error("Scheduled weekly report failed:", error);
        }
    },
};

// Auto-create missing tables for effortless self-healing
async function ensureTables(db) {
    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                title TEXT NOT NULL,
                reminder_time TEXT NOT NULL,
                frequency TEXT NOT NULL DEFAULT 'weekdays',
                type TEXT NOT NULL DEFAULT 'lunchbox',
                is_active INTEGER NOT NULL DEFAULT 1,
                last_sent_date TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables error:", e);
    }
}

async function handleUpdateSafely(update, env, origin) {
    try {
        const isDuplicate = await wasUpdateProcessed(env.DB, update.update_id);
        if (isDuplicate) {
            return;
        }

        await handleUpdate(update, env, origin);
    } catch (error) {
        console.error("Failed to handle Telegram update:", error);
    }
}

async function wasUpdateProcessed(db, updateId) {
    if (typeof updateId !== "number") {
        return false;
    }

    try {
        const result = await db
            .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
            .bind(updateId)
            .run();

        return result.meta?.changes === 0;
    } catch (error) {
        console.error("Could not save processed update id:", error);
        return false;
    }
}

async function handleUpdate(update, env, origin) {
    if (update.message) {
        await handleMessage(update.message, env, origin);
        return;
    }

    if (update.callback_query) {
        await handleCallback(update.callback_query, env, origin);
    }
}

async function handleMessage(message, env, origin) {
    const text = (message.text || "").trim();
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);

    // 1. Main Navigation
    if (text.startsWith("/start") || text === "/menu" || text.startsWith("/menu@") || text === "/s" || text === "/m") {
        await sendMainMenu(env, chatId, userId, message.from, origin);
        return;
    }

    // 2. Lunch Box Reminder Command
    if (text.startsWith("/lunchbox") || text === "/lb") {
        await handleLunchboxCommand(env, chatId, userId, text);
        return;
    }

    // 3. General Reminder Command
    if (text.startsWith("/remind")) {
        await handleRemindCommand(env, chatId, userId, text);
        return;
    }

    if (text === "/reminders" || text === "/reminder" || text === "/r") {
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    // 4. Logging Expenses & Income
    if (text.startsWith("/add") || text.startsWith("/a ") || text === "/a") {
        if (text === "/add" || text === "/a") {
            await sendCategoryPicker(env, chatId, "expense");
            return;
        }
        await addTransactionFromCommand(env, chatId, userId, text);
        return;
    }

    if (text.startsWith("/income") || text.startsWith("/i ") || text === "/i") {
        if (text === "/income" || text === "/i") {
            await sendCategoryPicker(env, chatId, "income");
            return;
        }
        await addTransactionFromCommand(env, chatId, userId, text);
        return;
    }

    // 5. Ledger & Summaries
    if (text === "/transactions" || text === "/today" || text === "/t" || text === "/td") {
        await sendTransactions(env, chatId, userId);
        return;
    }

    if (text === "/summary") {
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (text === "/month") {
        await sendSummary(env, chatId, userId, "month");
        return;
    }

    if (text === "/week") {
        const startDate = dateDaysAgo(6);
        const endDate = today();
        await sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, "Weekly Spending Report (Rolling 7 Days)");
        return;
    }

    if (text === "/categories") {
        await sendCategoryBreakdown(env, chatId, userId, "month");
        return;
    }

    if (text.startsWith("/history") || text === "/all") {
        const parts = text.split(/\s+/);
        let page = 1;
        if (parts.length > 1) {
            const parsedPage = parseInt(parts[1], 10);
            if (Number.isInteger(parsedPage) && parsedPage > 0) {
                page = parsedPage;
            }
        }
        await sendHistory(env, chatId, userId, page);
        return;
    }

    // 6. Settings & Budget
    if (text.startsWith("/budget") || text.startsWith("/b ") || text === "/b") {
        await handleBudgetCommand(env, chatId, userId, text);
        return;
    }

    if (text === "/settings") {
        await sendSettingsMenu(env, chatId, userId);
        return;
    }

    if (text === "/total") {
        const total = await getTotalExpenses(env.DB, userId);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await sendMessage(env, chatId, `💰 Total all-time expenses: \`${formatAmount(total, displayCurrency)}\``, { parse_mode: "Markdown" });
        return;
    }

    if (text === "/clear") {
        await askClearConfirmation(env, chatId);
        return;
    }

    if (text === "/help" || text === "/h") {
        await sendHelpMessage(env, chatId);
        return;
    }

    if (text.startsWith("/")) {
        await sendMessage(env, chatId, "⚠️ Unknown command. Type /help to see all available commands, or /menu to open the main dashboard.");
    }
}

async function handleCallback(callback, env, origin) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);

    await answerCallback(env, callback.id);

    if (!chatId) return;

    // --- Main Menu & Settings ---
    if (data === "menu") {
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "settings") {
        await sendSettingsMenu(env, chatId, userId);
        return;
    }

    if (data === "toggle_currency") {
        const currentCurrency = await getDisplayCurrency(env.DB, userId);
        const newCurrency = currentCurrency === "USD" ? "KHR" : "USD";
        await setDisplayCurrency(env.DB, userId, newCurrency);
        const flag = newCurrency === "USD" ? "🇺🇸" : "🇰🇭";
        await sendMessage(env, chatId, `${flag} Display switched to *${newCurrency}*!`, { parse_mode: "Markdown" });
        await sendSettingsMenu(env, chatId, userId);
        return;
    }

    if (data === "budget_help") {
        await sendMessage(
            env,
            chatId,
            `🎯 *HOW TO SET YOUR MONTHLY BUDGET*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Use the command:\n` +
            `• \`/budget 300 usd\` (Sets limit to $300)\n` +
            `• \`/budget 1200000 khr\` (Sets limit in Riel)\n` +
            `• \`/budget 0\` (Disables budget tracking)\n\n` +
            `You will receive visual progress alerts whenever you log an expense!`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    // --- Adding Transactions ---
    if (data === "add_expense") {
        await sendCategoryPicker(env, chatId, "expense");
        return;
    }

    if (data === "add_income") {
        await sendCategoryPicker(env, chatId, "income");
        return;
    }

    if (data.startsWith("cat_exp:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "expense", userId);
        return;
    }

    if (data.startsWith("cat_inc:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "income", userId);
        return;
    }

    if (data.startsWith("quick_exp:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "expense", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "expense", amount, displayCurrency, category);
        return;
    }

    if (data.startsWith("quick_inc:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "income", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "income", amount, displayCurrency, category);
        return;
    }

    if (data === "custom_add") {
        await sendMessage(env, chatId, "✏️ *Custom Expense:*\nType: `/add 5 usd lunch` or `/add 15000 food`", { parse_mode: "Markdown" });
        return;
    }

    if (data === "custom_inc") {
        await sendMessage(env, chatId, "✏️ *Custom Income:*\nType: `/income 500 usd salary` or `/income 200000 freelance`", { parse_mode: "Markdown" });
        return;
    }

    // --- Lunch Box Alarm Callbacks ---
    if (data === "lunchbox") {
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("lb_toggle:")) {
        const active = parseInt(data.slice(10), 10) === 1 ? 1 : 0;
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = ?, chat_id = ? WHERE id = ?")
                .bind(active, String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Lunch Box Reminder', '17:30', 'weekdays', 'lunchbox', ?)
            `).bind(userId, String(chatId), active).run();
        }

        const stateTxt = active ? "🟢 Lunch box alarm enabled (17:30 Mon-Fri)!" : "🔴 Lunch box alarm disabled.";
        await answerCallback(env, callback.id, { text: stateTxt });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("lb_time:")) {
        const newTime = data.slice(8);
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ?")
                .bind(newTime, String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Lunch Box Reminder', ?, 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId), newTime).run();
        }

        await answerCallback(env, callback.id, { text: `⏰ Lunch box reminder set to ${newTime}!` });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("lb_freq:")) {
        const newFreq = data.slice(8); // 'weekdays' or 'daily'
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET frequency = ?, chat_id = ? WHERE id = ?")
                .bind(newFreq, String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Lunch Box Reminder', '17:30', ?, 'lunchbox', 1)
            `).bind(userId, String(chatId), newFreq).run();
        }

        const freqLabel = newFreq === "weekdays" ? "Weekdays only (Mon–Fri)" : "Everyday";
        await answerCallback(env, callback.id, { text: `🗓️ Schedule updated to: ${freqLabel}` });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    if (data === "lb_test") {
        await answerCallback(env, callback.id, { text: "🔔 Sending test lunch box reminder..." });
        await sendLunchboxNotification(env, chatId);
        return;
    }

    if (data.startsWith("lb_ack")) {
        await answerCallback(env, callback.id, { text: "🎉 Great job! Have a safe trip home! 🏠" });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `🍱🔔 *LUNCH BOX REMINDER*`,
                    `━━━━━━━━━━━━━━━━━━━━`,
                    `✅ *Lunch box packed and ready!*`,
                    `Have a wonderful evening and safe trip home! 🏡✨`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("lb_snooze")) {
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 15 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, 'Lunch Box (Snoozed)', ?, 'once', 'lunchbox', 1)
        `).bind(userId, String(chatId), snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Snoozed for 15 mins! We will alert you at ${snoozeStr}.` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `🍱🔔 *LUNCH BOX REMINDER (SNOOZED)*`,
                    `━━━━━━━━━━━━━━━━━━━━`,
                    `⏰ Snoozed for 15 minutes!`,
                    `We will remind you again at *${snoozeStr}*. Don't forget it before leaving! 🥪`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    // --- General Reminders Callbacks ---
    if (data === "reminders") {
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data === "toggle_expense_reminder") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'expense_log' LIMIT 1"
        ).bind(userId).first();

        let newActive = 1;
        if (existing) {
            newActive = existing.is_active ? 0 : 1;
            await env.DB.prepare("UPDATE reminders SET is_active = ?, chat_id = ? WHERE id = ?")
                .bind(newActive, String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Daily Expense Check-in', '21:00', 'daily', 'expense_log', 1)
            `).bind(userId, String(chatId)).run();
        }

        const stateTxt = newActive ? "🟢 Daily expense reminder ENABLED (21:00)!" : "🔴 Daily expense reminder DISABLED.";
        await answerCallback(env, callback.id, { text: stateTxt });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_del:")) {
        const id = parseInt(data.slice(11), 10);
        await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Reminder deleted." });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_done:")) {
        await answerCallback(env, callback.id, { text: "✅ Done!" });
        return;
    }

    // --- Ledger & Summaries Callbacks ---
    if (data === "view_transactions") {
        await sendTransactions(env, chatId, userId);
        return;
    }

    if (data.startsWith("history:")) {
        const page = parseInt(data.slice(8), 10) || 1;
        await updateHistoryMessage(env, chatId, userId, callback.message.message_id, page);
        return;
    }

    if (data === "summary_today") {
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (data === "summary_month") {
        await sendSummary(env, chatId, userId, "month");
        return;
    }

    // --- Clear Data Callbacks ---
    if (data === "clear_data") {
        await askClearConfirmation(env, chatId);
        return;
    }

    if (data === "clear_today_warn") {
        await sendMessage(env, chatId, "⚠️ Are you sure you want to clear today's expenses? This action cannot be undone.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Yes, clear today", callback_data: "confirm_clear_today" }],
                    [{ text: "❌ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "clear_all_warn") {
        const total = await getTotalExpenses(env.DB, userId);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?").bind(userId).first();
        const count = countRow?.count || 0;

        if (count === 0) {
            await sendMessage(env, chatId, "You don't have any recorded transactions to delete.");
            return;
        }

        const warningMsg = [
            `⚠️ *PERMANENT DATABASE RESET* ⚠️`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `This action will delete all transaction records matching your user account.`,
            ``,
            `📊 *Wipe Stats:*`,
            `├ Total transactions: \`${count}\``,
            `└ Total spent: \`${formatMoney(total)} ៛\` (~$${formatMoney(total / EXCHANGE_RATE)})`,
            ``,
            `🔒 *Backup Safety:*`,
            `We will auto-generate and send you a *CSV backup file* in this chat before deleting anything.`,
            ``,
            `Do you wish to proceed?`
        ].join("\n");

        await sendMessage(env, chatId, warningMsg, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Yes, Backup & Wipe All", callback_data: "confirm_clear_all" }],
                    [{ text: "❌ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "confirm_clear" || data === "confirm_clear_today") {
        await clearToday(env.DB, userId);
        await sendMessage(env, chatId, "✅ Today's expenses have been cleared.");
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "confirm_clear_all") {
        try {
            await sendCSVBackup(env, chatId, userId);
        } catch (error) {
            await sendMessage(env, chatId, `❌ Backup failed: ${error.message}\n\nDeletion cancelled to protect your data.`);
            return;
        }

        await clearAllExpenses(env.DB, userId);
        await sendMessage(env, chatId, "🗑️ All historical transactions have been deleted. A backup CSV has been sent above.");
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "cancel_clear") {
        await sendMessage(env, chatId, "Clear cancelled. Your data remains safe.");
        return;
    }
}

// ---------------------------------------------------------------------------
// Commands Handlers
// ---------------------------------------------------------------------------

async function handleLunchboxCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length === 1) {
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    const arg = parts[1].toLowerCase();
    if (arg === "on") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1").bind(userId).first();
        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?").bind(String(chatId), existing.id).run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Lunch Box Reminder', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }
        await sendMessage(env, chatId, "🟢 *Lunch box alarm enabled for 17:30 (Mon–Fri)!*", { parse_mode: "Markdown" });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    if (arg === "off") {
        await ensureTables(env.DB);
        await env.DB.prepare("UPDATE reminders SET is_active = 0 WHERE user_id = ? AND type = 'lunchbox'").bind(userId).run();
        await sendMessage(env, chatId, "🔴 *Lunch box alarm disabled.*", { parse_mode: "Markdown" });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    const timeMatch = arg.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (timeMatch) {
        const formattedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
        await ensureTables(env.DB);
        const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1").bind(userId).first();
        if (existing) {
            await env.DB.prepare("UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ?").bind(formattedTime, String(chatId), existing.id).run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Lunch Box Reminder', ?, 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId), formattedTime).run();
        }
        await sendMessage(env, chatId, `⏰ *Lunch box reminder time set to ${formattedTime} (Active)!*`, { parse_mode: "Markdown" });
        await sendLunchboxMenu(env, chatId, userId);
        return;
    }

    await sendLunchboxMenu(env, chatId, userId);
}

async function handleRemindCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2 || parts[1] === "help") {
        await sendMessage(env, chatId, [
            `💡 *HOW TO SET A REMINDER*`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `Usage: \`/remind <time> <title>\``,
            ``,
            `Examples:`,
            `• \`/remind 17:30 Bring lunch box home\``,
            `• \`/remind 21:00 Review today's spending\``,
            `• \`/remind 08:30 Morning vitamins\``,
            ``,
            `Time must be 24-hour format (\`HH:mm\`) in Asia/Bangkok time.`
        ].join("\n"), { parse_mode: "Markdown" });
        return;
    }

    const timeArg = parts[1];
    const timeMatch = timeArg.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (!timeMatch) {
        await sendMessage(env, chatId, "❌ Invalid time format. Please use 24-hour format like `17:30` or `08:00`.\nExample: `/remind 17:30 Lunch box`", { parse_mode: "Markdown" });
        return;
    }

    const formattedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    const title = parts.slice(2).join(" ").trim() || "Reminder";
    const type = title.toLowerCase().includes("lunch") ? "lunchbox" : "custom";

    await ensureTables(env.DB);
    await env.DB.prepare(`
        INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
        VALUES (?, ?, ?, ?, 'daily', ?, 1)
    `).bind(userId, String(chatId), title, formattedTime, type).run();

    await sendMessage(env, chatId, [
        `⏰ *REMINDER SET!*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📌 *Title:* *${title}*`,
        `⏰ *Time:* \`${formattedTime}\` (Daily, Asia/Bangkok)`,
        `🔔 We will alert you on Telegram when it's time!`
    ].join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "⏰ All Reminders", callback_data: "reminders" },
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

async function addTransactionFromCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const isIncome = command === "/i" || command.startsWith("/income");
    const type = isIncome ? "income" : "expense";

    if (parts.length < 3) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:*\n` +
            `• Expense: \`/add <amount> [USD/KHR] <category>\`\n` +
            `• Income: \`/income <amount> [USD/KHR] <category>\`\n\n` +
            `Example: \`/add 5 usd coffee\` or \`/income 100000 khr salary\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    const amount = Number(parts[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage(env, chatId, "❌ Please enter a valid amount.");
        return;
    }

    let currency = await getDisplayCurrency(env.DB, userId);
    let categoryIndex = 2;

    const maybeCurrency = parts[2].toUpperCase();
    if (maybeCurrency === "USD" || maybeCurrency === "KHR") {
        currency = maybeCurrency;
        categoryIndex = 3;
    }

    const category = parts.slice(categoryIndex).join(" ").trim();
    if (!category) {
        await sendMessage(env, chatId, "❌ Please enter a category.");
        return;
    }

    await addExpenseRecord(env.DB, userId, amount, category, type, currency);
    await sendTransactionReceipt(env, chatId, userId, type, amount, currency, category);
}

// ---------------------------------------------------------------------------
// Beautiful, Clean UI Screen Renderers
// ---------------------------------------------------------------------------

async function sendMainMenu(env, chatId, userId, from, origin) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const monthSummary = await getFinancialSummary(env.DB, userId, "month");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");
    
    // Check lunchbox reminder status
    const lbRow = await env.DB.prepare(
        "SELECT reminder_time, frequency, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
    ).bind(userId).first();

    let lbStatus = "⚪ Off (Tap below to enable)";
    if (lbRow && lbRow.is_active) {
        const freqText = lbRow.frequency === "weekdays" ? "Mon–Fri" : "Daily";
        lbStatus = `🟢 Active (${lbRow.reminder_time} ${freqText})`;
    }

    const text = [
        `✨ *CASHFLOW & REMINDER BOT*`,
        `Hi *${cleanUsername}* 👋`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💳 *FINANCIAL OVERVIEW*`,
        `├ 💰 *Balance:* \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `├ 📈 *This Month:* \`${formatAmount(monthSummary.totalExpenseInKhr, displayCurrency)}\``,
        `└ 📅 *Today Spent:* \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\``,
        ``,
        `⏰ *HABITS & REMINDERS*`,
        `└ 🍱 *Lunch Box:* ${lbStatus}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Choose an action below:`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(cleanUsername)}`;

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "➕ Add Expense", callback_data: "add_expense" },
                    { text: "📥 Add Income", callback_data: "add_income" }
                ],
                [
                    { text: "🍱 Lunch Box Alarm", callback_data: "lunchbox" },
                    { text: "⏰ All Reminders", callback_data: "reminders" }
                ],
                [
                    { text: "📊 Today Summary", callback_data: "summary_today" },
                    { text: "📜 Daily Ledger", callback_data: "view_transactions" }
                ],
                [
                    { text: "📱 Open Web Dashboard", web_app: { url: webAppUrl } },
                    { text: "⚙️ Settings", callback_data: "settings" }
                ]
            ]
        }
    });
}

async function sendLunchboxMenu(env, chatId, userId) {
    await ensureTables(env.DB);
    const lbRow = await env.DB.prepare(
        "SELECT id, reminder_time, frequency, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
    ).bind(userId).first();

    const isActive = lbRow ? Boolean(lbRow.is_active) : false;
    const time = lbRow?.reminder_time || "17:30";
    const freq = lbRow?.frequency || "weekdays";
    const freqLabel = freq === "weekdays" ? "🗓️ Weekdays (Mon–Fri)" : "🗓️ Everyday";

    const statusBadge = isActive ? "🟢 *ACTIVE*" : "⚪ *DISABLED*";

    const text = [
        `🍱 *LUNCH BOX REMINDER*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Never leave your lunch box behind at the office again! When activated, the bot alerts you before you head home so you remember to pack your box from the fridge or pantry. 🥪✨`,
        ``,
        `📌 *Current Status:* ${statusBadge}`,
        `⏰ *Reminder Time:* *${time}* (Asia/Bangkok)`,
        `🗓️ *Schedule:* *${freqLabel}*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Tap below to toggle or change time:`
    ].join("\n");

    const toggleText = isActive ? "🔴 Turn Alarm OFF" : "🟢 Turn Alarm ON";
    const toggleVal = isActive ? "0" : "1";
    const nextFreq = freq === "weekdays" ? "daily" : "weekdays";
    const nextFreqText = freq === "weekdays" ? "Switch to: Everyday 🔁" : "Switch to: Weekdays only 🔁";

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: toggleText, callback_data: `lb_toggle:${toggleVal}` }
                ],
                [
                    { text: "⏰ 16:30", callback_data: "lb_time:16:30" },
                    { text: "⏰ 17:00", callback_data: "lb_time:17:00" },
                    { text: "⏰ 17:30", callback_data: "lb_time:17:30" },
                    { text: "⏰ 18:00", callback_data: "lb_time:18:00" }
                ],
                [
                    { text: nextFreqText, callback_data: `lb_freq:${nextFreq}` }
                ],
                [
                    { text: "🔔 Test Notification Now", callback_data: "lb_test" }
                ],
                [
                    { text: "⬅️ Back to Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

async function sendRemindersMenu(env, chatId, userId) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];

    const lines = [
        `⏰ *REMINDERS & HABITS*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Manage your automated reminders and daily notifications:`,
        ``
    ];

    if (reminders.length === 0) {
        lines.push(`_No reminders configured yet._`, `Tap *🍱 Lunch Box Alarm* below to set up your departure reminder!`);
    } else {
        reminders.forEach((r, idx) => {
            const status = r.is_active ? "🟢" : "⚪";
            const icon = r.type === "lunchbox" ? "🍱" : r.type === "expense_log" ? "💰" : "📌";
            const freq = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
            lines.push(`${idx + 1}. ${status} ${icon} *${r.title}* — \`${r.reminder_time}\` (${freq})`);
        });
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`💡 _Tip: You can also type \`/remind 17:30 Bring lunch box\` anytime!_`);

    const buttons = [
        [
            { text: "🍱 Lunch Box Alarm", callback_data: "lunchbox" },
            { text: "💰 Daily Expense Check-in", callback_data: "toggle_expense_reminder" }
        ]
    ];

    if (reminders.length > 0) {
        const delRow = reminders.slice(0, 3).map(r => ({
            text: `🗑️ #${r.id}`,
            callback_data: `remind_del:${r.id}`
        }));
        buttons.push(delRow);
    }

    buttons.push([
        { text: "🔔 Test Lunch Box Alert", callback_data: "lb_test" },
        { text: "🏠 Main Menu", callback_data: "menu" }
    ]);

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

async function sendSettingsMenu(env, chatId, userId) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const settingsRow = await env.DB.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    ).bind(userId).first();

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const budgetStr = budgetKhr > 0 ? formatAmount(budgetKhr, displayCurrency) : "Disabled (No limit)";
    const toggleLabel = displayCurrency === "USD" ? "🇰🇭 Switch to KHR (៛)" : "🇺🇸 Switch to USD ($)";

    const text = [
        `⚙️ *BOT SETTINGS*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🏳️ *Active Currency:* *${displayCurrency}*`,
        `🎯 *Monthly Budget:* *${budgetStr}*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Manage your currency, budget, or transaction records below:`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: toggleLabel, callback_data: "toggle_currency" }],
                [{ text: "🎯 Set / Change Budget", callback_data: "budget_help" }],
                [
                    { text: "🗑️ Clear Today's Data", callback_data: "clear_today_warn" },
                    { text: "⚠️ Wipe All History", callback_data: "clear_all_warn" }
                ],
                [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
            ]
        }
    });
}

async function sendCategoryPicker(env, chatId, type = "expense") {
    const isIncome = type === "income";
    const title = isIncome ? "📥 *ADD NEW INCOME*" : "➕ *ADD NEW EXPENSE*";
    const prefix = isIncome ? "cat_inc:" : "cat_exp:";
    const categories = isIncome ? QUICK_INCOME_CATS : QUICK_EXPENSE_CATS;
    const exampleCmd = isIncome ? "/income 500 usd salary" : "/add 5 usd coffee";

    const rows = [];
    for (let i = 0; i < categories.length; i += 2) {
        const row = [
            { text: `${categories[i].icon} ${categories[i].name}`, callback_data: `${prefix}${categories[i].name}` }
        ];
        if (categories[i + 1]) {
            row.push({
                text: `${categories[i + 1].icon} ${categories[i + 1].name}`,
                callback_data: `${prefix}${categories[i + 1].name}`
            });
        }
        rows.push(row);
    }

    const customCb = isIncome ? "custom_inc" : "custom_add";
    rows.push([{ text: `✏️ Type custom: ${exampleCmd}`, callback_data: customCb }]);
    rows.push([{ text: "⬅️ Back to Menu", callback_data: "menu" }]);

    const text = [
        title,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Choose a category below, or type your entry directly:`,
        `\`${exampleCmd}\``
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

async function sendAmountPicker(env, chatId, category, type = "expense", userId) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const isIncome = type === "income";
    const icon = getCategoryIcon(category, type);
    const title = isIncome ? "📥 *SELECT INCOME AMOUNT*" : "💸 *SELECT EXPENSE AMOUNT*";
    const prefix = isIncome ? "quick_inc:" : "quick_exp:";

    let amounts = [];
    if (displayCurrency === "USD") {
        amounts = isIncome ? [50, 100, 200, 500, 1000, 2000] : [2, 5, 10, 15, 20, 50];
    } else {
        amounts = isIncome ? [100000, 200000, 500000, 1000000, 2000000, 4000000] : [2000, 5000, 10000, 20000, 40000, 80000];
    }

    const rows = [];
    for (let i = 0; i < amounts.length; i += 2) {
        const row = [
            {
                text: formatAmount(displayCurrency === "USD" ? amounts[i] * EXCHANGE_RATE : amounts[i], displayCurrency),
                callback_data: `${prefix}${category}:${amounts[i]}`
            }
        ];
        if (amounts[i + 1] !== undefined) {
            row.push({
                text: formatAmount(displayCurrency === "USD" ? amounts[i + 1] * EXCHANGE_RATE : amounts[i + 1], displayCurrency),
                callback_data: `${prefix}${category}:${amounts[i + 1]}`
            });
        }
        rows.push(row);
    }

    const backCb = isIncome ? "add_income" : "add_expense";
    rows.push([{ text: `✏️ Custom: ${isIncome ? "/income" : "/add"} <amount> ${category}`, callback_data: isIncome ? "custom_inc" : "custom_add" }]);
    rows.push([{ text: "⬅️ Back to Categories", callback_data: backCb }]);

    const text = [
        title,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Selected Category: ${icon} *${capitalize(category)}*`,
        `Choose an amount below:`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

async function sendTransactionReceipt(env, chatId, userId, type, amount, currency, category) {
    const isIncome = type === "income";
    const title = isIncome ? "🎉 *INCOME LOGGED!*" : "✅ *EXPENSE LOGGED!*";
    const sign = isIncome ? "+" : "-";
    const symbol = currency === "USD" ? "$" : "";
    const suffix = currency === "KHR" ? " ៛" : "";
    const formatted = formatMoney(amount);
    const mainAmt = `${sign}${symbol}${formatted}${suffix}`;
    
    let altAmt = "";
    if (currency === "USD") {
        altAmt = ` (~${formatMoney(amount * EXCHANGE_RATE)} ៛)`;
    } else {
        altAmt = ` (~$${formatMoney(amount / EXCHANGE_RATE)})`;
    }

    const icon = getCategoryIcon(category, type);
    const lines = [
        title,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🏷️ *Category:* ${icon} ${capitalize(category)}`,
        `💵 *Amount:* \`${mainAmt}\`${altAmt}`,
        `📅 *Date:* \`${today()}\``,
    ];

    if (!isIncome) {
        const warn = await getBudgetWarningText(env.DB, userId);
        if (warn) lines.push(warn);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);

    const addAnotherCb = isIncome ? "add_income" : "add_expense";
    const addAnotherText = isIncome ? "📥 Add More Income" : "➕ Add Another Expense";

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: addAnotherText, callback_data: addAnotherCb },
                    { text: "📜 Today's Ledger", callback_data: "view_transactions" }
                ],
                [
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

async function sendTransactions(env, chatId, userId) {
    const date = today();
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const { results } = await env.DB.prepare(
        "SELECT amount, category, type, currency, created_at FROM expenses WHERE user_id = ? AND date = ? ORDER BY id ASC"
    )
    .bind(userId, date)
    .all();

    if (!results || !results.length) {
        await sendMessage(env, chatId, [
            `📜 *TODAY'S TRANSACTIONS*`,
            `📅 \`${date}\``,
            `━━━━━━━━━━━━━━━━━━━━`,
            `_No transactions recorded today yet._`,
            ``,
            `Tap below to log your first expense or income today!`
        ].join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "➕ Add Expense", callback_data: "add_expense" },
                        { text: "📥 Add Income", callback_data: "add_income" }
                    ],
                    [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
                ]
            }
        });
        return;
    }

    let totalIncome = 0;
    let totalExpense = 0;

    const lines = results.map((row) => {
        const isIncome = row.type === "income";
        const icon = getCategoryIcon(row.category, row.type);
        const sign = isIncome ? "+" : "-";
        const symbol = row.currency === "USD" ? "$" : "";
        const suffix = row.currency === "KHR" ? " ៛" : "";
        const amtKhr = row.currency === "USD" ? row.amount * EXCHANGE_RATE : row.amount;

        if (isIncome) totalIncome += amtKhr;
        else totalExpense += amtKhr;

        const amtStr = `${sign}${symbol}${row.currency === "USD" ? formatMoney(row.amount) : formatMoney(row.amount)}${suffix}`;
        return `${icon} \`${amtStr}\` • ${capitalize(row.category)}`;
    });

    const netKhr = totalIncome - totalExpense;

    const message = [
        `📜 *TODAY'S TRANSACTIONS*`,
        `📅 \`${date}\``,
        `━━━━━━━━━━━━━━━━━━━━`,
        ...lines,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📥 *Income:* \`${formatAmount(totalIncome, displayCurrency)}\``,
        `📤 *Spent:* \`${formatAmount(totalExpense, displayCurrency)}\``,
        `⚖️ *Net Today:* \`${formatAmount(netKhr, displayCurrency)}\``
    ].join("\n");

    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "➕ Add Expense", callback_data: "add_expense" },
                    { text: "📥 Add Income", callback_data: "add_income" }
                ],
                [
                    { text: "📊 Today Summary", callback_data: "summary_today" },
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

async function sendSummary(env, chatId, userId, period) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const stats = await getPeriodStats(env.DB, userId, period);
    const breakdown = await getCategoryRows(env.DB, userId, period, 5);
    const title = period === "month" ? `MONTHLY SUMMARY (${monthLabel()})` : `DAILY SUMMARY (${today()})`;

    const lines = [
        `📊 *${title}*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *Total Spent:* \`${formatAmount(stats.total, displayCurrency)}\``,
        `🧮 *Average / Entry:* \`${formatAmount(stats.average, displayCurrency)}\``,
        `🛍️ *Entries:* \`${stats.count} transactions\``,
    ];

    if (stats.maxAmount) {
        const symbol = stats.maxCurrency === "USD" ? "$" : "";
        const suffix = stats.maxCurrency === "KHR" ? " ៛" : "";
        const amt = stats.maxCurrency === "USD" ? stats.maxAmount : formatMoney(stats.maxAmount);
        const icon = getCategoryIcon(stats.maxCategory, "expense");
        lines.push(`🔥 *Biggest Single Spend:* \`${symbol}${amt}${suffix}\` on ${icon} *${capitalize(stats.maxCategory)}*`);
    }

    if (breakdown.length) {
        lines.push(`━━━━━━━━━━━━━━━━━━━━`, `🏷️ *Category Breakdown:*`);
        breakdown.forEach((row) => {
            const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
            const bar = generateTextProgressBar(percent);
            const icon = getCategoryIcon(row.category, "expense");
            lines.push(`${icon} *${capitalize(row.category)}:* ${bar} \`${formatAmount(row.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📜 Daily Ledger", callback_data: "view_transactions" },
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

function generateTextProgressBar(percent) {
    const totalBars = 6;
    const filled = Math.min(totalBars, Math.max(0, Math.round((percent / 100) * totalBars)));
    const empty = totalBars - filled;
    return "▰".repeat(filled) + "▱".repeat(empty);
}

async function sendCategoryBreakdown(env, chatId, userId, period) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const rows = await getCategoryRows(env.DB, userId, period, 10);
    const stats = await getPeriodStats(env.DB, userId, period);
    const title = period === "month" ? `Monthly Category Breakdown (${monthLabel()})` : `Daily Category Breakdown (${today()})`;

    if (!rows.length) {
        await sendMessage(env, chatId, "No category data recorded yet.");
        return;
    }

    const lines = [`📊 *${title.toUpperCase()}*`, `━━━━━━━━━━━━━━━━━━━━`];
    for (const row of rows) {
        const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
        const icon = getCategoryIcon(row.category, "expense");
        const bar = generateTextProgressBar(percent);
        lines.push(`${icon} *${capitalize(row.category)}:* ${bar} \`${formatAmount(row.total, displayCurrency)}\` (${percent}%)`);
    }

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
            ]
        }
    });
}

async function sendHistory(env, chatId, userId, page = 1) {
    const { text, replyMarkup } = await getHistoryMessageData(env.DB, userId, page);
    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: replyMarkup
    });
}

async function updateHistoryMessage(env, chatId, userId, messageId, page = 1) {
    const { text, replyMarkup } = await getHistoryMessageData(env.DB, userId, page);
    try {
        await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: "Markdown",
            reply_markup: replyMarkup
        });
    } catch (err) {
        console.error("Failed to edit history message, sending new message instead:", err);
        await sendMessage(env, chatId, text, {
            parse_mode: "Markdown",
            reply_markup: replyMarkup
        });
    }
}

async function getHistoryMessageData(db, userId, page = 1) {
    const limit = 10;
    const countRow = await db
        .prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?")
        .bind(userId)
        .first();
    const totalCount = countRow?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const { results } = await db
        .prepare(
            `SELECT id, amount, category, type, currency, date, created_at 
             FROM expenses 
             WHERE user_id = ? 
             ORDER BY date DESC, id DESC 
             LIMIT ? OFFSET ?`
        )
        .bind(userId, limit, (currentPage - 1) * limit)
        .all();

    if (!results || results.length === 0) {
        return {
            text: "📜 *TRANSACTION HISTORY*\n━━━━━━━━━━━━━━━━━━━━\nNo transactions recorded yet.",
            replyMarkup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
                ]
            }
        };
    }

    const lines = results.map((row) => {
        const isIncome = row.type === "income";
        const icon = getCategoryIcon(row.category, row.type);
        const sign = isIncome ? "+" : "-";
        const symbol = row.currency === "USD" ? "$" : "";
        const suffix = row.currency === "KHR" ? " ៛" : "";
        const amtStr = `${sign}${symbol}${row.currency === "USD" ? row.amount : formatMoney(row.amount)}${suffix}`;
        return `• \`${row.date}\` • ${icon} \`${amtStr}\` • ${capitalize(row.category)}`;
    });

    const text = [
        `📜 *TRANSACTION HISTORY*`,
        `📖 *Page ${currentPage} of ${totalPages}* (Total: ${totalCount})`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ...lines
    ].join("\n");

    const navRow = [];
    if (currentPage > 1) {
        navRow.push({ text: "⬅️ Prev", callback_data: `history:${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
        navRow.push({ text: "Next ➡️", callback_data: `history:${currentPage + 1}` });
    }

    const inlineKeyboard = [];
    if (navRow.length > 0) {
        inlineKeyboard.push(navRow);
    }
    inlineKeyboard.push([{ text: "⬅️ Back to Menu", callback_data: "menu" }]);

    return {
        text,
        replyMarkup: { inline_keyboard: inlineKeyboard }
    };
}

async function sendHelpMessage(env, chatId) {
    const text = [
        `💡 *CASHFLOW & REMINDER BOT GUIDE*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🍱 *Lunch Box & Reminders*`,
        `• /lunchbox — Lunch box alarm manager`,
        `• /lunchbox 17:30 — Set lunch box reminder time`,
        `• /lunchbox on / off — Enable or disable alarm`,
        `• /remind 17:30 Take lunch box — Set custom reminder`,
        `• /reminders — View & manage all active reminders`,
        ``,
        `💳 *Logging Transactions*`,
        `• /add 5 usd coffee — Log expense in USD`,
        `• /add 10000 lunch — Log expense in KHR`,
        `• /income 500 usd salary — Log income`,
        `• /a or /i — Interactive category & amount picker`,
        ``,
        `📊 *Summaries & Insights*`,
        `• /today or /t — Today's transactions ledger`,
        `• /summary — Spending stats & breakdown`,
        `• /week — 7-day visual report & doughnut chart`,
        `• /month — Current month spending overview`,
        `• /history — Full paginated transaction ledger`,
        ``,
        `⚙️ *Settings & Budgets*`,
        `• /budget 300 usd — Set monthly spending cap`,
        `• /settings — Currency toggle & budget settings`,
        `• /clear — Clear data with automatic CSV backup`,
        `• /menu — Return to main dashboard`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🍱 Lunch Box Alarm", callback_data: "lunchbox" },
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

// ---------------------------------------------------------------------------
// Reminder Dispatcher & Cron Tasks
// ---------------------------------------------------------------------------

async function processDueReminders(env) {
    await ensureTables(env.DB);
    const now = new Date();
    
    const timeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(now); // e.g. "17:30"

    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "short"
    }).format(now); // "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"

    const todayStr = today();
    const isWeekday = weekdayStr !== "Sat" && weekdayStr !== "Sun";

    const { results } = await env.DB.prepare(`
        SELECT id, user_id, chat_id, title, reminder_time, frequency, type 
        FROM reminders 
        WHERE is_active = 1 
          AND reminder_time = ? 
          AND (last_sent_date IS NULL OR last_sent_date != ?)
    `).bind(timeStr, todayStr).all();

    if (!results || results.length === 0) return;

    for (const r of results) {
        if (r.frequency === "weekdays" && !isWeekday) {
            continue;
        }

        try {
            if (r.type === "lunchbox") {
                await sendLunchboxNotification(env, r.chat_id, r.id);
            } else if (r.type === "expense_log") {
                await sendExpenseLogNotification(env, r.chat_id);
            } else {
                await sendCustomReminderNotification(env, r.chat_id, r.title, r.reminder_time, r.id);
            }

            if (r.frequency === "once") {
                await env.DB.prepare("UPDATE reminders SET is_active = 0, last_sent_date = ? WHERE id = ?")
                    .bind(todayStr, r.id)
                    .run();
            } else {
                await env.DB.prepare("UPDATE reminders SET last_sent_date = ? WHERE id = ?")
                    .bind(todayStr, r.id)
                    .run();
            }
        } catch (err) {
            console.error(`Failed to send reminder ${r.id} to chat ${r.chat_id}:`, err);
        }
    }
}

async function sendLunchboxNotification(env, chatId, reminderId = 0) {
    const text = [
        `🍱🔔 *DON'T FORGET YOUR LUNCH BOX!*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Hey there! Wrapping up your work day? 🎒`,
        ``,
        `Friendly reminder: Don't leave your *lunch box* behind in the office fridge or pantry! Grab it before you leave! 🥪✨`,
        ``,
        `Have a great evening and safe travels home! 🏡`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Got it, Packed!", callback_data: `lb_ack:${reminderId}` },
                    { text: "⏰ Snooze 15m", callback_data: `lb_snooze:${reminderId}` }
                ]
            ]
        }
    });
}

async function sendExpenseLogNotification(env, chatId) {
    const text = [
        `💰🔔 *DAILY EXPENSE CHECK-IN*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Did you spend or earn anything today? 📝`,
        ``,
        `Take 10 seconds to record your day's transactions and keep your cashflow on track! 📊`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "➕ Add Expense", callback_data: "add_expense" },
                    { text: "📥 Add Income", callback_data: "add_income" }
                ],
                [
                    { text: "📜 Today's Ledger", callback_data: "view_transactions" },
                    { text: "🏠 Main Menu", callback_data: "menu" }
                ]
            ]
        }
    });
}

async function sendCustomReminderNotification(env, chatId, title, time, reminderId) {
    const text = [
        `⏰🔔 *REMINDER ALERT*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📌 *${title}*`,
        ``,
        `⏰ Time: *${time}* (Asia/Bangkok)`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Done", callback_data: `remind_done:${reminderId}` }]
            ]
        }
    });
}

// ---------------------------------------------------------------------------
// Helpers & Database Operations
// ---------------------------------------------------------------------------

async function askClearConfirmation(env, chatId) {
    await sendMessage(env, chatId, "What would you like to clear?", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Today's expenses only", callback_data: "clear_today_warn" }],
                [{ text: "ALL history (Full Reset)", callback_data: "clear_all_warn" }],
                [{ text: "Cancel", callback_data: "cancel_clear" }],
            ],
        },
    });
}

async function getDisplayCurrency(db, userId) {
    const row = await db
        .prepare("SELECT display_currency FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
    return row?.display_currency || "KHR";
}

async function setDisplayCurrency(db, userId, currency) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, display_currency) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET display_currency = excluded.display_currency"
        )
        .bind(userId, currency)
        .run();
}

function formatAmount(amountInKhr, displayCurrency) {
    if (displayCurrency === "USD") {
        const usd = amountInKhr / EXCHANGE_RATE;
        return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
        return `${formatMoney(amountInKhr)} ៛`;
    }
}

async function getFinancialSummary(db, userId, period) {
    let condition = "";
    let bindParams = [userId];
    
    if (period === "today") {
        condition = "AND date = ?";
        bindParams.push(today());
    } else if (period === "month") {
        condition = "AND date LIKE ?";
        bindParams.push(`${monthPrefix()}%`);
    }

    const { results } = await db.prepare(
        `SELECT type, currency, SUM(amount) AS total
         FROM expenses
         WHERE user_id = ? ${condition}
         GROUP BY type, currency`
    )
    .bind(...bindParams)
    .all();

    let incomeUsd = 0;
    let incomeKhr = 0;
    let expenseUsd = 0;
    let expenseKhr = 0;

    if (results) {
        for (const row of results) {
            const amount = Number(row.total || 0);
            if (row.type === "income") {
                if (row.currency === "USD") incomeUsd += amount;
                else incomeKhr += amount;
            } else {
                if (row.currency === "USD") expenseUsd += amount;
                else expenseKhr += amount;
            }
        }
    }

    const totalIncomeInKhr = incomeKhr + (incomeUsd * EXCHANGE_RATE);
    const totalExpenseInKhr = expenseKhr + (expenseUsd * EXCHANGE_RATE);
    const balanceKhr = totalIncomeInKhr - totalExpenseInKhr;

    return {
        incomeKhr,
        incomeUsd,
        expenseKhr,
        expenseUsd,
        totalIncomeInKhr,
        totalExpenseInKhr,
        balanceKhr
    };
}

async function getTotalExpenses(db, userId) {
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total 
             FROM expenses 
             WHERE user_id = ? AND type = 'expense'`
        )
        .bind(userId)
        .first();

    return Number(row?.total || 0);
}

async function getPeriodStats(db, userId, period) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}`
        )
        .bind(userId, value)
        .first();

    const biggest = await db
        .prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
             LIMIT 1`
        )
        .bind(userId, value)
        .first();

    return {
        total: Number(row?.total || 0),
        count: Number(row?.count || 0),
        average: Number(row?.average || 0),
        maxAmount: Number(biggest?.amount || 0),
        maxCategory: biggest?.category || "",
        maxCurrency: biggest?.currency || "KHR"
    };
}

async function getCategoryRows(db, userId, period, limit) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    const { results } = await db
        .prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) AS total, 
                    COUNT(*) AS count
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             GROUP BY LOWER(category)
             ORDER BY total DESC
             LIMIT ?`
        )
        .bind(userId, value, limit)
        .all();

    return results || [];
}

async function addExpenseRecord(db, userId, amount, category, type = "expense", currency = "KHR") {
    await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, today(), amount, normalizeCategory(category), type, currency)
        .run();
}

async function clearToday(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ? AND date = ?")
        .bind(userId, today())
        .run();
}

async function clearAllExpenses(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ?")
        .bind(userId)
        .run();
}

async function sendCSVBackup(env, chatId, userId) {
    const { results } = await env.DB.prepare(
        "SELECT date, category, amount, currency, type, created_at FROM expenses WHERE user_id = ? ORDER BY date ASC, id ASC"
    )
    .bind(userId)
    .all();

    if (!results || results.length === 0) {
        throw new Error("No transactions found to backup.");
    }

    let csvContent = "Date,Type,Category,Amount,Currency,Created At\n";
    for (const row of results) {
        const escapedCategory = String(row.category || "").replace(/"/g, '""');
        csvContent += `"${row.date}","${row.type}","${escapedCategory}",${row.amount},"${row.currency}","${row.created_at}"\n`;
    }

    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([csvContent], `cashflow_backup_${today()}.csv`, { type: "text/csv" });
    formData.append("document", file);
    formData.append("caption", "Here is a CSV backup of your expenses before wiping.");

    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
        {
            method: "POST",
            body: formData,
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram sendDocument failed with status ${response.status}: ${detail}`);
    }
}

async function sendMessage(env, chatId, text, extra = {}) {
    try {
        return await telegram(env, "sendMessage", {
            chat_id: chatId,
            text,
            ...extra,
        });
    } catch (err) {
        if (extra.parse_mode) {
            console.warn("Telegram sendMessage failed with parse_mode, retrying as plain text:", err.message);
            const { parse_mode, ...fallbackExtra } = extra;
            const cleanText = text.replace(/[*`_]/g, "");
            return await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: cleanText,
                ...fallbackExtra,
            });
        }
        throw err;
    }
}

async function answerCallback(env, callbackQueryId, extra = {}) {
    if (!callbackQueryId) return;
    return telegram(env, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...extra,
    });
}

async function telegram(env, method, payload) {
    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram ${method} failed: ${response.status} ${detail}`);
    }

    return response.json();
}

function today() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function monthPrefix() {
    return today().slice(0, 7);
}

function monthLabel() {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "long",
    }).format(new Date());
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    });
}

function capitalize(value) {
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeCategory(value) {
    const category = String(value || "").trim().replace(/\s+/g, " ");
    if (!category) return "Other";
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

function getCategoryIcon(category, type = "expense") {
    const cat = (category || "").toLowerCase();
    if (cat.includes("food") || cat.includes("lunch") || cat.includes("dinner") || cat.includes("breakfast") || cat.includes("meal")) return "🍔";
    if (cat.includes("coffee") || cat.includes("tea") || cat.includes("cafe") || cat.includes("drink")) return "☕";
    if (cat.includes("transport") || cat.includes("bus") || cat.includes("gas") || cat.includes("fuel")) return "🚗";
    if (cat.includes("taxi") || cat.includes("passapp") || cat.includes("grab")) return "🚕";
    if (cat.includes("rent") || cat.includes("house") || cat.includes("room")) return "🏠";
    if (cat.includes("shop") || cat.includes("cloth") || cat.includes("buy")) return "🛍️";
    if (cat.includes("bill") || cat.includes("electric") || cat.includes("water") || cat.includes("internet") || cat.includes("wifi")) return "💡";
    if (cat.includes("salary") || cat.includes("wage") || cat.includes("paycheck")) return "💼";
    if (cat.includes("freelance") || cat.includes("client") || cat.includes("project")) return "💻";
    if (cat.includes("gift")) return "🎁";
    if (cat.includes("invest") || cat.includes("stock") || cat.includes("crypto") || cat.includes("dividend")) return "📈";
    if (cat.includes("bonus")) return "💰";
    return type === "income" ? "💵" : "💸";
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}

function dateDaysAgo(days) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

async function sendWeeklyScheduledReports(env) {
    const sevenDaysAgo = dateDaysAgo(7);
    const oneDayAgo = dateDaysAgo(1);

    const { results } = await env.DB.prepare(
        "SELECT DISTINCT user_id FROM expenses WHERE date >= ? AND date <= ?"
    )
    .bind(sevenDaysAgo, oneDayAgo)
    .all();

    if (results && results.length > 0) {
        for (const row of results) {
            try {
                await sendWeeklyReportForUser(
                    env,
                    row.user_id,
                    row.user_id,
                    sevenDaysAgo,
                    oneDayAgo,
                    "Weekly Spending Report (Last Week)"
                );
            } catch (err) {
                console.error(`Failed to send weekly scheduled report to ${row.user_id}:`, err);
            }
        }
    }
}

async function sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, titleLabel) {
    const row = await env.DB
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`
        )
        .bind(userId, startDate, endDate)
        .first();

    const total = Number(row?.total || 0);
    const count = Number(row?.count || 0);
    const average = Number(row?.average || 0);

    if (count === 0) {
        await sendMessage(env, chatId, `📊 *${titleLabel}*\n\n📅 \`${startDate}\` to \`${endDate}\`\n\nYou didn't record any expenses during this period.`, {
            parse_mode: "Markdown"
        });
        return;
    }

    const biggest = await env.DB
        .prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
             LIMIT 1`
        )
        .bind(userId, startDate, endDate)
        .first();

    const categories = await env.DB
        .prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) AS total
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             GROUP BY LOWER(category)
             ORDER BY total DESC`
        )
        .bind(userId, startDate, endDate)
        .all();

    const catResults = categories.results || [];
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const totalSpentStr = formatAmount(total, displayCurrency);
    const chartUrl = generatePieChartUrl(catResults, totalSpentStr);

    const textLines = [
        `📊 *${titleLabel.toUpperCase()}*`,
        `📅 \`${startDate}\` to \`${endDate}\``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *Total Spent:* \`${formatAmount(total, displayCurrency)}\``,
        `🧮 *Average / Entry:* \`${formatAmount(average, displayCurrency)}\``,
        `🛍️ *Activity:* \`${count} entries\``,
    ];

    if (biggest) {
        const symbol = biggest.currency === "USD" ? "$" : "";
        const suffix = biggest.currency === "KHR" ? " ៛" : "";
        const amt = biggest.currency === "USD" ? biggest.amount : formatMoney(biggest.amount);
        const icon = getCategoryIcon(biggest.category, "expense");
        let maxStr = `🔥 *Biggest Single Spend:* \`${symbol}${amt}${suffix}\` on ${icon} *${capitalize(biggest.category)}*`;
        if (biggest.currency === "USD") {
            maxStr += ` (~${formatMoney(biggest.amount * EXCHANGE_RATE)} ៛)`;
        } else {
            maxStr += ` (~$${formatMoney(biggest.amount / EXCHANGE_RATE)})`;
        }
        textLines.push(maxStr);
    }

    if (catResults.length > 0) {
        textLines.push(``, `🏷️ *Category Breakdown:*`);
        catResults.forEach((cat) => {
            const percent = total > 0 ? Math.round((cat.total / total) * 100) : 0;
            const bar = generateTextProgressBar(percent);
            const icon = getCategoryIcon(cat.category, "expense");
            textLines.push(`${icon} *${capitalize(cat.category)}:* ${bar} \`${formatAmount(cat.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    const caption = textLines.join("\n");
    const payload = {
        chat_id: chatId,
        photo: chartUrl,
        caption: caption,
        parse_mode: "Markdown",
    };

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            const detail = await response.text();
            console.error(`Telegram sendPhoto failed: ${response.status} ${detail}`);
            await sendMessage(env, chatId, caption, { parse_mode: "Markdown" });
        }
    } catch (err) {
        console.error("Error sending photo to Telegram:", err);
        await sendMessage(env, chatId, caption, { parse_mode: "Markdown" });
    }
}

function generatePieChartUrl(categories, totalSpentStr) {
    const labels = categories.map(c => capitalize(c.category));
    const data = categories.map(c => c.total);

    const limit = 5;
    let finalLabels = labels;
    let finalData = data;
    if (categories.length > limit) {
        finalLabels = labels.slice(0, limit);
        finalData = data.slice(0, limit);
        const otherTotal = data.slice(limit).reduce((a, b) => a + b, 0);
        finalLabels.push("Other");
        finalData.push(otherTotal);
    }

    const chart = {
        type: "doughnut",
        data: {
            labels: finalLabels,
            datasets: [{
                data: finalData,
                backgroundColor: [
                    "#6366f1",
                    "#ec4899",
                    "#f59e0b",
                    "#10b981",
                    "#06b6d4",
                    "#64748b"
                ],
                borderWidth: 3,
                borderColor: "#0d0f14"
            }]
        },
        options: {
            cutoutPercentage: 72,
            legend: {
                position: "bottom",
                labels: {
                    fontSize: 12,
                    fontColor: "#9ca3af",
                    fontFamily: "Arial",
                    padding: 12
                }
            },
            plugins: {
                datalabels: {
                    display: false
                },
                doughnutlabel: {
                    labels: [
                        {
                            text: "Total Spent",
                            font: { size: 13, family: "Arial", weight: "bold" },
                            color: "#9ca3af"
                         },
                         {
                            text: totalSpentStr,
                            font: { size: 19, family: "Arial", weight: "bold" },
                            color: "#ffffff"
                         }
                    ]
                }
            }
        }
    };

    const encodedChart = encodeURIComponent(JSON.stringify(chart));
    return `https://quickchart.io/chart?c=${encodedChart}&w=500&h=350&bkg=%230d0f14`;
}

async function handleBudgetCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:*\n` +
            `• Set Budget: \`/budget <amount> [USD/KHR]\`\n` +
            `• Disable Budget: \`/budget 0\`\n\n` +
            `Example: \`/budget 300 usd\` or \`/budget 1200000 khr\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    const amount = Number(parts[1]);
    if (!Number.isFinite(amount) || amount < 0) {
        await sendMessage(env, chatId, "❌ Please enter a valid non-negative amount.");
        return;
    }

    if (amount === 0) {
        await setMonthlyBudget(env.DB, userId, 0);
        await sendMessage(env, chatId, "🎯 *Monthly budget disabled.*", { parse_mode: "Markdown" });
        return;
    }

    let currency = "KHR";
    if (parts.length >= 3) {
        const maybeCurrency = parts[2].toUpperCase();
        if (maybeCurrency === "USD" || maybeCurrency === "KHR") {
            currency = maybeCurrency;
        } else {
            await sendMessage(env, chatId, "❌ Please specify a valid currency (USD or KHR).");
            return;
        }
    } else {
        currency = await getDisplayCurrency(env.DB, userId);
    }

    const budgetInKhr = currency === "USD" ? amount * EXCHANGE_RATE : amount;
    await setMonthlyBudget(env.DB, userId, budgetInKhr);

    const formattedAmount = currency === "USD" ? `$${formatMoney(amount)}` : `${formatMoney(amount)} ៛`;
    const altAmount = currency === "USD" ? `${formatMoney(budgetInKhr)} ៛` : `$${formatMoney(amount / EXCHANGE_RATE)}`;
    await sendMessage(
        env,
        chatId,
        `🎯 *Monthly budget set to ${formattedAmount}* (~${altAmount})!`,
        { parse_mode: "Markdown" }
    );
}

async function setMonthlyBudget(db, userId, budgetInKhr) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, monthly_budget) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET monthly_budget = excluded.monthly_budget"
        )
        .bind(userId, budgetInKhr)
        .run();
}

async function getBudgetWarningText(db, userId) {
    const settingsRow = await db.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    )
    .bind(userId)
    .first();
    
    const budgetKhr = settingsRow?.monthly_budget || 0;
    if (budgetKhr <= 0) return "";

    const monthSummary = await getFinancialSummary(db, userId, "month");
    const totalSpentInKhr = monthSummary.totalExpenseInKhr;
    const displayCurrency = await getDisplayCurrency(db, userId);
    
    const percent = Math.round((totalSpentInKhr / budgetKhr) * 100);
    
    if (percent >= 100) {
        const overageInKhr = totalSpentInKhr - budgetKhr;
        const formattedOverage = formatAmount(overageInKhr, displayCurrency);
        return `\n🚨 *OVER BUDGET ALERT!*\n└ You have exceeded your monthly budget by *${formattedOverage}* (${percent}% spent).`;
    } else if (percent >= 90) {
        const formattedRemaining = formatAmount(budgetKhr - totalSpentInKhr, displayCurrency);
        return `\n⚠️ *BUDGET WARNING!*\n└ You have spent *${percent}%* of your monthly budget (only *${formattedRemaining}* remaining).`;
    }
    return "";
}
