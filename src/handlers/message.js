import { today, dateDaysAgo } from "../utils/time.js";
import { formatAmount } from "../utils/format.js";
import { sendMessage } from "../services/telegram.js";
import { getDisplayCurrency, getTotalExpenses, addExpenseRecord } from "../db/queries.js";

// Hub
import { sendMainHub, sendHelpMessage, sendSettingsMenu } from "../modules/hub/views.js";

// Finance
import {
    sendFinanceHub,
    sendTransactions,
    sendSummary,
    sendCategoryBreakdown,
    sendHistory,
    sendCategoryPicker,
    sendTransactionReceipt,
    sendWeeklyReportForUser
} from "../modules/finance/views.js";
import {
    addTransactionFromCommand,
    handleBudgetCommand,
    askClearConfirmation,
    handleExportLedgerCommand,
    handleSearchExpensesCommand
} from "../modules/finance/commands.js";
import {
    handleImageReceipt,
    sendScanHelp
} from "../modules/finance/scanner.js";

// Work
import {
    sendWorkHub,
    sendStandupReport,
    sendStandupCopyBlock,
    handleAiPolishStandup,
    handleAiPolishWorkReport
} from "../modules/work/views.js";
import {
    handleAddWorkLogCommand,
    handleReportCommand
} from "../modules/work/commands.js";

// Reminders
import {
    sendRemindersMenu
} from "../modules/reminders/views.js";
import {
    handleLunchboxCommand,
    handleRemindCommand
} from "../modules/reminders/commands.js";

// Voice & Copilot
import { sendVoiceHelp, handleVoiceMessage } from "../modules/voice/handler.js";
import { handleAiCopilotQuery, sendFridayTacticalBriefing } from "../modules/copilot/handler.js";

export async function handleMessage(message, env, origin) {
    const rawText = (message.text || "").trim();
    // Normalize command by stripping bot username suffix if present (e.g., /today@my_bot -> /today)
    const text = rawText.startsWith("/")
        ? rawText.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1")
        : rawText;
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const chatType = message.chat?.type || "private";
    const isGroup = chatType === "group" || chatType === "supergroup";

    // 0. Smart Bank Slip & Receipt Scanner (Photo or Image Document)
    if (message.photo || (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/"))) {
        await handleImageReceipt(message, env, origin);
        return;
    }

    // 0.1. 🎙️ Voice Note & Audio Transcription (Workers AI Whisper + Gemini Multimodal Fallback)
    if (message.voice || message.audio || (message.document && message.document.mime_type && message.document.mime_type.startsWith("audio/"))) {
        await handleVoiceMessage(message, env, origin, handleMessage);
        return;
    }

    if (text === "/voice" || text === "/mic" || text === "/audio") {
        await sendVoiceHelp(env, chatId);
        return;
    }

    if (text === "/scan" || text === "/receipt" || text === "/ocr" || text === "/slip") {
        await sendScanHelp(env, chatId);
        return;
    }

    // 0.4 🤖 F.R.I.D.A.Y. Tactical Briefing & Commands
    if (
        text === "/friday" || 
        text === "/briefing" || 
        text === "/brief" || 
        text === "/status" || 
        text.startsWith("/friday ") || 
        text.startsWith("/briefing ")
    ) {
        const sub = text.replace(/^\/(friday|briefing|brief|status)(@\w+)?\s*/i, "").trim();
        if (sub) {
            await handleAiCopilotQuery(env, chatId, userId, sub, message.from, null, message.isFromVoice || false);
        } else {
            await sendFridayTacticalBriefing(env, chatId, userId, { withVoice: message.isFromVoice || false });
        }
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
        await handleAiCopilotQuery(env, chatId, userId, query, message.from, null, message.isFromVoice || false);
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

    // 3. Movie Watchlist (Retired for focus)
    if (
        text.startsWith("/watch") || 
        text.startsWith("/movie") || 
        text.startsWith("/film") || 
        text.startsWith("/watchlist") || 
        text.startsWith("/wl")
    ) {
        await sendMessage(
            env,
            chatId,
            `💡 *Streamlined Workspace*\n\nThe entertainment watchlist has been removed to keep this bot fast and focused on *Cashflow & Work Productivity*.\n\nUse \`/hub\` to view your active workspaces.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🌟 Open Hub", callback_data: "hub" }]]
                }
            }
        );
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

    if (text === "/export" || text.startsWith("/export ") || text === "/backup") {
        await handleExportLedgerCommand(env, chatId, userId);
        return;
    }

    if (text.startsWith("/find") || text.startsWith("/search")) {
        await handleSearchExpensesCommand(env, chatId, userId, text);
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
        // In group chats, ignore arbitrary conversational text unless directly replying to the bot
        if (isGroup && !message.reply_to_message?.from?.is_bot) {
            return;
        }

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
            await handleReportCommand(env, chatId, userId, "/report", message.from);
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
        // Conversational phrases checked first before greedy category match
        const expMatch3 = text.match(/^(?:i\s+)?(?:spent|paid|bought)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?\s*(?:on|for)?\s*([a-zA-Z\s]+)$/i);
        const expMatch4 = text.match(/^(?:i\s+)?(?:spent|paid|bought)\s+([a-zA-Z\s]+)\s+(?:for|at)?\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?$/i);
        const expMatch1 = text.match(/^(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s+([a-zA-Z\s]+)$/i);
        const expMatch2 = text.match(/^([a-zA-Z\s]+)\s+(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?$/i);

        let amount = null;
        let category = null;
        let currencyHint = null;

        if (expMatch3) {
            amount = Number(expMatch3[1].replace("$", ""));
            currencyHint = expMatch3[2] || (expMatch3[1].includes("$") ? "USD" : null);
            category = expMatch3[3].trim();
        } else if (expMatch4) {
            amount = Number(expMatch4[2].replace("$", ""));
            currencyHint = expMatch4[3] || (expMatch4[2].includes("$") ? "USD" : null);
            category = expMatch4[1].trim();
        } else if (expMatch1) {
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
                if (cUpper === "$" || cUpper === "USD" || cUpper === "DOLLARS") curr = "USD";
                else if (cUpper === "KHR" || cUpper === "RIEL") curr = "KHR";
            } else {
                if (amount >= 500) curr = "KHR";
                else curr = "USD";
            }
            await addExpenseRecord(env.DB, userId, amount, category, "expense", curr);
            await sendTransactionReceipt(env, chatId, userId, "expense", amount, curr, category);
            return;
        }

        // 6. Natural Language F.R.I.D.A.Y. AI Copilot fallback (or friendly guidance if AI not configured)
        if (env.GEMINI_API_KEY || env.AI) {
            let queryText = text;
            if (/^(?:hey\s+)?friday[,:]?\s+/i.test(queryText)) {
                queryText = queryText.replace(/^(?:hey\s+)?friday[,:]?\s+/i, "");
            }
            await handleAiCopilotQuery(env, chatId, userId, queryText, message.from, null, message.isFromVoice || false);
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
