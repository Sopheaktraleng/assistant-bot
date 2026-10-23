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

    // 1. Try Gemini Flash for a fresh, personalized, intelligent morning brief
    if (env.GEMINI_API_KEY) {
        try {
            const prompt = `You are F.R.I.D.A.Y., the elite personal executive chief of staff addressing Boss.
It is morning on ${context.currentDate} at ${context.currentTime} (${TIME_ZONE}).
Generate the official Morning Tactical Briefing.
Live Telemetry:
- Net Cashflow Balance: ${netSign}${symbol}${formatMoney(Math.abs(netBalance))}${suffix}
- Month-to-date Spending: ${symbol}${formatMoney(totalExpenses)}${suffix}
- Month-to-date Income: ${symbol}${formatMoney(totalIncome)}${suffix}
- Today's Spending: ${symbol}${formatMoney(todaySpend)}${suffix}
${budget ? `- Monthly Budget: ${symbol}${budget.limitUsd || budget.limitKhr}${suffix} (${budget.percentUsed}% used, ${symbol}${budget.remainingUsd || budget.remainingKhr}${suffix} remaining)` : ""}
- Active Scheduled Alarms: ${reminders.length} scheduled (${reminders.map(r => `${r.time} ${r.title}`).join(", ") || "none"})
- Logged Tasks: ${tasks.length} tasks

Directives:
1. Greet Boss warmly, sharp, real-world grounded (STRICTLY NO superhero/Marvel/movie tropes).
2. Give a clear financial runway check (highlight net balance and budget runway).
3. If reminders are scheduled today, mention them.
4. Conclude with a punchy, clever kickoff 1-liner for engineering/work productivity today.
5. Return JSON:
{
  "reply": "Visually crisp, beautifully structured markdown message for Boss's screen with clean bullet points and emojis",
  "voice_summary": "1-2 natural spoken sentences written specifically for human ears (NO asterisks, NO emojis, natural spoken cadence)"
}`;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        response_mime_type: "application/json",
                        temperature: 0.7
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
            console.warn("AI morning briefing generation failed, using structured fallback:", e.message);
        }
    }

    // 2. Structured fallback if AI is unavailable or fails
    if (!result || !result.reply) {
        let budgetLine = "";
        if (budget) {
            budgetLine = `● *Budget Runway:* \`${budget.percentUsed}% used\` (${symbol}${formatMoney(budget.remainingUsd || budget.remainingKhr)}${suffix} left)\n`;
        }

        let reminderLines = "";
        if (reminders.length > 0) {
            reminderLines = reminders.slice(0, 3).map(r => `  └ \`${r.time || "--:--"}\` ${r.title}`).join("\n") + "\n";
        }

        const lines = [
            `🤖 *F.R.I.D.A.Y. Tactical Briefing*`,
            `────────────────────`,
            `Good morning, Boss. All telemetry systems are operational for *${context.currentDate}*.`,
            ``,
            `💳 *Cashflow Telemetry:*`,
            `● *Net Balance:*   \`${netSign}${symbol}${formatMoney(Math.abs(netBalance))}${suffix}\``,
            `● *Month Spend:*   \`${symbol}${formatMoney(totalExpenses)}${suffix}\``,
            `● *Today's Burn:*  \`${symbol}${formatMoney(todaySpend)}${suffix}\``,
            budgetLine ? budgetLine.trimEnd() : null,
            ``,
            `⚡ *Operations & Schedule:*`,
            `● *Scheduled Alerts:* \`${reminders.length} active\``,
            reminderLines ? reminderLines.trimEnd() : null,
            `● *Today's Tasks:*     \`${tasks.length} logged\``,
            `────────────────────`,
            `_Ready when you are. Have an exceptional day, Boss._`
        ].filter(Boolean);

        const voiceSummary = `Good morning Boss. Friday online. Your net balance is ${netSign} ${formatMoney(Math.abs(netBalance))} dollars, with ${totalExpenses} dollars spent this month. You have ${reminders.length} scheduled alerts. Let's make today productive.`;

        result = {
            reply: lines.join("\n"),
            voice_summary: voiceSummary
        };
    }

    // Minimal, high-impact buttons (no screen clutter)
    const keyboard = {
        inline_keyboard: [
            [
                { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                { text: "📊 Today's Ledger", callback_data: "summary_today" }
            ]
        ]
    };

    // If audio requested, generate speech audio
    if (options.withVoice) {
        try {
            const spokenSummary = result.voice_summary || `Good morning Boss. Friday online. All systems operational.`;
            const audioBuffer = await generateSpeechAudio(spokenSummary, "en-gb");
            if (audioBuffer) {
                await Promise.all([
                    sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Morning Briefing"),
                    sendMessage(env, chatId, result.reply, {
                        parse_mode: "Markdown",
                        reply_markup: keyboard
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
