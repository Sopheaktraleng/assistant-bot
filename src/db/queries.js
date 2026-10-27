import { EXCHANGE_RATE } from "../config/constants.js";
import { today, monthPrefix } from "../utils/time.js";
import { formatAmount, formatMoney, normalizeCategory } from "../utils/format.js";

export async function wasUpdateProcessed(db, updateId) {
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

export async function getDisplayCurrency(db, userId) {
    const row = await db
        .prepare("SELECT display_currency FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
    return row?.display_currency || "KHR";
}

export async function setDisplayCurrency(db, userId, currency) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, display_currency) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET display_currency = excluded.display_currency"
        )
        .bind(userId, currency)
        .run();
}

export async function getUserVoiceMode(db, userId) {
    try {
        const row = await db
            .prepare("SELECT voice_mode FROM user_settings WHERE user_id = ?")
            .bind(userId)
            .first();
        return row?.voice_mode || "off";
    } catch (e) {
        return "off";
    }
}

export async function setUserVoiceMode(db, userId, mode = "off") {
    try {
        await db
            .prepare(
                "INSERT INTO user_settings (user_id, voice_mode) VALUES (?, ?) " +
                "ON CONFLICT(user_id) DO UPDATE SET voice_mode = excluded.voice_mode"
            )
            .bind(userId, mode)
            .run();
        return true;
    } catch (e) {
        console.error("setUserVoiceMode error:", e);
        return false;
    }
}

export async function getUserBriefingMode(db, userId) {
    try {
        const row = await db
            .prepare("SELECT briefing_mode FROM user_settings WHERE user_id = ?")
            .bind(userId)
            .first();
        return row?.briefing_mode || "on";
    } catch (e) {
        return "on";
    }
}

export async function setUserBriefingMode(db, userId, mode = "on") {
    try {
        await db
            .prepare(
                "INSERT INTO user_settings (user_id, briefing_mode) VALUES (?, ?) " +
                "ON CONFLICT(user_id) DO UPDATE SET briefing_mode = excluded.briefing_mode"
            )
            .bind(userId, mode)
            .run();
        return true;
    } catch (e) {
        console.error("setUserBriefingMode error:", e);
        return false;
    }
}

export async function getLastModelChatMessage(db, userId) {
    try {
        const row = await db
            .prepare("SELECT content FROM chat_history WHERE user_id = ? AND role = 'model' ORDER BY id DESC LIMIT 1")
            .bind(userId)
            .first();
        return row?.content || null;
    } catch (e) {
        console.error("getLastModelChatMessage error:", e);
        return null;
    }
}

export async function getFinancialSummary(db, userId, period) {
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

export async function getTotalExpenses(db, userId) {
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

export async function getPeriodStats(db, userId, period) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    
    const [row, biggest] = await Promise.all([
        db.prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}`
        ).bind(userId, value).first(),
        db.prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
             LIMIT 1`
        ).bind(userId, value).first()
    ]);

    return {
        total: Number(row?.total || 0),
        count: Number(row?.count || 0),
        average: Number(row?.average || 0),
        maxAmount: Number(biggest?.amount || 0),
        maxCategory: biggest?.category || "",
        maxCurrency: biggest?.currency || "KHR"
    };
}

export async function getCategoryRows(db, userId, period, limit) {
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

export async function addExpenseRecord(db, userId, amount, category, type = "expense", currency = "KHR", customDate = null) {
    const recordDate = (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) ? customDate : today();
    await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, recordDate, amount, normalizeCategory(category), type, currency)
        .run();
}

export async function clearToday(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ? AND date = ?")
        .bind(userId, today())
        .run();
}

export async function clearAllExpenses(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ?")
        .bind(userId)
        .run();
}

export async function deleteLastTransaction(db, userId, filterType = null) {
    try {
        let query = "SELECT id, amount, category, type, currency, date FROM expenses WHERE user_id = ?";
        const params = [userId];
        if (filterType && filterType !== "any" && filterType !== "all") {
            query += " AND type = ?";
            params.push(filterType.toLowerCase());
        }
        query += " ORDER BY id DESC LIMIT 1";

        const lastRow = await db.prepare(query).bind(...params).first();
        if (!lastRow) {
            return null;
        }

        await db.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?").bind(userId, lastRow.id).run();
        return lastRow;
    } catch (e) {
        console.error("deleteLastTransaction error:", e);
        return null;
    }
}

export async function deleteExpenseById(db, userId, expenseId) {
    try {
        const row = await db.prepare("SELECT id, amount, category, type, currency, date FROM expenses WHERE user_id = ? AND id = ?").bind(userId, expenseId).first();
        if (!row) return null;
        await db.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?").bind(userId, expenseId).run();
        return row;
    } catch (e) {
        console.error("deleteExpenseById error:", e);
        return null;
    }
}

export async function setMonthlyBudget(db, userId, budgetInKhr) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, monthly_budget) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET monthly_budget = excluded.monthly_budget"
        )
        .bind(userId, budgetInKhr)
        .run();
}

export async function getBudgetWarningText(db, userId) {
    const [settingsRow, monthSummary, displayCurrency] = await Promise.all([
        db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(userId).first(),
        getFinancialSummary(db, userId, "month"),
        getDisplayCurrency(db, userId)
    ]);
    
    const budgetKhr = settingsRow?.monthly_budget || 0;
    if (budgetKhr <= 0) return "";

    const totalSpentInKhr = monthSummary.totalExpenseInKhr;
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

// ============================================================================
// Multi-turn Conversation & Personal Long-Term Memory
// ============================================================================

export async function getRecentChatHistory(db, userId, limit = 8) {
    try {
        const { results } = await db
            .prepare(
                `SELECT role, content FROM (
                    SELECT id, role, content FROM chat_history 
                    WHERE user_id = ? 
                    ORDER BY id DESC LIMIT ?
                ) ORDER BY id ASC`
            )
            .bind(userId, limit)
            .all();
        return results || [];
    } catch (e) {
        console.error("getRecentChatHistory error:", e);
        return [];
    }
}

export async function saveChatMessage(db, userId, role, content) {
    if (!content || !userId) return;
    try {
        await db
            .prepare("INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)")
            .bind(userId, role, content)
            .run();

        // Maintain lean storage: keep most recent 30 conversation turns per user
        db.prepare(
            "DELETE FROM chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT 30)"
        )
            .bind(userId, userId)
            .run()
            .catch(() => {});
    } catch (e) {
        console.error("saveChatMessage error:", e);
    }
}

export async function clearChatHistory(db, userId) {
    try {
        await db.prepare("DELETE FROM chat_history WHERE user_id = ?").bind(userId).run();
        return true;
    } catch (e) {
        console.error("clearChatHistory error:", e);
        return false;
    }
}

export async function getUserMemories(db, userId, limit = 20) {
    try {
        const { results } = await db
            .prepare("SELECT id, category, fact, created_at FROM user_memories WHERE user_id = ? ORDER BY id DESC LIMIT ?")
            .bind(userId, limit)
            .all();
        return results || [];
    } catch (e) {
        console.error("getUserMemories error:", e);
        return [];
    }
}

export async function saveUserMemory(db, userId, fact, category = "preference") {
    if (!fact || !fact.trim()) return null;
    const cleanFact = fact.trim();
    try {
        const existing = await db
            .prepare("SELECT id FROM user_memories WHERE user_id = ? AND LOWER(fact) = LOWER(?)")
            .bind(userId, cleanFact)
            .first();
        if (existing) {
            return existing.id;
        }

        const res = await db
            .prepare("INSERT INTO user_memories (user_id, category, fact) VALUES (?, ?, ?)")
            .bind(userId, category, cleanFact)
            .run();
        return res.meta?.last_row_id || true;
    } catch (e) {
        console.error("saveUserMemory error:", e);
        return null;
    }
}

export async function deleteUserMemory(db, userId, memoryId) {
    try {
        const res = await db
            .prepare("DELETE FROM user_memories WHERE user_id = ? AND id = ?")
            .bind(userId, memoryId)
            .run();
        return (res.meta?.changes || 0) > 0;
    } catch (e) {
        console.error("deleteUserMemory error:", e);
        return false;
    }
}

export async function clearUserMemories(db, userId) {
    try {
        await db.prepare("DELETE FROM user_memories WHERE user_id = ?").bind(userId).run();
        return true;
    } catch (e) {
        console.error("clearUserMemories error:", e);
        return false;
    }
}

/**
 * Atomic deduplication lock for daily scheduled broadcasts (wake-up call, briefing, reports).
 * Guarantees that even if Cloudflare or concurrent cron executions fire simultaneously,
 * only one execution claims the slot and sends the alert to the user.
 * Returns true if claimed successfully, false if already sent today.
 */
export async function claimDailyBroadcast(db, userId, type, date) {
    if (!db) return true;
    try {
        const uId = String(userId);
        const t = String(type);
        const d = String(date);

        // 1. Quick check if already dispatched today
        const existing = await db
            .prepare("SELECT 1 FROM daily_broadcast_logs WHERE user_id = ? AND type = ? AND date = ?")
            .bind(uId, t, d)
            .first();

        if (existing) {
            return false;
        }

        // 2. Atomic insert to block concurrent worker race conditions
        const result = await db
            .prepare("INSERT OR IGNORE INTO daily_broadcast_logs (user_id, type, date) VALUES (?, ?, ?)")
            .bind(uId, t, d)
            .run();

        const changes = result?.meta?.changes ?? result?.changes;
        if (typeof changes === "number" && changes === 0) {
            return false;
        }

        return true;
    } catch (error) {
        console.warn("claimDailyBroadcast warning:", error.message);
        return true;
    }
}

export async function getAuthorizedUser(db, userId) {
    if (!db || !userId) return null;
    try {
        return await db
            .prepare("SELECT user_id, username, first_name, role, status, created_at, approved_by FROM authorized_users WHERE user_id = ?")
            .bind(String(userId))
            .first();
    } catch (e) {
        console.warn("getAuthorizedUser error:", e.message);
        return null;
    }
}

export async function listAuthorizedUsers(db) {
    if (!db) return [];
    try {
        const { results } = await db
            .prepare("SELECT user_id, username, first_name, role, status, created_at, approved_by FROM authorized_users ORDER BY role DESC, created_at ASC")
            .all();
        return results || [];
    } catch (e) {
        console.warn("listAuthorizedUsers error:", e.message);
        return [];
    }
}

export async function addOrUpdateAuthorizedUser(db, { userId, username = "", firstName = "", role = "guest", status = "active", approvedBy = "owner" }) {
    if (!db || !userId) return false;
    try {
        await db
            .prepare(
                `INSERT INTO authorized_users (user_id, username, first_name, role, status, approved_by)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET
                    username = excluded.username,
                    first_name = excluded.first_name,
                    role = excluded.role,
                    status = excluded.status,
                    approved_by = excluded.approved_by`
            )
            .bind(String(userId), username, firstName, role, status, approvedBy)
            .run();
        return true;
    } catch (e) {
        console.error("addOrUpdateAuthorizedUser error:", e);
        return false;
    }
}

export async function setAuthorizedUserStatus(db, userId, status) {
    if (!db || !userId) return false;
    try {
        await db
            .prepare("UPDATE authorized_users SET status = ? WHERE user_id = ?")
            .bind(status, String(userId))
            .run();
        return true;
    } catch (e) {
        console.error("setAuthorizedUserStatus error:", e);
        return false;
    }
}

export async function isUserAllowedInDb(db, userId) {
    if (!db || !userId) return false;
    try {
        const row = await db
            .prepare("SELECT status FROM authorized_users WHERE user_id = ?")
            .bind(String(userId))
            .first();
        return row?.status === "active";
    } catch (e) {
        return false;
    }
}

/**
 * Searches engineering work logs using FTS5 when available, falling back to LIKE.
 */
export async function searchWorkLogs(db, userId, query, limit = 10) {
    if (!db || !userId) return [];
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
        const rows = await db.prepare(
            "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT ?"
        ).bind(String(userId), limit).all();
        return rows.results || [];
    }

    // Attempt FTS5 virtual table first
    try {
        const ftsQuery = cleanQuery.replace(/[^a-zA-Z0-9_\u1780-\u17FF\s]/g, " ").trim();
        if (ftsQuery) {
            const ftsRows = await db.prepare(
                `SELECT rowid as id, date, content, category 
                 FROM work_logs_fts 
                 WHERE user_id = ? AND work_logs_fts MATCH ? 
                 ORDER BY rank 
                 LIMIT ?`
            ).bind(String(userId), `${ftsQuery}*`, limit).all();
            if (ftsRows.results && ftsRows.results.length > 0) {
                return ftsRows.results;
            }
        }
    } catch (_) {}

    // Resilient fallback to LIKE
    try {
        const term = `%${cleanQuery}%`;
        const rows = await db.prepare(
            `SELECT id, date, time, content, category 
             FROM work_logs 
             WHERE user_id = ? AND (content LIKE ? OR category LIKE ?) 
             ORDER BY date DESC, id DESC 
             LIMIT ?`
        ).bind(String(userId), term, term, limit).all();
        return rows.results || [];
    } catch (e) {
        console.warn("searchWorkLogs error:", e.message);
        return [];
    }
}

/**
 * Searches user memory matrix using FTS5 when available, falling back to LIKE.
 */
export async function searchUserMemories(db, userId, query, limit = 10) {
    if (!db || !userId) return [];
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) {
        return getUserMemories(db, userId, limit);
    }

    // Attempt FTS5 virtual table first
    try {
        const ftsQuery = cleanQuery.replace(/[^a-zA-Z0-9_\u1780-\u17FF\s]/g, " ").trim();
        if (ftsQuery) {
            const ftsRows = await db.prepare(
                `SELECT rowid as id, fact, category 
                 FROM user_memories_fts 
                 WHERE user_id = ? AND user_memories_fts MATCH ? 
                 ORDER BY rank 
                 LIMIT ?`
            ).bind(String(userId), `${ftsQuery}*`, limit).all();
            if (ftsRows.results && ftsRows.results.length > 0) {
                return ftsRows.results;
            }
        }
    } catch (_) {}

    // Resilient fallback to LIKE
    try {
        const term = `%${cleanQuery}%`;
        const rows = await db.prepare(
            `SELECT id, fact, category 
             FROM user_memories 
             WHERE user_id = ? AND (fact LIKE ? OR category LIKE ?) 
             ORDER BY id DESC 
             LIMIT ?`
        ).bind(String(userId), term, term, limit).all();
        return rows.results || [];
    } catch (e) {
        console.warn("searchUserMemories error:", e.message);
        return [];
    }
}

/**
 * Flexible ledger search by date range, category, and type.
 */
export async function searchLedger(db, userId, options = {}) {
    if (!db || !userId) return { transactions: [], totalKhr: 0, count: 0 };
    const { fromDate, toDate, category, type, limit = 20 } = options;

    const conditions = ["user_id = ?"];
    const params = [String(userId)];

    if (fromDate) {
        conditions.push("date >= ?");
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push("date <= ?");
        params.push(toDate);
    }
    if (category) {
        conditions.push("LOWER(category) = LOWER(?)");
        params.push(category);
    }
    if (type && type !== "all") {
        conditions.push("type = ?");
        params.push(type);
    }

    const whereClause = conditions.join(" AND ");
    params.push(limit);

    try {
        const rows = await db.prepare(
            `SELECT id, date, amount, currency, category, type, created_at 
             FROM expenses 
             WHERE ${whereClause} 
             ORDER BY date DESC, id DESC 
             LIMIT ?`
        ).bind(...params).all();

        const transactions = rows.results || [];
        let totalKhr = 0;
        for (const t of transactions) {
            const amtKhr = t.currency === "USD" ? t.amount * EXCHANGE_RATE : t.amount;
            totalKhr += amtKhr;
        }

        return {
            transactions,
            count: transactions.length,
            totalKhr,
            totalUsd: Number((totalKhr / EXCHANGE_RATE).toFixed(2))
        };
    } catch (e) {
        console.warn("searchLedger error:", e.message);
        return { transactions: [], totalKhr: 0, count: 0 };
    }
}

/**
 * Unified RAG search across memories, work logs, and ledger transactions.
 */
export async function searchHistoricalRecords(db, userId, query, options = {}) {
    if (!db || !userId) return { memories: [], workLogs: [], transactions: [] };
    const limit = options.limit || 5;

    const [memories, workLogs, txns] = await Promise.all([
        searchUserMemories(db, userId, query, limit),
        searchWorkLogs(db, userId, query, limit),
        searchLedger(db, userId, { category: query, limit })
    ]);

    return {
        memories,
        workLogs,
        transactions: txns.transactions || []
    };
}

/**
 * Saves a multi-transaction parsed PDF statement for user confirmation.
 */
export async function savePendingStatement(db, { userId, chatId, bank, period, currency, totalInflow, totalOutflow, transactionCount, transactionsJson }) {
    if (!db) return null;
    try {
        const result = await db.prepare(
            `INSERT INTO pending_statements 
             (user_id, chat_id, bank, period, currency, total_inflow, total_outflow, transaction_count, transactions_json) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            String(userId),
            String(chatId),
            bank || "Bank Statement",
            period || "",
            currency || "USD",
            totalInflow || 0,
            totalOutflow || 0,
            transactionCount || 0,
            transactionsJson
        ).run();

        return result.meta?.last_row_id || result.lastRowId || null;
    } catch (e) {
        console.error("savePendingStatement error:", e);
        return null;
    }
}

/**
 * Retrieves a pending statement by id and user_id.
 */
export async function getPendingStatement(db, id, userId) {
    if (!db || !id) return null;
    try {
        return await db.prepare(
            "SELECT * FROM pending_statements WHERE id = ? AND user_id = ?"
        ).bind(id, String(userId)).first();
    } catch (e) {
        console.error("getPendingStatement error:", e);
        return null;
    }
}

/**
 * Deletes a pending statement by id and user_id.
 */
export async function deletePendingStatement(db, id, userId) {
    if (!db || !id) return false;
    try {
        await db.prepare(
            "DELETE FROM pending_statements WHERE id = ? AND user_id = ?"
        ).bind(id, String(userId)).run();
        return true;
    } catch (e) {
        console.error("deletePendingStatement error:", e);
        return false;
    }
}

/**
 * Imports all extracted transactions from a pending statement into the expenses ledger.
 */
export async function importPendingStatementTransactions(db, id, userId) {
    if (!db || !id) return { success: false, count: 0 };
    const stmt = await getPendingStatement(db, id, userId);
    if (!stmt) return { success: false, count: 0 };

    let transactions = [];
    try {
        transactions = JSON.parse(stmt.transactions_json);
    } catch (e) {
        console.error("Failed to parse statement transactions_json:", e);
        return { success: false, count: 0 };
    }

    if (!Array.isArray(transactions) || transactions.length === 0) {
        await deletePendingStatement(db, id, userId);
        return { success: true, count: 0 };
    }

    const stmts = transactions.map(t => {
        const amt = parseFloat(t.amount);
        const curr = (t.currency || stmt.currency || "USD").toUpperCase();
        const cat = normalizeCategory(t.category || (t.type === "income" ? "Income" : "Other"));
        const tType = t.type === "income" ? "income" : "expense";
        const tDate = t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today();

        return db.prepare(
            "INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(String(userId), tDate, amt, cat, tType, curr);
    });

    try {
        if (typeof db.batch === "function") {
            await db.batch(stmts);
        } else {
            for (const s of stmts) {
                await s.run();
            }
        }
        await deletePendingStatement(db, id, userId);
        return { success: true, count: transactions.length, transactions };
    } catch (err) {
        console.error("importPendingStatementTransactions error:", err);
        return { success: false, count: 0, error: err.message };
    }
}


