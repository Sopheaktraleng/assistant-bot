import { EXCHANGE_RATE, QUICK_EXPENSE_CATS, QUICK_INCOME_CATS, isUserAuthorized } from "../../config/constants.js";
import { today, monthLabel, dateDaysAgo, formatCambodiaDateTime, formatTimeFromCreatedAt } from "../../utils/time.js";
import { formatAmount, formatMoney, capitalize, getCategoryIcon, generateTextProgressBar, cleanMd } from "../../utils/format.js";
import { getDisplayCurrency, getFinancialSummary, getPeriodStats, getCategoryRows, getBudgetWarningText, getBudgetStatus, claimDailyBroadcast, getRecentFavorites } from "../../db/queries.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendFinanceHub(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const monthSummary = await getFinancialSummary(env.DB, userId, "month");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");

    const netBalance = allSummary?.balanceKhr || 0;
    const isNegative = netBalance < 0;
    const sign = netBalance > 0 ? "+" : "";
    const balanceStatus = isNegative ? "deficit" : "healthy";
    const balanceStr = `${sign}${formatAmount(netBalance, displayCurrency)}`;

    const text = [
        `💳 *Finance & Cashflow*`,
        ``,
        `● *Net Balance:*  \`${balanceStr}\` _(${balanceStatus})_`,
        `● *Spent Today:*  \`${formatAmount(todaySummary?.totalExpenseInKhr || 0, displayCurrency)}\``,
        `● *This Month:*   \`${formatAmount(monthSummary?.totalExpenseInKhr || 0, displayCurrency)}\``,
        ``,
        `_📸 Snap any ABA / KHQR receipt or type: \`5 coffee\` or \`+500 salary\`_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📋 Today's Ledger", callback_data: "view_transactions" },
                    { text: "📊 Month Insights", callback_data: "summary_month" }
                ],
                [
                    { text: "📜 All History", callback_data: "view_history" },
                    { text: "📥 Export CSV", callback_data: "export_csv" }
                ],
                [
                    { text: "‹ Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendCategoryPicker(env, chatId, type = "expense", messageId = null, userId = null) {
    const isIncome = type === "income";
    const effectiveUserId = userId || chatId;
    await ensureTables(env.DB);

    const [displayCurrency, favorites] = await Promise.all([
        getDisplayCurrency(env.DB, effectiveUserId),
        getRecentFavorites(env.DB, effectiveUserId, type, 3)
    ]);

    const isUsd = displayCurrency === "USD";
    const sign = isIncome ? "+" : "";

    // Candidate items: use user's frequent recent favorites, filled with standard presets if fewer than 3
    const candidateItems = [];
    if (favorites && favorites.length > 0) {
        for (const f of favorites) {
            candidateItems.push({
                id: f.last_id,
                category: f.category,
                amount: f.amount,
                currency: f.currency,
                merchant: f.merchant,
                isExisting: true
            });
        }
    }

    if (candidateItems.length < 3) {
        const defaultExpensePresets = isUsd
            ? [
                { category: "Coffee", amount: 2.5, currency: "USD", merchant: null },
                { category: "Lunch", amount: 5.0, currency: "USD", merchant: null },
                { category: "Ride", amount: 2.0, currency: "USD", merchant: null }
            ]
            : [
                { category: "Coffee", amount: 10000, currency: "KHR", merchant: null },
                { category: "Lunch", amount: 20000, currency: "KHR", merchant: null },
                { category: "Ride", amount: 8000, currency: "KHR", merchant: null }
            ];

        const defaultIncomePresets = isUsd
            ? [
                { category: "Salary", amount: 500, currency: "USD", merchant: null },
                { category: "Freelance", amount: 50, currency: "USD", merchant: null },
                { category: "Gift", amount: 20, currency: "USD", merchant: null }
            ]
            : [
                { category: "Salary", amount: 2000000, currency: "KHR", merchant: null },
                { category: "Freelance", amount: 200000, currency: "KHR", merchant: null },
                { category: "Gift", amount: 80000, currency: "KHR", merchant: null }
            ];

        const defaults = isIncome ? defaultIncomePresets : defaultExpensePresets;
        for (const def of defaults) {
            if (candidateItems.length >= 3) break;
            const alreadyHas = candidateItems.some(c => c.category.toLowerCase() === def.category.toLowerCase());
            if (!alreadyHas) {
                candidateItems.push({ ...def, isExisting: false });
            }
        }
    }

    const keyboard = [];
    for (const item of candidateItems) {
        const itemIcon = getCategoryIcon(item.category, type);
        const itemSym = item.currency === "USD" ? "$" : "";
        const itemSuf = item.currency === "KHR" ? " ៛" : "";
        const minDecimals = item.currency === "USD" ? 2 : 0;
        const amtStr = `${sign}${itemSym}${formatMoney(item.amount, minDecimals)}${itemSuf}`;
        const label = item.merchant ? cleanMd(item.merchant) : capitalize(item.category);
        const buttonText = `${itemIcon} ${amtStr} • ${label} (1-Tap)`;

        const cbData = item.isExisting && item.id
            ? `relog_tx:${item.id}`
            : `relog_def:${type === "income" ? "inc" : "exp"}:${item.amount}:${item.currency}:${item.category}`;

        keyboard.push([{ text: buttonText, callback_data: cbData }]);
    }

    keyboard.push([
        { text: "‹ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    const title = isIncome ? "💰 *Add Income*" : "🧾 *Add Expense*";
    const subheader = favorites && favorites.length > 0
        ? `Tap a recent favorite to re-log in 1 second, or type/speak:`
        : `Tap a quick preset to log in 1 second, or type/speak:`;

    const bullets = isIncome
        ? [
            `• \`+500 salary\``,
            `• \`40$ income freelance\``,
            `• \`earned $50 bonus\``,
            ``,
            `💡 *Tip:* Hold the 🎙️ mic button to speak naturally!`
        ]
        : [
            `• \`5 coffee\``,
            `• \`12000 lunch\``,
            `• \`3.50 grab\``,
            `• \`40 gas\``,
            ``,
            `💡 *Tip:* Hold 🎙️ mic or snap an ABA / KHQR receipt photo!`
        ];

    const text = [
        title,
        ``,
        subheader,
        ...bullets
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function sendAmountPicker(env, chatId, category, type = "expense", userId, messageId = null) {
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
        ``,
        `● *Category:* ${icon} *${capitalize(category)}*`,
        ``,
        `_Choose an amount below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

export async function sendTransactionReceipt(env, chatId, userId, type, amount, currency, category, messageId = null, extra = {}) {
    // Graceful support if caller passed options as 8th argument
    if (messageId && typeof messageId === "object" && !extra.txId && !extra.merchant && !extra.note) {
        extra = messageId;
        messageId = null;
    }

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
    const cambodiaTime = formatCambodiaDateTime(extra.customDate || null);

    const [displayCurrency, todayTotalRow, budgetStatus] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        env.DB.prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) as total FROM expenses WHERE user_id = ? AND date = ? AND type = 'expense'`
        ).bind(userId, today()).first(),
        !isIncome ? getBudgetStatus(env.DB, userId) : Promise.resolve(null)
    ]);
    const todaySpentKhr = todayTotalRow?.total || 0;
    const todaySpentStr = formatAmount(todaySpentKhr, displayCurrency);

    const header = isIncome ? "＋ *Income Recorded*" : "－ *Expense Recorded*";
    const lines = [
        header,
        ``,
        `● *Amount:*      \`${mainAmt}\`${altAmt}`,
        `● *Category:*    ${icon} *${capitalize(category)}*`,
        extra.merchant ? `● *Merchant:*    🏪 *${cleanMd(extra.merchant)}*` : null,
        extra.note ? `● *Note:*        📝 _${cleanMd(extra.note)}_` : null,
        `● *Date & Time:* 📅 \`${cambodiaTime.full} ICT\``,
        `● *Spent Today:* \`${todaySpentStr}\``
    ].filter(Boolean);

    if (budgetStatus) {
        lines.push(``);
        if (budgetStatus.isOver) {
            const overAmt = formatAmount(budgetStatus.spentKhr - budgetStatus.budgetKhr, displayCurrency);
            lines.push(`🚨 *Over Budget:* \`${budgetStatus.bar}\` *${budgetStatus.percent}%*`);
            lines.push(`   └ Over by *${overAmt}* (Limit: ${budgetStatus.budgetStr})`);
        } else {
            lines.push(`📊 *Monthly Budget:* \`${budgetStatus.bar}\` *${budgetStatus.percent}%*`);
            lines.push(`   └ [${budgetStatus.spentStr} / ${budgetStatus.budgetStr}] • \`${budgetStatus.safeDailyStr}/day\` safe`);
        }
    }

    const addAnotherCb = isIncome ? "add_income" : "add_expense";
    const addAnotherText = isIncome ? "＋ Add More" : "＋ Add Another";

    const inlineKeyboard = [
        [
            { text: addAnotherText, callback_data: addAnotherCb },
            { text: "📜 Today's Ledger", callback_data: "view_transactions" }
        ]
    ];

    const actionRow = [];
    if (extra.txId) {
        actionRow.push({ text: "❌ Undo", callback_data: `undo_tx:${extra.txId}` });
    }
    actionRow.push({ text: "💳 Finance", callback_data: "finance_hub" });
    inlineKeyboard.push(actionRow);
    inlineKeyboard.push([{ text: "🏠 Main Hub", callback_data: "hub" }]);

    await safeEditOrSendMessage(env, chatId, messageId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: inlineKeyboard
        }
    });
}

export async function sendTransactions(env, chatId, userId, messageId = null) {
    const date = today();
    const cambodiaDate = formatCambodiaDateTime().date;
    const [displayCurrency, { results }] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        env.DB.prepare(
            "SELECT id, amount, category, type, currency, merchant, note, created_at FROM expenses WHERE user_id = ? AND date = ? ORDER BY id ASC"
        ).bind(userId, date).all()
    ]);

    if (!results || !results.length) {
        await safeEditOrSendMessage(env, chatId, messageId, [
            `📋 *Today's Ledger*`,
            `📅 \`${cambodiaDate} • Phnom Penh\``,
            ``,
            `_No transactions recorded today yet._`,
            ``,
            `_Tap below to log your first transaction today!_`
        ].join("\n"), {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "＋ Log Expense", callback_data: "add_expense" },
                        { text: "＋ Log Income", callback_data: "add_income" }
                    ],
                    [
                        { text: "📊 Month Insights", callback_data: "summary_month" },
                        { text: "📜 All History", callback_data: "history:1" }
                    ],
                    [
                        { text: "‹ Back to Finance", callback_data: "finance_hub" },
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
        const amtKhr = row.currency === "USD" ? row.amount * EXCHANGE_RATE : row.amount;

        if (isIncome) totalIncome += amtKhr;
        else totalExpense += amtKhr;

        // Primary amount formatted in user's active display currency
        let mainAmtStr = "";
        let altAmtStr = "";
        if (displayCurrency === "USD") {
            const usdVal = amtKhr / EXCHANGE_RATE;
            mainAmtStr = `${sign}$${formatMoney(usdVal, 2)}`;
            if (row.currency === "KHR") {
                altAmtStr = ` _(${formatMoney(row.amount)} ៛)_`;
            }
        } else {
            mainAmtStr = `${sign}${formatMoney(amtKhr)} ៛`;
            if (row.currency === "USD") {
                altAmtStr = ` _($${formatMoney(row.amount, 2)})_`;
            }
        }

        const timeStr = row.created_at ? formatTimeFromCreatedAt(row.created_at) : "";
        const timeBadge = timeStr ? `\`${timeStr}\` • ` : "";
        const merchantDetail = row.merchant ? ` (${cleanMd(row.merchant)})` : "";
        return `• ${timeBadge}${icon} \`${mainAmtStr}\` • ${capitalize(row.category)}${merchantDetail}${altAmtStr}`;
    });

    const netKhr = totalIncome - totalExpense;
    const isNegative = netKhr < 0;
    const netStatus = isNegative ? "🔴 _(in the red)_" : "🟢 _(in the green)_";
    const forceDecimals = displayCurrency === "USD";

    const incomeVal = formatAmount(totalIncome, displayCurrency, forceDecimals).replace(/^[+-]/, "");
    const spentVal = formatAmount(totalExpense, displayCurrency, forceDecimals).replace(/^[+-]/, "");
    const netFormatted = formatAmount(netKhr, displayCurrency, forceDecimals);
    const netSign = netKhr > 0 ? "+" : "";
    const netStr = `${netSign}${netFormatted}`;

    const message = [
        `📋 *Today's Ledger*`,
        `📅 \`${cambodiaDate} • Phnom Penh\``,
        ``,
        ...lines,
        ``,
        `💵 *Income:* \`+${incomeVal}\``,
        `💸 *Spent:*  \`${spentVal}\``,
        `💳 *Net:*    \`${netStr}\` ${netStatus}`
    ].join("\n");

    const keyboard = [];

    // Row 1: Add Entry + Quick Undo Last
    const topRow = [
        { text: "＋ Add Entry", callback_data: "add_expense" }
    ];
    if (results.length > 0) {
        const lastTx = results[results.length - 1];
        topRow.push({ text: "❌ Undo Last", callback_data: `undo_tx:${lastTx.id}` });
    }
    keyboard.push(topRow);

    // Row 2: Month Insights (no truncation) + All History
    keyboard.push([
        { text: "📊 Month Insights", callback_data: "summary_month" },
        { text: "📜 All History", callback_data: "history:1" }
    ]);

    // Row 3: Navigation
    keyboard.push([
        { text: "‹ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

export async function sendSummary(env, chatId, userId, period = "month", messageId = null) {
    const safePeriod = "month";
    const [displayCurrency, stats, breakdown, budgetStatus] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        getPeriodStats(env.DB, userId, safePeriod),
        getCategoryRows(env.DB, userId, safePeriod, 5),
        getBudgetStatus(env.DB, userId)
    ]);

    const title = `Monthly Insights (${monthLabel()})`;

    const lines = [
        `📊 *${title}*`,
        ``,
        `● *Total Spent:*   \`${formatAmount(stats.total, displayCurrency)}\``,
        `● *Average / Tx:*  \`${formatAmount(stats.average, displayCurrency)}\``,
        `● *Entries:*       \`${stats.count} transactions\``
    ];

    if (stats.maxAmount) {
        const maxKhr = stats.maxCurrency === "USD" ? stats.maxAmount * EXCHANGE_RATE : stats.maxAmount;
        const icon = getCategoryIcon(stats.maxCategory, "expense");
        lines.push(`● *Biggest Spend:* \`${formatAmount(maxKhr, displayCurrency)}\` (${icon} ${capitalize(stats.maxCategory)})`);
    }

    if (budgetStatus) {
        lines.push(
            `● *Monthly Budget:* \`${budgetStatus.bar}\` *${budgetStatus.percent}%*`,
            `   └ [${budgetStatus.spentStr} / ${budgetStatus.budgetStr}] • \`${budgetStatus.safeDailyStr}/day\` safe`
        );
    }

    if (breakdown.length) {
        lines.push(``, `🏷️ *Category Breakdown:*`);
        breakdown.forEach((row) => {
            const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
            const bar = generateTextProgressBar(percent);
            const icon = getCategoryIcon(row.category, "expense");
            lines.push(`${icon} *${capitalize(row.category)}:* ${bar} \`${formatAmount(row.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    await safeEditOrSendMessage(env, chatId, messageId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📋 Today's Ledger", callback_data: "view_transactions" },
                    { text: "💳 Finance Hub", callback_data: "finance_hub" }
                ],
                [
                    { text: "‹ Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendCategoryBreakdown(env, chatId, userId, period) {
    const [displayCurrency, rows, stats] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        getCategoryRows(env.DB, userId, period, 10),
        getPeriodStats(env.DB, userId, period)
    ]);
    const title = period === "month" ? `Monthly Category Breakdown (${monthLabel()})` : `Daily Category Breakdown (${today()})`;

    if (!rows.length) {
        await sendMessage(env, chatId, "No category data recorded yet.");
        return;
    }

    const lines = [`📊 *${title}*`, ``];
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

export async function sendHistory(env, chatId, userId, page = 1) {
    const { text, replyMarkup } = await getHistoryMessageData(env.DB, userId, page);
    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: replyMarkup
    });
}

export async function updateHistoryMessage(env, chatId, userId, messageId, page = 1) {
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

export async function getHistoryMessageData(db, userId, page = 1) {
    const limit = 10;
    const requestedPage = Math.max(1, page);
    const [countRow, res] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?").bind(userId).first(),
        db.prepare(
            `SELECT id, amount, category, type, currency, date, merchant, note, created_at 
             FROM expenses 
             WHERE user_id = ? 
             ORDER BY date DESC, id DESC 
             LIMIT ? OFFSET ?`
        ).bind(userId, limit, (requestedPage - 1) * limit).all()
    ]);
    const results = res?.results || [];
    const totalCount = countRow?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.min(requestedPage, totalPages);

    if (!results || results.length === 0) {
        return {
            text: "📜 *All Transactions (History)*\n\n_No transactions recorded yet._",
            replyMarkup: {
                inline_keyboard: [
                    [
                        { text: "📋 Today's Ledger", callback_data: "view_transactions" },
                        { text: "‹ Back to Finance", callback_data: "finance_hub" }
                    ],
                    [
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
        const amtStr = `${sign}${symbol}${formatMoney(row.amount)}${suffix}`;
        const timeStr = row.created_at ? formatTimeFromCreatedAt(row.created_at) : "";
        const timeBadge = timeStr ? `\`${timeStr}\` ` : "";
        const merchantDetail = row.merchant ? ` (${cleanMd(row.merchant)})` : "";
        return `• \`${row.date}\` ${timeBadge}${icon} \`${amtStr}\` • ${capitalize(row.category)}${merchantDetail}`;
    });

    const text = [
        `📜 *All Transactions (History)*`,
        `📖 Page ${currentPage} of ${totalPages} (${totalCount} total)`,
        ``,
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
        { text: "📋 Today's Ledger", callback_data: "view_transactions" },
        { text: "📊 Month Insights", callback_data: "summary_month" }
    ]);
    inlineKeyboard.push([
        { text: "‹ Back to Finance", callback_data: "finance_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    return {
        text,
        replyMarkup: { inline_keyboard: inlineKeyboard }
    };
}

export function generatePieChartUrl(categories, totalSpentStr) {
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

export async function sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, titleLabel) {
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

    const [biggest, categories, displayCurrency] = await Promise.all([
        env.DB.prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
             LIMIT 1`
        ).bind(userId, startDate, endDate).first(),
        env.DB.prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) AS total
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             GROUP BY LOWER(category)
             ORDER BY total DESC`
        ).bind(userId, startDate, endDate).all(),
        getDisplayCurrency(env.DB, userId)
    ]);

    const catResults = categories?.results || [];
    const totalSpentStr = formatAmount(total, displayCurrency);
    const chartUrl = generatePieChartUrl(catResults, totalSpentStr);

    const textLines = [
        `📊 *${titleLabel}*`,
        `📅 \`${startDate}\` to \`${endDate}\``,
        ``,
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
        await telegram(env, "sendPhoto", payload);
    } catch (err) {
        console.warn("Telegram sendPhoto failed, falling back to message:", err.message);
        await sendMessage(env, chatId, caption, { parse_mode: "Markdown" });
    }
}

export async function sendWeeklyScheduledReports(env) {
    if (env.DB) await ensureTables(env.DB);
    const todayStr = today();
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
                if (!isUserAuthorized(row.user_id, env)) continue;

                const canSend = await claimDailyBroadcast(env.DB, row.user_id, "weekly_report", todayStr);
                if (!canSend) continue;

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
