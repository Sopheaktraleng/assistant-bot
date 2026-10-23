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
