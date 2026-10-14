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

                const activeReminder = await env.DB.prepare(
                    "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? AND is_active = 1 ORDER BY (CASE WHEN type = 'lunchbox' THEN 0 ELSE 1 END), id ASC LIMIT 1"
                ).bind(userId).first();

                return json({
                    summary,
                    categories,
                    daily,
                    recent: recentRows.results || [],
                    budgetKhr,
                    monthExpenseKhr,
                    activeReminder: activeReminder || null,
                    lunchboxReminder: activeReminder || null
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

            if (url.pathname === "/api/work") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                await ensureTables(env.DB);
                const curDate = today();
                const mPrefix = monthPrefix();
                const prevDate = getPreviousWorkdayDate();

                // Month count & active days
                const monthRows = await env.DB.prepare(
                    "SELECT date, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date DESC, id DESC"
                ).bind(userId, `${mPrefix}%`).all();
                const monthLogs = monthRows.results || [];
                const activeDays = new Set(monthLogs.map(r => r.date)).size;

                // Category counts
                const catCounts = {};
                for (const l of monthLogs) {
                    catCounts[l.category] = (catCounts[l.category] || 0) + 1;
                }

                // Today's logs
                const todayRows = await env.DB.prepare(
                    "SELECT id, date, time, content, category, created_at FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id DESC"
                ).bind(userId, curDate).all();

                // Previous workday logs
                let prevRows = await env.DB.prepare(
                    "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
                ).bind(userId, prevDate).all();

                let effectivePrevDate = prevDate;
                if (!prevRows.results || prevRows.results.length === 0) {
                    const fallbackRow = await env.DB.prepare(
                        "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
                    ).bind(userId, curDate).first();
                    if (fallbackRow?.date) {
                        effectivePrevDate = fallbackRow.date;
                        prevRows = await env.DB.prepare(
                            "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
                        ).bind(userId, effectivePrevDate).all();
                    }
                }

                // Recent logs
                const recentRows = await env.DB.prepare(
                    "SELECT id, date, time, content, category, created_at FROM work_logs WHERE user_id = ? ORDER BY date DESC, time DESC, id DESC LIMIT 50"
                ).bind(userId).all();

                return json({
                    stats: {
                        monthCount: monthLogs.length,
                        todayCount: (todayRows.results || []).length,
                        activeDays,
                        monthLabel: monthLabel(),
                        currentDate: curDate,
                        previousDate: effectivePrevDate
                    },
                    categories: catCounts,
                    today: todayRows.results || [],
                    previous: prevRows.results || [],
                    recent: recentRows.results || []
                });
            }

            if (url.pathname === "/api/reminders") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                await ensureTables(env.DB);
                const { results } = await env.DB.prepare(
                    "SELECT id, chat_id, title, reminder_time, frequency, type, is_active, last_sent_date FROM reminders WHERE user_id = ? ORDER BY reminder_time ASC, id ASC"
                ).bind(userId).all();

                return json({
                    reminders: results || []
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

            if (url.pathname === "/api/work/add") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id" }, 400);
                }
                const body = await request.json().catch(() => ({}));
                const content = (body.content || "").trim();
                let category = (body.category || "General").trim();

                if (!content) {
                    return json({ error: "Content is required" }, 400);
                }

                const bracketMatch = content.match(/^\[(.*?)\]\s*(.*)$/);
                let finalContent = content;
                if (bracketMatch) {
                    category = capitalize(bracketMatch[1].trim());
                    finalContent = bracketMatch[2].trim() || content;
                }

                await ensureTables(env.DB);
                const curDate = today();
                const curTime = currentTime();

                const result = await env.DB.prepare(
                    "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
                ).bind(userId, curDate, curTime, finalContent, category).run();

                return json({
                    ok: true,
                    task: {
                        id: result.meta?.last_row_id,
                        date: curDate,
                        time: curTime,
                        content: finalContent,
                        category
                    }
                });
            }

            if (url.pathname === "/api/work/delete") {
                const userId = url.searchParams.get("user_id");
                const taskId = url.searchParams.get("id");
                if (!userId || !taskId) {
                    return json({ error: "Missing parameters" }, 400);
                }

                await ensureTables(env.DB);
                const result = await env.DB.prepare("DELETE FROM work_logs WHERE user_id = ? AND id = ?")
                    .bind(userId, taskId)
                    .run();

                return json({ ok: true, changes: result.meta?.changes || 0 });
            }

            if (url.pathname === "/api/reminders/toggle") {
                const userId = url.searchParams.get("user_id");
                const reminderId = url.searchParams.get("id");
                if (!userId || !reminderId) {
                    return json({ error: "Missing parameters" }, 400);
                }

                await ensureTables(env.DB);
                const r = await env.DB.prepare(
                    "SELECT is_active FROM reminders WHERE user_id = ? AND id = ?"
                ).bind(userId, reminderId).first();

                if (!r) {
                    return json({ error: "Reminder not found" }, 404);
                }

                const newActive = r.is_active ? 0 : 1;
                await env.DB.prepare(
                    "UPDATE reminders SET is_active = ? WHERE user_id = ? AND id = ?"
                ).bind(newActive, userId, reminderId).run();

                return json({ ok: true, is_active: newActive });
            }

            if (url.pathname === "/api/reminders/add") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id" }, 400);
                }
                const body = await request.json().catch(() => ({}));
                const title = (body.title || "").trim();
                const reminderTime = (body.reminder_time || "").trim();
                const frequency = body.frequency || "weekdays";
                const type = body.type || (title.toLowerCase().includes("standup") ? "standup" : title.toLowerCase().includes("lunch") ? "lunchbox" : "custom");

                if (!title || !reminderTime) {
                    return json({ error: "Title and reminder_time are required" }, 400);
                }

                await ensureTables(env.DB);
                const chatId = body.chat_id || userId;

                const result = await env.DB.prepare(
                    "INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)"
                ).bind(userId, String(chatId), title, reminderTime, frequency, type).run();

                return json({
                    ok: true,
                    reminder: {
                        id: result.meta?.last_row_id,
                        title,
                        reminder_time: reminderTime,
                        frequency,
                        type,
                        is_active: 1
                    }
                });
            }

            if (url.pathname === "/api/reminders/delete") {
                const userId = url.searchParams.get("user_id");
                const reminderId = url.searchParams.get("id");
                if (!userId || !reminderId) {
                    return json({ error: "Missing parameters" }, 400);
                }

                await ensureTables(env.DB);
                const result = await env.DB.prepare("DELETE FROM reminders WHERE user_id = ? AND id = ?")
                    .bind(userId, reminderId)
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

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL,
                amount REAL NOT NULL CHECK (amount > 0),
                category TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'expense',
                currency TEXT NOT NULL DEFAULT 'KHR',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables expenses error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id TEXT PRIMARY KEY,
                display_currency TEXT NOT NULL DEFAULT 'KHR',
                monthly_budget REAL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables user_settings error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS processed_updates (
                update_id INTEGER PRIMARY KEY,
                processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables processed_updates error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS pending_scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL DEFAULT 'USD',
                category TEXT NOT NULL DEFAULT 'Other',
                type TEXT NOT NULL DEFAULT 'expense',
                merchant TEXT,
                bank TEXT,
                note TEXT,
                date TEXT,
                message_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables pending_scans error:", e);
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

    // 0. Smart Bank Slip & Receipt Scanner (Photo or Image Document)
    if (message.photo || (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/"))) {
        await handleImageReceipt(message, env, origin);
        return;
    }

    if (text === "/scan" || text === "/receipt" || text === "/ocr" || text === "/slip") {
        await sendScanHelp(env, chatId);
        return;
    }

    // 0.5. 🤖 AI Financial & Work Copilot
    if (
        text.startsWith("/ask") || 
        text.startsWith("/ai") || 
        text.startsWith("/copilot") ||
        text === "/ask" ||
        text === "/ai" ||
        text === "/copilot"
    ) {
        const query = text.replace(/^\/(ask|ai|copilot)(@\w+)?\s*/i, "").trim();
        await handleAiCopilotQuery(env, chatId, userId, query, message.from);
        return;
    }

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

    if (text === "/standup" || text.startsWith("/standup ") || text === "/su" || text.startsWith("/su ")) {
        const parts = text.split(/\s+/);
        const sub = (parts[1] || "").toLowerCase();
        if (sub === "polish" || sub === "ai") {
            await handleAiPolishStandup(env, chatId, userId, message.from);
        } else if (sub === "copy") {
            await sendStandupCopyBlock(env, chatId, userId, message.from);
        } else {
            await sendStandupReport(env, chatId, userId, message.from);
        }
        return;
    }

    if (text === "/polish") {
        await handleAiPolishWorkReport(env, chatId, userId, "this_month", message.from);
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
        await sendMessage(env, chatId, `💰 Total all-time expenses: \`${formatAmount(total, displayCurrency)}\``, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "💰 Finance Hub", callback_data: "finance_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
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

        if (lower === "standup" || lower === "scrum" || lower === "daily sync" || lower === "sync") {
            await sendStandupReport(env, chatId, userId, message.from);
            return;
        }

        if (lower === "report") {
            await sendWorkReport(env, chatId, userId, "this_month", message.from);
            return;
        }

        if (lower === "polish" || lower === "polish report") {
            await handleAiPolishWorkReport(env, chatId, userId, "this_month", message.from);
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

        if (lower === "scan" || lower === "receipt" || lower === "slip" || lower === "ocr") {
            await sendScanHelp(env, chatId);
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

        // 6. Natural Language AI Copilot fallback (or friendly guidance if AI not configured)
        if (env.GEMINI_API_KEY || env.AI) {
            await handleAiCopilotQuery(env, chatId, userId, text, message.from);
            return;
        }

        // Friendly guidance if casual text doesn't match and no AI is configured
        await sendMessage(
            env,
            chatId,
            `💡 *Quick Shortcuts:*\n` +
            `• Ask AI: \`/ask <question>\` or type your question\n` +
            `• Scan slip: Send any ABA/Bakong/KHQR payment screenshot!\n` +
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
    const messageId = callback.message?.message_id;

    await answerCallback(env, callback.id);

    if (!chatId) return;

    // --- Main Hub, Finance Hub & Settings ---
    if (data === "menu" || data === "hub") {
        await sendMainHub(env, chatId, userId, callback.from, origin, messageId);
        return;
    }

    if (data === "finance_hub") {
        await sendFinanceHub(env, chatId, userId, messageId);
        return;
    }

    // --- Work Log & Reports Callbacks ---
    if (data === "work_hub") {
        await sendWorkHub(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_today") {
        await sendTodayWork(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_week") {
        await sendWorkReport(env, chatId, userId, "this_week", callback.from, messageId);
        return;
    }

    if (data === "work_report_this") {
        await sendWorkReport(env, chatId, userId, "this_month", callback.from, messageId);
        return;
    }

    if (data === "work_report_last") {
        await sendWorkReport(env, chatId, userId, "last_month", callback.from, messageId);
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
        await sendWorkDeletePicker(env, chatId, userId, messageId);
        return;
    }

    if (data === "work_standup") {
        await sendStandupReport(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_standup_copy") {
        await sendStandupCopyBlock(env, chatId, userId, callback.from, callback.id);
        return;
    }

    if (data === "work_standup_polish") {
        await handleAiPolishStandup(env, chatId, userId, callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_this") {
        await handleAiPolishWorkReport(env, chatId, userId, "this_month", callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_last") {
        await handleAiPolishWorkReport(env, chatId, userId, "last_month", callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_export_this") {
        await handleAiPolishWorkReportExport(env, chatId, userId, "this_month", callback.from, callback.id);
        return;
    }

    if (data === "work_report_polish_export_last") {
        await handleAiPolishWorkReportExport(env, chatId, userId, "last_month", callback.from, callback.id);
        return;
    }

    if (data.startsWith("work_del:")) {
        const id = parseInt(data.slice(9), 10);
        await env.DB.prepare("DELETE FROM work_logs WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Task deleted." });
        await sendWorkHub(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_log_prompt") {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚡ *How to Log Work Tasks*\n` +
            `────────────────────\n` +
            `Whenever you finish a task, meeting, or bugfix, type:\n` +
            `• \`/done Fixed customer checkout payment failure\`\n` +
            `• \`/done Prepared Q3 API migration roadmap\`\n` +
            `• \`/done Weekly team sprint planning meeting\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\`\n\n` +
            `_At month's end, type \`/report\` or tap **This Month's Report** to generate your manager accomplishment report!_`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Work Log", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    if (data === "copilot_help") {
        await handleAiCopilotQuery(env, chatId, userId, "", callback.from, messageId);
        return;
    }

    if (data === "help") {
        await sendHelpMessage(env, chatId, messageId);
        return;
    }

    if (data === "settings") {
        await sendSettingsMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "toggle_currency") {
        const currentCurrency = await getDisplayCurrency(env.DB, userId);
        const newCurrency = currentCurrency === "USD" ? "KHR" : "USD";
        await setDisplayCurrency(env.DB, userId, newCurrency);
        const flag = newCurrency === "USD" ? "🇺🇸" : "🇰🇭";
        await answerCallback(env, callback.id, { text: `${flag} Display switched to ${newCurrency}!` });
        await sendSettingsMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "budget_help") {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `🎯 *Monthly Budget Setting*\n` +
            `────────────────────\n` +
            `Use the command:\n` +
            `• \`/budget 300 usd\` (Sets limit to $300)\n` +
            `• \`/budget 1200000 khr\` (Sets limit in Riel)\n` +
            `• \`/budget 0\` (Disables budget tracking)\n\n` +
            `_You will receive progress alerts whenever you log an expense!_`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Settings", callback_data: "settings" }]
                    ]
                }
            }
        );
        return;
    }

    // --- Adding Transactions ---
    if (data === "add_expense") {
        await sendCategoryPicker(env, chatId, "expense", messageId);
        return;
    }

    if (data === "add_income") {
        await sendCategoryPicker(env, chatId, "income", messageId);
        return;
    }

    if (data.startsWith("cat_exp:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "expense", userId, messageId);
        return;
    }

    if (data.startsWith("cat_inc:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "income", userId, messageId);
        return;
    }

    if (data.startsWith("quick_exp:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "expense", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "expense", amount, displayCurrency, category, messageId);
        return;
    }

    if (data.startsWith("quick_inc:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "income", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "income", amount, displayCurrency, category, messageId);
        return;
    }

    if (data === "custom_add") {
        await safeEditOrSendMessage(env, chatId, messageId, "✏️ *Custom Expense:*\nType: `/add 5 usd lunch` or `/add 15000 food`", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Categories", callback_data: "add_expense" }]
                ]
            }
        });
        return;
    }

    if (data === "custom_inc") {
        await safeEditOrSendMessage(env, chatId, messageId, "✏️ *Custom Income:*\nType: `/income 500 usd salary` or `/income 200000 freelance`", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Categories", callback_data: "add_income" }]
                ]
            }
        });
        return;
    }

    // --- Lunch Box Alarm Callbacks ---
    if (data === "lunchbox") {
        await sendLunchboxMenu(env, chatId, userId, messageId);
        return;
    }



    if (data.startsWith("lb_ack")) {
        await answerCallback(env, callback.id, { text: "Safe travels home!" });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `🎒 *Departure Reminder*`,
                    `────────────────────`,
                    `✅ *Lunch box packed and ready.*`,
                    `_Have a wonderful evening and safe trip home!_`
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

        await answerCallback(env, callback.id, { text: `⏰ Snoozed 15 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Snoozed*`,
                    `────────────────────`,
                    `Snoozed for 15 minutes.`,
                    `We will remind you again at \`${snoozeStr}\`.`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("su_snooze")) {
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 30 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, 'Morning Standup (Snoozed)', ?, 'once', 'standup', 1)
        `).bind(userId, String(chatId), snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Standup snoozed 30 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Standup Snoozed*`,
                    `────────────────────`,
                    `Snoozed for 30 minutes.`,
                    `We will remind you again at \`${snoozeStr}\`.`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    // --- General Reminders Callbacks ---
    if (data === "reminders") {
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "remind_prompt_add") {
        await sendPromptAddReminder(env, chatId, messageId);
        return;
    }

    if (data === "remind_add_standup") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'standup' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?")
                .bind(String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Morning Standup Sync', '09:00', 'weekdays', 'standup', 1)
            `).bind(userId, String(chatId)).run();
        }

        await answerCallback(env, callback.id, { text: "🗣️ Morning Standup alarm enabled (09:00 Mon–Fri)!" });
        await sendRemindersMenu(env, chatId, userId, messageId);
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

        await answerCallback(env, callback.id, { text: "🎒 Departure preset enabled (17:30 Mon–Fri)!" });
        await sendRemindersMenu(env, chatId, userId, messageId);
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
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_time_menu:")) {
        const id = parseInt(data.slice(17), 10);
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
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
        await sendRemindersMenu(env, chatId, userId, messageId);
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
        await sendRemindersMenu(env, chatId, userId, messageId);
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
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
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
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_del:")) {
        const id = parseInt(data.slice(11), 10);
        await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Reminder deleted." });
        await sendRemindersMenu(env, chatId, userId, messageId);
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

        await answerCallback(env, callback.id, { text: `⏰ Snoozed 15 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Snoozed*`,
                    `────────────────────`,
                    `📌 *${title}*`,
                    `Alert snoozed for 15 minutes.`,
                    `We will alert you again at \`${snoozeStr}\`.`
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
                    `⏰ *Reminder Completed*`,
                    `────────────────────`,
                    `✅ *Marked as done!*`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data === "remind_help") {
        await sendPromptAddReminder(env, chatId, messageId);
        return;
    }

    // --- Ledger & Summaries Callbacks ---
    if (data === "view_transactions") {
        await sendTransactions(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("history:")) {
        const page = parseInt(data.slice(8), 10) || 1;
        await updateHistoryMessage(env, chatId, userId, callback.message.message_id, page);
        return;
    }

    if (data === "summary_today") {
        await sendSummary(env, chatId, userId, "today", messageId);
        return;
    }

    if (data === "summary_month") {
        await sendSummary(env, chatId, userId, "month", messageId);
        return;
    }

    // --- Clear Data Callbacks ---
    if (data === "clear_data") {
        await askClearConfirmation(env, chatId, messageId);
        return;
    }

    if (data === "clear_today_warn") {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Are you sure you want to clear today's expenses? This action cannot be undone.", {
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
            await safeEditOrSendMessage(env, chatId, messageId, "You don't have any recorded transactions to delete.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🏠 Main Hub", callback_data: "hub" }]
                    ]
                }
            });
            return;
        }

        const warningMsg = [
            `⚠️ *Database Reset Warning*`,
            `────────────────────`,
            `This action will permanently delete all transaction records for your account.`,
            ``,
            `● *Transactions:* \`${count}\``,
            `● *Total Volume:* \`${formatMoney(total)} ៛\` (~$${formatMoney(total / EXCHANGE_RATE)})`,
            ``,
            `🔒 *Backup Safety:*`,
            `A CSV backup file will be auto-generated and sent to this chat before deletion.`,
            ``,
            `_Do you wish to proceed?_`
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, warningMsg, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⚠️ Yes, Backup & Wipe All", callback_data: "confirm_clear_all" }],
                    [{ text: "✕ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "confirm_clear" || data === "confirm_clear_today") {
        await clearToday(env.DB, userId);
        await answerCallback(env, callback.id, { text: "✅ Today's expenses cleared!" });
        await sendMainMenu(env, chatId, userId, callback.from, origin, messageId);
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
        await safeEditOrSendMessage(env, chatId, messageId, "Clear cancelled. Your data remains safe.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏠 Main Hub", callback_data: "hub" }]
                ]
            }
        });
        return;
    }

    // --- Bank Slip / Receipt Scanner Callbacks ---
    if (data === "scan_prompt") {
        await sendScanHelp(env, chatId, messageId);
        return;
    }

    if (data.startsWith("scan_ok:")) {
        const scanId = parseInt(data.slice(8), 10);
        await handleScanConfirm(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_cat:")) {
        const scanId = parseInt(data.slice(9), 10);
        await sendScanCategoryPicker(env, chatId, scanId, callback.message?.message_id);
        return;
    }

    if (data.startsWith("scan_set_cat:")) {
        const parts = data.split(":");
        const scanId = parseInt(parts[1], 10);
        const newCat = parts[2];
        await handleScanSetCategory(env, chatId, userId, scanId, newCat, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_type:")) {
        const scanId = parseInt(data.slice(10), 10);
        await handleScanToggleType(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_view:")) {
        const scanId = parseInt(data.slice(10), 10);
        await renderPendingScanCard(env, chatId, scanId, callback.message?.message_id);
        return;
    }

    if (data.startsWith("scan_del:")) {
        const scanId = parseInt(data.slice(9), 10);
        await handleScanDiscard(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }
}

// ---------------------------------------------------------------------------
// Smart Bank Slip & Receipt Scanner (AI OCR)
// ---------------------------------------------------------------------------

function cleanMd(text) {
    if (!text) return "";
    return String(text).replace(/[_*`[\]]/g, " ").trim();
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function parseExtractedJson(text) {
    if (!text) return null;
    try {
        let cleaned = text.trim();
        const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
            cleaned = match[1].trim();
        } else {
            const start = cleaned.indexOf("{");
            const end = cleaned.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                cleaned = cleaned.substring(start, end + 1);
            }
        }
        const parsed = JSON.parse(cleaned);
        if (parsed.is_slip === false) {
            return { is_slip: false };
        }

        let amount = null;
        let currency = (parsed.currency || "").toUpperCase();

        if (typeof parsed.amount === "number" && parsed.amount > 0) {
            amount = parsed.amount;
        } else if (parsed.amount) {
            const strAmt = String(parsed.amount);
            if (strAmt.includes("$")) currency = "USD";
            else if (strAmt.includes("៛") || strAmt.toUpperCase().includes("KHR") || strAmt.toUpperCase().includes("RIEL")) currency = "KHR";
            const cleanAmt = strAmt.replace(/[^0-9.]/g, "");
            const num = parseFloat(cleanAmt);
            if (!isNaN(num) && num > 0) {
                amount = num;
            }
        }

        if (!amount) return null;

        if (currency !== "USD" && currency !== "KHR") {
            currency = amount >= 500 ? "KHR" : "USD";
        }

        return {
            is_slip: true,
            type: parsed.type === "income" ? "income" : "expense",
            amount,
            currency,
            merchant: cleanMd(parsed.merchant || ""),
            bank: cleanMd(parsed.bank || "Bank Transfer"),
            category: normalizeCategory(parsed.category || "Other"),
            note: cleanMd(parsed.note || ""),
            date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null
        };
    } catch (e) {
        console.error("parseExtractedJson error:", e.message);
        return null;
    }
}

async function parseReceiptWithGemini(env, base64Data, mimeType = "image/jpeg", caption = "") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const candidateModels = [
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-2.5-flash"
    ];

    const prompt = `You are an expert OCR financial receipt and bank slip analyzer for Cambodia and international transactions.
Examine this image carefully. Common types include:
- ABA Bank mobile payment / KHQR transfer slip
- Bakong KHQR transfer or payment slip
- Acleda ToanChet, Wing, TrueMoney, Canadia Bank, Prince Bank, Chip Mong Bank
- Store, cafe, restaurant, or supermarket receipts (e.g., Brown Coffee, Starbucks, Tube Coffee, Amazon Cafe, Lucky, Chip Mong, Aeon, Makro, KOI The)
- Invoices or utility bills (EDC, water, internet)

Extract the financial data and output ONLY valid JSON matching this schema:
{
  "is_slip": boolean (true if image is a payment slip, bank transfer, invoice, or receipt; false if unrelated photo),
  "amount": number (positive numeric value paid or transferred, e.g. 4.50 or 18000. No currency symbol in amount),
  "currency": "USD" or "KHR" (detect whether US Dollars $ or Cambodian Riel ៛/KHR),
  "merchant": string (the recipient name, business name, or merchant, e.g. "Brown Coffee", "Grab", "PassApp", "Sokha Heng"),
  "bank": string (bank or source, e.g. "ABA Bank", "Bakong KHQR", "Acleda", "Wing", "Store Receipt"),
  "category": string (best category: "Food", "Coffee", "Transport", "Taxi", "Shopping", "Bills", "Rent", or "Other"),
  "type": "expense" or "income" (default "expense" for payments/transfers sent; "income" only if money was received/transferred to user),
  "note": string (short description, e.g. item purchased, transfer remark, or reference number),
  "date": string (YYYY-MM-DD if date is visible, or null)
}
${caption ? `User caption note: "${caption}"` : ""}
Return ONLY pure JSON.`;

    const requestBody = JSON.stringify({
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`Gemini OCR model ${model} failed (${response.status}):`, errText);
                continue;
            }

            const resJson = await response.json();
            const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
            if (rawText) {
                const parsed = parseExtractedJson(rawText);
                if (parsed) return parsed;
            }
        } catch (e) {
            console.warn(`Gemini OCR fetch error for ${model}:`, e.message);
        }
    }

    return null;
}

async function parseReceiptWithWorkersAI(env, base64Data, mimeType = "image/jpeg", caption = "") {
    if (!env.AI) return null;

    const prompt = `You are a financial receipt and bank slip analyzer. Examine this image (ABA Bank, Bakong, KHQR, Acleda, Wing, or restaurant receipt).
Extract transaction details into JSON:
{
  "is_slip": true,
  "amount": 3.50,
  "currency": "USD",
  "merchant": "merchant or recipient name",
  "bank": "ABA Bank or bank name",
  "category": "Coffee",
  "type": "expense",
  "note": "short note or remark",
  "date": "YYYY-MM-DD or null"
}
If this image is not a payment slip or receipt, set "is_slip": false.
${caption ? `User caption note: "${caption}"` : ""}
Output valid JSON only without explanations.`;

    try {
        const imageUri = `data:${mimeType};base64,${base64Data}`;
        const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image", image: imageUri }
                    ]
                }
            ],
            max_tokens: 512,
            temperature: 0.1
        });

        const outputText = response?.response || response?.description || (typeof response === "string" ? response : JSON.stringify(response));
        return parseExtractedJson(outputText);
    } catch (err) {
        console.error("Workers AI vision error:", err);
        return null;
    }
}

async function parseReceiptImage(env, base64Data, mimeType = "image/jpeg", caption = "") {
    if (!env.GEMINI_API_KEY && !env.AI) {
        throw new Error(
            "AI OCR is not configured.\n\n" +
            "To enable receipt & KHQR bank slip scanning, set your free Google Gemini API key:\n" +
            "`npx wrangler secret put GEMINI_API_KEY`\n" +
            "(Get a free key at https://aistudio.google.com)"
        );
    }

    if (env.GEMINI_API_KEY) {
        try {
            const geminiResult = await parseReceiptWithGemini(env, base64Data, mimeType, caption);
            if (geminiResult && geminiResult.amount) {
                return geminiResult;
            }
        } catch (e) {
            console.warn("Gemini vision error, trying Workers AI:", e.message);
        }
    }

    if (env.AI) {
        try {
            const aiResult = await parseReceiptWithWorkersAI(env, base64Data, mimeType, caption);
            if (aiResult && aiResult.amount) {
                return aiResult;
            }
        } catch (e) {
            console.warn("Workers AI vision error:", e.message);
        }
    }

    return null;
}

// ===========================================================================
// 🤖 AI Financial & Work Copilot (Conversational Q&A & Assistant)
// ===========================================================================

async function buildAiUserContext(db, userId) {
    const curDate = today();
    const curTime = currentTime();
    const displayCurrency = await getDisplayCurrency(db, userId);

    const [
        todaySummary,
        monthSummary,
        allSummary,
        settingsRow,
        monthCats,
        todayCats,
        recentExpenses,
        todayTasks,
        recentTasks,
        activeReminders
    ] = await Promise.all([
        getFinancialSummary(db, userId, "today"),
        getFinancialSummary(db, userId, "month"),
        getFinancialSummary(db, userId, "all"),
        db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(userId).first(),
        getCategoryRows(db, userId, "month", 10),
        getCategoryRows(db, userId, "today", 6),
        db.prepare(
            "SELECT date, amount, currency, category, type FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 25"
        ).bind(userId).all(),
        db.prepare(
            "SELECT time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY time ASC, id ASC"
        ).bind(userId, curDate).all(),
        db.prepare(
            "SELECT date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 20"
        ).bind(userId).all(),
        db.prepare(
            "SELECT title, reminder_time, frequency, type FROM reminders WHERE user_id = ? AND is_active = 1 ORDER BY reminder_time ASC"
        ).bind(userId).all()
    ]);

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const spentMonthKhr = monthSummary?.totalExpenseInKhr || 0;
    const remainingBudgetKhr = budgetKhr > 0 ? (budgetKhr - spentMonthKhr) : null;

    return {
        currentDate: curDate,
        currentTime: curTime,
        timezone: TIME_ZONE,
        displayCurrency,
        budget: budgetKhr > 0 ? {
            limitUsd: Number((budgetKhr / EXCHANGE_RATE).toFixed(2)),
            limitKhr: budgetKhr,
            spentUsd: Number((spentMonthKhr / EXCHANGE_RATE).toFixed(2)),
            spentKhr: spentMonthKhr,
            remainingUsd: Number(((budgetKhr - spentMonthKhr) / EXCHANGE_RATE).toFixed(2)),
            remainingKhr: remainingBudgetKhr,
            percentUsed: Math.round((spentMonthKhr / budgetKhr) * 100)
        } : null,
        totals: {
            allTimeNetBalanceUsd: Number(((allSummary?.balanceKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            allTimeNetBalanceKhr: allSummary?.balanceKhr || 0,
            thisMonthExpenseUsd: Number(((monthSummary?.totalExpenseInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            thisMonthExpenseKhr: monthSummary?.totalExpenseInKhr || 0,
            thisMonthIncomeUsd: Number(((monthSummary?.totalIncomeInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            thisMonthIncomeKhr: monthSummary?.totalIncomeInKhr || 0,
            todayExpenseUsd: Number(((todaySummary?.totalExpenseInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            todayExpenseKhr: todaySummary?.totalExpenseInKhr || 0,
            todayIncomeUsd: Number(((todaySummary?.totalIncomeInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            todayIncomeKhr: todaySummary?.totalIncomeInKhr || 0
        },
        topMonthCategories: (monthCats || []).map(c => ({
            category: c.category,
            totalUsd: Number((c.total / EXCHANGE_RATE).toFixed(2)),
            totalKhr: c.total,
            count: c.count
        })),
        recentTransactions: (recentExpenses?.results || []).map(r => ({
            date: r.date,
            type: r.type,
            amount: r.amount,
            currency: r.currency,
            category: r.category
        })),
        todayWorkTasks: (todayTasks?.results || []).map(t => ({
            time: t.time,
            category: t.category,
            task: t.content
        })),
        recentWorkTasks: (recentTasks?.results || []).map(t => ({
            date: t.date,
            time: t.time,
            category: t.category,
            task: t.content
        })),
        activeReminders: (activeReminders?.results || []).map(r => ({
            title: r.title,
            time: r.reminder_time,
            frequency: r.frequency
        }))
    };
}

function buildCopilotPrompt(userQuery, context) {
    return `You are the intelligent AI Personal Financial & Work Copilot for a Telegram assistant bot in Cambodia.
Exchange rate: 1 USD = 4,000 KHR.
Today's Date: ${context.currentDate}, Time: ${context.currentTime} (${context.timezone}).
Preferred Display Currency: ${context.displayCurrency}.

=== USER LIVE FINANCIAL & WORK DATA ===
${JSON.stringify(context, null, 2)}
=======================================

User message: "${userQuery}"

Instructions:
1. Provide a direct, helpful, and natural response formatted for Telegram (use markdown: *bold*, \`code\`, bullet points, emojis).
2. Use the live data above accurately. Mention amounts in both USD ($) and Cambodian Riel (៛) when helpful. Do NOT invent numbers that contradict the data.
3. If the user asks for their daily standup or to summarize accomplishments, synthesize recent and today's tasks into a crisp 3-part update (Yesterday, Today, Blockers), and recommend /standup or /report polish.
4. If the user asks in Khmer (អក្សរខ្មែរ), reply fluently in Khmer. If in English, reply in English.
5. If the user explicitly asks to record an expense, log work, or set a reminder that is NOT already recorded, return an "action" object. Otherwise, set "action" to null.
6. You MUST return ONLY valid JSON matching this schema:
{
  "reply": "Conversational markdown message to the user.",
  "action": null | {
    "type": "add_expense" | "add_income" | "add_work" | "add_reminder",
    "amount": number (for expense/income),
    "currency": "USD" | "KHR" (for expense/income),
    "category": string (for expense/income/work),
    "date": "YYYY-MM-DD" (optional, for expense/income),
    "content": string (for work task),
    "title": string (for reminder),
    "time": "HH:mm" (24h format, for reminder),
    "frequency": "daily" | "weekdays" | "once" (for reminder)
  }
}
Return pure JSON only.`;
}

function parseCopilotResponse(rawText) {
    if (!rawText) return null;
    let clean = rawText.trim();
    if (clean.startsWith("```json")) {
        clean = clean.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    try {
        const obj = JSON.parse(clean);
        if (obj && typeof obj.reply === "string") {
            return {
                reply: obj.reply,
                action: obj.action || null
            };
        }
    } catch (e) {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                const subObj = JSON.parse(clean.substring(start, end + 1));
                if (subObj && typeof subObj.reply === "string") {
                    return {
                        reply: subObj.reply,
                        action: subObj.action || null
                    };
                }
            } catch (e2) {}
        }
    }

    if (clean && clean.length > 3) {
        return {
            reply: clean,
            action: null
        };
    }

    return null;
}

async function askAiCopilot(env, userQuery, context) {
    const prompt = buildCopilotPrompt(userQuery, context);

    if (env.GEMINI_API_KEY) {
        const candidateModels = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-1.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.8-flash",
            "gemini-flash-latest"
        ];

        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [{ text: prompt }]
                }
            ],
            generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.2
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini Copilot model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
                if (rawText) {
                    const parsed = parseCopilotResponse(rawText);
                    if (parsed) return parsed;
                }
            } catch (err) {
                console.warn(`Gemini Copilot error with ${model}:`, err.message);
            }
        }
    }

    if (env.AI) {
        try {
            const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are a personal financial and productivity copilot. Return valid JSON only with 'reply' and 'action'."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                max_tokens: 1024,
                temperature: 0.2
            });

            const outputText = aiResp?.response || (typeof aiResp === "string" ? aiResp : JSON.stringify(aiResp));
            const parsed = parseCopilotResponse(outputText);
            if (parsed) return parsed;
        } catch (aiErr) {
            console.error("Workers AI Copilot error:", aiErr);
        }
    }

    return null;
}

async function callAiTextModel(env, systemPrompt, userPrompt, temperature = 0.3) {
    const candidateModels = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gemini-flash-latest"
    ];

    if (env.GEMINI_API_KEY) {
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [{ text: fullPrompt }]
                }
            ],
            generationConfig: {
                temperature
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini text model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
                if (rawText && rawText.trim()) {
                    return rawText.trim();
                }
            } catch (err) {
                console.warn(`Gemini text error with ${model}:`, err.message);
            }
        }
    }

    if (env.AI) {
        try {
            const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                    { role: "user", content: userPrompt }
                ],
                max_tokens: 1500,
                temperature
            });

            const outputText = aiResp?.response || (typeof aiResp === "string" ? aiResp : JSON.stringify(aiResp));
            if (outputText && outputText.trim()) {
                return outputText.trim();
            }
        } catch (aiErr) {
            console.error("Workers AI text model error:", aiErr);
        }
    }

    return null;
}

async function handleAiCopilotQuery(env, chatId, userId, query, from, messageId = null) {
    await ensureTables(env.DB);
    const cleanQuery = (query || "").trim();

    if (!cleanQuery) {
        const text = [
            `✨ *AI Copilot*`,
            `────────────────────`,
            `Real-time intelligence for your cashflow ledger, work journal, budget, and reminders.`,
            ``,
            `💡 *Example questions:*`,
            `• *"How much did I spend this week?"*`,
            `• *"What's my biggest expense category this month?"*`,
            `• *"Can I afford a $50 dinner based on my budget?"*`,
            `• *"What tasks did I finish today?"*`,
            `• *"Summarize my work achievements this week"*`,
            `• *"What active reminders do I have?"*`,
            `• *"ថ្ងៃនេះខ្ញុំចាយអស់ប៉ុន្មាន?"* _(Khmer supported!)_`,
            ``,
            `_Type your question directly, or use \`/ask <question>\`_`
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📊 Summary", callback_data: "summary_today" },
                        { text: "⚡ Work Tasks", callback_data: "work_today" }
                    ],
                    [
                        { text: "💳 Finance", callback_data: "finance_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    if (!env.GEMINI_API_KEY && !env.AI) {
        await sendMessage(
            env,
            chatId,
            `⚠️ *AI Copilot is not configured.*\n\n` +
            `To enable conversational AI features, set your free Google Gemini API key:\n` +
            `\`npx wrangler secret put GEMINI_API_KEY\`\n` +
            `(Get a free key at https://aistudio.google.com)`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const context = await buildAiUserContext(env.DB, userId);
    const result = await askAiCopilot(env, cleanQuery, context);

    if (!result || !result.reply) {
        await sendMessage(
            env,
            chatId,
            `⚠️ *AI Copilot was unable to answer right now.*\n\n` +
            `Here are quick shortcuts:\n` +
            `• \`/today\` — View today's transactions\n` +
            `• \`/summary\` — Spending summary\n` +
            `• \`/week\` — 7-day spending report\n` +
            `• \`/work\` — Work journal\n` +
            `• \`/hub\` — Main Hub`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    // Process action if any
    if (result.action && typeof result.action === "object") {
        try {
            const act = result.action;
            if (act.type === "add_expense" && act.amount && act.amount > 0) {
                const cat = act.category || "Other";
                const curr = (act.currency || context.displayCurrency || "USD").toUpperCase();
                const recordDate = (act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date)) ? act.date : today();
                await addExpenseRecord(env.DB, userId, act.amount, cat, "expense", curr, recordDate);
            } else if (act.type === "add_income" && act.amount && act.amount > 0) {
                const cat = act.category || "Income";
                const curr = (act.currency || context.displayCurrency || "USD").toUpperCase();
                const recordDate = (act.date && /^\d{4}-\d{2}-\d{2}$/.test(act.date)) ? act.date : today();
                await addExpenseRecord(env.DB, userId, act.amount, cat, "income", curr, recordDate);
            } else if (act.type === "add_work" && act.content) {
                const curTime = currentTime();
                const curDate = today();
                const cat = act.category || "General";
                await env.DB.prepare(
                    "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
                ).bind(userId, curDate, curTime, act.content.trim(), cat).run();
            } else if (act.type === "add_reminder" && act.time && act.title) {
                const cleanTime = act.time.trim();
                const cleanTitle = act.title.trim();
                const freq = act.frequency || "weekdays";
                await env.DB.prepare(
                    "INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active) VALUES (?, ?, ?, ?, ?, 'custom', 1)"
                ).bind(userId, String(chatId), cleanTitle, cleanTime, freq).run();
            }
        } catch (actErr) {
            console.error("Failed to execute AI Copilot action:", actErr);
        }
    }

    await sendMessage(env, chatId, result.reply, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🏠 Main Hub", callback_data: "hub" },
                    { text: "💰 Finance Hub", callback_data: "finance_hub" },
                    { text: "💼 Work Hub", callback_data: "work_hub" }
                ]
            ]
        }
    });
}

function formatPendingScanText(scan) {
    const isIncome = scan.type === "income";
    const sign = isIncome ? "+" : "-";
    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const mainAmt = `${sign}${symbol}${formatMoney(scan.amount)}${suffix}`;

    let altAmt = "";
    if (scan.currency === "USD") {
        altAmt = ` (~${formatMoney(scan.amount * EXCHANGE_RATE)} ៛)`;
    } else {
        altAmt = ` (~$${formatMoney(scan.amount / EXCHANGE_RATE)})`;
    }

    const icon = getCategoryIcon(scan.category, scan.type);
    const bankName = scan.bank || "Bank Transfer";
    const merchant = scan.merchant ? scan.merchant : "Merchant / Store";
    const note = scan.note ? `\n📝 *Note:* ${cleanMd(scan.note)}` : "";
    const date = scan.date || today();

    return [
        `🧾 *Slip / Receipt Detected*`,
        `────────────────────`,
        `● *Bank:*     ${cleanMd(bankName)}`,
        `● *${isIncome ? "Payer" : "Merchant"}:*  ${cleanMd(merchant)}`,
        `● *Amount:*   \`${mainAmt}\`${altAmt}`,
        `● *Category:* ${icon} *${capitalize(scan.category)}*`,
        `● *Date:*     \`${date}\`${note}`,
        `────────────────────`,
        `_Tap below to confirm and record:_`
    ].join("\n");
}

function getPendingScanKeyboard(scan) {
    const isIncome = scan.type === "income";
    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const amtStr = `${symbol}${formatMoney(scan.amount)}${suffix}`;

    return {
        inline_keyboard: [
            [
                {
                    text: `✓ Confirm (${amtStr})`,
                    callback_data: `scan_ok:${scan.id}`
                }
            ],
            [
                {
                    text: `🏷️ ${getCategoryIcon(scan.category, scan.type)} ${capitalize(scan.category)}`,
                    callback_data: `scan_cat:${scan.id}`
                },
                {
                    text: isIncome ? "⇄ To Expense" : "⇄ To Income",
                    callback_data: `scan_type:${scan.id}`
                }
            ],
            [
                {
                    text: "✕ Discard",
                    callback_data: `scan_del:${scan.id}`
                }
            ]
        ]
    };
}

async function safeEditOrSendMessage(env, chatId, messageId, text, extra = {}) {
    if (messageId) {
        try {
            return await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                ...extra
            });
        } catch (err) {
            console.warn("editMessageText failed with error:", err.message);
            if (extra.parse_mode) {
                try {
                    const { parse_mode, ...fallbackExtra } = extra;
                    const cleanText = text.replace(/[*`_]/g, "");
                    return await telegram(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: cleanText,
                        ...fallbackExtra
                    });
                } catch (err2) {
                    console.warn("editMessageText plain fallback failed:", err2.message);
                }
            }
        }
    }

    return await sendMessage(env, chatId, text, extra);
}

async function renderPendingScanCard(env, chatId, scanOrId, messageId) {
    let scan = null;
    if (scanOrId && typeof scanOrId === "object") {
        scan = scanOrId;
    } else {
        const idToFind = scanOrId || 0;
        if (idToFind) {
            scan = await env.DB.prepare(
                "SELECT * FROM pending_scans WHERE id = ?"
            ).bind(idToFind).first();
        }
        if (!scan) {
            scan = await env.DB.prepare(
                "SELECT * FROM pending_scans WHERE chat_id = ? ORDER BY id DESC LIMIT 1"
            ).bind(String(chatId)).first();
        }
    }

    if (!scan) {
        console.error("renderPendingScanCard: No pending scan found for chat", chatId);
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Could not display receipt details. Please try sending the image again.");
        return;
    }

    const text = formatPendingScanText(scan);
    const markup = getPendingScanKeyboard(scan);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: markup
    });
}

async function sendScanHelp(env, chatId, messageId = null) {
    const text = [
        `📸 *Receipt & Slip Scanner*`,
        `────────────────────`,
        `Simply send or forward any payment screenshot or receipt photo directly into this chat!`,
        ``,
        `✅ *Supported Slips & Receipts:*`,
        `• 🏦 *ABA Mobile* (KHQR transfers & merchant payments)`,
        `• 🇰🇭 *Bakong* (KHQR payments & transfers)`,
        `• 💳 *Acleda ToanChet, Wing, TrueMoney, Canadia*`,
        `• 🧾 *Store & Cafe Receipts* (Brown Coffee, Starbucks, Supermarkets)`,
        ``,
        `💡 *How it works:*`,
        `1. Send your bank slip screenshot`,
        `2. AI automatically detects the amount, merchant, and category`,
        `3. Tap *[✓ Confirm]* to record it to your ledger!`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function handleScanConfirm(env, chatId, userId, scanId, messageId, callbackId) {
    await ensureTables(env.DB);
    const scan = await env.DB.prepare(
        "SELECT * FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).first();

    if (!scan) {
        if (callbackId) await answerCallback(env, callbackId, { text: "⚠️ Scan not found or already processed." });
        if (messageId) {
            try {
                await telegram(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: "⚠️ *This scan was already processed or has expired.*",
                    parse_mode: "Markdown"
                });
            } catch (e) {}
        }
        return;
    }

    await addExpenseRecord(
        env.DB,
        userId,
        scan.amount,
        scan.category,
        scan.type,
        scan.currency,
        scan.date
    );

    await env.DB.prepare("DELETE FROM pending_scans WHERE id = ?").bind(scanId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: "✅ Slip recorded to cashflow!" });

    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const amtStr = `${symbol}${formatMoney(scan.amount)}${suffix}`;
    const icon = getCategoryIcon(scan.category, scan.type);

    if (messageId) {
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: [
                    `✅ *Receipt Recorded*`,
                    `────────────────────`,
                    `● *Amount:*   \`${amtStr}\``,
                    `● *Category:* ${icon} *${capitalize(scan.category)}*`,
                    `● *Source:*   ${cleanMd(scan.bank || "Bank Transfer")}`,
                    scan.merchant ? `● *Merchant:* *${cleanMd(scan.merchant)}*` : "",
                    `● *Date:*     \`${scan.date || today()}\``,
                    `────────────────────`,
                    `_Saved to your ledger._`
                ].filter(Boolean).join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }

    await sendTransactionReceipt(
        env,
        chatId,
        userId,
        scan.type,
        scan.amount,
        scan.currency,
        scan.category
    );
}

async function sendScanCategoryPicker(env, chatId, scanId, messageId) {
    const scan = await env.DB.prepare(
        "SELECT * FROM pending_scans WHERE id = ?"
    ).bind(scanId).first();

    if (!scan) return;

    const rows = [];
    for (let i = 0; i < QUICK_EXPENSE_CATS.length; i += 2) {
        const row = [
            {
                text: `${QUICK_EXPENSE_CATS[i].icon} ${QUICK_EXPENSE_CATS[i].name}`,
                callback_data: `scan_set_cat:${scanId}:${QUICK_EXPENSE_CATS[i].name}`
            }
        ];
        if (i + 1 < QUICK_EXPENSE_CATS.length) {
            row.push({
                text: `${QUICK_EXPENSE_CATS[i + 1].icon} ${QUICK_EXPENSE_CATS[i + 1].name}`,
                callback_data: `scan_set_cat:${scanId}:${QUICK_EXPENSE_CATS[i + 1].name}`
            });
        }
        rows.push(row);
    }
    rows.push([
        { text: "⬅️ Back to Slip", callback_data: `scan_view:${scanId}` }
    ]);

    await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `🏷️ *Select Category for this Slip:*\nCurrent: *${getCategoryIcon(scan.category, scan.type)} ${capitalize(scan.category)}*`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

async function handleScanSetCategory(env, chatId, userId, scanId, newCat, messageId, callbackId) {
    await env.DB.prepare(
        "UPDATE pending_scans SET category = ? WHERE id = ? AND user_id = ?"
    ).bind(normalizeCategory(newCat), scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: `Category set to ${newCat}!` });
    await renderPendingScanCard(env, chatId, scanId, messageId);
}

async function handleScanToggleType(env, chatId, userId, scanId, messageId, callbackId) {
    const scan = await env.DB.prepare(
        "SELECT type FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).first();

    if (!scan) return;
    const newType = scan.type === "income" ? "expense" : "income";
    await env.DB.prepare(
        "UPDATE pending_scans SET type = ? WHERE id = ? AND user_id = ?"
    ).bind(newType, scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: `Switched to ${newType === "income" ? "Income" : "Expense"}!` });
    await renderPendingScanCard(env, chatId, scanId, messageId);
}

async function handleScanDiscard(env, chatId, userId, scanId, messageId, callbackId) {
    await env.DB.prepare(
        "DELETE FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: "🗑️ Scan discarded." });
    if (messageId) {
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: "🗑️ *Bank slip scan discarded.*",
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }
}

async function handleImageReceipt(message, env, origin) {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const caption = (message.caption || "").trim();

    await ensureTables(env.DB);

    let fileId = null;
    let mimeType = "image/jpeg";
    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
        fileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/")) {
        fileId = message.document.file_id;
        mimeType = message.document.mime_type;
    }

    if (!fileId) return;

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    let statusMsg = null;
    try {
        statusMsg = await sendMessage(
            env,
            chatId,
            `🔍 *Scanning bank slip / receipt...*\n_Reading transaction details with AI OCR..._`,
            { parse_mode: "Markdown" }
        );
    } catch (e) {}
    const statusMsgId = statusMsg?.result?.message_id;

    try {
        const fileInfo = await telegram(env, "getFile", { file_id: fileId });
        const filePath = fileInfo.result?.file_path;
        if (!filePath) {
            throw new Error("Could not retrieve file path from Telegram.");
        }

        if (filePath.endsWith(".png")) mimeType = "image/png";
        else if (filePath.endsWith(".webp")) mimeType = "image/webp";

        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const imgResponse = await fetch(fileUrl);
        if (!imgResponse.ok) {
            throw new Error("Failed to download image file from Telegram.");
        }

        const arrayBuffer = await imgResponse.arrayBuffer();
        const base64Data = arrayBufferToBase64(arrayBuffer);

        const parsed = await parseReceiptImage(env, base64Data, mimeType, caption);

        if (!parsed || !parsed.amount || parsed.amount <= 0) {
            const notFoundText = [
                `⚠️ *Amount Not Detected*`,
                `────────────────────`,
                `We couldn't clearly identify an amount or bank slip in this image.`,
                ``,
                `💡 *Tips for best results:*`,
                `• Send a clear screenshot of your ABA Bank, Bakong, or KHQR transfer slip.`,
                `• For restaurant/store receipts, ensure the total amount is visible.`,
                `• Or type directly: \`5 coffee\` or \`/add 5 usd lunch\``
            ].join("\n");

            await safeEditOrSendMessage(env, chatId, statusMsgId, notFoundText, { parse_mode: "Markdown" });
            return;
        }

        const insertResult = await env.DB.prepare(`
            INSERT INTO pending_scans (user_id, chat_id, amount, currency, category, type, merchant, bank, note, date, message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            userId,
            String(chatId),
            parsed.amount,
            parsed.currency,
            parsed.category,
            parsed.type,
            parsed.merchant || null,
            parsed.bank || null,
            parsed.note || null,
            parsed.date || today(),
            statusMsgId || null
        ).run();

        const scanId = insertResult.meta?.last_row_id || 
            (await env.DB.prepare("SELECT id FROM pending_scans WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first())?.id;

        const scanObj = {
            id: scanId,
            user_id: userId,
            chat_id: String(chatId),
            amount: parsed.amount,
            currency: parsed.currency,
            category: parsed.category,
            type: parsed.type,
            merchant: parsed.merchant || null,
            bank: parsed.bank || null,
            note: parsed.note || null,
            date: parsed.date || today()
        };

        await renderPendingScanCard(env, chatId, scanObj, statusMsgId);

    } catch (err) {
        console.error("Receipt scan error:", err);
        const errMsg = [
            `⚠️ *Scan processing error:* ${cleanMd(err.message)}`,
            ``,
            `💡 You can still log manually: \`5 coffee\` or \`/add 5 usd lunch\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, statusMsgId, errMsg, { parse_mode: "Markdown" });
    }
}

// ---------------------------------------------------------------------------
// Commands Handlers
// ---------------------------------------------------------------------------

async function handleLunchboxCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length === 1) {
        await sendRemindersMenu(env, chatId, userId);
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
                VALUES (?, ?, 'Departure / Lunchbox Reminder', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }
        await sendMessage(env, chatId, "🟢 *Departure alarm enabled for 17:30 (Mon–Fri)!*", { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (arg === "off") {
        await ensureTables(env.DB);
        await env.DB.prepare("UPDATE reminders SET is_active = 0 WHERE user_id = ? AND type = 'lunchbox'").bind(userId).run();
        await sendMessage(env, chatId, "🔴 *Departure alarm disabled.*", { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
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
                VALUES (?, ?, 'Departure / Lunchbox Reminder', ?, 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId), formattedTime).run();
        }
        await sendMessage(env, chatId, `⏰ *Departure reminder time set to ${formattedTime} (Active)!*`, { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    await sendRemindersMenu(env, chatId, userId);
}

async function sendPromptAddReminder(env, chatId, messageId = null) {
    const text = [
        `⏰ *New Reminder*`,
        `────────────────────`,
        `You can remind *anything at any time*! Type naturally:`,
        ``,
        `1️⃣ *Exact Time:*`,
        `• \`remind 17:30 Bring lunch box / bag home\``,
        `• \`remind 09:00 Team morning standup\``,
        `• \`remind 21:00 Review daily expenses\``,
        `• \`remind 8:30pm Water the plants\``,
        ``,
        `2️⃣ *Quick Timers (Minutes / Hours):*`,
        `• \`remind in 15m Check the oven\``,
        `• \`remind in 30m Take medicine\``,
        `• \`remind in 1h Call the client\``,
        ``,
        `_Or choose a preset below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ 09:00 Standup Preset", callback_data: "remind_add_standup" },
                    { text: "🎒 17:30 Departure", callback_data: "remind_add_lunchbox" }
                ],
                [
                    { text: "💳 Spending Check (21:00)", callback_data: "toggle_expense_reminder" },
                    { text: "‹ Back", callback_data: "reminders" }
                ],
                [
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
        `${icon} *Reminder Set*`,
        `────────────────────`,
        `● *Title:* *${title}*`,
        `● *Time:*  \`${timeStr}\` (${freqLabel})`,
        `────────────────────`,
        `_You will be alerted on Telegram when it's time._`
    ].join("\n");

    const buttons = [
        [
            { text: "⏰ Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];
    if (newId) {
        buttons.unshift([
            { text: "⏰ Adjust Time", callback_data: `remind_time_menu:${newId}` },
            { text: "✕ Delete", callback_data: `remind_del:${newId}` }
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
        if (lower.includes("fix") || lower.includes("bug") || lower.includes("issue") || lower.includes("resolve") || lower.includes("patch") || lower.includes("error") || lower.includes("#bug")) {
            category = "Bugfix";
        } else if (lower.includes("meet") || lower.includes("sync") || lower.includes("call") || lower.includes("standup") || lower.includes("discuss") || lower.includes("1-on-1") || lower.includes("1:1")) {
            category = "Meeting";
        } else if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish") || lower.includes("ship") || lower.includes("#release")) {
            category = "Release";
        } else if (lower.includes("doc") || lower.includes("report") || lower.includes("write") || lower.includes("spec") || lower.includes("manual")) {
            category = "Documentation";
        } else if (lower.includes("test") || lower.includes("qa") || lower.includes("verify") || lower.includes("audit")) {
            category = "Testing";
        } else if (lower.includes("design") || lower.includes("ui") || lower.includes("ux") || lower.includes("figma") || lower.includes("mockup")) {
            category = "Design";
        } else if (lower.includes("code") || lower.includes("api") || lower.includes("feature") || lower.includes("develop") || lower.includes("implement") || lower.includes("refactor") || lower.includes("build") || lower.includes("service") || lower.includes("#dev")) {
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
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish", callback_data: "work_report_polish_this" }
                ],
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

    if (arg === "polish" || arg === "ai") {
        const subArg = (parts[2] || "").toLowerCase();
        const targetPeriod = (subArg === "last" || subArg === "prev" || subArg === "previous") ? "last_month" : (subArg === "week" || subArg === "7d") ? "this_week" : "this_month";
        await handleAiPolishWorkReport(env, chatId, userId, targetPeriod, from);
        return;
    }

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

async function sendMainHub(env, chatId, userId, from, origin, messageId = null) {
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
    let remStatus = "○ None";
    if (activeRems.length > 0) {
        const first = activeRems[0];
        const shortTitle = first.title.length > 14 ? first.title.slice(0, 13) + "…" : first.title;
        remStatus = `● ${activeRems.length} active (${first.reminder_time} ${shortTitle})`;
    }

    const text = [
        `*Personal Assistant Hub*`,
        `────────────────────`,
        `● *Balance:*   \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `● *Today:*     \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\``,
        `● *Work:*      \`${workCount} tasks\` in ${monthLabel()}`,
        `● *Alerts:*    \`${remStatus}\``,
        `────────────────────`,
        `_Select a workspace below or type naturally:_`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(cleanUsername)}`;

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "＋ Expense", callback_data: "add_expense" },
                    { text: "＋ Income", callback_data: "add_income" }
                ],
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "⚡ Work Log", callback_data: "work_hub" }
                ],
                [
                    { text: "✨ AI Copilot", callback_data: "copilot_help" },
                    { text: "⏰ Reminders", callback_data: "reminders" }
                ],
                [
                    { text: "🌐 Dashboard", web_app: { url: webAppUrl } },
                    { text: "⚙️ Settings", callback_data: "settings" }
                ],
                [
                    { text: "💡 Guide & Shortcuts", callback_data: "help" }
                ]
            ]
        }
    });
}

async function sendMainMenu(env, chatId, userId, from, origin, messageId = null) {
    return sendMainHub(env, chatId, userId, from, origin, messageId);
}

async function sendFinanceHub(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const monthSummary = await getFinancialSummary(env.DB, userId, "month");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");

    const text = [
        `💳 *Finance & Cashflow*`,
        `────────────────────`,
        `● *Net Balance:*   \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `● *This Month:*    \`${formatAmount(monthSummary.totalExpenseInKhr, displayCurrency)}\``,
        `● *Spent Today:*   \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\``,
        `────────────────────`,
        `_Tip: Send an ABA / KHQR slip screenshot or type \`5 coffee\`_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📸 Scan Slip", callback_data: "scan_prompt" },
                    { text: "＋ Expense", callback_data: "add_expense" },
                    { text: "＋ Income", callback_data: "add_income" }
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

async function sendWorkHub(env, chatId, userId, from, messageId = null) {
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
        ? todayLogs.map((item) => `• \`${item.time}\` *${item.content}*`).join("\n")
        : "_No tasks logged today yet._";

    const text = [
        `⚡ *Work Journal*`,
        `────────────────────`,
        `● *This Month:*  \`${monthCount} tasks\` in ${mLabel}`,
        `● *Today:*       \`${todayLogs.length} logged\``,
        `────────────────────`,
        `*Today's Activity:*`,
        todayList,
        `────────────────────`,
        `_Log anytime with: \`done <task description>\`_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish Report", callback_data: "work_report_polish_this" }
                ],
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

async function sendTodayWork(env, chatId, userId, from, messageId = null) {
    return sendWorkHub(env, chatId, userId, from, messageId);
}

async function sendWorkReport(env, chatId, userId, period = "this_month", from, messageId = null) {
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
            `📋 *Monthly Work Report*`,
            `🗓️ *Period:* \`${label}\``,
            `────────────────────`,
            `_No accomplishments logged for this period yet._`,
            ``,
            `💡 *How to log work:*`,
            `\`/done <task description>\``,
            `_Example:_ \`/done Completed API migration for auth service\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "＋ How to Log", callback_data: "work_log_prompt" },
                        { text: "⏪ Last Month", callback_data: "work_report_last" }
                    ],
                    [
                        { text: "⚡ Work Log", callback_data: "work_hub" },
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
        `📋 *Monthly Work Report*`,
        `────────────────────`,
        `● *Period:*  \`${label}\``,
        `● *User:*    ${cleanUsername}`,
        `● *Summary:* \`${logs.length} tasks\` across \`${activeDays} days\``,
        `● *Focus:*   ${catBreakdown}`,
        `────────────────────`
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

    lines.push(`────────────────────`);
    lines.push(`_Ready for your monthly review or manager 1-on-1._`);

    const fullMessage = lines.join("\n");
    const exportCb = period === "last_month" ? "work_export_last" : "work_export_this";
    const switchMonthText = period === "last_month" ? "⏩ This Month" : "⏪ Last Month";
    const switchMonthCb = period === "last_month" ? "work_report_this" : "work_report_last";
    const polishCb = period === "last_month" ? "work_report_polish_last" : "work_report_polish_this";

    if (fullMessage.length > 3800) {
        const preview = lines.slice(0, 30).join("\n") + "\n\n⚠️ _Report is extensive. Full report sent as file below..._";
        await sendMessage(env, chatId, preview, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✨ AI Polish", callback_data: polishCb },
                        { text: "📄 Export .txt", callback_data: exportCb }
                    ],
                    [
                        { text: switchMonthText, callback_data: switchMonthCb },
                        { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                    ],
                    [
                        { text: "⚡ Work Log", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        await sendWorkReportFile(env, chatId, userId, period, from);
        return;
    }

    await safeEditOrSendMessage(env, chatId, messageId, fullMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✨ AI Polish", callback_data: polishCb },
                    { text: "📄 Export .txt", callback_data: exportCb }
                ],
                [
                    { text: switchMonthText, callback_data: switchMonthCb },
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Log", callback_data: "work_hub" },
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

async function sendWorkDeletePicker(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, date, content, category FROM work_logs WHERE user_id = ? ORDER BY id DESC LIMIT 5"
    ).bind(userId).all();

    const logs = results || [];
    if (logs.length === 0) {
        await safeEditOrSendMessage(env, chatId, messageId, "No recent tasks found to delete.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "‹ Back to Work Log", callback_data: "work_hub" }],
                    [{ text: "🏠 Main Hub", callback_data: "hub" }]
                ]
            }
        });
        return;
    }

    const buttons = logs.map(item => [
        {
            text: `✕ ${item.date}: ${item.content.slice(0, 30)}${item.content.length > 30 ? "..." : ""}`,
            callback_data: `work_del:${item.id}`
        }
    ]);

    buttons.push([
        { text: "‹ Back to Work Log", callback_data: "work_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, [
        `🗑️ *Delete Recent Task*`,
        `────────────────────`,
        `_Select an accomplishment below to remove:_`
    ].join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}

// ---------------------------------------------------------------------------
// Daily Standup & AI Report Polish Engine
// ---------------------------------------------------------------------------

async function sendStandupReport(env, chatId, userId, from, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    const todayDate = today();
    const now = new Date();
    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "long"
    }).format(now);

    const prevWorkday = getPreviousWorkdayDate();

    // Fetch today's tasks
    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

    // Fetch previous workday's tasks (or latest prior available session)
    let prevLogs = [];
    let effectivePrevDate = prevWorkday;

    const directPrevRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, prevWorkday).all();

    if (directPrevRows.results && directPrevRows.results.length > 0) {
        prevLogs = directPrevRows.results;
    } else {
        const priorRow = await env.DB.prepare(
            "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
        ).bind(userId, todayDate).first();
        if (priorRow?.date) {
            effectivePrevDate = priorRow.date;
            const fallbackRows = await env.DB.prepare(
                "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
            ).bind(userId, effectivePrevDate).all();
            prevLogs = fallbackRows.results || [];
        }
    }

    const prevList = prevLogs.length > 0
        ? prevLogs.map(item => `• \`${item.time}\` ${getWorkCategoryIcon(item.category)} ${item.content}`).join("\n")
        : "_No tasks recorded for previous session._";

    const todayList = todayLogs.length > 0
        ? todayLogs.map(item => `• \`${item.time}\` ${getWorkCategoryIcon(item.category)} ${item.content}`).join("\n")
        : "_No tasks logged today yet. Type:_ \`done <task>\`";

    const text = [
        `🗣️ *Daily Standup*`,
        `────────────────────`,
        `● *Engineer:*   ${cleanUsername}`,
        `● *Date:*       \`${todayDate}\` (${weekdayStr})`,
        `────────────────────`,
        `⏮️ *Previous Focus (${effectivePrevDate}):*`,
        prevList,
        ``,
        `🎯 *Today's Focus:*`,
        todayList,
        ``,
        `🚧 *Blockers:*`,
        `• _None reported (all on track)_`,
        `────────────────────`,
        `_Ready for your daily team sync!_`
    ].join("\n");

    const buttons = [
        [
            { text: "📋 Copy Block", callback_data: "work_standup_copy" },
            { text: "✨ AI Polish Standup", callback_data: "work_standup_polish" }
        ],
        [
            { text: "＋ Log Today's Task", callback_data: "work_log_prompt" },
            { text: "⏰ Standup Alarm", callback_data: "remind_add_standup" }
        ],
        [
            { text: "⚡ Work Journal", callback_data: "work_hub" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

async function sendStandupCopyBlock(env, chatId, userId, from, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "📋 1-tap copy block generated!" });
    }

    const rawUsername = from?.first_name || from?.username || "Team Member";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Team Member";
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

    let prevLogs = [];
    let effectivePrevDate = prevWorkday;
    const directPrevRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, prevWorkday).all();
    if (directPrevRows.results && directPrevRows.results.length > 0) {
        prevLogs = directPrevRows.results;
    } else {
        const priorRow = await env.DB.prepare(
            "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
        ).bind(userId, todayDate).first();
        if (priorRow?.date) {
            effectivePrevDate = priorRow.date;
            const fallbackRows = await env.DB.prepare(
                "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
            ).bind(userId, effectivePrevDate).all();
            prevLogs = fallbackRows.results || [];
        }
    }

    const prevBullets = prevLogs.length > 0
        ? prevLogs.map(item => `  - [${item.category}] ${item.content}`).join("\n")
        : "  - Continued regular deliverables";

    const todayBullets = todayLogs.length > 0
        ? todayLogs.map(item => `  - [${item.category}] ${item.content}`).join("\n")
        : "  - Continue development and scheduled sprint tasks";

    const copyBlock = [
        `Daily Standup - ${todayDate}`,
        `Name: ${cleanUsername}`,
        ``,
        `1. Yesterday / Previous (${effectivePrevDate}):`,
        prevBullets,
        ``,
        `2. Today:`,
        todayBullets,
        ``,
        `3. Blockers: None`
    ].join("\n");

    const message = [
        `📋 *Tap the block below to copy:*`,
        ``,
        `\`\`\``,
        copyBlock,
        `\`\`\``,
        `_Paste directly into Slack, Microsoft Teams, or Telegram!_`
    ].join("\n");

    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "⚡ Work Journal", callback_data: "work_hub" }
                ]
            ]
        }
    });
}

async function handleAiPolishStandup(env, chatId, userId, from, messageId = null, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "🧠 Polishing with AI..." });
    }
    await ensureTables(env.DB);

    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

    let prevLogs = [];
    let effectivePrevDate = prevWorkday;
    const directPrevRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, prevWorkday).all();
    if (directPrevRows.results && directPrevRows.results.length > 0) {
        prevLogs = directPrevRows.results;
    } else {
        const priorRow = await env.DB.prepare(
            "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
        ).bind(userId, todayDate).first();
        if (priorRow?.date) {
            effectivePrevDate = priorRow.date;
            const fallbackRows = await env.DB.prepare(
                "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
            ).bind(userId, effectivePrevDate).all();
            prevLogs = fallbackRows.results || [];
        }
    }

    if (prevLogs.length === 0 && todayLogs.length === 0) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *No work logs available to polish.*\n\nLog tasks with \`/done <task>\` first (e.g. \`/done Fixed checkout bug\`), then tap **✨ AI Polish Standup**!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Standup", callback_data: "work_standup" }]
                    ]
                }
            }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const rawPrevText = prevLogs.map(i => `[${i.category}] ${i.content}`).join("\n") || "No explicit logs";
    const rawTodayText = todayLogs.map(i => `[${i.category}] ${i.content}`).join("\n") || "Continue scheduled tasks & review";

    const systemPrompt = `You are an elite software engineering manager and executive communicator.
Transform messy or casual work logs into a top-tier, impact-oriented daily engineering standup update.
Keep it concise, actionable, and professional. Use active verbs (Implemented, Resolved, Streamlined, Spearheaded).`;

    const userPrompt = `Engineer: ${cleanUsername}
Date: ${todayDate}
Previous Work Session (${effectivePrevDate}):
${rawPrevText}

Today's Tasks:
${rawTodayText}

Please write a polished, professional daily standup for Slack/Teams.
Include:
1. 🚀 Yesterday / Previous Focus (High impact, clear outcomes)
2. 🎯 Today's Planned Focus (Clear deliverables)
3. 🚧 Blockers / Dependencies (State 'None (All on track)' if none mentioned)

Format cleanly in Telegram Markdown with emojis and bullet points.`;

    const polishedText = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);

    if (!polishedText) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *AI Standup Polish was unavailable.*\n\nPlease verify your \`GEMINI_API_KEY\` or Workers AI binding.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Standup", callback_data: "work_standup" }]
                    ]
                }
            }
        );
        return;
    }

    const responseText = [
        `✨ *AI-Polished Daily Standup*`,
        `────────────────────`,
        polishedText,
        `────────────────────`,
        `_Copy to clipboard or share with your team:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, responseText, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📋 Copy Block", callback_data: "work_standup_copy" },
                    { text: "‹ Raw Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Journal", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function handleAiPolishWorkReport(env, chatId, userId, period = "this_month", from, messageId = null, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "🧠 Polishing report with Gemini AI..." });
    }
    await ensureTables(env.DB);

    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    let label = "";
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        label = monthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        label = lastMonthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else if (period === "this_week") {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    } else {
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *No work accomplishments found for ${label} to polish.*\n\nLog tasks with \`/done <task>\` first!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⚡ Work Journal", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const formattedTasks = logs.map(l => `• [${l.date}] [${l.category}] ${l.content}`).join("\n");

    const systemPrompt = `You are a Principal Engineering Lead and Executive Performance Coach.
Transform the provided work logs into an inspiring, executive-level Monthly Accomplishment Report suitable for high-stakes 1-on-1s and annual performance reviews.
Group related tasks into impactful business deliverables. Emphasize engineering excellence, business impact, and proactive leadership.`;

    const userPrompt = `Candidate: ${cleanUsername}
Period: ${label}
Completed Work Logs (${logs.length} tasks):
${formattedTasks}

Instructions:
Produce a structured Executive Accomplishment Report formatted in Telegram Markdown:
1. 🏆 Executive Summary: A punchy 2-sentence synthesis of key velocity and high-level milestones.
2. 🚀 Core Deliverables & Features Shipped: Group tasks into major themes/initiatives, detailing the technical outcome and value.
3. 🔧 Operational Excellence & Reliability: Bugfixes, refactors, tooling, performance improvements.
4. 🤝 Collaboration & Leadership: Cross-functional syncs, documentation, mentorship, code reviews.
5. 📈 Recommended Strategic Focus for Next Month: 2 high-leverage forward-looking opportunities.

Use bullet points, emojis, bold headings, and impactful action verbs.`;

    const polishedReport = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);

    if (!polishedReport) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *AI Report Polish was unable to respond.*\n\nPlease verify your \`GEMINI_API_KEY\` or Workers AI binding.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Work Hub", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    const exportCb = period === "last_month" ? "work_report_polish_export_last" : "work_report_polish_export_this";
    const rawCb = period === "last_month" ? "work_report_last" : "work_report_this";
    const switchMonthText = period === "last_month" ? "⏩ Polish This Month" : "⏪ Polish Last Month";
    const switchMonthCb = period === "last_month" ? "work_report_polish_this" : "work_report_polish_last";

    const header = [
        `✨ *Executive Accomplishment Report*`,
        `────────────────────`,
        `● *Period:*  \`${label}\``,
        `● *Engineer:* ${cleanUsername}`,
        `● *Input:*    \`${logs.length} completed tasks\``,
        `────────────────────`,
        ``
    ].join("\n");

    const fullMessage = header + polishedReport;

    if (fullMessage.length > 3800) {
        const preview = fullMessage.slice(0, 3200) + "\n\n⚠️ _Report is extensive. Full polished file sent below..._";
        await sendMessage(env, chatId, preview, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📄 Export Polished .txt", callback_data: exportCb },
                        { text: "📊 Raw Report", callback_data: rawCb }
                    ],
                    [
                        { text: "⚡ Work Journal", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        await sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedReport);
        return;
    }

    await safeEditOrSendMessage(env, chatId, messageId, fullMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📄 Export Polished .txt", callback_data: exportCb },
                    { text: "📊 Raw Report", callback_data: rawCb }
                ],
                [
                    { text: switchMonthText, callback_data: switchMonthCb },
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Journal", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function handleAiPolishWorkReportExport(env, chatId, userId, period = "this_month", from, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "📄 Preparing polished export..." });
    }
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    let label = "";
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        label = monthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        label = lastMonthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else {
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];
    if (logs.length === 0) {
        await sendMessage(env, chatId, `⚠️ No work accomplishments found for ${label} to export.`);
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
    } catch (e) {}

    const formattedTasks = logs.map(l => `• [${l.date}] [${l.category}] ${l.content}`).join("\n");
    const systemPrompt = `You are a Principal Engineering Lead and Executive Performance Coach.
Transform the provided work logs into an inspiring, executive-level Monthly Accomplishment Report suitable for high-stakes 1-on-1s and annual performance reviews.
Group related tasks into impactful business deliverables. Emphasize engineering excellence, business impact, and proactive leadership.`;

    const userPrompt = `Candidate: ${cleanUsername}
Period: ${label}
Completed Work Logs (${logs.length} tasks):
${formattedTasks}

Instructions:
Produce a structured Executive Accomplishment Report formatted with clear headings:
1. Executive Summary: 2-sentence synthesis of key velocity and high-level milestones.
2. Core Deliverables & Features Shipped: Group tasks into major themes/initiatives, detailing the technical outcome and value.
3. Operational Excellence & Reliability: Bugfixes, refactors, tooling, performance improvements.
4. Collaboration & Leadership: Cross-functional syncs, documentation, mentorship, code reviews.
5. Recommended Strategic Focus for Next Period: 2 high-leverage forward-looking opportunities.`;

    const polishedReport = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);
    if (!polishedReport) {
        await sendMessage(env, chatId, "⚠️ AI was unable to generate the polished export. Please try again.");
        return;
    }

    await sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedReport);
}

async function sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedContent) {
    const fileSuffix = period.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `executive_accomplishment_report_${fileSuffix}.txt`;

    const fileText = [
        "================================================================================",
        "                   EXECUTIVE ACCOMPLISHMENT REPORT (AI POLISHED)",
        "================================================================================",
        `Period:          ${label}`,
        `Prepared For:    ${cleanUsername}`,
        `Generated At:    ${today()} ${currentTime()} (Phnom Penh)`,
        "================================================================================",
        "",
        polishedContent.replace(/[*_`#]/g, ""),
        "",
        "================================================================================",
        "Generated with AI Executive Polish by Personal Assistant Bot",
        "================================================================================"
    ].join("\n");

    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([fileText], filename, { type: "text/plain" });
    formData.append("document", file);
    formData.append("caption", `✨ Executive Accomplishment Report (${label})\nAI-polished & formatted for performance reviews! 🚀`);

    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: formData,
    });

    if (!resp.ok) {
        const detail = await resp.text();
        console.error("sendPolishedWorkReportFile error:", detail);
        await sendMessage(env, chatId, "❌ Failed to upload polished report file.");
    }
}

async function sendLunchboxMenu(env, chatId, userId, messageId = null) {
    return sendRemindersMenu(env, chatId, userId, messageId);
}

async function sendRemindersMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];
    const activeCount = reminders.filter(r => r.is_active).length;

    let listText = "";
    if (reminders.length === 0) {
        listText = "_No reminders set yet._\nTap *[ ＋ Add Reminder ]* below or type:\n`remind 17:30 Bring lunch box`";
    } else {
        listText = reminders.map((r, idx) => {
            const status = r.is_active ? "●" : "○";
            const freq = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
            const icon = r.type === "lunchbox" ? "🎒" : r.type === "standup" ? "🗣️" : r.type === "expense_log" ? "💳" : "⏰";
            return `${idx + 1}. ${status} ${icon} *${r.title}*\n    └ \`${r.reminder_time}\` (${freq})`;
        }).join("\n");
    }

    const text = [
        `⏰ *Reminders & Alerts*`,
        `────────────────────`,
        `● *Active:*  \`${activeCount}\` of ${reminders.length} reminder(s)`,
        `────────────────────`,
        listText,
        `────────────────────`,
        `_Type \`remind <time> <task>\` or \`remind in 30m <task>\`_`
    ].join("\n");

    const buttons = [
        [
            { text: "＋ Add Reminder", callback_data: "remind_prompt_add" },
            { text: "🗣️ Standup 09:00", callback_data: "remind_add_standup" },
            { text: "🎒 17:30", callback_data: "remind_add_lunchbox" }
        ]
    ];

    for (const r of reminders.slice(0, 6)) {
        const toggleIcon = r.is_active ? "●" : "○";
        const shortTitle = r.title.length > 13 ? r.title.slice(0, 12) + "…" : r.title;
        buttons.push([
            { text: `${toggleIcon} ${shortTitle}`, callback_data: `remind_toggle:${r.id}` },
            { text: `${r.reminder_time}`, callback_data: `remind_time_menu:${r.id}` },
            { text: "✕", callback_data: `remind_del:${r.id}` }
        ]);
    }

    buttons.push([
        { text: "🔔 Test Alert", callback_data: "remind_test_general" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

async function sendReminderTimeMenu(env, chatId, userId, reminderId, messageId = null) {
    await ensureTables(env.DB);
    const r = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, is_active FROM reminders WHERE id = ? AND user_id = ?"
    ).bind(reminderId, userId).first();

    if (!r) {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Reminder not found.");
        return sendRemindersMenu(env, chatId, userId, messageId);
    }

    const freqLabel = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
    const nextFreq = r.frequency === "weekdays" ? "daily" : r.frequency === "daily" ? "once" : "weekdays";
    const nextFreqLabel = nextFreq === "weekdays" ? "Mon–Fri" : nextFreq === "daily" ? "Daily" : "Once";

    const text = [
        `⏰ *Reminder Schedule*`,
        `────────────────────`,
        `📌 *${r.title}*`,
        `● *Current Time:* \`${r.reminder_time}\` (${freqLabel})`,
        `────────────────────`,
        `_Choose a preset time below or type:_`,
        `\`remind <time> ${r.title}\``
    ].join("\n");

    const buttons = [
        [
            { text: "16:30", callback_data: `remind_set_time:${r.id}:16:30` },
            { text: "17:00", callback_data: `remind_set_time:${r.id}:17:00` },
            { text: "17:30", callback_data: `remind_set_time:${r.id}:17:30` },
            { text: "18:00", callback_data: `remind_set_time:${r.id}:18:00` }
        ],
        [
            { text: "08:30", callback_data: `remind_set_time:${r.id}:08:30` },
            { text: "09:00", callback_data: `remind_set_time:${r.id}:09:00` },
            { text: "12:00", callback_data: `remind_set_time:${r.id}:12:00` },
            { text: "21:00", callback_data: `remind_set_time:${r.id}:21:00` }
        ],
        [
            { text: "⏱️ In 15m", callback_data: `remind_set_rel:${r.id}:15` },
            { text: "⏱️ In 30m", callback_data: `remind_set_rel:${r.id}:30` },
            { text: "⏱️ In 1h", callback_data: `remind_set_rel:${r.id}:60` }
        ],
        [
            { text: `🔁 Schedule: ${nextFreqLabel}`, callback_data: `remind_freq:${r.id}:${nextFreq}` }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}

async function sendSettingsMenu(env, chatId, userId, messageId = null) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const settingsRow = await env.DB.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    ).bind(userId).first();

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const budgetStr = budgetKhr > 0 ? formatAmount(budgetKhr, displayCurrency) : "Off (No limit)";
    const toggleLabel = displayCurrency === "USD" ? "💱 Switch to KHR (៛)" : "💱 Switch to USD ($)";

    const text = [
        `⚙️ *System Settings*`,
        `────────────────────`,
        `● *Display Currency:*  \`${displayCurrency}\``,
        `● *Monthly Budget:*   \`${budgetStr}\``,
        `────────────────────`,
        `_Configure preferences or manage your records below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: toggleLabel, callback_data: "toggle_currency" }],
                [{ text: "🎯 Set Monthly Budget", callback_data: "budget_help" }],
                [
                    { text: "🗑️ Clear Today", callback_data: "clear_today_warn" },
                    { text: "⚠️ Wipe All History", callback_data: "clear_all_warn" }
                ],
                [{ text: "🏠 Main Hub", callback_data: "hub" }]
            ]
        }
    });
}

async function sendCategoryPicker(env, chatId, type = "expense", messageId = null) {
    const isIncome = type === "income";
    const title = isIncome ? "＋ *Add Income*" : "－ *Add Expense*";
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
    rows.push([{ text: `✏️ Custom: \`${exampleCmd}\``, callback_data: customCb }]);
    rows.push([
        { text: "‹ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    const text = [
        title,
        `────────────────────`,
        `Choose a category below, or type directly:`,
        `\`${exampleCmd}\``
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

async function sendAmountPicker(env, chatId, category, type = "expense", userId, messageId = null) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const isIncome = type === "income";
    const icon = getCategoryIcon(category, type);
    const title = isIncome ? "＋ *Select Income Amount*" : "－ *Select Expense Amount*";
    const prefix = isIncome ? "quick_inc:" : "quick_exp:";

    let amounts = [];
    if (displayCurrency === "USD") {
        amounts = isIncome ? [50, 100, 200, 500, 1000, 2000] : [2, 5, 10, 15, 20, 50];
    } else {
        amounts = isIncome ? [100000, 200000, 500000, 1000000, 2000000, 4000000] : [2000, 5000, 10000, 20000, 40000, 80000];
    }

    const rows = [];
    for (let i = 0; i < amounts.length; i += 3) {
        const row = [];
        for (let j = 0; j < 3 && i + j < amounts.length; j++) {
            const idx = i + j;
            row.push({
                text: formatAmount(displayCurrency === "USD" ? amounts[idx] * EXCHANGE_RATE : amounts[idx], displayCurrency),
                callback_data: `${prefix}${category}:${amounts[idx]}`
            });
        }
        rows.push(row);
    }

    const backCb = isIncome ? "add_income" : "add_expense";
    rows.push([{ text: `✏️ Custom: ${isIncome ? "/income" : "/add"} <amount> ${category}`, callback_data: isIncome ? "custom_inc" : "custom_add" }]);
    rows.push([
        { text: "‹ Back to Categories", callback_data: backCb },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    const text = [
        title,
        `────────────────────`,
        `● *Category:* ${icon} *${capitalize(category)}*`,
        `────────────────────`,
        `_Choose an amount below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

async function sendTransactionReceipt(env, chatId, userId, type, amount, currency, category, messageId = null) {
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

    const header = isIncome ? "＋ *Income Recorded*" : "－ *Expense Recorded*";
    const lines = [
        header,
        `────────────────────`,
        `● *Amount:*      \`${mainAmt}\`${altAmt}`,
        `● *Category:*    ${icon} *${capitalize(category)}*`,
        `● *Spent Today:* \`${todaySpentStr}\``
    ];
    if (warn) lines.push(`────────────────────`, warn);

    const addAnotherCb = isIncome ? "add_income" : "add_expense";
    const addAnotherText = isIncome ? "＋ Add More" : "＋ Add Another";

    await safeEditOrSendMessage(env, chatId, messageId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: addAnotherText, callback_data: addAnotherCb },
                    { text: "📜 Today's Ledger", callback_data: "view_transactions" }
                ],
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function sendTransactions(env, chatId, userId, messageId = null) {
    const date = today();
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const { results } = await env.DB.prepare(
        "SELECT amount, category, type, currency, created_at FROM expenses WHERE user_id = ? AND date = ? ORDER BY id ASC"
    )
    .bind(userId, date)
    .all();

    if (!results || !results.length) {
        await safeEditOrSendMessage(env, chatId, messageId, [
            `📜 *Today's Ledger*`,
            `📅 \`${date}\``,
            `────────────────────`,
            `_No transactions recorded today yet._`,
            ``,
            `_Tap below to log your first transaction today!_`
        ].join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "＋ Expense", callback_data: "add_expense" },
                        { text: "＋ Income", callback_data: "add_income" }
                    ],
                    [
                        { text: "💳 Finance", callback_data: "finance_hub" },
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
        `📜 *Today's Ledger*`,
        `📅 \`${date}\``,
        `────────────────────`,
        ...lines,
        `────────────────────`,
        `● *Income:* \`${formatAmount(totalIncome, displayCurrency)}\``,
        `● *Spent:*  \`${formatAmount(totalExpense, displayCurrency)}\``,
        `● *Net:*    \`${formatAmount(netKhr, displayCurrency)}\``
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "＋ Expense", callback_data: "add_expense" },
                    { text: "＋ Income", callback_data: "add_income" }
                ],
                [
                    { text: "📊 Summary", callback_data: "summary_today" },
                    { text: "💳 Finance", callback_data: "finance_hub" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

async function sendSummary(env, chatId, userId, period, messageId = null) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const stats = await getPeriodStats(env.DB, userId, period);
    const breakdown = await getCategoryRows(env.DB, userId, period, 5);
    const title = period === "month" ? `Monthly Summary (${monthLabel()})` : `Daily Summary (${today()})`;

    const lines = [
        `📊 *${title}*`,
        `────────────────────`,
        `● *Total Spent:*   \`${formatAmount(stats.total, displayCurrency)}\``,
        `● *Average / Tx:*  \`${formatAmount(stats.average, displayCurrency)}\``,
        `● *Entries:*       \`${stats.count} transactions\``,
    ];

    if (stats.maxAmount) {
        const symbol = stats.maxCurrency === "USD" ? "$" : "";
        const suffix = stats.maxCurrency === "KHR" ? " ៛" : "";
        const amt = stats.maxCurrency === "USD" ? stats.maxAmount : formatMoney(stats.maxAmount);
        const icon = getCategoryIcon(stats.maxCategory, "expense");
        lines.push(`● *Biggest Spend:* \`${symbol}${amt}${suffix}\` (${icon} ${capitalize(stats.maxCategory)})`);
    }

    if (breakdown.length) {
        lines.push(`────────────────────`, `🏷️ *Category Breakdown:*`);
        breakdown.forEach((row) => {
            const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
            const bar = generateTextProgressBar(percent);
            const icon = getCategoryIcon(row.category, "expense");
            lines.push(`${icon} *${capitalize(row.category)}:* ${bar} \`${formatAmount(row.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    lines.push(`────────────────────`);

    await safeEditOrSendMessage(env, chatId, messageId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📜 Daily Ledger", callback_data: "view_transactions" },
                    { text: "💳 Finance", callback_data: "finance_hub" }
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

    const lines = [`📊 *${title}*`, `────────────────────`];
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
                    { text: "‹ Back to Finance", callback_data: "finance_hub" },
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
            text: "📜 *Transaction History*\n────────────────────\n_No transactions recorded yet._",
            replyMarkup: {
                inline_keyboard: [
                    [
                        { text: "‹ Back to Finance", callback_data: "finance_hub" },
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
        `📜 *Transaction History*`,
        `📖 Page ${currentPage} of ${totalPages} (${totalCount} total)`,
        `────────────────────`,
        ...lines
    ].join("\n");

    const navRow = [];
    if (currentPage > 1) {
        navRow.push({ text: "‹ Prev", callback_data: `history:${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
        navRow.push({ text: "Next ›", callback_data: `history:${currentPage + 1}` });
    }

    const inlineKeyboard = [];
    if (navRow.length > 0) {
        inlineKeyboard.push(navRow);
    }
    inlineKeyboard.push([
        { text: "‹ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    return {
        text,
        replyMarkup: { inline_keyboard: inlineKeyboard }
    };
}

async function sendHelpMessage(env, chatId, messageId = null) {
    const text = [
        `💡 *Personal Assistant Guide*`,
        `────────────────────`,
        `⚡ *Natural Typing (No Commands Needed)*`,
        `• Reminders: \`remind 17:30 Bring lunch box\` or \`remind in 30m Check oven\``,
        `• Expense: \`5 coffee\` or \`10000 lunch\` or \`3.50 grab\``,
        `• Income: \`+500 salary\` or \`+50 bonus\``,
        `• Work log: \`done Fixed checkout bug\` or \`done Team sprint planning\``,
        `• Today ledger: \`today\` or \`ledger\``,
        `• Main menu: \`menu\` or \`hub\``,
        ``,
        `✨ *AI Copilot (Khmer & English)*`,
        `• \`/ask <question>\` or \`/ai <question>\``,
        `• Ask: *"How much did I spend this week?"*, *"Can I afford a $50 dinner?"*`,
        ``,
        `⏰ *Reminders & Alarms*`,
        `• \`remind 17:30 <task>\` — Daily recurring reminder`,
        `• \`remind in 15m <task>\` — Quick one-time timer`,
        `• \`/reminders\` — Open Reminders Workspace`,
        ``,
        `⚡ *Work Log, Standup & AI Reports*`,
        `• \`done <task>\` — Record accomplishment instantly (supports \`#tag\`)`,
        `• \`/standup\` — Daily standup generator (Yesterday, Today, Blockers)`,
        `• \`/standup polish\` — AI-polished standup for Slack / Teams`,
        `• \`/report\` — Generate monthly manager accomplishment report`,
        `• \`/report polish\` — AI executive accomplishment synthesis`,
        `• \`/report export\` — Download report as .txt file`,
        `• \`/work\` — Open Work Journal Workspace`,
        ``,
        `🧾 *Smart Receipt & Slip Scanner*`,
        `• Send or forward ABA Bank, Bakong, or KHQR slips to record automatically!`,
        `• Send paper receipt photos to extract itemized totals`,
        ``,
        `💳 *Finance & Cashflow*`,
        `• \`/add 5 usd coffee\` or \`/income 500 usd salary\``,
        `• \`/today\` — Today's transactions`,
        `• \`/summary\` — Spending statistics & breakdown`,
        `• \`/settings\` — Currency toggle & budget limit`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Standup", callback_data: "work_standup" },
                    { text: "⚡ Work Log", callback_data: "work_hub" }
                ],
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "⏰ Reminders", callback_data: "reminders" }
                ],
                [
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
            } else if (r.type === "standup") {
                await sendStandupNotification(env, r.chat_id, r.user_id, r.id);
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

async function sendStandupNotification(env, chatId, userId, reminderId = 0) {
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    let prevLogs = [];
    let effectivePrevDate = prevWorkday;

    const directPrevRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, prevWorkday).all();

    if (directPrevRows.results && directPrevRows.results.length > 0) {
        prevLogs = directPrevRows.results;
    } else {
        const priorRow = await env.DB.prepare(
            "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
        ).bind(userId, todayDate).first();
        if (priorRow?.date) {
            effectivePrevDate = priorRow.date;
            const fallbackRows = await env.DB.prepare(
                "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
            ).bind(userId, effectivePrevDate).all();
            prevLogs = fallbackRows.results || [];
        }
    }

    const prevSummary = prevLogs.length > 0
        ? prevLogs.map(item => `• ${getWorkCategoryIcon(item.category)} ${item.content}`).slice(0, 4).join("\n")
        : "_No tasks recorded for previous session._";

    const text = [
        `🌅 *Morning Standup Time!*`,
        `────────────────────`,
        `Ready to start your work day? 🚀`,
        ``,
        `⏮️ *Accomplished in last session (${effectivePrevDate}):*`,
        prevSummary,
        ``,
        `🎯 *What are your top priorities for today?*`,
        `────────────────────`,
        `_Log anytime with: \`done <task description>\`_`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ View Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish", callback_data: "work_standup_polish" }
                ],
                [
                    { text: "＋ Log Task", callback_data: "work_log_prompt" },
                    { text: "⏰ Snooze 30m", callback_data: `su_snooze:${reminderId}` }
                ]
            ]
        }
    });
}

async function sendLunchboxNotification(env, chatId, reminderId = 0) {
    const text = [
        `🎒 *Departure Reminder*`,
        `────────────────────`,
        `Wrapping up your work day? 🥪`,
        ``,
        `Don't forget to grab your *lunch box* from the fridge or pantry before you head out!`,
        ``,
        `💡 *Habit:* Take 10 seconds to log today's accomplishments: \`/done <task>\``,
        ``,
        `_Safe travels home! ✨_`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✓ Packed & Ready", callback_data: `lb_ack:${reminderId}` },
                    { text: "⏰ Snooze 15m", callback_data: `lb_snooze:${reminderId}` }
                ],
                [
                    { text: "⚡ Log Work", callback_data: "work_log_prompt" },
                    { text: "📋 Today's Work", callback_data: "work_today" }
                ]
            ]
        }
    });
}

async function sendExpenseLogNotification(env, chatId) {
    const text = [
        `💳 *Daily Check-in*`,
        `────────────────────`,
        `Did you spend or earn anything today?`,
        ``,
        `Take 10 seconds to record your day's transactions and keep your cashflow on track! 📊`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "＋ Expense", callback_data: "add_expense" },
                    { text: "＋ Income", callback_data: "add_income" }
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
        `⏰ *Reminder Alert*`,
        `────────────────────`,
        `📌 *${title}*`,
        ``,
        `● *Time:* \`${time}\``
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "✓ Done", callback_data: `remind_done:${reminderId}` }]
            ]
        }
    });
}

// ---------------------------------------------------------------------------
// Helpers & Database Operations
// ---------------------------------------------------------------------------

async function askClearConfirmation(env, chatId, messageId = null) {
    await safeEditOrSendMessage(env, chatId, messageId, "What would you like to clear?", {
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

async function addExpenseRecord(db, userId, amount, category, type = "expense", currency = "KHR", customDate = null) {
    const recordDate = (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) ? customDate : today();
    await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, recordDate, amount, normalizeCategory(category), type, currency)
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

function getPreviousWorkdayDate() {
    const now = new Date();
    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "short"
    }).format(now); // "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"

    if (weekdayStr === "Mon") {
        return dateDaysAgo(3); // Friday
    } else if (weekdayStr === "Sun") {
        return dateDaysAgo(2); // Friday
    } else {
        return dateDaysAgo(1); // Yesterday
    }
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
        `📊 *${titleLabel}*`,
        `📅 \`${startDate}\` to \`${endDate}\``,
        `────────────────────`,
        `● *Total Spent:*  \`${formatAmount(total, displayCurrency)}\``,
        `● *Average / Tx:* \`${formatAmount(average, displayCurrency)}\``,
        `● *Activity:*     \`${count} entries\``,
    ];

    if (biggest) {
        const symbol = biggest.currency === "USD" ? "$" : "";
        const suffix = biggest.currency === "KHR" ? " ៛" : "";
        const amt = biggest.currency === "USD" ? biggest.amount : formatMoney(biggest.amount);
        const icon = getCategoryIcon(biggest.category, "expense");
        let maxStr = `● *Biggest Spend:* \`${symbol}${amt}${suffix}\` (${icon} ${capitalize(biggest.category)})`;
        if (biggest.currency === "USD") {
            maxStr += ` (~${formatMoney(biggest.amount * EXCHANGE_RATE)} ៛)`;
        } else {
            maxStr += ` (~$${formatMoney(biggest.amount / EXCHANGE_RATE)})`;
        }
        textLines.push(maxStr);
    }

    if (catResults.length > 0) {
        textLines.push(`────────────────────`, `🏷️ *Category Breakdown:*`);
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
        await telegram(env, "sendPhoto", payload);
    } catch (err) {
        console.warn("Telegram sendPhoto failed, falling back to message:", err.message);
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
