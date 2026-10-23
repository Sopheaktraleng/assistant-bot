import { today, currentTime, dateDaysAgo } from "../../utils/time.js";
import { TIME_ZONE } from "../../config/constants.js";
import { formatMoney } from "../../utils/format.js";
import { buildAiUserContext, parseCopilotResponse, generateSpeechAudio } from "../../services/ai.js";
import { sendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { ensureTables } from "../../db/schema.js";
import { getUserBriefingMode } from "../../db/queries.js";

/**
 * Builds and sends a structured tactical status briefing in the voice of F.R.I.D.A.Y.
 * Pulls accurate telemetry from SQLite and uses Gemini Flash for fresh, executive morning intelligence.
 */
export async function sendFridayTacticalBriefing(env, chatId, userId, options = {}) {
    await ensureTables(env.DB);
    const context = await buildAiUserContext(env.DB, userId);

    const curr = context.displayCurrency || "USD";
    const symbol = curr === "USD" ? "$" : "";
    const suffix = curr === "KHR" ? " ៛" : "";
    const isUsd = curr === "USD";

    // Accurate calculation using context.totals (with fallback to legacy summary)
    const netBalance = (context.totals ? (isUsd ? context.totals.allTimeNetBalanceUsd : context.totals.allTimeNetBalanceKhr) : null) ?? ((context.summary?.totalIncome || 0) - (context.summary?.totalExpenses || 0));
    const totalExpenses = (context.totals ? (isUsd ? context.totals.thisMonthExpenseUsd : context.totals.thisMonthExpenseKhr) : null) ?? (context.summary?.totalExpenses || 0);
    const totalIncome = (context.totals ? (isUsd ? context.totals.thisMonthIncomeUsd : context.totals.thisMonthIncomeKhr) : null) ?? (context.summary?.totalIncome || 0);
    const todaySpend = (context.totals ? (isUsd ? context.totals.todayExpenseUsd : context.totals.todayExpenseKhr) : null) ?? ((context.todayExpenses || []).reduce((acc, r) => acc + (r.amount || 0), 0));
    const netSign = netBalance >= 0 ? "+" : "-";

    const tasks = context.todayWorkTasks || [];
    const reminders = context.activeReminders || [];
    const budget = context.budget;

    let result = null;

    // 1. Try Gemini Flash for a warm, natural personal assistant wake-up call
    if (env.GEMINI_API_KEY) {
        try {
            const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: TIME_ZONE });
            const prompt = `You are F.R.I.D.A.Y., Boss's warm, witty, and loyal personal assistant.
It is morning (8:00 AM) on ${context.currentDate} (${dayName}) in Cambodia.
Your task is to give Boss a friendly morning check-in and coffee greeting.

STRICT TONE DIRECTIVES:
- DO NOT sound like a cold server monitoring bot or spit out raw system telemetry dashboards!
- Sound like a genuine, caring personal assistant wishing Boss a great morning with warmth, energy, and charm.
- Acknowledge whether it's a weekday or weekend (${dayName}).
- Weave in a brief, reassuring note about their status: finances are steady at ${netSign}${symbol}${formatMoney(Math.abs(netBalance))}${suffix}, and mention any alarms (${reminders.length > 0 ? reminders.map(r => `${r.time} ${r.title}`).join(", ") : "calendar is clear"}).
- Wish Boss a great morning and remind them to enjoy their coffee/breakfast.
- Spoken voice_summary MUST sound like an assistant talking to Boss (NO asterisks, NO emojis, natural spoken flow).

Return pure JSON only:
{
  "reply": "Warm, beautifully formatted Telegram markdown message from a caring assistant with gentle emojis and clean bullet points",
  "voice_summary": "Conversational spoken morning check-in greeting for human ears"
}`;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        response_mime_type: "application/json",
                        temperature: 0.75
                    }
                }),
                signal: AbortSignal.timeout(8000)
            });

            if (resp.ok) {
                const data = await resp.json();
                const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (raw) {
                    result = parseCopilotResponse(raw);
                }
            }
        } catch (e) {
            console.warn("AI morning wake-up generation failed, using structured fallback:", e.message);
        }
    }

    // 2. Structured fallback if AI is unavailable or fails
    if (!result || !result.reply) {
        const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: TIME_ZONE });
        const isWeekend = dayName === "Saturday" || dayName === "Sunday";

        const reminderNote = reminders.length > 0
            ? `• ⏰ *Reminders:* You have ${reminders.length} scheduled alert today (\`${reminders[0].time} ${reminders[0].title}\`).`
            : `• 📅 *Schedule:* Completely clear today${isWeekend ? "—enjoy your weekend!" : "."}`;

        const lines = [
            `☀️ *Good morning, Boss!*`,
            `────────────────────`,
            `Rise and shine! It's \`${context.currentTime}\` on a fresh ${dayName}.`,
            ``,
            `Hope you had a great night's rest. Here's your morning check-in:`,
            `• 💵 *Finances:* All looking good at *${netSign}${symbol}${formatMoney(Math.abs(netBalance))}${suffix}*.`,
            reminderNote,
            ``,
            `Grab some morning coffee, and let me know whenever you need anything. Have a great day, Boss! ☕`
        ];

        const voiceSummary = `Good morning Boss! Hope you had a great sleep and are enjoying your morning coffee. It's 8:00 AM on a wonderful ${dayName}. Your finances are looking solid, and I'm ready whenever you need me. Have a great day!`;

        result = {
            reply: lines.join("\n"),
            voice_summary: voiceSummary
        };
    }

    // Minimal, clean action buttons
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🔊 Read Aloud", callback_data: "speak_status" },
                { text: "🏠 Main Hub", callback_data: "hub" }
            ]
        ]
    };

    // If audio requested, generate speech audio
    if (options.withVoice) {
        try {
            const spokenSummary = result.voice_summary || `Good morning Boss! Hope you had a wonderful sleep. Have a great day!`;
            const audioBuffer = await generateSpeechAudio(spokenSummary, "en-gb");
            if (audioBuffer) {
                await Promise.all([
                    sendTelegramVoice(env, chatId, audioBuffer, "🎙️ Good Morning, Boss! ☀️"),
                    sendMessage(env, chatId, result.reply, {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                        }
                    })
                ]);
                return;
            }
        } catch (vErr) {
            console.warn("Failed to generate voice for briefing, falling back to text:", vErr.message);
        }
    }

    await sendMessage(env, chatId, result.reply, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

/**
 * Quick, energetic personal assistant wake-up call at 07:50 AM ICT.
 */
export async function sendFridayWakeupCall(env, chatId, userId) {
    const text = [
        `⏰ *Wake Up, Boss!*`,
        `────────────────────`,
        `It's \`07:50 AM\`! Rise and shine, time to get out of bed. ☀️`,
        ``,
        `_I'll check back in with your morning status at 08:00 AM!_`
    ].join("\n");

    const voiceText = "Boss, time to wake up! It is 7:50 AM. Rise and shine, time to start your day!";

    try {
        const audioBuffer = await generateSpeechAudio(voiceText, "en-gb");
        if (audioBuffer) {
            await Promise.all([
                sendTelegramVoice(env, chatId, audioBuffer, "🎙️ ⏰ Wake Up Call! (07:50 AM)"),
                sendMessage(env, chatId, text, { parse_mode: "Markdown" })
            ]);
            return;
        }
    } catch (e) {
        console.warn("sendFridayWakeupCall voice error:", e.message);
    }

    await sendMessage(env, chatId, text, { parse_mode: "Markdown" });
}

/**
 * Autonomous daily morning wake-up broadcast to active users at 07:50 AM ICT.
 */
export async function sendDailyScheduledWakeup(env) {
    try {
        const sevenDaysAgo = dateDaysAgo(7);
        const { results } = await env.DB.prepare(
            `SELECT DISTINCT user_id FROM (
                SELECT user_id FROM user_settings
                UNION
                SELECT user_id FROM expenses WHERE date >= ?
                UNION
                SELECT user_id FROM work_logs WHERE date >= ?
            )`
        ).bind(sevenDaysAgo, sevenDaysAgo).all();

        if (results && results.length > 0) {
            for (const row of results) {
                try {
                    const isEnabled = await getUserBriefingMode(env.DB, row.user_id);
                    if (isEnabled !== "off") {
                        await sendFridayWakeupCall(env, row.user_id, row.user_id);
                    }
                } catch (err) {
                    console.error(`Failed to send 7:50 AM wake up call to ${row.user_id}:`, err);
                }
            }
        }
    } catch (e) {
        console.error("sendDailyScheduledWakeup error:", e);
    }
}

/**
 * Autonomous daily morning broadcast to active users at 08:00 AM ICT.
 * Honors user briefing preference (skips if turned off).
 */
export async function sendDailyScheduledBriefings(env) {
    try {
        const sevenDaysAgo = dateDaysAgo(7);
        const { results } = await env.DB.prepare(
            `SELECT DISTINCT user_id FROM (
                SELECT user_id FROM user_settings
                UNION
                SELECT user_id FROM expenses WHERE date >= ?
                UNION
                SELECT user_id FROM work_logs WHERE date >= ?
            )`
        ).bind(sevenDaysAgo, sevenDaysAgo).all();

        if (results && results.length > 0) {
            for (const row of results) {
                try {
                    const isEnabled = await getUserBriefingMode(env.DB, row.user_id);
                    if (isEnabled !== "off") {
                        await sendFridayTacticalBriefing(env, row.user_id, row.user_id, { withVoice: true });
                    }
                } catch (err) {
                    console.error(`Failed to send daily briefing to ${row.user_id}:`, err);
                }
            }
        }
    } catch (e) {
        console.error("sendDailyScheduledBriefings error:", e);
    }
}
