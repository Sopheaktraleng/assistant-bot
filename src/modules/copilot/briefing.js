import { today, currentTime, dateDaysAgo } from "../../utils/time.js";
import { TIME_ZONE, GEMINI_MODELS } from "../../config/constants.js";
import { formatMoney } from "../../utils/format.js";
import { buildAiUserContext, parseCopilotResponse, generateSpeechAudio, extractGeminiCandidateText } from "../../services/ai.js";
import { sendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { ensureTables } from "../../db/schema.js";
import { getUserBriefingMode, claimDailyBroadcast } from "../../db/queries.js";

/**
 * Resilient multi-model Gemini caller for JSON responses with automatic fallback.
 */
async function callGeminiForJson(env, prompt, temperature = 0.75) {
    if (!env?.GEMINI_API_KEY) return null;
    const candidateModels = [
        env?.GEMINI_MODEL,
        ...GEMINI_MODELS
    ].filter(Boolean).filter(m => m !== "gemini-3-flash-preview");

    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            response_mime_type: "application/json",
            temperature
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(8000)
            });

            if (!resp.ok) continue;
            const data = await resp.json();
            const raw = extractGeminiCandidateText(data);
            if (raw) {
                const parsed = parseCopilotResponse(raw);
                if (parsed && parsed.reply) return parsed;
            }
        } catch (e) {
            // continue to next model
        }
    }
    return null;
}

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

            result = await callGeminiForJson(env, prompt, 0.75);
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
 * Contextual, emotionally intelligent human-style wake-up fallback.
 * Used when Gemini is unreachable or offline.
 * Thoughtful, varied, day-specific, and caring—never a rigid robotic alarm.
 */
export function getHumanWakeupFallback(dayName, context) {
    const reminders = context?.activeReminders || [];
    const reminderAlert = reminders.length > 0
        ? `\n• 🔔 *Early Alert:* You have \`${reminders[0].reminder_time || reminders[0].time} ${reminders[0].title}\` scheduled.`
        : "";

    switch (dayName) {
        case "Monday":
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `It's \`07:50 AM\`—a fresh Monday morning is here. 🌅`,
                    ``,
                    `Take a slow deep breath, drink a tall glass of cool water, and stretch out that sleep. No need to rush into the week; let's ease into the morning and build steady momentum.`,
                    reminderAlert,
                    ``,
                    `_I'm already putting together your 08:00 AM briefing and coffee check-in. Time to get moving, Boss!_ ☕`
                ].filter(Boolean).join("\n"),
                voice_summary: "Good morning Boss. It is 7:50 AM on Monday. Drink a tall glass of water, stretch, and ease into the morning. I have your full morning briefing ready for you at eight o'clock."
            };

        case "Tuesday":
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `The clock shows \`07:50 AM\` on a crisp Tuesday morning. ☀️`,
                    ``,
                    `Shake off the drowsiness, get some water in your system, and let the morning light in. You built great momentum yesterday—let's carry it forward today.`,
                    reminderAlert,
                    ``,
                    `_Your 08:00 AM briefing and status check-in drops in 10 minutes. Rise and shine, Boss!_ ☕`
                ].filter(Boolean).join("\n"),
                voice_summary: "Good morning, Boss. It is 7:50 on Tuesday. Grab a glass of water, stretch your shoulders, and get ready for a great day. Your eight o'clock briefing is almost ready."
            };

        case "Wednesday":
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `It's \`07:50 AM\`—midweek checkpoint! 🚀`,
                    ``,
                    `You're halfway through the week, Boss. Give yourself a moment to stretch, hydrate, and clear your head before the day gets rolling.`,
                    reminderAlert,
                    ``,
                    `_I'll be right back at 08:00 AM with your morning status, tasks, and coffee check-in._ ☕`
                ].filter(Boolean).join("\n"),
                voice_summary: "Boss, time to wake up. It is 7:50 AM on Wednesday. You are halfway through the week. Drink some water, shake off the sleep, and I'll deliver your eight o'clock briefing shortly."
            };

        case "Thursday":
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `It's \`07:50 AM\` on Thursday morning. ☀️`,
                    ``,
                    `We're on the doorstep of the weekend. Step out of bed, drink some water, and let's keep the focus sharp today.`,
                    reminderAlert,
                    ``,
                    `_Your 08:00 AM morning check-in and coffee status is in the queue. Have a wonderful start, Boss!_ ☕`
                ].filter(Boolean).join("\n"),
                voice_summary: "Good morning Boss. It is 7:50 AM on Thursday. Stretch, drink some water, and let's keep the great momentum going. I will check in at eight with your full morning update."
            };

        case "Friday":
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `It's \`07:50 AM\`—and Friday has officially arrived! 🎉`,
                    ``,
                    `You've put in solid work all week. Stretch out that sleep, hydrate, and let's finish strong today before the weekend kicks off.`,
                    reminderAlert,
                    ``,
                    `_Your full morning briefing & coffee check-in drops at 08:00 AM!_ ☕`
                ].filter(Boolean).join("\n"),
                voice_summary: "Boss, wake up! It is 7:50 on Friday morning. The weekend is right in front of us, so let's finish today strong. Your eight o'clock briefing is on the way."
            };

        case "Saturday":
        case "Sunday":
        default:
            return {
                reply: [
                    `⏰ *Wake Up, Boss!*`,
                    `────────────────────`,
                    `It's \`07:50 AM\` on a peaceful ${dayName}. 🌿`,
                    ``,
                    `No alarms or deadlines pressing you this morning. Stretch out, enjoy the calm morning air, and ease out of bed at your own pace.`,
                    reminderAlert,
                    ``,
                    `_I'll check in with a quick status update at 08:00 AM. Enjoy your morning, Boss!_ ☀️`
                ].filter(Boolean).join("\n"),
                voice_summary: `Morning Boss. It is 7:50 on a relaxed ${dayName}. Take your time, stretch, and start your morning at your own pace. I'll check in with you at eight.`
            };
    }
}

/**
 * Warm, intelligent personal assistant wake-up call at 07:50 AM ICT.
 * Uses Gemini AI with rich user context to generate a thoughtful, human-level wake-up greeting,
 * complete with natural TTS audio and dynamic day-specific fallbacks.
 */
export async function sendFridayWakeupCall(env, chatId, userId) {
    if (env.DB) await ensureTables(env.DB);
    const context = env.DB ? await buildAiUserContext(env.DB, userId) : { currentDate: today(), currentTime: "07:50 AM" };

    const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: TIME_ZONE });
    let result = null;

    if (env.GEMINI_API_KEY) {
        try {
            const memoriesSnippet = (context.memories && context.memories.length > 0)
                ? `Boss's personal memories & preferences:\n${context.memories.slice(0, 5).map(m => `- ${m.fact}`).join("\n")}`
                : "";

            const reminderSnippet = (context.activeReminders && context.activeReminders.length > 0)
                ? `Upcoming alarms today: ${context.activeReminders.map(r => `${r.reminder_time || r.time} ${r.title}`).join(", ")}`
                : "No early morning alarms scheduled.";

            const prompt = `You are F.R.I.D.A.Y., Boss's exceptionally smart, warm, loyal, and witty personal executive assistant.
It is exactly 07:50 AM on ${context.currentDate} (${dayName}) in Cambodia.
This is your 07:50 AM morning wake-up call to Boss (10 minutes before the 08:00 AM full day briefing).

STRICT TONE DIRECTIVES - SOUND LIKE NATURAL HUMAN THINKING:
- Absolutely DO NOT sound like a cold robotic alarm clock, a generic bot, or spit out canned clichés ("Rise and shine, time to get out of bed").
- Think and write like a genuine, high-EQ personal executive assistant who knows Boss personally and understands how human beings actually wake up:
  1. Day-Specific Awareness (${dayName}):
     - If Monday: Grounding, gentle encouragement, easing into the new week with calm focus, no stress or pressure.
     - If midweek (Tuesday/Wednesday/Thursday): Upbeat, sharp momentum, recognizing progress and today's opportunities.
     - If Friday: Enthusiastic, warm finish to the work week with the weekend right around the corner.
     - If Saturday or Sunday: Relaxed, leisurely, peaceful, reminding Boss there is no rush whatsoever.
  2. Thoughtful Human Habits:
     - Remind Boss to take a deep breath, stretch their body, drink a tall glass of cool water to activate their system, or let the morning light into the room.
     - Reassure Boss that you are already compiling their 08:00 AM morning check-in and coffee status report, so they can take their time waking up right now.
  3. Formatting:
     - Clean, human-crafted Telegram markdown.
     - Start header with: ⏰ *Wake Up, Boss!*
     - Follow with 2 to 3 short, easy-to-read natural paragraphs with subtle emojis (🌅, 💧, ☕, ☀️).
     - Keep the tone personal, attentive, and respectful (addressing user as Boss).
${memoriesSnippet ? `\n${memoriesSnippet}\n` : ""}
${reminderSnippet ? `\n${reminderSnippet}\n` : ""}

- Spoken voice_summary:
  - Must sound 100% natural when spoken aloud by TTS (British assistant accent).
  - Absolutely NO asterisks, NO bullet points, NO emojis, NO markdown syntax.
  - Smooth British executive assistant cadence, 2-3 conversational sentences for human ears.

Return strictly JSON only:
{
  "reply": "Warm, beautifully formatted Telegram markdown message starting with '⏰ *Wake Up, Boss!'",
  "voice_summary": "Natural conversational spoken wake-up greeting for human ears"
}`;

            result = await callGeminiForJson(env, prompt, 0.75);
        } catch (e) {
            console.warn("AI wake-up call generation failed, using dynamic human fallback:", e.message);
        }
    }

    if (!result || !result.reply) {
        result = getHumanWakeupFallback(dayName, context);
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: "☕ I'm Awake", callback_data: "hub" },
                { text: "🔊 Read Aloud", callback_data: "speak_status" }
            ]
        ]
    };

    try {
        const spokenText = result.voice_summary || "Good morning Boss. Time to wake up, drink some water, and start your day.";
        const audioBuffer = await generateSpeechAudio(spokenText, "en-gb");
        if (audioBuffer) {
            await Promise.all([
                sendTelegramVoice(env, chatId, audioBuffer, "🎙️ ⏰ Wake Up Call! (07:50 AM)"),
                sendMessage(env, chatId, result.reply, {
                    parse_mode: "Markdown",
                    reply_markup: keyboard
                })
            ]);
            return;
        }
    } catch (e) {
        console.warn("sendFridayWakeupCall voice error:", e.message);
    }

    await sendMessage(env, chatId, result.reply, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

/**
 * Autonomous daily morning wake-up broadcast to active users at 07:50 AM ICT.
 * Uses atomic daily_broadcast_logs lock to prevent any duplicate sends.
 */
export async function sendDailyScheduledWakeup(env) {
    try {
        if (env.DB) await ensureTables(env.DB);
        const todayStr = today();
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
                    if (isEnabled === "off") continue;

                    // Atomic daily broadcast lock - ensures 100% idempotency (never sends twice)
                    const canSend = await claimDailyBroadcast(env.DB, row.user_id, "wakeup", todayStr);
                    if (!canSend) {
                        console.log(`Wake-up call already sent today for user ${row.user_id}, skipping duplicate.`);
                        continue;
                    }

                    await sendFridayWakeupCall(env, row.user_id, row.user_id);
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
 * Honors user briefing preference (skips if turned off) and deduplicates atomically.
 */
export async function sendDailyScheduledBriefings(env) {
    try {
        if (env.DB) await ensureTables(env.DB);
        const todayStr = today();
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
                    if (isEnabled === "off") continue;

                    // Atomic daily broadcast lock - ensures 100% idempotency (never sends twice)
                    const canSend = await claimDailyBroadcast(env.DB, row.user_id, "briefing", todayStr);
                    if (!canSend) {
                        console.log(`Daily briefing already sent today for user ${row.user_id}, skipping duplicate.`);
                        continue;
                    }

                    await sendFridayTacticalBriefing(env, row.user_id, row.user_id, { withVoice: true });
                } catch (err) {
                    console.error(`Failed to send daily briefing to ${row.user_id}:`, err);
                }
            }
        }
    } catch (e) {
        console.error("sendDailyScheduledBriefings error:", e);
    }
}
