import { today, currentTime } from "../../utils/time.js";
import { addExpenseRecord } from "../../db/queries.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, safeEditOrSendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { buildAiUserContext, askAiCopilot, generateSpeechAudio } from "../../services/ai.js";
export { sendFridayTacticalBriefing } from "./briefing.js";

export async function handleAiCopilotQuery(env, chatId, userId, query, from, messageId = null, isVoice = false) {
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

    if (!env.GEMINI_API_KEY && !env.AI) {
        await sendMessage(
            env,
            chatId,
            `⚠️ *F.R.I.D.A.Y. Intelligence is not configured.*\n\n` +
            `To enable conversational AI features, set your free Google Gemini API key:\n` +
            `\`npx wrangler secret put GEMINI_API_KEY\`\n` +
            `(Get a free key at https://aistudio.google.com)`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: isVoice ? "record_voice" : "typing" });
    } catch (e) {}

    const context = await buildAiUserContext(env.DB, userId);
    const result = await askAiCopilot(env, cleanQuery, context);

    if (!result || !result.reply) {
        await sendMessage(
            env,
            chatId,
            `⚠️ *F.R.I.D.A.Y. was unable to process that request right now.*\n\n` +
            `Here are quick shortcuts:\n` +
            `• \`/today\` — View today's transactions\n` +
            `• \`/summary\` — Spending summary\n` +
            `• \`/briefing\` — Tactical status briefing\n` +
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
                // 1. Send clean audio voice note without cluttered caption
                await sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission");
                // 2. Send the rich visual card with action buttons
                await sendMessage(env, chatId, result.reply, {
                    parse_mode: "Markdown",
                    reply_markup: replyMarkup
                });
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
}
