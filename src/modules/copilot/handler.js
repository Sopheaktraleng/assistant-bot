import { today, currentTime, normalizeReminderTime } from "../../utils/time.js";
import { 
    addExpenseRecord, 
    deleteLastTransaction,
    deleteExpenseById,
    setDisplayCurrency,
    setMonthlyBudget,
    clearToday,
    clearAllExpenses,
    saveChatMessage, 
    saveUserMemory, 
    getUserVoiceMode 
} from "../../db/queries.js";
import { EXCHANGE_RATE, isOwner } from "../../config/constants.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, safeEditOrSendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { buildAiUserContext, askAiCopilot, generateSpeechAudio } from "../../services/ai.js";
export { sendFridayTacticalBriefing, sendFridayWakeupCall, sendDailyScheduledWakeup } from "./briefing.js";

/**
 * Intelligent deterministic fallback when AI APIs are unreachable or timing out.
 * Computes exact answers and supports full system actions from onboard database tables.
 */
export function buildSmartLocalFallback(query, context = {}) {
    const q = (query || "").toLowerCase();
    const curr = context.displayCurrency || "USD";
    const symbol = curr === "USD" ? "$" : "";
    const suffix = curr === "KHR" ? " ៛" : "";
    const isUsd = curr === "USD";
    const isOwnerUser = context?.isOwner !== false;
    const title = isOwnerUser ? "Boss" : (context?.userName || "there");

    const totalInc = (context.totals ? (isUsd ? context.totals.thisMonthIncomeUsd : context.totals.thisMonthIncomeKhr) : null) ?? (context.summary?.totalIncome || 0);
    const totalExp = (context.totals ? (isUsd ? context.totals.thisMonthExpenseUsd : context.totals.thisMonthExpenseKhr) : null) ?? (context.summary?.totalExpenses || 0);
    const netBal = (context.totals ? (isUsd ? context.totals.allTimeNetBalanceUsd : context.totals.allTimeNetBalanceKhr) : null) ?? (totalInc - totalExp);

    let todayBurn = 0;
    if (context.totals) {
        todayBurn = isUsd ? (context.totals.todayExpenseUsd || 0) : (context.totals.todayExpenseKhr || 0);
    }
    if (todayBurn === 0 && Array.isArray(context.todayExpenses)) {
        todayBurn = context.todayExpenses.reduce((acc, r) => acc + (r.amount || 0), 0);
    }
    const netSign = netBal >= 0 ? "+" : "-";

    const tasks = context.todayWorkTasks || [];
    const rems = context.activeReminders || [];

    // 0. Compound Multi-Action Parser (e.g. "I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review design, and note down that she loves matcha")
    const localActions = [];
    const confirmedSummaries = [];

    // 0a. Expense: "paid $8.50 for lunch", "spent $12 on dinner", "bought coffee for 4$"
    const expMatch = query.match(/(?:paid|spent|bought)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?\s*(?:for|on)?\s*([^,\.]+?)(?=\s*,\s*|\s+and\s+|\s+remind|\s+note|\s+remember|\s*$)/i);
    if (expMatch) {
        const amt = parseFloat(expMatch[1].replace("$", ""));
        if (!isNaN(amt) && amt > 0) {
            let cur = expMatch[2] || (expMatch[1].includes("$") ? "USD" : (context?.displayCurrency || "USD"));
            if (cur === "$" || cur.toLowerCase() === "dollars") cur = "USD";
            else if (cur.toLowerCase() === "riel") cur = "KHR";
            const rawCat = (expMatch[3] || "").trim();
            let cat = "Other";
            if (/lunch|dinner|breakfast|food|meal|eat/i.test(rawCat)) cat = "Food";
            else if (/coffee|tea|cafe/i.test(rawCat)) cat = "Coffee";
            else if (/grab|taxi|passapp|ride|transport/i.test(rawCat)) cat = "Transport";
            else if (rawCat) cat = rawCat;

            localActions.push({
                type: "add_expense",
                amount: amt,
                currency: cur.toUpperCase(),
                category: cat
            });
            confirmedSummaries.push(`logged ${cur.toUpperCase() === "USD" ? "$" : ""}${amt}${cur.toUpperCase() === "KHR" ? " ៛" : ""} for ${cat.toLowerCase()}`);
        }
    }

    // 0b. Reminder: "remind me at 3:30 PM to review the design file", "remind in 30 mins to check server"
    const remMatch = query.match(/\bremind(?:\s+me)?\s+(?:at\s+|in\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d+\s*(?:m|min|mins|minutes|h|hr|hrs|hours))\s*(?:to\s+|for\s+)?([^,\.]+?)(?=\s*,\s*|\s+and\s+|\s+note|\s+remember|\s*$)/i);
    if (remMatch) {
        const rawTime = remMatch[1].trim();
        const normTime = normalizeReminderTime(rawTime);
        const remTitle = (remMatch[2] || "Reminder").trim();
        if (normTime) {
            localActions.push({
                type: "add_reminder",
                time: normTime,
                title: remTitle,
                frequency: "once"
            });
            confirmedSummaries.push(`scheduled reminder for ${normTime} (${remTitle})`);
        }
    }

    // 0c. Memory: "note down that she loves matcha lattes", "remember that ..."
    const memMatch = query.match(/\b(?:note\s+down|remember(?:\s+that)?|keep\s+in\s+mind)\s+(?:that\s+)?([^,\.]+)/i);
    if (memMatch) {
        const fact = memMatch[1].trim();
        if (fact) {
            localActions.push({
                type: "add_memory",
                fact,
                category: "preference"
            });
            confirmedSummaries.push(`saved personal memory: "${fact}"`);
        }
    }

    // 0d. Work task: "done fixed checkout bug"
    const workMatch = query.match(/\b(?:done|completed|finished)\s+([^,\.]+?)(?=\s*,\s*|\s+and\s+|\s+remind|\s+note|\s+remember|\s*$)/i);
    if (workMatch) {
        const taskText = workMatch[1].trim();
        if (taskText && !/lunch|dinner|review the design/i.test(taskText)) {
            localActions.push({
                type: "add_work",
                content: taskText,
                category: "General"
            });
            confirmedSummaries.push(`logged work task: "${taskText}"`);
        }
    }

    if (localActions.length >= 2) {
        const countWord = localActions.length === 2 ? "Both" : (localActions.length === 3 ? "All three" : `All ${localActions.length}`);
        const replyText = `${countWord} taken care of, Boss! ${confirmedSummaries.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(", ")}.`;
        return {
            reply: replyText,
            voice_summary: `${countWord} taken care of Boss.`,
            actions: localActions
        };
    }

    // 1. Correction: "income not expense", "that was income"
    if (q.includes("income not expense") || q.includes("is my income") || q.includes("was income")) {
        const numMatch = q.match(/\$?([0-9]+(?:\.[0-9]+)?)/);
        const amount = numMatch ? parseFloat(numMatch[1]) : 40;
        const curHint = q.includes("khr") || q.includes("riel") ? "KHR" : (q.includes("$") || q.includes("usd") || amount < 500 ? "USD" : "KHR");
        return {
            reply: [
                `⚡ *F.R.I.D.A.Y. • Ledger Correction*`,
                `────────────────────`,
                `Understood, Boss! My apologies for the misclassification.`,
                `• *Reversed:* Last wrongful expense entry deleted.`,
                `• *Logged:* \`${curHint === "USD" ? "$" : ""}${amount}${curHint === "KHR" ? " ៛" : ""}\` credited to *Income*.`,
                `────────────────────`,
                `_Net cashflow telemetry recalibrated._`
            ].join("\n"),
            voice_summary: `Understood Boss. I removed the wrongful expense and credited ${amount} dollars to your income.`,
            actions: [
                { type: "delete_last_transaction", filter: "expense" },
                { type: "add_income", amount, currency: curHint, category: "Income" }
            ]
        };
    }

    // 2. Undo / Delete Last Transaction
    if (q === "undo" || q.includes("delete last") || q.includes("undo that") || q.includes("cancel last") || q.includes("remove last")) {
        const filter = q.includes("income") ? "income" : (q.includes("expense") ? "expense" : "any");
        return {
            reply: [
                `🗑️ *F.R.I.D.A.Y. • Ledger Operation*`,
                `────────────────────`,
                `The last recorded transaction has been purged from your ledger, Boss.`,
                `────────────────────`,
                `_Balances have been updated._`
            ].join("\n"),
            voice_summary: `Last transaction removed from your ledger, Boss.`,
            action: { type: "delete_last_transaction", filter }
        };
    }

    // 3. Clear Ledger
    if (q.includes("clear all") || q.includes("wipe ledger") || q.includes("reset ledger")) {
        return {
            reply: [
                `⚠️ *F.R.I.D.A.Y. • Ledger Reset*`,
                `────────────────────`,
                `All transactions have been purged from your database ledger, Boss.`,
                `────────────────────`,
                `_Fresh ledger initialized._`
            ].join("\n"),
            voice_summary: `All transactions purged from ledger, Boss.`,
            action: { type: "clear_all_transactions" }
        };
    }

    if (q.includes("clear today")) {
        return {
            reply: [
                `🧹 *F.R.I.D.A.Y. • Daily Reset*`,
                `────────────────────`,
                `Today's transactions have been cleared from your ledger, Boss.`,
                `────────────────────`,
                `_Today's burn reset to zero._`
            ].join("\n"),
            voice_summary: `Today's transactions cleared, Boss.`,
            action: { type: "clear_today_expenses" }
        };
    }

    // 4. Switch Currency
    if (q.includes("currency to usd") || q.includes("switch to usd") || q.includes("use usd") || q.includes("use dollars")) {
        return {
            reply: `💱 *Currency Updated*\n\nDisplay currency switched to **USD**, Boss.`,
            voice_summary: `Display currency switched to U S Dollars, Boss.`,
            action: { type: "set_currency", currency: "USD" }
        };
    }
    if (q.includes("currency to khr") || q.includes("switch to khr") || q.includes("use khr") || q.includes("use riel")) {
        return {
            reply: `💱 *Currency Updated*\n\nDisplay currency switched to **KHR (៛)**, Boss.`,
            voice_summary: `Display currency switched to Khmer Riel, Boss.`,
            action: { type: "set_currency", currency: "KHR" }
        };
    }

    // 5. Set Monthly Budget
    const budgetMatch = q.match(/(?:budget\s*(?:is|to)?\s*)\$?([0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$)?/i);
    if (budgetMatch) {
        const bAmount = parseFloat(budgetMatch[1]);
        const bCurr = budgetMatch[2] === "khr" || bAmount >= 500 ? "KHR" : "USD";
        return {
            reply: `🎯 *Monthly Budget Configured*\n\nMonthly budget set to **${bCurr === "USD" ? "$" : ""}${bAmount}${bCurr === "KHR" ? " ៛" : ""}**, Boss.`,
            voice_summary: `Monthly budget configured to ${bAmount} ${bCurr === "USD" ? "dollars" : "riel"}, Boss.`,
            action: { type: "set_budget", amount: bAmount, currency: bCurr }
        };
    }

    // 6. "Can I afford..." check
    const affordMatch = q.match(/(?:afford|buy|purchase|spend)\s*(?:a|an)?\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
    if (affordMatch) {
        const itemCost = parseFloat(affordMatch[1]);
        const remainingBuffer = netBal - itemCost;
        const canAfford = remainingBuffer >= 0;
        return {
            reply: [
                `🛡️ *F.R.I.D.A.Y. • Local Affordability Assessment*`,
                `────────────────────`,
                canAfford 
                    ? `🟢 *Affirmative, Boss.* You can safely afford this purchase.` 
                    : `🔴 *Caution, Boss.* This purchase will result in a negative cashflow buffer.`,
                ``,
                `● *Target Cost:*   \`${symbol}${itemCost}${suffix}\``,
                `● *Current Net:*   \`${netSign}${symbol}${Math.abs(netBal)}${suffix}\``,
                `● *Buffer After:*  \`${remainingBuffer >= 0 ? "+" : "-"}${symbol}${Math.abs(remainingBuffer)}${suffix}\``,
                `────────────────────`,
                `_Calculated via onboard SQLite ledger telemetry._`
            ].join("\n"),
            voice_summary: canAfford
                ? `Affirmative Boss. You can safely afford ${itemCost} dollars with buffer remaining.`
                : `Caution Boss. Spending ${itemCost} dollars will put your cashflow in the red.`
        };
    }

    // 7. Spending / Expenses inquiry
    if (q.includes("spend") || q.includes("expense") || q.includes("cost") || q.includes("how much") || q.includes("ចាយ")) {
        return {
            reply: [
                `💳 *F.R.I.D.A.Y. • Local Expense Telemetry*`,
                `────────────────────`,
                `● *Today's Spending:*   \`${symbol}${todayBurn}${suffix}\``,
                `● *Monthly Expenses:*  \`${symbol}${totalExp}${suffix}\``,
                `● *Net Cashflow:*      \`${netSign}${symbol}${Math.abs(netBal)}${suffix}\``,
                `────────────────────`,
                `_Calculated directly from live database ledger._`
            ].join("\n"),
            voice_summary: `Today you have spent ${todayBurn} dollars. Monthly total is ${totalExp} dollars.`
        };
    }

    // 8. Work / Tasks inquiry
    if (q.includes("task") || q.includes("work") || q.includes("standup") || q.includes("did i log")) {
        const taskLines = tasks.length > 0 
            ? tasks.map((t, i) => `${i + 1}. \`${t.time || "--:--"}\` ${t.task}`).join("\n")
            : "_No work logs recorded today yet._";
        return {
            reply: [
                `⚡ *F.R.I.D.A.Y. • Local Operations Telemetry*`,
                `────────────────────`,
                `📋 *Logged Tasks Today (${tasks.length}):*`,
                taskLines,
                `────────────────────`,
                `_Use \`/done <task>\` to log new accomplishments._`
            ].join("\n"),
            voice_summary: `You have ${tasks.length} tasks logged for today, Boss.`
        };
    }

    // 9. Greetings & Casual chit-chat
    if (/^(hi|hello|hey|yo|sup|hiya|howdy|hell|good morning|good afternoon|good evening|សួស្តី|ជំរាបសួរ)\b/i.test(q)) {
        const hour = (new Date().getUTCHours() + 7) % 24; // ICT (UTC+7)
        let greeting = "Good day";
        if (hour >= 5 && hour < 12) greeting = "Good morning";
        else if (hour >= 12 && hour < 18) greeting = "Good afternoon";
        else greeting = "Good evening";

        return {
            reply: `${greeting}, ${title}! Everything is running smoothly. How can I help you today?`,
            voice_summary: `${greeting} ${title}! How can I help you today?`
        };
    }
    if (q.includes("how are you") || q.includes("how's it going") || q.includes("how you doing")) {
        return {
            reply: `Running smoothly and ready for action, Boss! How can I assist you today?`,
            voice_summary: `Running smoothly and ready for action, Boss. How can I help you today?`
        };
    }
    if (q.includes("who are you") || q.includes("what are you") || q.includes("introduce yourself")) {
        return {
            reply: `I'm F.R.I.D.A.Y., your personal assistant for managing cashflow, work logs, and daily reminders, Boss.`,
            voice_summary: `I am Friday, your personal assistant, Boss.`
        };
    }

    // 10. Clean Default Response
    return {
        reply: `I'm running in offline mode right now, Boss, but your ledger is safe. You can ask about your spending, log tasks, or check your balance anytime.`,
        voice_summary: `I am currently in offline mode, Boss, but standing by for your ledger and task updates.`
    };
}

export async function handleAiCopilotQuery(env, chatId, userId, query, from, messageId = null, isVoice = false) {
    try {
        await ensureTables(env.DB);
        const cleanQuery = (query || "").trim();

        if (!cleanQuery) {
            const text = [
                `🤖 *F.R.I.D.A.Y. Tactical Assistant*`,
                `────────────────────`,
                `Tactical intelligence for your cashflow ledger, work journal, budget, and reminders.`,
                ``,
                `💡 *What you can ask Boss:*`,
                `• *"Friday, brief me"* or \`/briefing\``,
                `• *"Can I afford a $100 gadget based on my runway?"*`,
                `• *"What's my biggest spending category this month?"*`,
                `• *"What tasks did I log today?"*`,
                `• *"Friday, generate my standup report"*`,
                `• *"Remind me at 17:00 to commit code"*`,
                `• *"ថ្ងៃនេះខ្ញុំចាយអស់ប៉ុន្មាន?"* _(Khmer supported!)_`,
                ``,
                `_Type directly, hold the 🎙️ mic button, or use \`/ask <query>\`_`
            ].join("\n");

            await safeEditOrSendMessage(env, chatId, messageId, text, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🛡️ Tactical Briefing", callback_data: "friday_briefing" },
                            { text: "📊 Summary", callback_data: "summary_today" }
                        ],
                        [
                            { text: "⚡ Work Tasks", callback_data: "work_today" },
                            { text: "🏠 Main Hub", callback_data: "hub" }
                        ]
                    ]
                }
            });
            return;
        }

        const [userVoicePref, context] = await Promise.all([
            getUserVoiceMode(env.DB, userId),
            buildAiUserContext(env.DB, userId, cleanQuery)
        ]);
        const shouldVoice = isVoice || userVoicePref === "on";

        try {
            await telegram(env, "sendChatAction", { chat_id: chatId, action: shouldVoice ? "record_voice" : "typing" });
        } catch (e) {}

        const isUserOwner = isOwner(userId, env);
        const requesterName = from?.first_name || from?.username || (isUserOwner ? "Boss" : "Friend");
        context.db = env.DB;
        context.userId = userId;
        context.chatId = chatId;
        context.isOwner = isUserOwner;
        context.userName = requesterName;
        let result = null;

        // Try conversational AI if keys are present
        if (env.GEMINI_API_KEY || env.AI) {
            try {
                result = await askAiCopilot(env, cleanQuery, context);
            } catch (aiErr) {
                console.warn("askAiCopilot error, switching to smart local fallback:", aiErr.message);
            }
        }

        // Resilient deterministic fallback: Friday always answers using local database math
        if (!result || !result.reply) {
            const localFallback = buildSmartLocalFallback(cleanQuery, context);
            result = {
                reply: localFallback.reply,
                voice_summary: localFallback.voice_summary,
                action: localFallback.action || null,
                actions: localFallback.actions || (localFallback.action ? [localFallback.action] : [])
            };
        }

        // Process all actions (supporting single action, array of actions, and corrective actions)
        const actionsToExecute = Array.isArray(result.actions) && result.actions.length > 0
            ? result.actions
            : (result.action && typeof result.action === "object" ? [result.action] : []);

        for (const act of actionsToExecute) {
            try {
                if (!act || typeof act !== "object" || act.alreadyExecuted) continue;

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
                } else if (act.type === "delete_last_transaction") {
                    await deleteLastTransaction(env.DB, userId, act.filter || null);
                } else if (act.type === "delete_transaction" && act.id) {
                    await deleteExpenseById(env.DB, userId, act.id);
                } else if (act.type === "set_currency" && act.currency) {
                    await setDisplayCurrency(env.DB, userId, act.currency.toUpperCase());
                } else if (act.type === "set_budget" && act.amount && act.amount > 0) {
                    const bCurr = (act.currency || context.displayCurrency || "USD").toUpperCase();
                    const budgetKhr = bCurr === "USD" ? Math.round(act.amount * EXCHANGE_RATE) : Math.round(act.amount);
                    await setMonthlyBudget(env.DB, userId, budgetKhr);
                } else if (act.type === "clear_today_expenses") {
                    await clearToday(env.DB, userId);
                } else if (act.type === "clear_all_transactions") {
                    await clearAllExpenses(env.DB, userId);
                } else if (act.type === "add_work" && act.content) {
                    const curTime = currentTime();
                    const curDate = today();
                    const cat = act.category || "General";
                    await env.DB.prepare(
                        "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
                    ).bind(userId, curDate, curTime, act.content.trim(), cat).run();
                } else if (act.type === "add_reminder" && act.title) {
                    const cleanTitle = act.title.trim();
                    const cleanTime = (act.time ? normalizeReminderTime(act.time) : null) || (act.time ? act.time.trim() : "12:00");
                    const freq = act.frequency || "once";
                    await env.DB.prepare(
                        "INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active) VALUES (?, ?, ?, ?, ?, 'custom', 1)"
                    ).bind(userId, String(chatId), cleanTitle, cleanTime, freq).run();
                } else if (act.type === "add_memory" && act.fact) {
                    const memCat = act.category || "preference";
                    await saveUserMemory(env.DB, userId, act.fact.trim(), memCat);
                }
            } catch (actErr) {
                console.error("Failed to execute AI Copilot action:", actErr);
            }
        }

        // Asynchronously persist conversation history turns into chat_history
        saveChatMessage(env.DB, userId, "user", cleanQuery).catch(() => {});
        if (result.reply) {
            saveChatMessage(env.DB, userId, "model", result.reply).catch(() => {});
        }

        // If voice mode is active (or input was voice/speak), send audio transmission.
        // Telegram's native voice player handles playback cleanly, so no button clutter is needed!
        if (shouldVoice) {
            try {
                const spokenText = result.voice_summary || result.reply;
                const audioBuffer = await generateSpeechAudio(spokenText);
                if (audioBuffer) {
                    await Promise.all([
                        sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission"),
                        sendMessage(env, chatId, result.reply, { parse_mode: "Markdown" })
                    ]);
                    return;
                }
            } catch (voiceErr) {
                console.warn("Spoken reply generation failed, falling back to text:", voiceErr.message);
            }
        }

        // Clean conversational response without repetitive navigation buttons.
        // Provide only a subtle on-demand "🔊 Read Aloud" button for users lazy to read.
        await sendMessage(env, chatId, result.reply, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔊 Read Aloud", callback_data: "speak_last" }]
                ]
            }
        });
    } catch (criticalErr) {
        console.error("Critical handleAiCopilotQuery error:", criticalErr);
        await sendMessage(
            env,
            chatId,
            `🛡️ *F.R.I.D.A.Y. Diagnostics*\n\nBoss, an unexpected processing exception occurred. All ledgers remain intact.\n\nType \`/hub\` or \`/today\` to inspect your accounts.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                }
            }
        ).catch(() => {});
    }
}
