import { TIME_ZONE } from "../../config/constants.js";
import { ensureTables } from "../../db/schema.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendPromptAddReminder(env, chatId, messageId = null) {
    const text = [
        `⏰ *Quick Timers & Reminders*`,
        `────────────────────`,
        `⚡ *1-Tap Countdown Timers:*`,
        `Tap any button below to start a quick alert right now:`,
        ``,
        `✍️ *Or Type Naturally Anytime:*`,
        `• \`remind in 25m Check oven\``,
        `• \`remind 18:30 Pick up laundry\``,
        `• \`remind 9am Team sprint review\``,
        `────────────────────`,
        `_The bot will alert you on Telegram when it's time!_`
    ].join("\n");

    const buttons = [
        [
            { text: "⏱️ In 10 Mins", callback_data: "remind_quick_timer:10" },
            { text: "⏱️ In 15 Mins", callback_data: "remind_quick_timer:15" }
        ],
        [
            { text: "⏱️ In 30 Mins", callback_data: "remind_quick_timer:30" },
            { text: "⏱️ In 45 Mins", callback_data: "remind_quick_timer:45" }
        ],
        [
            { text: "⏱️ In 1 Hour", callback_data: "remind_quick_timer:60" },
            { text: "⏱️ In 2 Hours", callback_data: "remind_quick_timer:120" }
        ],
        [
            { text: "‹ Back to Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: buttons
        }
    });
}

export async function sendRemindersMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, title, reminder_time, frequency, type, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();

    const reminders = results || [];

    const standup = reminders.find(r => r.type === "standup");
    const standupActive = standup ? Boolean(standup.is_active) : false;

    const lunchbox = reminders.find(r => r.type === "lunchbox");
    const lunchboxActive = lunchbox ? Boolean(lunchbox.is_active) : false;

    const expense = reminders.find(r => r.type === "expense_log");
    const expenseActive = expense ? Boolean(expense.is_active) : false;

    const customReminders = reminders.filter(
        r => r.type !== "standup" && r.type !== "lunchbox" && r.type !== "expense_log"
    );
    const activeCustom = customReminders.filter(r => r.is_active).length;

    const autoCount = (standupActive ? 1 : 0) + (lunchboxActive ? 1 : 0) + (expenseActive ? 1 : 0);

    let customTextList = "";
    if (customReminders.length === 0) {
        customTextList = `_No custom timers right now. Tap **＋ Quick Timers** below!_`;
    } else {
        customTextList = customReminders.map((r, idx) => {
            const status = r.is_active ? "🟢" : "⚪";
            const freq = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
            return `${idx + 1}. ${status} \`${r.reminder_time}\` (${freq}) • *${r.title}*`;
        }).join("\n");
    }

    const text = [
        `⏰ *Reminders & Alerts Hub*`,
        `────────────────────`,
        `● *Automations:*  \`${autoCount}\` of 3 active`,
        `● *Custom Timers:* \`${activeCustom}\` active`,
        `● *Timezone:*      \`${TIME_ZONE}\` (UTC+7)`,
        `────────────────────`,
        `🤖 *Daily Routine Automations:*`,
        `${standupActive ? "🟢" : "⚪"} *09:00* • 🗣️ Morning Standup Sync (Mon–Fri)`,
        `${lunchboxActive ? "🟢" : "⚪"} *17:30* • 🎒 Departure Alarm (Mon–Fri)`,
        `${expenseActive ? "🟢" : "⚪"} *21:00* • 💳 Daily Expense Check (Daily)`,
        ``,
        `📌 *Custom Reminders & Timers:*`,
        customTextList,
        `────────────────────`,
        `💡 _Tap any automation to toggle, or type: \`remind in 20m <task>\`_`
    ].join("\n");

    const buttons = [
        [
            { text: "＋ New Reminder", callback_data: "remind_prompt_add" },
            { text: "⏱️ Quick Timers", callback_data: "remind_prompt_add" }
        ],
        [
            { 
                text: `${standupActive ? "🟢" : "⚪"} Standup 09:00`, 
                callback_data: "remind_add_standup" 
            },
            { 
                text: `${lunchboxActive ? "🟢" : "⚪"} Departure 17:30`, 
                callback_data: "remind_add_lunchbox" 
            }
        ],
        [
            { 
                text: `${expenseActive ? "🟢" : "⚪"} Expense Check 21:00`, 
                callback_data: "toggle_expense_reminder" 
            },
            { text: "🔔 Test Alert", callback_data: "remind_test_general" }
        ]
    ];

    for (const r of customReminders.slice(0, 5)) {
        const statusIcon = r.is_active ? "🟢" : "⚪";
        const shortTitle = r.title.length > 18 ? r.title.slice(0, 17) + "…" : r.title;
        buttons.push([
            { text: `${statusIcon} ${r.reminder_time} • ${shortTitle}`, callback_data: `remind_toggle:${r.id}` },
            { text: "⚙️ Edit", callback_data: `remind_time_menu:${r.id}` }
        ]);
    }

    buttons.push([
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
        return sendRemindersMenu(env, chatId, userId, messageId);
    }

    const freqLabel = r.frequency === "weekdays" ? "Mon–Fri" : r.frequency === "daily" ? "Daily" : "Once";
    const nextFreq = r.frequency === "weekdays" ? "daily" : r.frequency === "daily" ? "once" : "weekdays";
    const statusLabel = r.is_active ? "🟢 Active" : "⚪ Disabled";

    const text = [
        `⚙️ *Manage Reminder*`,
        `────────────────────`,
        `📌 *${r.title}*`,
        `● *Status:*     ${statusLabel}`,
        `● *Time:*       \`${r.reminder_time}\` (${freqLabel})`,
        `────────────────────`,
        `_Quickly toggle, shift time, change repeat, or delete:_`
    ].join("\n");

    const buttons = [
        [
            { text: r.is_active ? "⚪ Turn Off" : "🟢 Turn On", callback_data: `remind_toggle_inspect:${r.id}` },
            { text: `🔁 Repeat: ${freqLabel}`, callback_data: `remind_freq:${r.id}:${nextFreq}` }
        ],
        [
            { text: "⏱️ +15m", callback_data: `remind_shift:${r.id}:15` },
            { text: "⏱️ +30m", callback_data: `remind_shift:${r.id}:30` },
            { text: "⏱️ +1h", callback_data: `remind_shift:${r.id}:60` }
        ],
        [
            { text: "🌅 09:00", callback_data: `remind_set_time:${r.id}:09:00` },
            { text: "☀️ 12:00", callback_data: `remind_set_time:${r.id}:12:00` },
            { text: "🌇 17:30", callback_data: `remind_set_time:${r.id}:17:30` },
            { text: "🌙 21:00", callback_data: `remind_set_time:${r.id}:21:00` }
        ],
        [
            { text: "🗑️ Delete Reminder", callback_data: `remind_del:${r.id}` }
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
