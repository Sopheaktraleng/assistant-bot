import dashboardHtml from "./dashboard_html.js";

const TIME_ZONE = "Asia/Phnom_Penh";
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
        console.error("ensureTables reminders error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS work_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables work_logs error:", e);
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

    // 1. Main Navigation & Workspaces
    if (text.startsWith("/start") || text === "/menu" || text.startsWith("/menu@") || text === "/hub" || text.startsWith("/hub@") || text === "/s" || text === "/m") {
        await sendMainHub(env, chatId, userId, message.from, origin);
        return;
    }

    if (text === "/finance" || text === "/cashflow" || text === "/money" || text === "/f") {
        await sendFinanceHub(env, chatId, userId);
        return;
    }

    // 2. Work Log & Manager Reports Workspace
    if (text === "/work" || text === "/worklog" || text === "/tasks" || text === "/task" || text === "/w") {
        await sendWorkHub(env, chatId, userId, message.from);
        return;
    }

    if (text.startsWith("/done") || text.startsWith("/did") || text.startsWith("/log")) {
        const parts = text.split(/\s+/);
        if (parts.length === 1) {
            await sendWorkHub(env, chatId, userId, message.from);
            return;
        }
        await handleAddWorkLogCommand(env, chatId, userId, text, message.from);
        return;
    }

    if (text.startsWith("/report")) {
        await handleReportCommand(env, chatId, userId, text, message.from);
        return;
    }

    // 2. Reminders & Alarms Commands
    if (text.startsWith("/remind") || text.startsWith("/alarm")) {
        await handleRemindCommand(env, chatId, userId, text);
        return;
    }

    if (text === "/reminders" || text === "/reminder" || text === "/r") {
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (text.startsWith("/lunchbox") || text === "/lb") {
        await handleLunchboxCommand(env, chatId, userId, text);
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

    // =========================================================================
    // Smart Natural Text Detection (Zero Command Friction!)
    // =========================================================================
    if (!text.startsWith("/")) {
        const lower = text.toLowerCase();

        // 1. Natural Navigation Keywords
        if (lower === "menu" || lower === "hub" || lower === "start" || lower === "hi" || lower === "hello" || lower === "hey") {
            await sendMainHub(env, chatId, userId, message.from, origin);
            return;
        }

        if (lower === "work" || lower === "tasks" || lower === "task") {
            await sendWorkHub(env, chatId, userId, message.from);
            return;
        }

        if (lower === "report") {
            await sendWorkReport(env, chatId, userId, "this_month", message.from);
            return;
        }

        if (lower === "today" || lower === "spent" || lower === "ledger") {
            await sendTransactions(env, chatId, userId);
            return;
        }

        if (lower === "finance" || lower === "money" || lower === "cashflow" || lower === "balance") {
            await sendFinanceHub(env, chatId, userId);
            return;
        }

        if (lower === "reminder" || lower === "reminders" || lower === "alarm" || lower === "alarms" || lower === "lunchbox" || lower === "lunch") {
            await sendRemindersMenu(env, chatId, userId);
            return;
        }

        if (lower === "help") {
            await sendHelpMessage(env, chatId);
            return;
        }

        // 2. Natural Reminder: e.g. "remind 17:30 Bring lunch box", "remind in 30m Check oven", "remind 9am Standup"
        if (lower.startsWith("remind ") || lower.startsWith("remindme ") || lower.startsWith("alarm ")) {
            await handleRemindCommand(env, chatId, userId, text);
            return;
        }

        // 3. Natural Work Logging: e.g. "done fixed checkout bug", "did code review", "finished report"
        if (
            lower.startsWith("done ") || 
            lower.startsWith("did ") || 
            lower.startsWith("finished ") || 
            lower.startsWith("completed ") ||
            lower.startsWith("log ")
        ) {
            const cleanContent = text.replace(/^(done|did|finished|completed|log)\s+/i, "").trim();
            if (cleanContent) {
                await handleAddWorkLogCommand(env, chatId, userId, `/done ${cleanContent}`, message.from);
                return;
            }
        }

        // 4. Natural Income: e.g. "+500 salary" or "income 500 salary"
        const incMatch = text.match(/^\+([0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s*(.*)$/i) ||
                         text.match(/^income\s+([0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s*(.*)$/i);
        if (incMatch) {
            const amount = Number(incMatch[1]);
            const currencyStr = (incMatch[3] || "").toUpperCase();
            const cat = incMatch[4].trim() || "Income";
            let curr = await getDisplayCurrency(env.DB, userId);
            if (currencyStr === "$" || currencyStr === "USD") curr = "USD";
            else if (currencyStr === "KHR") curr = "KHR";
            else if (amount < 100) curr = "USD";
            await addExpenseRecord(env.DB, userId, amount, cat, "income", curr);
            await sendTransactionReceipt(env, chatId, userId, "income", amount, curr, cat);
            return;
        }

        // 5. Natural Expense: e.g. "5 coffee", "$5 coffee", "5$ coffee", "10000 lunch", "coffee 5"
        const expMatch1 = text.match(/^(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s+([a-zA-Z\s]+)$/i);
        const expMatch2 = text.match(/^([a-zA-Z\s]+)\s+(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?$/i);

        let amount = null;
        let category = null;
        let currencyHint = null;

        if (expMatch1) {
            amount = Number(expMatch1[1].replace("$", ""));
            currencyHint = expMatch1[3] || (expMatch1[1].includes("$") ? "USD" : null);
            category = expMatch1[4].trim();
        } else if (expMatch2) {
            amount = Number(expMatch2[2].replace("$", ""));
            currencyHint = expMatch2[4] || (expMatch2[2].includes("$") ? "USD" : null);
            category = expMatch2[1].trim();
        }

        if (amount && Number.isFinite(amount) && amount > 0 && category && category.length < 30) {
            let curr = await getDisplayCurrency(env.DB, userId);
            if (currencyHint) {
                const cUpper = currencyHint.toUpperCase();
                if (cUpper === "$" || cUpper === "USD") curr = "USD";
                else if (cUpper === "KHR") curr = "KHR";
            } else {
                if (amount >= 500) curr = "KHR";
                else curr = "USD";
            }
            await addExpenseRecord(env.DB, userId, amount, category, "expense", curr);
            await sendTransactionReceipt(env, chatId, userId, "expense", amount, curr, category);
            return;
        }

        // 6. Friendly guidance if casual text doesn't match
        await sendMessage(
            env,
            chatId,
            `💡 *Quick Shortcuts:*\n` +
            `• Remind anything: \`remind 17:30 Bring lunch box\` or \`remind in 30m Check oven\`\n` +
            `• Log work: \`done <task>\`\n` +
            `• Log spend: \`5 coffee\` or \`10000 lunch\`\n` +
            `• Manager report: \`report\`\n` +
            `• Menu: /menu`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    if (text.startsWith("/")) {
        await sendMessage(env, chatId, "⚠️ Unknown command. Type /help to see all available commands, or /hub to open your Personal Assistant Hub.");
    }
}

async function handleCallback(callback, env, origin) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);

    await answerCallback(env, callback.id);

    if (!chatId) return;

    // --- Main Hub, Finance Hub & Settings ---
    if (data === "menu" || data === "hub") {
        await sendMainHub(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "finance_hub") {
        await sendFinanceHub(env, chatId, userId);
        return;
    }

    // --- Work Log & Reports Callbacks ---
    if (data === "work_hub") {
        await sendWorkHub(env, chatId, userId, callback.from);
        return;
    }

    if (data === "work_today") {
        await sendTodayWork(env, chatId, userId);
        return;
    }

    if (data === "work_week") {
        await sendWorkReport(env, chatId, userId, "this_week", callback.from);
        return;
    }

    if (data === "work_report_this") {
        await sendWorkReport(env, chatId, userId, "this_month", callback.from);
        return;
    }

    if (data === "work_report_last") {
        await sendWorkReport(env, chatId, userId, "last_month", callback.from);
        return;
    }

    if (data === "work_export_this") {
        await sendWorkReportFile(env, chatId, userId, "this_month", callback.from);
        return;
    }

    if (data === "work_export_last") {
        await sendWorkReportFile(env, chatId, userId, "last_month", callback.from);
        return;
    }

    if (data === "work_delete_menu") {
        await sendWorkDeletePicker(env, chatId, userId);
        return;
    }

    if (data.startsWith("work_del:")) {
        const id = parseInt(data.slice(9), 10);
        await env.DB.prepare("DELETE FROM work_logs WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Task deleted." });
        await sendWorkHub(env, chatId, userId, callback.from);
        return;
    }

    if (data === "work_log_prompt") {
        await sendMessage(
            env,
            chatId,
            `💼 *HOW TO LOG WORK TASKS*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `Whenever you finish a task, meeting, or bugfix, type:\n` +
            `• \`/done Fixed customer checkout payment failure\`\n` +
            `• \`/done Prepared Q3 API migration roadmap\`\n` +
            `• \`/done Weekly team sprint planning meeting\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\`\n\n` +
            `At the end of the month, type \`/report\` or tap *This Month's Report* to generate your complete monthly manager accomplishment report ready to copy & paste! 🚀`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    if (data === "help") {
        await sendHelpMessage(env, chatId);
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

    if (data === "remind_prompt_add") {
        await sendPromptAddReminder(env, chatId);
        return;
    }

    if (data === "remind_add_lunchbox") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?")
                .bind(String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Bring lunch box home', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }

        await answerCallback(env, callback.id, { text: "🍱 Lunchbox alarm enabled (17:30 Mon–Fri)!" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_toggle:")) {
        const id = parseInt(data.slice(14), 10);
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active, title FROM reminders WHERE id = ? AND user_id = ?"
        ).bind(id, userId).first();

        if (existing) {
            const newActive = existing.is_active ? 0 : 1;
            await env.DB.prepare("UPDATE reminders SET is_active = ?, chat_id = ? WHERE id = ?")
                .bind(newActive, String(chatId), id)
                .run();
            const statusTxt = newActive ? `🟢 "${existing.title}" is now ON!` : `⚪ "${existing.title}" is now OFF.`;
            await answerCallback(env, callback.id, { text: statusTxt });
        }
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_time_menu:")) {
        const id = parseInt(data.slice(17), 10);
        await sendReminderTimeMenu(env, chatId, userId, id);
        return;
    }

    if (data.startsWith("remind_set_time:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const newTime = `${parts[2]}:${parts[3]}`;
        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(newTime, String(chatId), id, userId).run();

        await answerCallback(env, callback.id, { text: `⏰ Time updated to ${newTime}!` });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_set_rel:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const mins = parseInt(parts[2], 10);
        const now = new Date();
        const targetDate = new Date(now.getTime() + mins * 60 * 1000);
        const targetTimeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(targetDate);

        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET reminder_time = ?, frequency = 'once', is_active = 1, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(targetTimeStr, String(chatId), id, userId).run();

        await answerCallback(env, callback.id, { text: `⏱️ Set to ${targetTimeStr} (in ${mins}m)!` });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (data.startsWith("remind_freq:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const newFreq = parts[2];
        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET frequency = ?, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(newFreq, String(chatId), id, userId).run();

        const label = newFreq === "weekdays" ? "Mon–Fri" : newFreq === "daily" ? "Daily" : "Once";
        await answerCallback(env, callback.id, { text: `🗓️ Schedule: ${label}` });
        await sendReminderTimeMenu(env, chatId, userId, id);
        return;
    }

    if (data === "remind_test_general") {
        await answerCallback(env, callback.id, { text: "🔔 Sending test reminder..." });
        await sendCustomReminderNotification(env, chatId, "Test Reminder: Everything is working perfectly!", currentTime(), 0);
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

    if (data.startsWith("remind_snooze:")) {
        const id = parseInt(data.slice(14), 10);
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 15 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        let title = "Reminder";
        if (id) {
            const r = await env.DB.prepare("SELECT title FROM reminders WHERE id = ?").bind(id).first();
            if (r?.title) title = r.title;
        }

        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, ?, ?, 'once', 'custom', 1)
        `).bind(userId, String(chatId), `${title} (Snoozed)`, snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Snoozed 15 mins (until ${snoozeStr})!` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰🔔 *REMINDER SNOOZED*`,
                    `━━━━━━━━━━━━━━━━━━━━`,
                    `📌 *${title}*`,
                    `⏰ Alert snoozed for 15 minutes!`,
                    `We will alert you again at *${snoozeStr}*. ✨`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("remind_done:")) {
        await answerCallback(env, callback.id, { text: "✅ Done!" });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰🔔 *REMINDER COMPLETED*`,
                    `━━━━━━━━━━━━━━━━━━━━`,
                    `✅ *Marked as done! Keep up the great work!* 🎉`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data === "remind_help") {
        await sendPromptAddReminder(env, chatId);
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

async function sendPromptAddReminder(env, chatId) {
    const text = [
        `⏰ *SET A NEW REMINDER*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `You can remind *whatever you want* with any time! Just type:`,
        ``,
        `1️⃣ *Exact Time:*`,
        `• \`remind 17:30 Bring lunch box home\``,
        `• \`remind 09:00 Team morning standup\``,
        `• \`remind 21:00 Review daily expenses\``,
        `• \`remind 8:30pm Water the plants\``,
        ``,
        `2️⃣ *Quick Timers (Minutes / Hours):*`,
        `• \`remind in 15m Check the oven\``,
        `• \`remind in 30m Take medicine\``,
        `• \`remind in 1h Call the client\``,
        ``,
        `Or choose a quick preset below:`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🍱 Lunchbox (17:30)", callback_data: "remind_add_lunchbox" },
                    { text: "💰 Spending Check (21:00)", callback_data: "toggle_expense_reminder" }
                ],
                [
                    { text: "⬅️ Back to Reminders", callback_data: "reminders" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function handleRemindCommand(env, chatId, userId, text) {
    const raw = text.replace(/^\/?(remindme|remind|alarm)\s*/i, "").trim();
    if (!raw || raw.toLowerCase() === "help") {
        await sendPromptAddReminder(env, chatId);
        return;
    }

    let timeStr = "";
    let title = "";
    let frequency = "daily";
    let isRelative = false;
    let mins = 0;

    // 1. Relative: e.g. "in 30m check oven", "30 mins call mom", "in 1h check server"
    const relMatch = raw.match(/^(?:in\s+)?(\d+)\s*(minutes|minute|mins|min|hours|hour|hrs|hr|m|h)\s*(.*)$/i);
    if (relMatch) {
        const num = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        title = relMatch[3].trim() || "Reminder";
        mins = unit.startsWith("h") ? num * 60 : num;
        const now = new Date();
        const target = new Date(now.getTime() + mins * 60 * 1000);
        timeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(target);
        frequency = "once";
        isRelative = true;
    }

    // 2. 12-hour AM/PM: e.g. "5pm bring lunch box", "5:30pm call mom", "9am standup"
    if (!timeStr) {
        const ampmMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(.*)$/i);
        if (ampmMatch) {
            let hour = parseInt(ampmMatch[1], 10);
            const minute = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
            const ampm = ampmMatch[3].toLowerCase();
            if (ampm === "pm" && hour < 12) hour += 12;
            if (ampm === "am" && hour === 12) hour = 0;
            timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
            title = ampmMatch[4].trim() || "Reminder";
            frequency = "daily";
        }
    }

    // 3. 24-hour format: e.g. "17:30 bring lunch box", "08:00 vitamins", "9:00 standup"
    if (!timeStr) {
        const standardMatch = raw.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])\s*(.*)$/i);
        if (standardMatch) {
            const hour = standardMatch[1].padStart(2, "0");
            const minute = standardMatch[2];
            timeStr = `${hour}:${minute}`;
            title = standardMatch[3].trim() || "Reminder";
            frequency = "daily";
        }
    }

    if (!timeStr) {
        await sendMessage(env, chatId, [
            `❌ *Could not understand the time.*`,
            `Please specify a time like \`17:30\`, \`5:30pm\`, or \`in 30m\`.`,
            ``,
            `Examples:`,
            `• \`remind 17:30 Bring lunch box\``,
            `• \`remind in 20m Check oven\``,
            `• \`remind 9am Team standup\``
        ].join("\n"), { parse_mode: "Markdown" });
        return;
    }

    const type = title.toLowerCase().includes("lunch") ? "lunchbox" : "custom";

    await ensureTables(env.DB);
    const insertResult = await env.DB.prepare(`
        INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(userId, String(chatId), title, timeStr, frequency, type).run();

    const newId = insertResult?.meta?.last_row_id;
    const freqLabel = frequency === "once" 
        ? (isRelative ? `in ${mins} mins` : "Once") 
        : frequency === "weekdays" ? "Mon–Fri" : "Daily";

    const isLunch = type === "lunchbox";
    const icon = isLunch ? "🍱" : "⏰";

    const textResponse = [
        `${icon} *REMINDER SET!*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📌 *Title:* *${title}*`,
        `⏰ *Time:* \`${timeStr}\` (${freqLabel}, Phnom Penh)`,
        `🔔 We will alert you on Telegram when it's time!`
    ].join("\n");

    const buttons = [
        [
            { text: "⏰ Reminders Hub", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];
    if (newId) {
        buttons.unshift([
            { text: "⏰ Adjust Time", callback_data: `remind_time_menu:${newId}` },
            { text: "🗑️ Delete", callback_data: `remind_del:${newId}` }
        ]);
    }

    await sendMessage(env, chatId, textResponse, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}

async function handleAddWorkLogCommand(env, chatId, userId, text, from) {
    await ensureTables(env.DB);
    const content = text.replace(/^\/\w+\s*/, "").trim();
    if (!content) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:* \`/done <task description>\`\n\n` +
            `Examples:\n` +
            `• \`/done Fixed checkout payment failure bug\`\n` +
            `• \`/done Completed API migration for auth service\`\n` +
            `• \`/done Sprint planning meeting with design team\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    let category = "General";
    let finalContent = content;

    const bracketMatch = content.match(/^\[(.*?)\]\s*(.*)$/);
    if (bracketMatch) {
        category = capitalize(bracketMatch[1].trim());
        finalContent = bracketMatch[2].trim() || content;
    } else {
        const lower = content.toLowerCase();
        if (lower.includes("fix") || lower.includes("bug") || lower.includes("issue") || lower.includes("resolve") || lower.includes("patch") || lower.includes("error")) {
            category = "Bugfix";
        } else if (lower.includes("meet") || lower.includes("sync") || lower.includes("call") || lower.includes("standup") || lower.includes("discuss") || lower.includes("1-on-1") || lower.includes("1:1")) {
            category = "Meeting";
        } else if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish") || lower.includes("ship")) {
            category = "Release";
        } else if (lower.includes("doc") || lower.includes("report") || lower.includes("write") || lower.includes("spec") || lower.includes("manual")) {
            category = "Documentation";
        } else if (lower.includes("test") || lower.includes("qa") || lower.includes("verify") || lower.includes("audit")) {
            category = "Testing";
        } else if (lower.includes("design") || lower.includes("ui") || lower.includes("ux") || lower.includes("figma") || lower.includes("mockup")) {
            category = "Design";
        } else if (lower.includes("code") || lower.includes("api") || lower.includes("feature") || lower.includes("develop") || lower.includes("implement") || lower.includes("refactor") || lower.includes("build") || lower.includes("service")) {
            category = "Development";
        }
    }

    const todayDate = today();
    const timeStr = currentTime();

    await env.DB.prepare(
        "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, todayDate, timeStr, finalContent, category).run();

    const monthStr = monthPrefix();
    const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();
    const monthCount = countRow?.count || 1;

    const icon = getWorkCategoryIcon(category);
    const message = [
        `✅ *Logged:* ${finalContent}`,
        `🏆 *${monthCount} tasks* this month (${icon} ${category})`
    ].join("\n");

    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📋 Today's Work", callback_data: "work_today" },
                    { text: "📊 Monthly Report", callback_data: "work_report_this" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function handleReportCommand(env, chatId, userId, text, from) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || "").toLowerCase();

    if (arg === "last" || arg === "prev" || arg === "previous") {
        await sendWorkReport(env, chatId, userId, "last_month", from);
        return;
    }

    if (arg === "week" || arg === "7d") {
        await sendWorkReport(env, chatId, userId, "this_week", from);
        return;
    }

    if (arg === "export" || arg === "file" || arg === "txt") {
        await sendWorkReportFile(env, chatId, userId, "this_month", from);
        return;
    }

    if (arg.match(/^\d{4}-\d{2}$/)) {
        await sendWorkReport(env, chatId, userId, arg, from);
        return;
    }

    await sendWorkReport(env, chatId, userId, "this_month", from);
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
// Personal Assistant Hub & Modular Workspace Renderers
// ---------------------------------------------------------------------------

async function sendMainHub(env, chatId, userId, from, origin) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");
    const monthStr = monthPrefix();

    const workRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();
    const workCount = workRow?.count || 0;

    const { results: allReminders } = await env.DB.prepare(
        "SELECT id, title, reminder_time, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();
    const remList = allReminders || [];
    const activeRems = remList.filter(r => r.is_active);
    let remStatus = "⚪ None active";
    if (activeRems.length > 0) {
        const first = activeRems[0];
        const shortTitle = first.title.length > 15 ? first.title.slice(0, 14) + "…" : first.title;
        remStatus = `🟢 \`${activeRems.length} active\` (${first.reminder_time} ${shortTitle})`;
    }

    const text = [
        `👋 *Hi ${cleanUsername}*`,
        ``,
        `💼 *Work:* \`${workCount} tasks\` logged this month`,
        `💰 *Money:* \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\` today • Balance: \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `⏰ *Reminders:* ${remStatus}`,
        ``,
        `_What would you like to do?_`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(cleanUsername)}`;

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💼 Work & Report", callback_data: "work_hub" },
                    { text: "💰 Money & Budget", callback_data: "finance_hub" }
                ],
                [
                    { text: "⏰ Reminders & Alarms", callback_data: "reminders" },
                    { text: "📱 Web Dashboard", web_app: { url: webAppUrl } }
                ],
                [
                    { text: "⚙️ Settings", callback_data: "settings" },
                    { text: "💡 Help & Guide", callback_data: "help" }
                ]
            ]
        }
    });
}

async function sendMainMenu(env, chatId, userId, from, origin) {
    return sendMainHub(env, chatId, userId, from, origin);
}

async function sendFinanceHub(env, chatId, userId) {
    await ensureTables(env.DB);
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const monthSummary = await getFinancialSummary(env.DB, userId, "month");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");

    const text = [
        `💰 *Finance & Cashflow*`,
        `• Balance: *${formatAmount(allSummary.balanceKhr, displayCurrency)}*`,
        `• Spent This Month: *${formatAmount(monthSummary.totalExpenseInKhr, displayCurrency)}*`,
        `• Spent Today: *${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}*`,
        ``,
        `💡 _Tip: Just type \`5 coffee\` or \`10000 lunch\` anytime!_`
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
                    { text: "📊 Summary", callback_data: "summary_today" }
                ],
                [
                    { text: "🎯 Budget", callback_data: "budget_help" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

// ---------------------------------------------------------------------------
// Work Journal & Manager Accomplishment Reports Workspace
// ---------------------------------------------------------------------------

async function sendWorkHub(env, chatId, userId, from) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";

    const todayDate = today();
    const monthStr = monthPrefix();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

    const monthRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();

    const monthCount = monthRow?.count || 0;
    const mLabel = monthLabel();

    const todayList = todayLogs.length > 0
        ? todayLogs.map((item, idx) => `• ${getWorkCategoryIcon(item.category)} *${item.content}* \`${item.time}\``).join("\n")
        : "_No tasks logged today yet._";

    const text = [
        `💼 *Work Journal*`,
        `*${monthCount} tasks* logged in ${mLabel} • *${todayLogs.length} today*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        todayList,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💡 _Type \`done <task>\` to log accomplishment._`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📊 Monthly Report", callback_data: "work_report_this" },
                    { text: "📄 Export .txt", callback_data: "work_export_this" }
                ],
                [
                    { text: "⏪ Last Month", callback_data: "work_report_last" },
                    { text: "🗑️ Delete Task", callback_data: "work_delete_menu" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function sendTodayWork(env, chatId, userId, from) {
    return sendWorkHub(env, chatId, userId, from);
}

async function sendWorkReport(env, chatId, userId, period = "this_month", from) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "You";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "You";

    let label = "";
    let isMonth = false;
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        isMonth = true;
        label = monthLabel();
        const prefix = monthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    } else if (period === "last_month") {
        isMonth = true;
        label = lastMonthLabel();
        const prefix = lastMonthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    } else if (period === "this_week") {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    } else if (period.match(/^\d{4}-\d{2}$/)) {
        isMonth = true;
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    } else {
        isMonth = true;
        label = monthLabel();
        const prefix = monthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        const text = [
            `📋 *MONTHLY WORK REPORT*`,
            `🗓️ *Period:* *${label}*`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `_No accomplishments logged for this period yet._`,
            ``,
            `💡 Whenever you complete a task, meeting, or bugfix, type:`,
            `\`/done <task description>\``,
            `Example: \`/done Completed API migration for auth service\``
        ].join("\n");

        await sendMessage(env, chatId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "➕ How to Log Work", callback_data: "work_log_prompt" },
                        { text: "⏪ Last Month's Report", callback_data: "work_report_last" }
                    ],
                    [
                        { text: "💼 Work Workspace", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    const activeDays = new Set(logs.map(r => r.date)).size;
    const catMap = {};
    for (const r of logs) {
        catMap[r.category] = (catMap[r.category] || 0) + 1;
    }
    const catBreakdown = Object.entries(catMap)
        .map(([cat, cnt]) => `${getWorkCategoryIcon(cat)} ${cat}: ${cnt}`)
        .join(" • ");

    const lines = [
        `📋 *MONTHLY WORK REPORT*`,
        `🗓️ *Period:* *${label}*`,
        `👤 *Report for:* ${cleanUsername}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🏆 *Summary:* *${logs.length} tasks completed* across *${activeDays} working days*`,
        `📊 *Focus:* ${catBreakdown}`,
        `━━━━━━━━━━━━━━━━━━━━`
    ];

    if (isMonth) {
        const weeks = [
            { name: "Week 1 (Days 01–07)", min: 1, max: 7, items: [] },
            { name: "Week 2 (Days 08–14)", min: 8, max: 14, items: [] },
            { name: "Week 3 (Days 15–21)", min: 15, max: 21, items: [] },
            { name: "Week 4+ (Days 22–End)", min: 22, max: 31, items: [] }
        ];

        for (const item of logs) {
            const dayNum = parseInt(item.date.slice(8, 10), 10) || 1;
            const w = weeks.find(wk => dayNum >= wk.min && dayNum <= wk.max) || weeks[3];
            w.items.push(item);
        }

        for (const w of weeks) {
            if (w.items.length === 0) continue;
            lines.push(`📅 *${w.name}:*`);
            for (const item of w.items) {
                const shortDate = item.date.slice(5);
                const icon = getWorkCategoryIcon(item.category);
                lines.push(`• \`${shortDate}\` ${icon} ${item.content}`);
            }
            lines.push(``);
        }
    } else {
        let currentDate = "";
        for (const item of logs) {
            if (item.date !== currentDate) {
                currentDate = item.date;
                lines.push(`📅 *${currentDate}:*`);
            }
            const icon = getWorkCategoryIcon(item.category);
            lines.push(`• \`${item.time}\` ${icon} ${item.content}`);
        }
        lines.push(``);
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`💡 _Ready for your monthly review or manager 1-on-1!_`);

    const fullMessage = lines.join("\n");
    const exportCb = period === "last_month" ? "work_export_last" : "work_export_this";
    const switchMonthText = period === "last_month" ? "⏩ This Month" : "⏪ Last Month";
    const switchMonthCb = period === "last_month" ? "work_report_this" : "work_report_last";

    if (fullMessage.length > 3800) {
        const preview = lines.slice(0, 30).join("\n") + "\n\n⚠️ _Report is extensive. Full report sent as file below..._";
        await sendMessage(env, chatId, preview, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📄 Export .txt", callback_data: exportCb },
                        { text: switchMonthText, callback_data: switchMonthCb }
                    ],
                    [
                        { text: "💼 Work Journal", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        await sendWorkReportFile(env, chatId, userId, period, from);
        return;
    }

    await sendMessage(env, chatId, fullMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📄 Export .txt", callback_data: exportCb },
                    { text: switchMonthText, callback_data: switchMonthCb }
                ],
                [
                    { text: "💼 Work Journal", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function sendWorkReportFile(env, chatId, userId, period = "this_month", from) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "User";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "User";

    let label = "";
    let isMonth = false;
    let query = "";
    let bindArgs = [];
    let fileSuffix = "";

    if (period === "this_month") {
        isMonth = true;
        label = monthLabel();
        fileSuffix = monthPrefix().replace("-", "_");
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        isMonth = true;
        label = lastMonthLabel();
        fileSuffix = lastMonthPrefix().replace("-", "_");
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        fileSuffix = "rolling_7d";
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        await sendMessage(env, chatId, `No tasks recorded for ${label} to export.`);
        return;
    }

    const activeDays = new Set(logs.map(r => r.date)).size;
    const catMap = {};
    for (const r of logs) {
        catMap[r.category] = (catMap[r.category] || 0) + 1;
    }
    const catSummary = Object.entries(catMap)
        .map(([cat, cnt]) => `${cat}: ${cnt}`)
        .join(" | ");

    let content = [
        "================================================================================",
        "                        MONTHLY ACCOMPLISHMENT REPORT",
        "================================================================================",
        `Period:          ${label}`,
        `Prepared By:     ${cleanUsername}`,
        `Generated At:    ${today()} ${currentTime()} (Phnom Penh)`,
        `Total Completed: ${logs.length} tasks`,
        `Active Days:     ${activeDays} days`,
        `Focus Breakdown: ${catSummary}`,
        "================================================================================",
        ""
    ];

    if (isMonth) {
        const weeks = [
            { name: "WEEK 1 (Days 01 - 07)", min: 1, max: 7, items: [] },
            { name: "WEEK 2 (Days 08 - 14)", min: 8, max: 14, items: [] },
            { name: "WEEK 3 (Days 15 - 21)", min: 15, max: 21, items: [] },
            { name: "WEEK 4+ (Days 22 - End)", min: 22, max: 31, items: [] }
        ];

        for (const item of logs) {
            const dayNum = parseInt(item.date.slice(8, 10), 10) || 1;
            const w = weeks.find(wk => dayNum >= wk.min && dayNum <= wk.max) || weeks[3];
            w.items.push(item);
        }

        for (const w of weeks) {
            if (w.items.length === 0) continue;
            content.push(`[${w.name}]`);
            for (const item of w.items) {
                content.push(`  • ${item.date} (${item.time}) [${item.category}] ${item.content}`);
            }
            content.push("");
        }
    } else {
        let currentDate = "";
        for (const item of logs) {
            if (item.date !== currentDate) {
                currentDate = item.date;
                content.push(`[${currentDate}]`);
            }
            content.push(`  • ${item.time} [${item.category}] ${item.content}`);
        }
        content.push("");
    }

    content.push("================================================================================");
    content.push("Generated by Personal Assistant Bot");
    content.push("================================================================================");

    const textFileStr = content.join("\n");
    const filename = `work_report_${fileSuffix}.txt`;

    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([textFileStr], filename, { type: "text/plain" });
    formData.append("document", file);
    formData.append("caption", `📄 Monthly Accomplishment Report (${label})\n${logs.length} tasks ready for your manager! 🚀`);

    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: formData,
    });

    if (!resp.ok) {
        const detail = await resp.text();
        console.error("sendDocument error:", detail);
        await sendMessage(env, chatId, "❌ Failed to upload report file. Please try viewing it in chat with /report.");
    }
}

async function sendWorkDeletePicker(env, chatId, userId) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, date, content, category FROM work_logs WHERE user_id = ? ORDER BY id DESC LIMIT 5"
    ).bind(userId).all();

    const logs = results || [];
    if (logs.length === 0) {
        await sendMessage(env, chatId, "No recent tasks found to delete.");
        return;
    }

    const buttons = logs.map(item => [
        {
            text: `🗑️ ${item.date}: ${item.content.slice(0, 30)}${item.content.length > 30 ? "..." : ""}`,
            callback_data: `work_del:${item.id}`
        }
    ]);

    buttons.push([
        { text: "⬅️ Back to Work Workspace", callback_data: "work_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await sendMessage(env, chatId, [
        `🗑️ *DELETE RECENT TASK*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Select an accomplishment below to remove from your log:`
    ].join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
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
    const freqLabel = freq === "weekdays" ? "Mon–Fri" : "Daily";

    const statusBadge = isActive ? "🟢 *Active*" : "⚪ *Off*";

    const text = [
        `🍱 *Lunchbox Departure Alarm*`,
        `• Status: ${statusBadge}`,
        `• Time: *${time}* (${freqLabel})`,
        ``,
        `_Alerts you before heading home so you never forget your lunchbox!_ 🥪`
    ].join("\n");

    const toggleText = isActive ? "🔴 Turn Alarm OFF" : "🟢 Turn Alarm ON";
    const toggleVal = isActive ? "0" : "1";
    const nextFreq = freq === "weekdays" ? "daily" : "weekdays";
    const nextFreqText = freq === "weekdays" ? "🔁 Switch to Daily" : "🔁 Switch to Mon–Fri";

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
                    { text: nextFreqText, callback_data: `lb_freq:${nextFreq}` },
                    { text: "🔔 Test Alarm", callback_data: "lb_test" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
    const activeCount = reminders.filter(r => r.is_active).length;

    let listText = "";
    if (reminders.length === 0) {
        listText = "_No reminders set yet._\nTap *[ ➕ Add Reminder ]* below or type:\n`remind 17:30 Bring lunch box`";
    } else {
        listText = reminders.map((r, idx) => {
            const status = r.is_active ? "🟢" : "⚪";
            const freq = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
            const icon = r.type === "lunchbox" ? "🍱" : r.type === "expense_log" ? "💰" : "⏰";
            return `${idx + 1}. ${status} ${icon} *${r.title}*\n    └ \`${r.reminder_time}\` (${freq})`;
        }).join("\n");
    }

    const text = [
        `⏰ *REMINDERS & ALARMS*`,
        `*${activeCount} active* of ${reminders.length} reminder(s)`,
        `━━━━━━━━━━━━━━━━━━━━`,
        listText,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💡 _Type \`remind <time> <task>\` or \`remind in 30m <task>\`_`
    ].join("\n");

    const buttons = [
        [
            { text: "➕ Add Reminder", callback_data: "remind_prompt_add" },
            { text: "🍱 Lunchbox Preset", callback_data: "remind_add_lunchbox" }
        ]
    ];

    for (const r of reminders.slice(0, 6)) {
        const toggleIcon = r.is_active ? "🟢" : "⚪";
        const shortTitle = r.title.length > 13 ? r.title.slice(0, 12) + "…" : r.title;
        buttons.push([
            { text: `${toggleIcon} ${shortTitle}`, callback_data: `remind_toggle:${r.id}` },
            { text: `⏰ ${r.reminder_time}`, callback_data: `remind_time_menu:${r.id}` },
            { text: "🗑️", callback_data: `remind_del:${r.id}` }
        ]);
    }

    buttons.push([
        { text: "🔔 Test Notification", callback_data: "remind_test_general" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

async function sendReminderTimeMenu(env, chatId, userId, reminderId) {
    await ensureTables(env.DB);
    const r = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, is_active FROM reminders WHERE id = ? AND user_id = ?"
    ).bind(reminderId, userId).first();

    if (!r) {
        await sendMessage(env, chatId, "⚠️ Reminder not found.");
        return sendRemindersMenu(env, chatId, userId);
    }

    const freqLabel = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
    const nextFreq = r.frequency === "weekdays" ? "daily" : r.frequency === "daily" ? "once" : "weekdays";
    const nextFreqLabel = nextFreq === "weekdays" ? "Mon–Fri" : nextFreq === "daily" ? "Daily" : "Once";

    const text = [
        `⏰ *SET TIME FOR REMINDER*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📌 *${r.title}*`,
        `• Current Time: *${r.reminder_time}* (${freqLabel})`,
        ``,
        `Choose a preset time below or type:`,
        `\`remind <time> ${r.title}\``
    ].join("\n");

    const buttons = [
        [
            { text: "⏰ 16:30", callback_data: `remind_set_time:${r.id}:16:30` },
            { text: "⏰ 17:00", callback_data: `remind_set_time:${r.id}:17:00` },
            { text: "⏰ 17:30", callback_data: `remind_set_time:${r.id}:17:30` },
            { text: "⏰ 18:00", callback_data: `remind_set_time:${r.id}:18:00` }
        ],
        [
            { text: "⏰ 08:30", callback_data: `remind_set_time:${r.id}:08:30` },
            { text: "⏰ 09:00", callback_data: `remind_set_time:${r.id}:09:00` },
            { text: "⏰ 12:00", callback_data: `remind_set_time:${r.id}:12:00` },
            { text: "⏰ 21:00", callback_data: `remind_set_time:${r.id}:21:00` }
        ],
        [
            { text: "⏱️ In 15m", callback_data: `remind_set_rel:${r.id}:15` },
            { text: "⏱️ In 30m", callback_data: `remind_set_rel:${r.id}:30` },
            { text: "⏱️ In 1h", callback_data: `remind_set_rel:${r.id}:60` }
        ],
        [
            { text: `🔁 Switch Schedule: ${nextFreqLabel}`, callback_data: `remind_freq:${r.id}:${nextFreq}` }
        ],
        [
            { text: "⬅️ Back to Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
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
        `⚙️ *SYSTEM SETTINGS*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🏳️ *Active Currency:* *${displayCurrency}*`,
        `🎯 *Monthly Budget:* *${budgetStr}*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Configure preferences or manage your transaction records:`
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
                [{ text: "🏠 Main Hub", callback_data: "hub" }]
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
    rows.push([
        { text: "⬅️ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

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
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    
    const todayTotalRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(amount_in_khr), 0) as total FROM expenses WHERE user_id = ? AND date = ? AND type = 'expense'"
    ).bind(userId, today()).first();
    const todaySpentKhr = todayTotalRow?.total || 0;
    const todaySpentStr = formatAmount(todaySpentKhr, displayCurrency);

    const warn = !isIncome ? await getBudgetWarningText(env.DB, userId) : "";

    const lines = [
        `${isIncome ? "🎉" : "💸"} *${icon} ${capitalize(category)}:* \`${mainAmt}\`${altAmt}`,
        `📅 Today's total spent: \`${todaySpentStr}\``
    ];
    if (warn) lines.push(warn);

    const addAnotherCb = isIncome ? "add_income" : "add_expense";
    const addAnotherText = isIncome ? "📥 Add More" : "➕ Add Another";

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: addAnotherText, callback_data: addAnotherCb },
                    { text: "📜 Today's Ledger", callback_data: "view_transactions" }
                ],
                [
                    { text: "💰 Finance Hub", callback_data: "finance_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
                    [
                        { text: "💰 Finance Hub", callback_data: "finance_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
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
                    { text: "💰 Finance Hub", callback_data: "finance_hub" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
                    { text: "💰 Finance Hub", callback_data: "finance_hub" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
                [
                    { text: "⬅️ Back to Finance", callback_data: "finance_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
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
                    [
                        { text: "⬅️ Back to Finance", callback_data: "finance_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
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
    inlineKeyboard.push([
        { text: "⬅️ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    return {
        text,
        replyMarkup: { inline_keyboard: inlineKeyboard }
    };
}

async function sendHelpMessage(env, chatId) {
    const text = [
        `💡 *PERSONAL ASSISTANT GUIDE*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `✨ *Effortless Natural Typing (No Commands Needed!)*`,
        `• Remind anything: \`remind 17:30 Bring lunch box\` or \`remind in 30m Check oven\``,
        `• Spend: \`5 coffee\` or \`10000 lunch\` or \`3.50 grab\``,
        `• Income: \`+500 salary\` or \`+50 bonus\``,
        `• Work log: \`done Fixed checkout bug\` or \`done Team sprint planning\``,
        `• Manager report: \`report\` or \`work\``,
        `• Today's spend: \`today\` or \`ledger\``,
        `• Open Hub: \`menu\` or \`hub\``,
        ``,
        `⏰ *General Reminders & Alarms*`,
        `• \`remind 17:30 <task>\` — Set daily reminder at exact 24h time`,
        `• \`remind 5:30pm <task>\` — Set reminder using AM/PM`,
        `• \`remind in 15m <task>\` — Quick one-time timer in minutes/hours`,
        `• /reminders — Open Reminders Workspace to toggle, change times, or delete`,
        ``,
        `💼 *Work Journal & Monthly Manager Reports*`,
        `• \`done <task>\` — Record an accomplishment instantly`,
        `• /report — Generate this month's manager report`,
        `• /report last — Generate last month's report`,
        `• /report export — Export report as downloadable .txt file`,
        `• /work — Open your Work Journal & today's tasks`,
        ``,
        `💰 *Cashflow & Finance*`,
        `• /add 5 usd coffee or /income 500 usd salary`,
        `• /today — Today's transactions list`,
        `• /summary — Spending stats & category breakdown`,
        `• /week — 7-day visual spending trend & chart`,
        `• /settings — Currency toggle & monthly budget`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💼 Work Journal", callback_data: "work_hub" },
                    { text: "💰 Money & Budget", callback_data: "finance_hub" }
                ],
                [
                    { text: "⏰ Reminders & Alarms", callback_data: "reminders" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
        `💼 *End of Day Habit:* Take 10 seconds to log what you accomplished today: \`/done <task>\` so your monthly manager report is always ready!`,
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
                ],
                [
                    { text: "💼 Log Work Done", callback_data: "work_log_prompt" },
                    { text: "📋 Today's Work", callback_data: "work_today" }
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
                    { text: "🏠 Main Hub", callback_data: "hub" }
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
        `⏰ Time: *${time}* (Phnom Penh)`
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

function currentTime() {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(new Date());
}

function lastMonthPrefix() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

function lastMonthLabel() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "long",
    }).format(d);
}

function getWorkCategoryIcon(category) {
    const cat = (category || "").toLowerCase();
    if (cat.includes("bug")) return "🐞";
    if (cat.includes("meet") || cat.includes("call") || cat.includes("sync") || cat.includes("standup")) return "👥";
    if (cat.includes("release") || cat.includes("deploy") || cat.includes("ship")) return "🚀";
    if (cat.includes("doc") || cat.includes("spec") || cat.includes("report") || cat.includes("manual")) return "📝";
    if (cat.includes("test") || cat.includes("qa") || cat.includes("audit")) return "🧪";
    if (cat.includes("design") || cat.includes("ui") || cat.includes("ux") || cat.includes("figma")) return "🎨";
    if (cat.includes("dev") || cat.includes("code") || cat.includes("api") || cat.includes("feature") || cat.includes("refactor")) return "💻";
    return "✅";
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
