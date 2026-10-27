import { EXCHANGE_RATE } from "../../config/constants.js";
import { today } from "../../utils/time.js";
import { formatMoney, capitalize } from "../../utils/format.js";
import { getDisplayCurrency, addExpenseRecord, setMonthlyBudget, getBudgetStatus } from "../../db/queries.js";
import { sendMessage, safeEditOrSendMessage, sendTelegramDocument } from "../../services/telegram.js";
import { sendTransactionReceipt } from "./views.js";

export async function addTransactionFromCommand(env, chatId, userId, text) {
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

    const txId = await addExpenseRecord(env.DB, userId, amount, category, type, currency);
    await sendTransactionReceipt(env, chatId, userId, type, amount, currency, category, null, { txId });
}

export async function handleBudgetCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        const status = await getBudgetStatus(env.DB, userId);
        if (status) {
            const statusLines = [
                `🎯 *Monthly Budget Status*`,
                `━━━━━━━━━━━━━━━━━━━━━`,
                `● *Budget:*     \`${status.budgetStr}\``,
                `● *Spent:*      \`${status.spentStr}\` (${status.percent}%)`,
                `● *Safe Spend:* \`${status.safeDailyStr}/day\` (${status.daysRemaining} days left)`,
                `● *Gauge:*      \`${status.bar}\``,
                `━━━━━━━━━━━━━━━━━━━━━`,
                `💡 *Commands:*\n• Update: \`/budget <amount> [USD/KHR]\`\n• Disable: \`/budget 0\``
            ];
            await sendMessage(env, chatId, statusLines.join("\n"), { parse_mode: "Markdown" });
            return;
        }

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

export async function askClearConfirmation(env, chatId, messageId = null) {
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

export async function handleExportLedgerCommand(env, chatId, userId) {
    const { results } = await env.DB.prepare(
        "SELECT date, category, amount, currency, type, created_at FROM expenses WHERE user_id = ? ORDER BY date ASC, id ASC"
    )
    .bind(userId)
    .all();

    if (!results || results.length === 0) {
        await sendMessage(env, chatId, "ℹ️ *No transactions recorded yet to export.*", { parse_mode: "Markdown" });
        return;
    }

    let csvContent = "Date,Type,Category,Amount,Currency,Created At\n";
    for (const row of results) {
        const escapedCategory = String(row.category || "").replace(/"/g, '""');
        csvContent += `"${row.date}","${row.type}","${escapedCategory}",${row.amount},"${row.currency}","${row.created_at}"\n`;
    }

    const file = new File([csvContent], `cashflow_export_${today()}.csv`, { type: "text/csv" });
    await sendTelegramDocument(env, chatId, file, `📊 Cashflow Ledger Export (${today()})\nTotal transactions: ${results.length}`);
}

export async function handleSearchExpensesCommand(env, chatId, userId, text) {
    const query = text.replace(/^\/(find|search)\s*/i, "").trim();
    if (!query) {
        await sendMessage(env, chatId, "💡 *Usage:* `/find <category or amount>`\nExample: `/find coffee` or `/find 15`", { parse_mode: "Markdown" });
        return;
    }

    const searchPattern = `%${query}%`;
    const { results } = await env.DB.prepare(
        `SELECT id, date, amount, currency, category, type 
         FROM expenses 
         WHERE user_id = ? AND (category LIKE ? OR CAST(amount AS TEXT) LIKE ?)
         ORDER BY date DESC, id DESC LIMIT 10`
    ).bind(userId, searchPattern, searchPattern).all();

    if (!results || results.length === 0) {
        await sendMessage(env, chatId, `🔍 No transactions found matching *"${query}"*.`, { parse_mode: "Markdown" });
        return;
    }

    const lines = [
        `🔍 *Search results for "${query}":*`,
        `────────────────────`
    ];

    for (const r of results) {
        const sign = r.type === "income" ? "+" : "-";
        const symbol = r.currency === "USD" ? "$" : "";
        const suffix = r.currency === "KHR" ? " ៛" : "";
        lines.push(`• \`${r.date}\`: *${sign}${symbol}${formatMoney(r.amount)}${suffix}* (${capitalize(r.category)})`);
    }

    lines.push(`────────────────────`);
    lines.push(`_Showing ${results.length} most recent matches._`);

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 Full Summary", callback_data: "summary_today" }, { text: "📥 Export CSV", callback_data: "export_csv" }],
                [{ text: "🏠 Main Hub", callback_data: "hub" }]
            ]
        }
    });
}

export async function sendCSVBackup(env, chatId, userId) {
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

    const file = new File([csvContent], `cashflow_backup_${today()}.csv`, { type: "text/csv" });
    await sendTelegramDocument(env, chatId, file, "Here is a CSV backup of your expenses before wiping.");
}
