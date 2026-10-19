import { EXCHANGE_RATE } from "../config/constants.js";
import { today, currentTime, monthPrefix, monthLabel, dateDaysAgo, getPreviousWorkdayDate } from "../utils/time.js";
import { capitalize, json } from "../utils/format.js";
import { validateTelegramInitData } from "../utils/crypto.js";
import { ensureTables } from "../db/schema.js";
import { getFinancialSummary, getCategoryRows } from "../db/queries.js";

export async function authenticateApiRequest(request, env) {
    const url = new URL(request.url);
    const requestedUserId = url.searchParams.get("user_id");
    const initDataHeader = request.headers.get("X-Telegram-Init-Data") || url.searchParams.get("init_data");

    if (initDataHeader) {
        const validated = await validateTelegramInitData(initDataHeader, env.TELEGRAM_BOT_TOKEN);
        if (!validated || !validated.userId) {
            return { error: "Invalid or expired Telegram WebApp session", status: 401 };
        }
        if (requestedUserId && requestedUserId !== validated.userId) {
            return { error: "Forbidden: user_id does not match Telegram session", status: 403 };
        }
        return { userId: validated.userId, user: validated.user };
    }

    // Allow dev bypass on localhost or if no bot token is configured
    const host = request.headers.get("host") || "";
    const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1");
    if (isLocalhost || !env.TELEGRAM_BOT_TOKEN) {
        if (!requestedUserId) {
            return { error: "Missing user_id parameter", status: 400 };
        }
        return { userId: requestedUserId, user: { id: requestedUserId } };
    }

    return { error: "Unauthorized: Telegram WebApp authentication required", status: 401 };
}

export async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const auth = await authenticateApiRequest(request, env);
    if (auth.error) {
        return json({ error: auth.error }, auth.status || 401);
    }
    const userId = auth.userId;

    if (request.method === "GET" || request.method === "HEAD") {
        if (url.pathname === "/api/data") {
            await ensureTables(env.DB);
            const summary = await getFinancialSummary(env.DB, userId, "all");
            const categories = await getCategoryRows(env.DB, userId, "month", 10);

            // Optimized: Single SQL query with GROUP BY instead of 7 sequential roundtrips
            const past7Days = [];
            for (let i = 6; i >= 0; i--) {
                past7Days.push(dateDaysAgo(i));
            }
            const minDate = past7Days[0];
            const maxDate = past7Days[past7Days.length - 1];

            const dayRows = await env.DB.prepare(
                `SELECT date, COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total
                 FROM expenses
                 WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
                 GROUP BY date`
            )
            .bind(userId, minDate, maxDate)
            .all();

            const totalsMap = new Map((dayRows.results || []).map(r => [r.date, Number(r.total || 0)]));
            const daily = past7Days.map(d => ({
                date: d,
                total: totalsMap.get(d) || 0,
            }));

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
            await ensureTables(env.DB);
            const { results } = await env.DB.prepare(
                "SELECT id, chat_id, title, reminder_time, frequency, type, is_active, last_sent_date FROM reminders WHERE user_id = ? ORDER BY reminder_time ASC, id ASC"
            ).bind(userId).all();

            return json({
                reminders: results || []
            });
        }

        if (url.pathname === "/api/watchlist") {
            await ensureTables(env.DB);
            const { results } = await env.DB.prepare(
                `SELECT id, title, year, genre, rating, runtime, platforms, synopsis, why_love, status, created_at, watched_at
                 FROM watchlist
                 WHERE user_id = ? AND status IN ('plan_to_watch', 'watched')
                 ORDER BY (CASE WHEN status = 'plan_to_watch' THEN 0 ELSE 1 END), id DESC`
            ).bind(userId).all();

            const items = results || [];
            const planCount = items.filter(i => i.status === "plan_to_watch").length;
            const watchedCount = items.filter(i => i.status === "watched").length;

            return json({
                ok: true,
                items,
                total: items.length,
                planCount,
                watchedCount
            });
        }
    }

    if (request.method === "POST") {
        if (url.pathname === "/api/delete") {
            const txId = url.searchParams.get("id");
            if (!txId) {
                return json({ error: "Missing parameters" }, 400);
            }

            const result = await env.DB.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?")
                .bind(userId, txId)
                .run();

            return json({ ok: true, changes: result.meta?.changes || 0 });
        }

        if (url.pathname === "/api/work/add") {
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
            const taskId = url.searchParams.get("id");
            if (!taskId) {
                return json({ error: "Missing parameters" }, 400);
            }

            await ensureTables(env.DB);
            const result = await env.DB.prepare("DELETE FROM work_logs WHERE user_id = ? AND id = ?")
                .bind(userId, taskId)
                .run();

            return json({ ok: true, changes: result.meta?.changes || 0 });
        }

        if (url.pathname === "/api/reminders/toggle") {
            const reminderId = url.searchParams.get("id");
            if (!reminderId) {
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
            const reminderId = url.searchParams.get("id");
            if (!reminderId) {
                return json({ error: "Missing parameters" }, 400);
            }

            await ensureTables(env.DB);
            const result = await env.DB.prepare("DELETE FROM reminders WHERE user_id = ? AND id = ?")
                .bind(userId, reminderId)
                .run();

            return json({ ok: true, changes: result.meta?.changes || 0 });
        }

        if (url.pathname === "/api/watchlist/add") {
            const body = await request.json().catch(() => ({}));
            const title = (body.title || "").trim();
            if (!title) {
                return json({ error: "Title is required" }, 400);
            }

            await ensureTables(env.DB);
            const res = await env.DB.prepare(`
                INSERT INTO watchlist (user_id, title, year, genre, rating, runtime, platforms, synopsis, why_love, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'plan_to_watch')
            `).bind(
                userId,
                title,
                (body.year || "").trim(),
                (body.genre || "General").trim(),
                (body.rating || "").trim(),
                (body.runtime || "").trim(),
                (body.platforms || "").trim(),
                (body.synopsis || "").trim(),
                (body.why_love || "").trim()
            ).run();

            return json({
                ok: true,
                item: {
                    id: res.meta?.last_row_id,
                    title,
                    year: body.year || "",
                    genre: body.genre || "General",
                    rating: body.rating || "",
                    status: "plan_to_watch"
                }
            });
        }

        if (url.pathname === "/api/watchlist/toggle") {
            const id = url.searchParams.get("id");
            if (!id) {
                return json({ error: "Missing parameters" }, 400);
            }

            await ensureTables(env.DB);
            const row = await env.DB.prepare("SELECT status FROM watchlist WHERE id = ? AND user_id = ?").bind(id, userId).first();
            if (!row) {
                return json({ error: "Title not found" }, 404);
            }

            const newStatus = row.status === "watched" ? "plan_to_watch" : "watched";
            const watchedAt = newStatus === "watched" ? today() : null;

            await env.DB.prepare("UPDATE watchlist SET status = ?, watched_at = ? WHERE id = ? AND user_id = ?")
                .bind(newStatus, watchedAt, id, userId).run();

            return json({ ok: true, newStatus });
        }

        if (url.pathname === "/api/watchlist/delete") {
            const id = url.searchParams.get("id");
            if (!id) {
                return json({ error: "Missing parameters" }, 400);
            }

            await ensureTables(env.DB);
            const res = await env.DB.prepare("DELETE FROM watchlist WHERE id = ? AND user_id = ?").bind(id, userId).run();
            return json({ ok: true, changes: res.meta?.changes || 0 });
        }
    }

    return json({ ok: false, error: "Not found" }, 404);
}
