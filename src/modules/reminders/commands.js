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

export function parseReminderInput(raw, now = new Date()) {
    let clean = raw.replace(/^\/?(remindme|remind|alarm)\s*/i, "").trim();
    // remove leading "me" or "to"
    clean = clean.replace(/^(?:me\s+)?(?:to\s+)?/i, "").trim();

    let timeStr = "";
    let targetDateStr = null;
    let frequency = "daily";
    let isRelative = false;
    let mins = 0;
    let title = "";

    // 1. Check relative: e.g. "in 30m check oven", "30 mins call mom", "in 1h check server"
    const relMatch = clean.match(/^(?:in\s+)?(\d+)\s*(minutes|minute|mins|min|hours|hour|hrs|hr|m|h)\s*(.*)$/i);
    if (relMatch) {
        const num = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        title = relMatch[3].replace(/^(?:to\s+)/i, "").trim() || "Reminder";
        mins = unit.startsWith("h") ? num * 60 : num;
        const target = new Date(now.getTime() + mins * 60 * 1000);
        timeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(target);
        targetDateStr = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(target);
        frequency = "once";
        isRelative = true;
        return { timeStr, targetDateStr, title, frequency, isRelative, mins };
    }

    // Check trailing relative: "check oven in 20m"
    const relEndMatch = clean.match(/^(.*?)\s+(?:in\s+)(\d+)\s*(minutes|minute|mins|min|hours|hour|hrs|hr|m|h)$/i);
    if (relEndMatch) {
        const num = parseInt(relEndMatch[2], 10);
        const unit = relEndMatch[3].toLowerCase();
        title = relEndMatch[1].replace(/^(?:to\s+)/i, "").trim() || "Reminder";
        mins = unit.startsWith("h") ? num * 60 : num;
        const target = new Date(now.getTime() + mins * 60 * 1000);
        timeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(target);
        targetDateStr = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(target);
        frequency = "once";
        isRelative = true;
        return { timeStr, targetDateStr, title, frequency, isRelative, mins };
    }

    let workingStr = clean;

    // 2. Time extraction (extract time first so hour numbers in 17:30 are not confused with dates)
    const ampmMatch = workingStr.match(/(?:(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))/i);
    if (ampmMatch) {
        let hour = parseInt(ampmMatch[1], 10);
        const minute = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
        const ampm = ampmMatch[3].toLowerCase();
        if (ampm === "pm" && hour < 12) hour += 12;
        if (ampm === "am" && hour === 12) hour = 0;
        timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        workingStr = workingStr.replace(ampmMatch[0], "").trim();
    }

    if (!timeStr) {
        const stdMatch = workingStr.match(/(?:at\s+)?([0-1]?[0-9]|2[0-3]):([0-5][0-9])/i);
        if (stdMatch) {
            const hour = stdMatch[1].padStart(2, "0");
            const minute = stdMatch[2];
            timeStr = `${hour}:${minute}`;
            workingStr = workingStr.replace(stdMatch[0], "").trim();
        }
    }

    // 3. Date parsing:
    const localFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const [curYearStr, curMonthStr, curDayStr] = localFormatter.format(now).split("-");
    const curYear = parseInt(curYearStr, 10);
    const curMonth = parseInt(curMonthStr, 10);
    const curDay = parseInt(curDayStr, 10);

    const monthMap = {
        jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
        apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
        aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
        nov: 11, november: 11, dec: 12, december: 12
    };

    // Check "tomorrow"
    if (/\btomorrow\b/i.test(workingStr)) {
        workingStr = workingStr.replace(/\btomorrow\b/i, "").trim();
        const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        targetDateStr = localFormatter.format(tomorrowDate);
        frequency = "once";
    }

    // Check "on (the )?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)?"
    if (!targetDateStr) {
        const dateMatch = workingStr.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)?\b(?!\s*:)/i);
        if (dateMatch) {
            const dayNum = parseInt(dateMatch[1], 10);
            if (dayNum >= 1 && dayNum <= 31) {
                let targetMonth = curMonth;
                let targetYear = curYear;
                if (dateMatch[2]) {
                    const mKey = dateMatch[2].toLowerCase();
                    if (monthMap[mKey]) {
                        targetMonth = monthMap[mKey];
                        if (targetMonth < curMonth) targetYear += 1;
                    }
                } else {
                    if (dayNum < curDay) {
                        targetMonth += 1;
                        if (targetMonth > 12) {
                            targetMonth = 1;
                            targetYear += 1;
                        }
                    }
                }
                targetDateStr = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                workingStr = workingStr.replace(dateMatch[0], "").trim();
                frequency = "once";
            }
        }
    }

    // Check "Oct 30" / "October 30th"
    if (!targetDateStr) {
        const monthDayMatch = workingStr.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*:)/i);
        if (monthDayMatch) {
            const mKey = monthDayMatch[1].toLowerCase();
            const dayNum = parseInt(monthDayMatch[2], 10);
            if (monthMap[mKey] && dayNum >= 1 && dayNum <= 31) {
                let targetMonth = monthMap[mKey];
                let targetYear = curYear;
                if (targetMonth < curMonth) targetYear += 1;
                targetDateStr = `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
                workingStr = workingStr.replace(monthDayMatch[0], "").trim();
                frequency = "once";
            }
        }
    }

    // If date was found, but NO time, default to 09:00
    if (targetDateStr && !timeStr) {
        timeStr = "09:00";
    }

    title = workingStr
        .replace(/^to\s+/i, "")
        .replace(/^at\s+/i, "")
        .replace(/^on\s+/i, "")
        .replace(/^(?:me\s+)?to\s+/i, "")
        .trim();

    if (!title) title = "Reminder";
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return { timeStr, targetDateStr, title, frequency, isRelative, mins };
}

export async function handleRemindCommand(env, chatId, userId, text) {
    const raw = text.replace(/^\/?(remindme|remind|alarm)\s*/i, "").trim();
    if (!raw || raw.toLowerCase() === "help") {
        await sendPromptAddReminder(env, chatId);
        return;
    }

    const { timeStr, targetDateStr, title, frequency, isRelative, mins } = parseReminderInput(raw);

    if (!timeStr) {
        await sendMessage(env, chatId, [
            `❌ *Could not understand the reminder.*`,
            `Specify a time or date like \`17:30\`, \`in 30m\`, or \`on 30th at 8am\`.`,
            ``,
            `Examples:`,
            `• \`remind in 20m Check oven\``,
            `• \`remind on 30th at 8am Take the ice\``,
            `• \`remind 17:30 Bring lunch box\``
        ].join("\n"), { parse_mode: "Markdown" });
        return;
    }

    await ensureTables(env.DB);
    const insertResult = await env.DB.prepare(`
        INSERT INTO reminders (user_id, chat_id, title, reminder_time, target_date, frequency, type, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 'custom', 1)
    `).bind(userId, String(chatId), title, timeStr, targetDateStr, frequency).run();

    const newId = insertResult?.meta?.last_row_id;
    let whenLabel = `\`${timeStr}\``;
    if (targetDateStr) {
        const parts = targetDateStr.split("-");
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const mIdx = parseInt(parts[1], 10) - 1;
        whenLabel = `\`${monthNames[mIdx]} ${parseInt(parts[2], 10)} • ${timeStr}\``;
    } else if (isRelative) {
        whenLabel = `\`${timeStr}\` (in ${mins}m)`;
    } else if (frequency === "daily") {
        whenLabel = `\`${timeStr}\` (Daily)`;
    }

    const textResponse = [
        `⏰ *Reminder Set*`,
        ``,
        `● *Title:* *${title}*`,
        `● *When:*  ${whenLabel}`,
        ``,
        `_You will be alerted on Telegram when it's time._`
    ].join("\n");

    const buttons = [
        [
            { text: "⏰ Reminders Hub", callback_data: "reminders" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];
    if (newId) {
        buttons.unshift([
            { text: "🗑️ Delete", callback_data: `remind_del:${newId}` }
        ]);
    }

    await sendMessage(env, chatId, textResponse, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}
