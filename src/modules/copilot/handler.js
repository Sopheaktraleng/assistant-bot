import { today, currentTime } from "../../utils/time.js";
import { addExpenseRecord, saveChatMessage, saveUserMemory } from "../../db/queries.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, safeEditOrSendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { buildAiUserContext, askAiCopilot, generateSpeechAudio } from "../../services/ai.js";
export { sendFridayTacticalBriefing } from "./briefing.js";

/**
 * Intelligent deterministic fallback when AI APIs are unreachable or timing out.
 * Computes exact answers from onboard database tables.
 */
export function buildSmartLocalFallback(query, context) {
    const q = (query || "").toLowerCase();
    const curr = context.displayCurrency || "USD";
    const symbol = curr === "USD" ? "$" : "";
    const suffix = curr === "KHR" ? " ៛" : "";
    const totalInc = context.summary?.totalIncome || 0;
    const totalExp = context.summary?.totalExpenses || 0;
    const netBal = totalInc - totalExp;
    const netSign = netBal >= 0 ? "+" : "-";
    const todayBurn = (context.todayExpenses || []).reduce((acc, r) => acc + (r.amount || 0), 0);
    const tasks = context.todayWorkTasks || [];
    const rems = context.activeReminders || [];

    // 1. "Can I afford..." check
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

    // 2. Spending / Expenses inquiry
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

    // 3. Work / Tasks inquiry
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

    // 4. Default Telemetry Briefing
    return {
        reply: [
            `🛡️ *F.R.I.D.A.Y. • Local Telemetry Mode*`,
            `────────────────────`,
            `AI satellite link is temporarily unavailable, Boss. Displaying onboard telemetry:`,
            ``,
            `● *Net Balance:*  \`${netSign}${symbol}${Math.abs(netBal)}${suffix}\``,
            `● *Today's Burn:* \`${symbol}${todayBurn}${suffix}\``,
            `● *Logged Tasks:* \`${tasks.length} tasks today\``,
            `● *Active Alerts:* \`${rems.length} scheduled\``,
            `────────────────────`,
            `_All ledgers and settings are 100% intact._`
        ].join("\n"),
        voice_summary: `AI satellite link delayed, Boss. Local telemetry shows net balance is ${netSign} ${Math.abs(netBal)} dollars. All local systems operational.`
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

        try {
            await telegram(env, "sendChatAction", { chat_id: chatId, action: isVoice ? "record_voice" : "typing" });
        } catch (e) {}

        const context = await buildAiUserContext(env.DB, userId);
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
                action: null
            };
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

        const replyMarkup = {
            inline_keyboard: [
                [
                    { text: "🏠 Main Hub", callback_data: "hub" },
                    { text: "💰 Finance Hub", callback_data: "finance_hub" },
                    { text: "💼 Work Hub", callback_data: "work_hub" }
                ]
            ]
        };

        // If input originated from a voice note or /speak, speak back to user via neural voice!
        if (isVoice) {
            try {
                const spokenText = result.voice_summary || result.reply;
                const audioBuffer = await generateSpeechAudio(spokenText);
                if (audioBuffer) {
                    // Send audio note and formatted card concurrently in parallel!
                    await Promise.all([
                        sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission"),
                        sendMessage(env, chatId, result.reply, {
                            parse_mode: "Markdown",
                            reply_markup: replyMarkup
                        })
                    ]);
                    return;
                }
            } catch (voiceErr) {
                console.warn("Spoken reply generation failed, falling back to text:", voiceErr.message);
            }
        }

        await sendMessage(env, chatId, result.reply, {
            parse_mode: "Markdown",
            reply_markup: replyMarkup
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
