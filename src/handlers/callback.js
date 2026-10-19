import { TIME_ZONE, EXCHANGE_RATE } from "../config/constants.js";
import { today, currentTime } from "../utils/time.js";
import { formatMoney } from "../utils/format.js";
import { ensureTables } from "../db/schema.js";
import {
    getDisplayCurrency,
    setDisplayCurrency,
    getTotalExpenses,
    addExpenseRecord,
    clearToday,
    clearAllExpenses
} from "../db/queries.js";
import {
    telegram,
    sendMessage,
    answerCallback,
    safeEditOrSendMessage
} from "../services/telegram.js";
import {
    sendMainHub,
    sendMainMenu,
    sendSettingsMenu,
    sendHelpMessage
} from "../modules/hub/views.js";
import {
    sendFinanceHub,
    sendCategoryPicker,
    sendAmountPicker,
    sendTransactionReceipt,
    sendTransactions,
    sendSummary,
    updateHistoryMessage
} from "../modules/finance/views.js";
import {
    askClearConfirmation,
    sendCSVBackup
} from "../modules/finance/commands.js";
import {
    sendScanHelp,
    handleScanConfirm,
    sendScanCategoryPicker,
    handleScanSetCategory,
    handleScanToggleType,
    renderPendingScanCard,
    handleScanDiscard
} from "../modules/finance/scanner.js";
import {
    sendWorkHub,
    sendTodayWork,
    sendWorkReport,
    sendWorkReportFile,
    sendWorkDeletePicker,
    sendStandupReport,
    sendStandupCopyBlock,
    handleAiPolishStandup,
    handleAiPolishWorkReport,
    handleAiPolishWorkReportExport
} from "../modules/work/views.js";
import {
    sendPromptAddReminder,
    sendRemindersMenu,
    sendLunchboxMenu,
    sendReminderTimeMenu
} from "../modules/reminders/views.js";
import { sendCustomReminderNotification } from "../modules/reminders/cron.js";
import {
    sendMovieRecommenderHub,
    sendWatchlistMenu,
    handleGenerateMovieRecommendation
} from "../modules/watchlist/views.js";
import { handlePickRandomMovie } from "../modules/watchlist/commands.js";
import { handleAiCopilotQuery } from "../modules/copilot/handler.js";
import { sendVoiceHelp } from "../modules/voice/handler.js";

/**
 * Dispatches all Telegram inline keyboard callback queries.
 */
export async function handleCallback(callback, env, origin) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);
    const messageId = callback.message?.message_id;

    await answerCallback(env, callback.id);

    if (!chatId) return;

    // --- Main Hub, Finance Hub & Settings ---
    if (data === "menu" || data === "hub") {
        await sendMainHub(env, chatId, userId, callback.from, origin, messageId);
        return;
    }

    if (data === "finance_hub") {
        await sendFinanceHub(env, chatId, userId, messageId);
        return;
    }

    if (data === "voice_help") {
        await sendVoiceHelp(env, chatId, messageId);
        return;
    }

    // --- Work Log & Reports Callbacks ---
    if (data === "work_hub") {
        await sendWorkHub(env, chatId, userId, callback.from, messageId);
        return;
    }

    // --- Movie Recommender & Watchlist Callbacks ---
    if (data === "movie_hub") {
        await sendMovieRecommenderHub(env, chatId, userId, messageId);
        return;
    }

    if (data === "watchlist") {
        await sendWatchlistMenu(env, chatId, userId, "all", 1, messageId);
        return;
    }

    if (data.startsWith("wl_filter:")) {
        const filter = data.slice(10);
        await sendWatchlistMenu(env, chatId, userId, filter, 1, messageId);
        return;
    }

    if (data.startsWith("wl_page:")) {
        const [, pStr, filter] = data.split(":");
        const page = parseInt(pStr, 10) || 1;
        await sendWatchlistMenu(env, chatId, userId, filter || "all", page, messageId);
        return;
    }

    if (data === "wl_pick") {
        await handlePickRandomMovie(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("wl_genre:")) {
        const genre = data.slice(9);
        await handleGenerateMovieRecommendation(env, chatId, userId, genre, callback.from, messageId);
        return;
    }

    if (data.startsWith("wl_roll:")) {
        const genre = decodeURIComponent(data.slice(8)) || "random";
        await handleGenerateMovieRecommendation(env, chatId, userId, genre, callback.from, messageId);
        return;
    }

    if (data.startsWith("wl_save:")) {
        const id = parseInt(data.slice(8), 10);
        if (id) {
            await env.DB.prepare("UPDATE watchlist SET status = 'plan_to_watch' WHERE id = ? AND user_id = ?").bind(id, userId).run();
            await answerCallback(env, callback.id, { text: "⭐ Saved to your Watchlist!" });
            if (callback.message?.reply_markup) {
                const updatedMarkup = JSON.parse(JSON.stringify(callback.message.reply_markup));
                if (updatedMarkup.inline_keyboard?.[0]?.[0]) {
                    updatedMarkup.inline_keyboard[0][0] = { text: "✅ In Watchlist", callback_data: "watchlist" };
                }
                try {
                    await telegram(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: updatedMarkup
                    });
                } catch (e) {}
            }
        }
        return;
    }

    if (data.startsWith("wl_watched:")) {
        const id = parseInt(data.slice(11), 10);
        if (id) {
            await env.DB.prepare("UPDATE watchlist SET status = 'watched', watched_at = ? WHERE id = ? AND user_id = ?").bind(today(), id, userId).run();
            await answerCallback(env, callback.id, { text: "🍿 Marked as watched! Enjoy!" });
            if (callback.message?.reply_markup) {
                const updatedMarkup = JSON.parse(JSON.stringify(callback.message.reply_markup));
                if (updatedMarkup.inline_keyboard?.[0]) {
                    updatedMarkup.inline_keyboard[0] = [
                        { text: "🍿 Marked Watched ✅", callback_data: "watchlist" }
                    ];
                }
                try {
                    await telegram(env, "editMessageReplyMarkup", {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: updatedMarkup
                    });
                } catch (e) {}
            }
        }
        return;
    }

    if (data.startsWith("wl_toggle:")) {
        const id = parseInt(data.slice(10), 10);
        if (id) {
            const cur = await env.DB.prepare("SELECT status FROM watchlist WHERE id = ? AND user_id = ?").bind(id, userId).first();
            if (cur) {
                const newStatus = cur.status === "watched" ? "plan_to_watch" : "watched";
                const watchedAt = newStatus === "watched" ? today() : null;
                await env.DB.prepare("UPDATE watchlist SET status = ?, watched_at = ? WHERE id = ? AND user_id = ?").bind(newStatus, watchedAt, id, userId).run();
                await answerCallback(env, callback.id, { text: newStatus === "watched" ? "🍿 Marked watched!" : "⭐ Moved to Plan to Watch!" });
                await sendWatchlistMenu(env, chatId, userId, "all", 1, messageId);
            }
        }
        return;
    }

    if (data.startsWith("wl_del:")) {
        const id = parseInt(data.slice(7), 10);
        if (id) {
            await env.DB.prepare("DELETE FROM watchlist WHERE id = ? AND user_id = ?").bind(id, userId).run();
            await answerCallback(env, callback.id, { text: "🗑️ Removed from watchlist." });
            await sendWatchlistMenu(env, chatId, userId, "all", 1, messageId);
        }
        return;
    }

    if (data === "work_today") {
        await sendTodayWork(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_week") {
        await sendWorkReport(env, chatId, userId, "this_week", callback.from, messageId);
        return;
    }

    if (data === "work_report_this") {
        await sendWorkReport(env, chatId, userId, "this_month", callback.from, messageId);
        return;
    }

    if (data === "work_report_last") {
        await sendWorkReport(env, chatId, userId, "last_month", callback.from, messageId);
        return;
    }

    if (data === "work_export_this") {
        await sendWorkReportFile(env, chatId, userId, "this_month", callback.from);
        return;
    }

    if (data === "work_export_last") {
        await sendWorkReportFile(env, chatId, userId, "last_month", callback.from);
        return;
    }

    if (data === "work_delete_menu") {
        await sendWorkDeletePicker(env, chatId, userId, messageId);
        return;
    }

    if (data === "work_standup") {
        await sendStandupReport(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_standup_copy") {
        await sendStandupCopyBlock(env, chatId, userId, callback.from, callback.id);
        return;
    }

    if (data === "work_standup_polish") {
        await handleAiPolishStandup(env, chatId, userId, callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_this") {
        await handleAiPolishWorkReport(env, chatId, userId, "this_month", callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_last") {
        await handleAiPolishWorkReport(env, chatId, userId, "last_month", callback.from, messageId, callback.id);
        return;
    }

    if (data === "work_report_polish_export_this") {
        await handleAiPolishWorkReportExport(env, chatId, userId, "this_month", callback.from, callback.id);
        return;
    }

    if (data === "work_report_polish_export_last") {
        await handleAiPolishWorkReportExport(env, chatId, userId, "last_month", callback.from, callback.id);
        return;
    }

    if (data.startsWith("work_del:")) {
        const id = parseInt(data.slice(9), 10);
        await env.DB.prepare("DELETE FROM work_logs WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Task deleted." });
        await sendWorkHub(env, chatId, userId, callback.from, messageId);
        return;
    }

    if (data === "work_log_prompt") {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚡ *How to Log Work Tasks*\n` +
            `────────────────────\n` +
            `Whenever you finish a task, meeting, or bugfix, type:\n` +
            `• \`/done Fixed customer checkout payment failure\`\n` +
            `• \`/done Prepared Q3 API migration roadmap\`\n` +
            `• \`/done Weekly team sprint planning meeting\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\`\n\n` +
            `_At month's end, type \`/report\` or tap **This Month's Report** to generate your manager accomplishment report!_`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Work Log", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    if (data === "copilot_help") {
        await handleAiCopilotQuery(env, chatId, userId, "", callback.from, messageId);
        return;
    }

    if (data === "help") {
        await sendHelpMessage(env, chatId, messageId);
        return;
    }

    if (data === "settings") {
        await sendSettingsMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "toggle_currency") {
        const currentCurrency = await getDisplayCurrency(env.DB, userId);
        const newCurrency = currentCurrency === "USD" ? "KHR" : "USD";
        await setDisplayCurrency(env.DB, userId, newCurrency);
        const flag = newCurrency === "USD" ? "🇺🇸" : "🇰🇭";
        await answerCallback(env, callback.id, { text: `${flag} Display switched to ${newCurrency}!` });
        await sendSettingsMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "budget_help") {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `🎯 *Monthly Budget Setting*\n` +
            `────────────────────\n` +
            `Use the command:\n` +
            `• \`/budget 300 usd\` (Sets limit to $300)\n` +
            `• \`/budget 1200000 khr\` (Sets limit in Riel)\n` +
            `• \`/budget 0\` (Disables budget tracking)\n\n` +
            `_You will receive progress alerts whenever you log an expense!_`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Settings", callback_data: "settings" }]
                    ]
                }
            }
        );
        return;
    }

    // --- Adding Transactions ---
    if (data === "add_expense") {
        await sendCategoryPicker(env, chatId, "expense", messageId);
        return;
    }

    if (data === "add_income") {
        await sendCategoryPicker(env, chatId, "income", messageId);
        return;
    }

    if (data.startsWith("cat_exp:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "expense", userId, messageId);
        return;
    }

    if (data.startsWith("cat_inc:")) {
        const category = data.slice(8);
        await sendAmountPicker(env, chatId, category, "income", userId, messageId);
        return;
    }

    if (data.startsWith("quick_exp:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "expense", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "expense", amount, displayCurrency, category, messageId);
        return;
    }

    if (data.startsWith("quick_inc:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        await addExpenseRecord(env.DB, userId, amount, category, "income", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "income", amount, displayCurrency, category, messageId);
        return;
    }

    if (data === "custom_add") {
        await safeEditOrSendMessage(env, chatId, messageId, "✏️ *Custom Expense:*\nType: `/add 5 usd lunch` or `/add 15000 food`", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Categories", callback_data: "add_expense" }]
                ]
            }
        });
        return;
    }

    if (data === "custom_inc") {
        await safeEditOrSendMessage(env, chatId, messageId, "✏️ *Custom Income:*\nType: `/income 500 usd salary` or `/income 200000 freelance`", {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Categories", callback_data: "add_income" }]
                ]
            }
        });
        return;
    }

    // --- Lunch Box Alarm Callbacks ---
    if (data === "lunchbox") {
        await sendLunchboxMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("lb_ack")) {
        await answerCallback(env, callback.id, { text: "Safe travels home!" });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `🎒 *Departure Reminder*`,
                    `────────────────────`,
                    `✅ *Lunch box packed and ready.*`,
                    `_Have a wonderful evening and safe trip home!_`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("lb_snooze")) {
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 15 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, 'Lunch Box (Snoozed)', ?, 'once', 'lunchbox', 1)
        `).bind(userId, String(chatId), snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Snoozed 15 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Snoozed*`,
                    `────────────────────`,
                    `Snoozed for 15 minutes.`,
                    `We will remind you again at \`${snoozeStr}\`.`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("su_snooze")) {
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 30 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, 'Morning Standup (Snoozed)', ?, 'once', 'standup', 1)
        `).bind(userId, String(chatId), snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Standup snoozed 30 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Standup Snoozed*`,
                    `────────────────────`,
                    `Snoozed for 30 minutes.`,
                    `We will remind you again at \`${snoozeStr}\`.`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    // --- General Reminders Callbacks ---
    if (data === "reminders") {
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "remind_prompt_add") {
        await sendPromptAddReminder(env, chatId, messageId);
        return;
    }

    if (data === "remind_add_standup") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'standup' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?")
                .bind(String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Morning Standup Sync', '09:00', 'weekdays', 'standup', 1)
            `).bind(userId, String(chatId)).run();
        }

        await answerCallback(env, callback.id, { text: "🗣️ Morning Standup alarm enabled (09:00 Mon–Fri)!" });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "remind_add_lunchbox") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
        ).bind(userId).first();

        if (existing) {
            await env.DB.prepare("UPDATE reminders SET is_active = 1, chat_id = ? WHERE id = ?")
                .bind(String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Bring lunch box home', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }

        await answerCallback(env, callback.id, { text: "🎒 Departure preset enabled (17:30 Mon–Fri)!" });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_toggle:")) {
        const id = parseInt(data.slice(14), 10);
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active, title FROM reminders WHERE id = ? AND user_id = ?"
        ).bind(id, userId).first();

        if (existing) {
            const newActive = existing.is_active ? 0 : 1;
            await env.DB.prepare("UPDATE reminders SET is_active = ?, chat_id = ? WHERE id = ?")
                .bind(newActive, String(chatId), id)
                .run();
            const statusTxt = newActive ? `🟢 "${existing.title}" is now ON!` : `⚪ "${existing.title}" is now OFF.`;
            await answerCallback(env, callback.id, { text: statusTxt });
        }
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_time_menu:")) {
        const id = parseInt(data.slice(17), 10);
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
        return;
    }

    if (data.startsWith("remind_set_time:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const newTime = `${parts[2]}:${parts[3]}`;
        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(newTime, String(chatId), id, userId).run();

        await answerCallback(env, callback.id, { text: `⏰ Time updated to ${newTime}!` });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_set_rel:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const mins = parseInt(parts[2], 10);
        const now = new Date();
        const targetDate = new Date(now.getTime() + mins * 60 * 1000);
        const targetTimeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(targetDate);

        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET reminder_time = ?, frequency = 'once', is_active = 1, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(targetTimeStr, String(chatId), id, userId).run();

        await answerCallback(env, callback.id, { text: `⏱️ Set to ${targetTimeStr} (in ${mins}m)!` });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_freq:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const newFreq = parts[2];
        await ensureTables(env.DB);
        await env.DB.prepare(
            "UPDATE reminders SET frequency = ?, chat_id = ? WHERE id = ? AND user_id = ?"
        ).bind(newFreq, String(chatId), id, userId).run();

        const label = newFreq === "weekdays" ? "Mon–Fri" : newFreq === "daily" ? "Daily" : "Once";
        await answerCallback(env, callback.id, { text: `🗓️ Schedule: ${label}` });
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
        return;
    }

    if (data === "remind_test_general") {
        await answerCallback(env, callback.id, { text: "🔔 Sending test reminder..." });
        await sendCustomReminderNotification(env, chatId, "Test Reminder: Everything is working perfectly!", currentTime(), 0);
        return;
    }

    if (data === "toggle_expense_reminder") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'expense_log' LIMIT 1"
        ).bind(userId).first();

        let newActive = 1;
        if (existing) {
            newActive = existing.is_active ? 0 : 1;
            await env.DB.prepare("UPDATE reminders SET is_active = ?, chat_id = ? WHERE id = ?")
                .bind(newActive, String(chatId), existing.id)
                .run();
        } else {
            await env.DB.prepare(`
                INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
                VALUES (?, ?, 'Daily Expense Check-in', '21:00', 'daily', 'expense_log', 1)
            `).bind(userId, String(chatId)).run();
        }

        const stateTxt = newActive ? "🟢 Daily expense reminder ENABLED (21:00)!" : "🔴 Daily expense reminder DISABLED.";
        await answerCallback(env, callback.id, { text: stateTxt });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_del:")) {
        const id = parseInt(data.slice(11), 10);
        await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Reminder deleted." });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("remind_snooze:")) {
        const id = parseInt(data.slice(14), 10);
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + 15 * 60 * 1000);
        const snoozeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(snoozeTime);

        await ensureTables(env.DB);
        let title = "Reminder";
        if (id) {
            const r = await env.DB.prepare("SELECT title FROM reminders WHERE id = ?").bind(id).first();
            if (r?.title) title = r.title;
        }

        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, ?, ?, 'once', 'custom', 1)
        `).bind(userId, String(chatId), `${title} (Snoozed)`, snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Snoozed 15 mins (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Snoozed*`,
                    `────────────────────`,
                    `📌 *${title}*`,
                    `Alert snoozed for 15 minutes.`,
                    `We will alert you again at \`${snoozeStr}\`.`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data.startsWith("remind_done:")) {
        await answerCallback(env, callback.id, { text: "✅ Done!" });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Completed*`,
                    `────────────────────`,
                    `✅ *Marked as done!*`
                ].join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
        return;
    }

    if (data === "remind_help") {
        await sendPromptAddReminder(env, chatId, messageId);
        return;
    }

    // --- Ledger & Summaries Callbacks ---
    if (data === "view_transactions") {
        await sendTransactions(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("history:")) {
        const page = parseInt(data.slice(8), 10) || 1;
        await updateHistoryMessage(env, chatId, userId, callback.message.message_id, page);
        return;
    }

    if (data === "summary_today") {
        await sendSummary(env, chatId, userId, "today", messageId);
        return;
    }

    if (data === "summary_month") {
        await sendSummary(env, chatId, userId, "month", messageId);
        return;
    }

    // --- Clear Data Callbacks ---
    if (data === "clear_data") {
        await askClearConfirmation(env, chatId, messageId);
        return;
    }

    if (data === "clear_today_warn") {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Are you sure you want to clear today's expenses? This action cannot be undone.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Yes, clear today", callback_data: "confirm_clear_today" }],
                    [{ text: "❌ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "clear_all_warn") {
        const total = await getTotalExpenses(env.DB, userId);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?").bind(userId).first();
        const count = countRow?.count || 0;

        if (count === 0) {
            await safeEditOrSendMessage(env, chatId, messageId, "You don't have any recorded transactions to delete.", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🏠 Main Hub", callback_data: "hub" }]
                    ]
                }
            });
            return;
        }

        const warningMsg = [
            `⚠️ *Database Reset Warning*`,
            `────────────────────`,
            `This action will permanently delete all transaction records for your account.`,
            ``,
            `● *Transactions:* \`${count}\``,
            `● *Total Volume:* \`${formatMoney(total)} ៛\` (~$${formatMoney(total / EXCHANGE_RATE)})`,
            ``,
            `🔒 *Backup Safety:*`,
            `A CSV backup file will be auto-generated and sent to this chat before deletion.`,
            ``,
            `_Do you wish to proceed?_`
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, warningMsg, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⚠️ Yes, Backup & Wipe All", callback_data: "confirm_clear_all" }],
                    [{ text: "✕ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "confirm_clear" || data === "confirm_clear_today") {
        await clearToday(env.DB, userId);
        await answerCallback(env, callback.id, { text: "✅ Today's expenses cleared!" });
        await sendMainMenu(env, chatId, userId, callback.from, origin, messageId);
        return;
    }

    if (data === "confirm_clear_all") {
        try {
            await sendCSVBackup(env, chatId, userId);
        } catch (error) {
            await sendMessage(env, chatId, `❌ Backup failed: ${error.message}\n\nDeletion cancelled to protect your data.`);
            return;
        }

        await clearAllExpenses(env.DB, userId);
        await sendMessage(env, chatId, "🗑️ All historical transactions have been deleted. A backup CSV has been sent above.");
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "cancel_clear") {
        await safeEditOrSendMessage(env, chatId, messageId, "Clear cancelled. Your data remains safe.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏠 Main Hub", callback_data: "hub" }]
                ]
            }
        });
        return;
    }

    // --- Bank Slip / Receipt Scanner Callbacks ---
    if (data === "scan_prompt") {
        await sendScanHelp(env, chatId, messageId);
        return;
    }

    if (data.startsWith("scan_ok:")) {
        const scanId = parseInt(data.slice(8), 10);
        await handleScanConfirm(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_cat:")) {
        const scanId = parseInt(data.slice(9), 10);
        await sendScanCategoryPicker(env, chatId, scanId, callback.message?.message_id);
        return;
    }

    if (data.startsWith("scan_set_cat:")) {
        const parts = data.split(":");
        const scanId = parseInt(parts[1], 10);
        const newCat = parts[2];
        await handleScanSetCategory(env, chatId, userId, scanId, newCat, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_type:")) {
        const scanId = parseInt(data.slice(10), 10);
        await handleScanToggleType(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("scan_view:")) {
        const scanId = parseInt(data.slice(10), 10);
        await renderPendingScanCard(env, chatId, scanId, callback.message?.message_id);
        return;
    }

    if (data.startsWith("scan_del:")) {
        const scanId = parseInt(data.slice(9), 10);
        await handleScanDiscard(env, chatId, userId, scanId, callback.message?.message_id, callback.id);
        return;
    }
}
