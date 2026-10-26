import { today, dateDaysAgo } from "../utils/time.js";
import { formatAmount } from "../utils/format.js";
import { isUserAuthorized } from "../config/constants.js";
import { sendMessage, sendTelegramVoice } from "../services/telegram.js";
import { generateSpeechAudio } from "../services/ai.js";
import {
    getDisplayCurrency,
    getTotalExpenses,
    addExpenseRecord,
    deleteLastTransaction,
    getUserMemories,
    saveUserMemory,
    deleteUserMemory,
    clearUserMemories,
    clearChatHistory,
    getUserVoiceMode,
    setUserVoiceMode,
    getUserBriefingMode,
    setUserBriefingMode,
    getLastModelChatMessage
} from "../db/queries.js";
import { isConversationalOrCorrection, isCompoundOrMultiAction, parseNaturalIncome, parseNaturalExpense } from "../utils/natural.js";

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

// Work & Tasks
import {
    handleAddWorkLogCommand,
    handleListTodayTasksCommand
} from "../modules/work/commands.js";

// Reminders
import {
    sendRemindersMenu
} from "../modules/reminders/views.js";
import {
    handleRemindCommand
} from "../modules/reminders/commands.js";

// Voice & Copilot
import { sendVoiceHelp, handleVoiceMessage } from "../modules/voice/handler.js";
import { handleAiCopilotQuery, sendFridayTacticalBriefing } from "../modules/copilot/handler.js";

export async function handleUndoLastTransaction(env, chatId, userId) {
    const deleted = await deleteLastTransaction(env.DB, userId);
    if (!deleted) {
        await sendMessage(
            env,
            chatId,
            `ℹ️ *No Recent Transactions Found*\n\nBoss, there are no recorded transactions in your ledger to undo.`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    const curr = deleted.currency || "USD";
    const symbol = curr === "USD" ? "$" : "";
    const suffix = curr === "KHR" ? " ៛" : "";
    const formattedVal = `${symbol}${deleted.amount}${suffix}`;
    const typeLabel = deleted.type === "income" ? "Income" : "Expense";
    const typeEmoji = deleted.type === "income" ? "🟢" : "💸";

    await sendMessage(
        env,
        chatId,
        [
            `🗑️ *Transaction Undone*`,
            `────────────────────`,
            `${typeEmoji} *Type:* ${typeLabel}`,
            `💵 *Amount:* \`${formattedVal}\``,
            `🏷️ *Category:* *${deleted.category}*`,
            `📅 *Date:* \`${deleted.date}\``,
            `────────────────────`,
            `_Successfully removed from your ledger._`
        ].join("\n"),
        { parse_mode: "Markdown" }
    );
}

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

    // Enforce strict personal assistant access control
    if (userId && !isUserAuthorized(userId, env)) {
        if (!isGroup) {
            await sendMessage(
                env,
                chatId,
                `⛔ *Access Restricted*\n────────────────────\nThis assistant is private and configured for authorized personal use only.`,
                { parse_mode: "Markdown" }
            ).catch(() => {});
        }
        return;
    }

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

    if (
        text === "/voice on" || 
        text === "/speak on" || 
        text === "/audio on" ||
        text.startsWith("/voice on") ||
        text.startsWith("/speak on")
    ) {
        await setUserVoiceMode(env.DB, userId, "on");
        await sendMessage(
            env,
            chatId,
            `🎙️ *Auto-Voice Mode: ENABLED*\n────────────────────\nBoss, I will now speak back with neural audio notes for every response. You won't have to read long texts anymore!\n\n_Type \`/voice off\` anytime to return to standard text mode._`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                }
            }
        );
        return;
    }

    if (
        text === "/voice off" || 
        text === "/speak off" || 
        text === "/audio off" ||
        text.startsWith("/voice off") ||
        text.startsWith("/speak off")
    ) {
        await setUserVoiceMode(env.DB, userId, "off");
        await sendMessage(
            env,
            chatId,
            `📝 *Auto-Voice Mode: DISABLED*\n────────────────────\nSwitched back to standard text. Each message will still have a \`🔊 Read Aloud\` button if you're lazy to read!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                }
            }
        );
        return;
    }

    if (text === "/voice" || text === "/mic" || text === "/audio") {
        const mode = await getUserVoiceMode(env.DB, userId);
        const modeStatus = mode === "on" ? "🟢 *ENABLED* (Always Speaking)" : "⚪ *DISABLED* (Text + On-demand Voice)";
        await sendMessage(
            env,
            chatId,
            `🎙️ *F.R.I.D.A.Y. • Voice Synthesis & Hearing*\n────────────────────\nCurrent Mode: ${modeStatus}\n\n💡 *Voice Shortcuts:*\n• \`/voice on\` — Speak back automatically to every query\n• \`/voice off\` — Standard text mode with on-demand voice buttons\n• \`/speak\` — Read aloud my last response\n• \`/speak <query>\` — Ask a question and hear the answer\n• Hold 🎙️ mic button — Speak in English or Khmer (*អក្សរខ្មែរ*)`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: mode === "on" ? "📝 Turn Voice OFF" : "🎙️ Turn Voice ON", callback_data: "toggle_voice_mode" }
                        ],
                        [
                            { text: "🔊 Read Aloud Last Msg", callback_data: "speak_last" },
                            { text: "🏠 Main Hub", callback_data: "hub" }
                        ]
                    ]
                }
            }
        );
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
        const sub = text.replace(/^\/(friday|briefing|brief|status)(@\w+)?\s*/i, "").trim().toLowerCase();
        if (sub === "on") {
            await setUserBriefingMode(env.DB, userId, "on");
            await sendMessage(
                env,
                chatId,
                `🟢 *Morning Briefing: ENABLED*\n\nFriday will broadcast your daily tactical briefing at 08:00 AM ICT with audio transmission.`,
                { parse_mode: "Markdown" }
            );
            return;
        }
        if (sub === "off") {
            await setUserBriefingMode(env.DB, userId, "off");
            await sendMessage(
                env,
                chatId,
                `🔕 *Morning Briefing: DISABLED*\n\nAutomated 08:00 AM broadcasts are paused. You can still ask for a briefing anytime with \`/briefing\`.`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        const wantsVoice = message.isFromVoice || /\b(voice|audio|speak|talk)\b/i.test(sub);
        if (sub && !/^(voice|audio)$/i.test(sub)) {
            await handleAiCopilotQuery(env, chatId, userId, sub, message.from, null, wantsVoice);
        } else {
            await sendFridayTacticalBriefing(env, chatId, userId, { withVoice: wantsVoice });
        }
        return;
    }

    // 0.45 🗣️ Direct Speech Command (/speak, /say, /talk)
    if (
        text.startsWith("/speak") || 
        text.startsWith("/say") || 
        text.startsWith("/talk") ||
        text === "/speak" ||
        text === "/say" ||
        text === "/talk"
    ) {
        const query = text.replace(/^\/(speak|say|talk)(@\w+)?\s*/i, "").trim();

        // 1. If Boss replied to a message with /speak, read that replied message aloud!
        const repliedText = message.reply_to_message?.text;
        if (repliedText) {
            try {
                const audioBuffer = await generateSpeechAudio(repliedText);
                if (audioBuffer) {
                    await sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission");
                    return;
                }
            } catch (e) {
                console.warn("Failed to speak replied message:", e);
            }
        }

        // 2. If Boss just typed /speak without any query, read Friday's last response aloud!
        if (!query) {
            const lastMessage = await getLastModelChatMessage(env.DB, userId);
            if (lastMessage) {
                try {
                    const audioBuffer = await generateSpeechAudio(lastMessage);
                    if (audioBuffer) {
                        await sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission");
                        return;
                    }
                } catch (e) {
                    console.warn("Failed to speak last model message:", e);
                }
            }

            // Fallback: If no chat history exists, speak tactical briefing
            await sendFridayTacticalBriefing(env, chatId, userId, { withVoice: true });
            return;
        }

        // 3. Boss typed /speak <question>: answer and speak back concurrently!
        await handleAiCopilotQuery(env, chatId, userId, query, message.from, null, true);
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

    // 0.6. 🧠 F.R.I.D.A.Y. Long-Term Memory & Context Management
    if (text.startsWith("/remember") || text.startsWith("/memorize")) {
        const fact = text.replace(/^\/(remember|memorize)(@\w+)?\s*/i, "").trim();
        if (!fact) {
            await sendMessage(
                env,
                chatId,
                `🧠 *F.R.I.D.A.Y. • Memory Matrix*\n────────────────────\nTeach me preferences, work rules, or facts about you!\n\n💡 *Usage Examples:*\n• \`/remember I only drink iced Americano with no sugar\`\n• \`/remember My work hours are 08:30 to 17:30\`\n• \`/remember My manager is Alex\`\n\n_I will remember this across all our conversations!_`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        let category = "preference";
        if (/\b(work|job|boss|standup|company|office|team|client|project|manager)\b/i.test(fact)) {
            category = "work";
        } else if (/\b(name|call me|live in|birthday|age|identity)\b/i.test(fact)) {
            category = "identity";
        } else if (/\b(goal|target|plan|aim|aspire|saving for)\b/i.test(fact)) {
            category = "goal";
        } else if (/\b(rule|never|always|do not|don't|must)\b/i.test(fact)) {
            category = "rule";
        }

        await saveUserMemory(env.DB, userId, fact, category);
        await sendMessage(
            env,
            chatId,
            `🧠 *Memory Matrix Updated*\n────────────────────\nCommitted to long-term memory, Boss:\n\n🏷️ *Category:* \`${category.toUpperCase()}\`\n📝 *Fact:* _"${fact}"_\n\n_Type \`/memory\` anytime to inspect what I remember about you._`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🧠 View All Memories", callback_data: "view_memories" },
                            { text: "🏠 Main Hub", callback_data: "hub" }
                        ]
                    ]
                }
            }
        );
        return;
    }

    if (text === "/memory" || text === "/memories" || text.startsWith("/memory ") || text.startsWith("/memories ")) {
        const memories = await getUserMemories(env.DB, userId, 25);
        if (!memories || memories.length === 0) {
            await sendMessage(
                env,
                chatId,
                `🧠 *F.R.I.D.A.Y. • Long-Term Memory*\n────────────────────\nNo personal memories stored yet, Boss.\n\nTeach me by typing:\n• \`/remember <fact>\`\n• Or tell me in chat: _"Friday, remember that I prefer black coffee"_\n\nI adapt my tone and suggestions based on what you share!`,
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                    }
                }
            );
            return;
        }

        const lines = memories.map(m => {
            const catEmoji = m.category === "work" ? "💼" :
                             m.category === "identity" ? "👤" :
                             m.category === "goal" ? "🎯" :
                             m.category === "rule" ? "⚠️" : "✨";
            return `${catEmoji} *#${m.id}* [${(m.category || "pref").toUpperCase()}]: ${m.fact}`;
        });

        const card = [
            `🧠 *F.R.I.D.A.Y. • Long-Term Memory Matrix*`,
            `────────────────────`,
            `Here are the personal facts and directives I keep on record:`,
            ``,
            ...lines,
            ``,
            `────────────────────`,
            `💡 *Management Controls:*`,
            `• Delete single: \`/forget <id>\` (e.g. \`/forget ${memories[0].id}\`)`,
            `• Wipe all: \`/forget all\``,
            `• Add new: \`/remember <fact>\``
        ].join("\n");

        await sendMessage(env, chatId, card, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🗑️ Wipe Memories", callback_data: "clear_memories_warn" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    if (text.startsWith("/forget")) {
        const arg = text.replace(/^\/forget(@\w+)?\s*/i, "").trim().toLowerCase();
        if (!arg) {
            await sendMessage(
                env,
                chatId,
                `💡 *Forget Command Usage:*\n• \`/forget <id>\` — Remove a specific memory (see \`/memory\` for IDs)\n• \`/forget all\` — Wipe all stored memories`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        if (arg === "all" || arg === "clear") {
            await clearUserMemories(env.DB, userId);
            await sendMessage(
                env,
                chatId,
                `🗑️ *Memory Matrix Wiped*\n\nAll personal preferences and remembered facts have been erased, Boss. Starting with a clean slate.`,
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                    }
                }
            );
            return;
        }

        const memId = parseInt(arg.replace("#", ""), 10);
        if (isNaN(memId) || memId <= 0) {
            await sendMessage(env, chatId, "⚠️ Please provide a valid memory ID number, e.g. `/forget 3` (check `/memory` to view IDs).", { parse_mode: "Markdown" });
            return;
        }

        const success = await deleteUserMemory(env.DB, userId, memId);
        if (success) {
            await sendMessage(
                env,
                chatId,
                `✅ Memory *#${memId}* erased from memory matrix, Boss.`,
                { parse_mode: "Markdown" }
            );
        } else {
            await sendMessage(
                env,
                chatId,
                `⚠️ Memory *#${memId}* not found. Check \`/memory\` for current IDs.`,
                { parse_mode: "Markdown" }
            );
        }
        return;
    }

    if (text === "/reset" || text === "/newchat" || text === "/clearhistory") {
        await clearChatHistory(env.DB, userId);
        await sendMessage(
            env,
            chatId,
            `🧹 *Conversation Buffer Flushed*\n────────────────────\nActive multi-turn context has been reset, Boss.\n\n_(Note: Your long-term \`/memory\` and financial ledgers remain completely safe and intact.)_\n\nReady for your next command.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🛡️ Tactical Briefing", callback_data: "friday_briefing" },
                            { text: "🏠 Main Hub", callback_data: "hub" }
                        ]
                    ]
                }
            }
        );
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

    // 2. Work & Tasks Workspace
    if (text === "/tasks" || text === "/task" || text === "/work" || text === "/worklog" || text === "/w") {
        await handleListTodayTasksCommand(env, chatId, userId);
        return;
    }

    if (text.startsWith("/done") || text.startsWith("/did") || text.startsWith("/log")) {
        const parts = text.split(/\s+/);
        if (parts.length === 1) {
            await handleListTodayTasksCommand(env, chatId, userId);
            return;
        }
        await handleAddWorkLogCommand(env, chatId, userId, text, message.from);
        return;
    }

    // 3. Reminders & Alarms Commands
    if (text.startsWith("/remind") || text.startsWith("/alarm")) {
        await handleRemindCommand(env, chatId, userId, text);
        return;
    }

    if (text === "/reminders" || text === "/reminder" || text === "/r") {
        await sendRemindersMenu(env, chatId, userId);
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

    if (text === "/undo" || text === "/cancel") {
        await handleUndoLastTransaction(env, chatId, userId);
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

        // 0. Compound Multi-Action Voice & Text Commands (Direct to AI Copilot)
        // e.g. "Hey Friday, I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review design, and note down that she loves matcha"
        if (isCompoundOrMultiAction(text)) {
            if (env.GEMINI_API_KEY || env.AI) {
                let queryText = text;
                if (/^(?:hey\s+)?friday[,:]?\s+/i.test(queryText)) {
                    queryText = queryText.replace(/^(?:hey\s+)?friday[,:]?\s+/i, "");
                }
                const wantsVoice = message.isFromVoice || /\b(speak to me|talk to me|in voice|by voice|voice note|say it)\b/i.test(text);
                await handleAiCopilotQuery(env, chatId, userId, queryText, message.from, null, wantsVoice);
                return;
            }
        }

        // 1. Natural Navigation Keywords
        if (lower === "menu" || lower === "hub" || lower === "start" || lower === "hi" || lower === "hello" || lower === "hey") {
            await sendMainHub(env, chatId, userId, message.from, origin);
            return;
        }

        if (lower === "work" || lower === "tasks" || lower === "task") {
            await handleListTodayTasksCommand(env, chatId, userId);
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

        if (lower === "reminder" || lower === "reminders" || lower === "alarm" || lower === "alarms") {
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

        // 4. Natural Undo / Delete Last
        if (
            lower === "undo" || 
            lower === "undo last" || 
            lower === "undo that" || 
            lower === "delete last" || 
            lower === "delete last transaction" || 
            lower === "delete last expense" ||
            lower === "delete last income" ||
            lower === "cancel last"
        ) {
            await handleUndoLastTransaction(env, chatId, userId);
            return;
        }

        // 5. Natural Income: e.g. "+500 salary", "income 500", "40$ income", "500$ salary", "earned $50 freelance"
        const incData = parseNaturalIncome(text);
        if (incData) {
            let curr = await getDisplayCurrency(env.DB, userId);
            if (incData.currency) {
                curr = incData.currency;
            } else if (incData.amount < 100) {
                curr = "USD";
            }
            await addExpenseRecord(env.DB, userId, incData.amount, incData.category, "income", curr);
            await sendTransactionReceipt(env, chatId, userId, "income", incData.amount, curr, incData.category);
            return;
        }

        // 6. Natural Expense: e.g. "5 coffee", "$5 coffee", "5$ coffee", "10000 lunch", "coffee 5", "spent $15 on dinner"
        const expData = parseNaturalExpense(text);
        if (expData) {
            let curr = await getDisplayCurrency(env.DB, userId);
            if (expData.currency) {
                curr = expData.currency;
            } else {
                if (expData.amount >= 500) curr = "KHR";
                else curr = "USD";
            }
            await addExpenseRecord(env.DB, userId, expData.amount, expData.category, "expense", curr);
            await sendTransactionReceipt(env, chatId, userId, "expense", expData.amount, curr, expData.category);
            return;
        }

        // 6. Natural Language F.R.I.D.A.Y. AI Copilot fallback (or friendly guidance if AI not configured)
        if (env.GEMINI_API_KEY || env.AI) {
            let queryText = text;
            if (/^(?:hey\s+)?friday[,:]?\s+/i.test(queryText)) {
                queryText = queryText.replace(/^(?:hey\s+)?friday[,:]?\s+/i, "");
            }
            const wantsVoice = message.isFromVoice || /\b(speak to me|talk to me|in voice|by voice|voice note|say it)\b/i.test(text);
            await handleAiCopilotQuery(env, chatId, userId, queryText, message.from, null, wantsVoice);
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
            `• View tasks: \`/tasks\`\n` +
            `• Log spend: \`5 coffee\` or \`10000 lunch\`\n` +
            `• Menu: /menu`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    if (text.startsWith("/")) {
        await sendMessage(env, chatId, "⚠️ Unknown command. Type /help to see all available commands, or /hub to open your Personal Assistant Hub.");
    }
}
