import { ensureTables } from "../../db/schema.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendPromptAddReminder(env, chatId, messageId = null) {
    const text = [
        `⏰ *New Reminder*`,
        `────────────────────`,
        `You can remind *anything at any time*! Type naturally:`,
        ``,
        `1️⃣ *Exact Time:*`,
        `• \`remind 17:30 Bring lunch box / bag home\``,
        `• \`remind 09:00 Team morning standup\``,
        `• \`remind 21:00 Review daily expenses\``,
        `• \`remind 8:30pm Water the plants\``,
        ``,
        `2️⃣ *Quick Timers (Minutes / Hours):*`,
        `• \`remind in 15m Check the oven\``,
        `• \`remind in 30m Take medicine\``,
        `• \`remind in 1h Call the client\``,
        ``,
        `_Or choose a preset below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ 09:00 Standup Preset", callback_data: "remind_add_standup" },
                    { text: "🎒 17:30 Departure", callback_data: "remind_add_lunchbox" }
                ],
                [
                    { text: "💳 Spending Check (21:00)", callback_data: "toggle_expense_reminder" },
                    { text: "‹ Back", callback_data: "reminders" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendRemindersMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];
    const activeCount = reminders.filter(r => r.is_active).length;

    let listText = "";
    if (reminders.length === 0) {
        listText = "_No reminders set yet._\nTap *[ ＋ Add Reminder ]* below or type:\n`remind 17:30 Bring lunch box`";
    } else {
        listText = reminders.map((r, idx) => {
            const status = r.is_active ? "●" : "○";
            const freq = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
            const icon = r.type === "lunchbox" ? "🎒" : r.type === "standup" ? "🗣️" : r.type === "expense_log" ? "💳" : "⏰";
            return `${idx + 1}. ${status} ${icon} *${r.title}*\n    └ \`${r.reminder_time}\` (${freq})`;
        }).join("\n");
    }

    const text = [
        `⏰ *Reminders & Alerts*`,
        `────────────────────`,
        `● *Active:*  \`${activeCount}\` of ${reminders.length} reminder(s)`,
        `────────────────────`,
        listText,
        `────────────────────`,
        `_Type \`remind <time> <task>\` or \`remind in 30m <task>\`_`
    ].join("\n");

    const buttons = [
        [
            { text: "＋ Add Reminder", callback_data: "remind_prompt_add" },
            { text: "🗣️ Standup 09:00", callback_data: "remind_add_standup" },
            { text: "🎒 17:30", callback_data: "remind_add_lunchbox" }
        ]
    ];

    for (const r of reminders.slice(0, 6)) {
        const toggleIcon = r.is_active ? "●" : "○";
        const shortTitle = r.title.length > 13 ? r.title.slice(0, 12) + "…" : r.title;
        buttons.push([
            { text: `${toggleIcon} ${shortTitle}`, callback_data: `remind_toggle:${r.id}` },
            { text: `${r.reminder_time}`, callback_data: `remind_time_menu:${r.id}` },
            { text: "✕", callback_data: `remind_del:${r.id}` }
        ]);
    }

    buttons.push([
        { text: "🔔 Test Alert", callback_data: "remind_test_general" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendLunchboxMenu(env, chatId, userId, messageId = null) {
    return sendRemindersMenu(env, chatId, userId, messageId);
}

export async function sendReminderTimeMenu(env, chatId, userId, reminderId, messageId = null) {
    await ensureTables(env.DB);
    const r = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, is_active FROM reminders WHERE id = ? AND user_id = ?"
    ).bind(reminderId, userId).first();

    if (!r) {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Reminder not found.");
        return sendRemindersMenu(env, chatId, userId, messageId);
    }

    const freqLabel = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
    const nextFreq = r.frequency === "weekdays" ? "daily" : r.frequency === "daily" ? "once" : "weekdays";
    const nextFreqLabel = nextFreq === "weekdays" ? "Mon–Fri" : nextFreq === "daily" ? "Daily" : "Once";

    const text = [
        `⏰ *Reminder Schedule*`,
        `────────────────────`,
        `📌 *${r.title}*`,
        `● *Current Time:* \`${r.reminder_time}\` (${freqLabel})`,
        `────────────────────`,
        `_Choose a preset time below or type:_`,
        `\`remind <time> ${r.title}\``
    ].join("\n");

    const buttons = [
        [
            { text: "16:30", callback_data: `remind_set_time:${r.id}:16:30` },
            { text: "17:00", callback_data: `remind_set_time:${r.id}:17:00` },
            { text: "17:30", callback_data: `remind_set_time:${r.id}:17:30` },
            { text: "18:00", callback_data: `remind_set_time:${r.id}:18:00` }
        ],
        [
            { text: "08:30", callback_data: `remind_set_time:${r.id}:08:30` },
            { text: "09:00", callback_data: `remind_set_time:${r.id}:09:00` },
            { text: "12:00", callback_data: `remind_set_time:${r.id}:12:00` },
            { text: "21:00", callback_data: `remind_set_time:${r.id}:21:00` }
        ],
        [
            { text: "⏱️ In 15m", callback_data: `remind_set_rel:${r.id}:15` },
            { text: "⏱️ In 30m", callback_data: `remind_set_rel:${r.id}:30` },
            { text: "⏱️ In 1h", callback_data: `remind_set_rel:${r.id}:60` }
        ],
        [
            { text: `🔁 Schedule: ${nextFreqLabel}`, callback_data: `remind_freq:${r.id}:${nextFreq}` }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}
