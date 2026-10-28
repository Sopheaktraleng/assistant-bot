import { TIME_ZONE, isUserAuthorized } from "../../config/constants.js";
import { today, getPreviousWorkdayDate } from "../../utils/time.js";
import { getWorkCategoryIcon } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { sendMessage } from "../../services/telegram.js";

export async function processDueReminders(env) {
    await ensureTables(env.DB);
    const now = new Date();
    
    const timeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(now); // e.g. "17:30"

    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "short"
    }).format(now); // "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"

    const todayStr = today();
    const isWeekday = weekdayStr !== "Sat" && weekdayStr !== "Sun";

    const { results } = await env.DB.prepare(`
        SELECT id, user_id, chat_id, title, reminder_time, frequency, type 
        FROM reminders 
        WHERE is_active = 1 
          AND reminder_time = ? 
          AND (last_sent_date IS NULL OR last_sent_date != ?)
    `).bind(timeStr, todayStr).all();

    if (!results || results.length === 0) return;

    for (const r of results) {
        if (!isUserAuthorized(r.user_id, env)) {
            continue;
        }

        if (r.frequency === "weekdays" && !isWeekday) {
            continue;
        }

        try {
            if (r.type === "lunchbox") {
                await sendLunchboxNotification(env, r.chat_id, r.id);
            } else if (r.type === "standup") {
                await sendStandupNotification(env, r.chat_id, r.user_id, r.id);
            } else if (r.type === "expense_log") {
                await sendExpenseLogNotification(env, r.chat_id);
            } else {
                await sendCustomReminderNotification(env, r.chat_id, r.title, r.reminder_time, r.id);
            }

            if (r.frequency === "once") {
                await env.DB.prepare("UPDATE reminders SET is_active = 0, last_sent_date = ? WHERE id = ?")
                    .bind(todayStr, r.id)
                    .run();
            } else {
                await env.DB.prepare("UPDATE reminders SET last_sent_date = ? WHERE id = ?")
                    .bind(todayStr, r.id)
                    .run();
            }
        } catch (err) {
            console.error(`Failed to send reminder ${r.id} to chat ${r.chat_id}:`, err);
        }
    }
}

export async function sendStandupNotification(env, chatId, userId, reminderId = 0) {
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    let prevLogs = [];
    let effectivePrevDate = prevWorkday;

    const directPrevRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, prevWorkday).all();

    if (directPrevRows.results && directPrevRows.results.length > 0) {
        prevLogs = directPrevRows.results;
    } else {
        const priorRow = await env.DB.prepare(
            "SELECT DISTINCT date FROM work_logs WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1"
        ).bind(userId, todayDate).first();
        if (priorRow?.date) {
            effectivePrevDate = priorRow.date;
            const fallbackRows = await env.DB.prepare(
                "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
            ).bind(userId, effectivePrevDate).all();
            prevLogs = fallbackRows.results || [];
        }
    }

    const prevSummary = prevLogs.length > 0
        ? prevLogs.map(item => `• ${getWorkCategoryIcon(item.category)} ${item.content}`).slice(0, 4).join("\n")
        : "_No tasks recorded for previous session._";

    const text = [
        `🌅 *Morning Standup Time!*`,
        ``,
        `Ready to start your work day? 🚀`,
        ``,
        `⏮️ *Accomplished in last session (${effectivePrevDate}):*`,
        prevSummary,
        ``,
        `🎯 *What are your top priorities for today?*`,
        ``,
        `_Log anytime with: \`done <task description>\`_`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ View Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish", callback_data: "work_standup_polish" }
                ],
                [
                    { text: "＋ Log Task", callback_data: "work_log_prompt" },
                    { text: "⏰ Snooze 30m", callback_data: `su_snooze:${reminderId}` }
                ]
            ]
        }
    });
}

export async function sendLunchboxNotification(env, chatId, reminderId = 0) {
    const text = [
        `🎒 *End-of-Day Departure Alert*`,
        ``,
        `Wrapping up your workday? 🚪`,
        ``,
        `Don't forget to:`,
        `• Grab your lunchbox, bag, and personal belongings`,
        `• Log your daily accomplishments: \`/done <task>\``,
        ``,
        `_Safe travels home! ✨_`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✓ Packed & Ready", callback_data: `lb_ack:${reminderId}` },
                    { text: "⏰ Snooze 15m", callback_data: `lb_snooze:${reminderId}` }
                ],
                [
                    { text: "⚡ Log Work", callback_data: "work_log_prompt" },
                    { text: "📋 Today's Work", callback_data: "work_today" }
                ]
            ]
        }
    });
}

export async function sendExpenseLogNotification(env, chatId) {
    const text = [
        `💳 *Daily Cashflow Check-in*`,
        ``,
        `Did you spend or earn anything today? 📊`,
        ``,
        `Take 10 seconds to record your day's transactions and keep your budget balanced!`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "＋ Log Expense", callback_data: "add_expense" },
                    { text: "＋ Log Income", callback_data: "add_income" }
                ],
                [
                    { text: "📜 Today's Ledger", callback_data: "view_transactions" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendCustomReminderNotification(env, chatId, title, time, reminderId) {
    const text = [
        `⏰ *Reminder Alert*`,
        ``,
        `🔔 *${title}*`,
        `● *Scheduled:* \`${time}\``,
        ``,
        `_Take action or snooze below:_`
    ].join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Done / Dismiss", callback_data: `remind_done:${reminderId}` }
                ],
                [
                    { text: "⏰ Snooze 10m", callback_data: `remind_snooze:${reminderId}:10` },
                    { text: "⏰ Snooze 30m", callback_data: `remind_snooze:${reminderId}:30` }
                ]
            ]
        }
    });
}
