import { today, currentTime, dateDaysAgo } from "../../utils/time.js";
import { formatMoney, cleanMd } from "../../utils/format.js";
import { buildAiUserContext, askAiCopilot, generateSpeechAudio } from "../../services/ai.js";
import { sendMessage, sendTelegramVoice } from "../../services/telegram.js";
import { ensureTables } from "../../db/schema.js";

/**
 * Builds and sends a structured tactical status briefing in the voice of F.R.I.D.A.Y.
 */
export async function sendFridayTacticalBriefing(env, chatId, userId, options = {}) {
    await ensureTables(env.DB);
    const context = await buildAiUserContext(env.DB, userId);

    const curr = context.displayCurrency || "USD";
    const symbol = curr === "USD" ? "$" : "";
    const suffix = curr === "KHR" ? " ៛" : "";

    const totalIncome = context.summary?.totalIncome || 0;
    const totalExpenses = context.summary?.totalExpenses || 0;
    const netBalance = totalIncome - totalExpenses;
    const netSign = netBalance >= 0 ? "+" : "-";

    const todaySpend = (context.todayExpenses || []).reduce((acc, r) => acc + (r.amount || 0), 0);
    const activeTasksCount = (context.todayWorkTasks || []).length;
    const remindersCount = (context.activeReminders || []).length;

    // Tactical assessment
    let runwayAssessment = "All financial metrics within normal parameters, Boss.";
    if (totalExpenses > totalIncome && totalIncome > 0) {
        runwayAssessment = "Attention Boss: Expenses currently exceed income for this period. Recommend monitoring discretionary spending.";
    } else if (todaySpend > 50 && curr === "USD") {
        runwayAssessment = "Notice: Today's spending pace is elevated compared to daily average.";
    }

    const lines = [
        `🤖 *F.R.I.D.A.Y. Tactical Briefing*`,
        `────────────────────`,
        `*Status:* All systems green, Boss.`,
        `*Time:* \`${context.currentTime}\` | \`${context.currentDate}\``,
        ``,
        `💳 *Financial Defense:*`,
        `● *Net Balance:*   \`${netSign}${symbol}${formatMoney(Math.abs(netBalance))}${suffix}\``,
        `● *Period Spend:*  \`${symbol}${formatMoney(totalExpenses)}${suffix}\``,
        `● *Today's Burn:*  \`${symbol}${formatMoney(todaySpend)}${suffix}\``,
        ``,
        `⚡ *Operations & Tasks:*`,
        `● *Today's Tasks:* \`${activeTasksCount} logged\``,
        `● *Active Alerts:* \`${remindersCount} scheduled\``,
        ``,
        `🛡️ *Assessment:*`,
        `_${runwayAssessment}_`,
        `────────────────────`,
        `_Awaiting instructions. Hold 🎙️ or type any command._`
    ];

    const text = lines.join("\n");
    const keyboard = {
        inline_keyboard: [
            [
                { text: "📊 Summary", callback_data: "summary_today" },
                { text: "⚡ Standup", callback_data: "work_standup" }
            ],
            [
                { text: "💰 Finance Hub", callback_data: "finance_hub" },
                { text: "🏠 Main Hub", callback_data: "hub" }
            ]
        ]
    };

    // If audio is requested (or morning briefing), generate spoken voice snippet
    if (options.withVoice) {
        try {
            const spokenSummary = `Good morning Boss. Friday online. Your net balance is ${netBalance >= 0 ? "positive" : "negative"} ${formatMoney(Math.abs(netBalance))} dollars. You have ${activeTasksCount} tasks and ${remindersCount} alerts scheduled today. Standing by.`;
            const audioBuffer = await generateSpeechAudio(spokenSummary, "en-gb");
            if (audioBuffer) {
                await sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Tactical Briefing");
                await sendMessage(env, chatId, text, {
                    parse_mode: "Markdown",
                    reply_markup: keyboard
                });
                return;
            }
        } catch (vErr) {
            console.warn("Failed to generate voice for briefing, falling back to text:", vErr.message);
        }
    }

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

/**
 * Autonomous daily morning broadcast to active users at 08:00 AM ICT.
 */
export async function sendDailyScheduledBriefings(env) {
    try {
        const sevenDaysAgo = dateDaysAgo(7);
        const { results } = await env.DB.prepare(
            "SELECT DISTINCT user_id FROM expenses WHERE date >= ?"
        ).bind(sevenDaysAgo).all();

        if (results && results.length > 0) {
            for (const row of results) {
                try {
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
