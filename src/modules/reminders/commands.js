import { TIME_ZONE } from "../../config/constants.js";
import { ensureTables } from "../../db/schema.js";
import { sendMessage } from "../../services/telegram.js";
import { sendPromptAddReminder, sendRemindersMenu } from "./views.js";

export async function handleLunchboxCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length === 1) {
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    const arg = parts[1].toLowerCase();
    if (arg === "on") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1").bind(userId).first();
        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?").bind(String(chatId), existing.id).run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Departure / Lunchbox Reminder', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }
        await sendMessage(env, chatId, "🟢 *Departure alarm enabled for 17:30 (Mon–Fri)!*", { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    if (arg === "off") {
        await ensureTables(env.DB);
        await env.DB.prepare("UPDATE reminders SET is_active = 0 WHERE user_id = ? AND type = 'lunchbox'").bind(userId).run();
        await sendMessage(env, chatId, "🔴 *Departure alarm disabled.*", { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    const timeMatch = arg.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (timeMatch) {
        const formattedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
        await ensureTables(env.DB);
        const existing = await env.DB.prepare("SELECT id FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1").bind(userId).first();
        if (existing) {
            await env.DB.prepare("UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ?").bind(formattedTime, String(chatId), existing.id).run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Departure / Lunchbox Reminder', ?, 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId), formattedTime).run();
        }
        await sendMessage(env, chatId, `⏰ *Departure reminder time set to ${formattedTime} (Active)!*`, { parse_mode: "Markdown" });
        await sendRemindersMenu(env, chatId, userId);
        return;
    }

    await sendRemindersMenu(env, chatId, userId);
}

export async function handleRemindCommand(env, chatId, userId, text) {
    const raw = text.replace(/^\/?(remindme|remind|alarm)\s*/i, "").trim();
    if (!raw || raw.toLowerCase() === "help") {
        await sendPromptAddReminder(env, chatId);
        return;
    }

    let timeStr = "";
    let title = "";
    let frequency = "daily";
    let isRelative = false;
    let mins = 0;

    // 1. Relative: e.g. "in 30m check oven", "30 mins call mom", "in 1h check server"
    const relMatch = raw.match(/^(?:in\s+)?(\d+)\s*(minutes|minute|mins|min|hours|hour|hrs|hr|m|h)\s*(.*)$/i);
    if (relMatch) {
        const num = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        title = relMatch[3].trim() || "Reminder";
        mins = unit.startsWith("h") ? num * 60 : num;
        const now = new Date();
        const target = new Date(now.getTime() + mins * 60 * 1000);
        timeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(target);
        frequency = "once";
        isRelative = true;
    }

    // 2. 12-hour AM/PM: e.g. "5pm bring lunch box", "5:30pm call mom", "9am standup"
    if (!timeStr) {
        const ampmMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(.*)$/i);
        if (ampmMatch) {
            let hour = parseInt(ampmMatch[1], 10);
            const minute = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
            const ampm = ampmMatch[3].toLowerCase();
            if (ampm === "pm" && hour < 12) hour += 12;
            if (ampm === "am" && hour === 12) hour = 0;
            timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
            title = ampmMatch[4].trim() || "Reminder";
            frequency = "daily";
        }
    }

    // 3. 24-hour format: e.g. "17:30 bring lunch box", "08:00 vitamins", "9:00 standup"
    if (!timeStr) {
        const standardMatch = raw.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])\s*(.*)$/i);
        if (standardMatch) {
            const hour = standardMatch[1].padStart(2, "0");
            const minute = standardMatch[2];
            timeStr = `${hour}:${minute}`;
            title = standardMatch[3].trim() || "Reminder";
            frequency = "daily";
        }
    }

    if (!timeStr) {
        await sendMessage(env, chatId, [
            `❌ *Could not understand the time.*`,
            `Please specify a time like \`17:30\`, \`5:30pm\`, or \`in 30m\`.`,
            ``,
            `Examples:`,
            `• \`remind 17:30 Bring lunch box\``,
            `• \`remind in 20m Check oven\``,
            `• \`remind 9am Team standup\``
        ].join("\n"), { parse_mode: "Markdown" });
        return;
    }

    const type = title.toLowerCase().includes("lunch") ? "lunchbox" : "custom";

    await ensureTables(env.DB);
    const insertResult = await env.DB.prepare(`
        INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(userId, String(chatId), title, timeStr, frequency, type).run();

    const newId = insertResult?.meta?.last_row_id;
    const freqLabel = frequency === "once" 
        ? (isRelative ? `in ${mins} mins` : "Once") 
        : frequency === "weekdays" ? "Mon–Fri" : "Daily";

    const isLunch = type === "lunchbox";
    const icon = isLunch ? "🎒" : "⏰";

    const textResponse = [
        `${icon} *Reminder Set*`,
        `────────────────────`,
        `● *Title:* *${title}*`,
        `● *Time:*  \`${timeStr}\` (${freqLabel})`,
        `────────────────────`,
        `_You will be alerted on Telegram when it's time._`
    ].join("\n");

    const buttons = [
        [
            { text: "⏰ Reminders", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];
    if (newId) {
        buttons.unshift([
            { text: "⏰ Adjust Time", callback_data: `remind_time_menu:${newId}` },
            { text: "✕ Delete", callback_data: `remind_del:${newId}` }
        ]);
    }

    await sendMessage(env, chatId, textResponse, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}
