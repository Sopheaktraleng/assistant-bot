import { TIME_ZONE, EXCHANGE_RATE, isUserAuthorized, isUserAuthorizedAsync, isOwner, OWNER_USER_ID } from "../config/constants.js";
import { today, currentTime } from "../utils/time.js";
import { formatMoney, cleanMd, capitalize } from "../utils/format.js";
import { ensureTables } from "../db/schema.js";
import {
    getDisplayCurrency,
    setDisplayCurrency,
    getTotalExpenses,
    addExpenseRecord,
    deleteExpenseById,
    clearToday,
    clearAllExpenses,
    getUserMemories,
    clearUserMemories,
    getUserVoiceMode,
    setUserVoiceMode,
    getLastModelChatMessage,
    addOrUpdateAuthorizedUser,
    setAuthorizedUserStatus,
    getAuthorizedUser
} from "../db/queries.js";
import {
    telegram,
    sendMessage,
    answerCallback,
    safeEditOrSendMessage,
    sendTelegramVoice
} from "../services/telegram.js";
import { generateSpeechAudio } from "../services/ai.js";
import {
    sendMainHub,
    sendMainMenu,
    sendSettingsMenu,
    sendHelpMessage,
    sendUserManagementMenu
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
    sendCSVBackup,
    handleExportLedgerCommand
} from "../modules/finance/commands.js";
import {
    sendScanHelp,
    handleScanConfirm,
    sendScanCategoryPicker,
    handleScanSetCategory,
    handleScanToggleType,
    renderPendingScanCard,
    handleScanDiscard,
    handleStatementImport,
    handleStatementViewBreakdown,
    renderPendingStatementCard,
    handleStatementDiscard
} from "../modules/finance/scanner.js";
import {
    handleListTodayTasksCommand
} from "../modules/work/commands.js";
import {
    sendPromptAddReminder,
    sendRemindersMenu,
    sendRoutinesMenu,
    sendFocusMenu,
    sendLunchboxMenu,
    sendReminderTimeMenu
} from "../modules/reminders/views.js";
import { sendCustomReminderNotification } from "../modules/reminders/cron.js";
import { handleAiCopilotQuery, sendFridayTacticalBriefing } from "../modules/copilot/handler.js";
import { sendVoiceHelp } from "../modules/voice/handler.js";

/**
 * Dispatches all Telegram inline keyboard callback queries.
 */
export async function handleCallback(callback, env, origin) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);
    const messageId = callback.message?.message_id;

    // Enforce strict personal assistant access control on interactive callbacks
    // (Special exemption: allow request_access callback for unauthorized users)
    if (!data.startsWith("request_access")) {
        const isAuth = await isUserAuthorizedAsync(env.DB, userId, env);
        if (userId && !isAuth) {
            await answerCallback(env, callback.id, {
                text: "⛔ Access denied: This assistant is private.",
                show_alert: true
            }).catch(() => {});
            return;
        }
    }

    // Callbacks that show their own specific toast notification will invoke answerCallback with text
    const hasCustomToast = [
        "remind_add_standup",
        "remind_add_lunchbox",
        "toggle_expense_reminder",
        "remind_test_general"
    ].includes(data) || 
    data.startsWith("request_access") ||
    data.startsWith("approve_user:") ||
    data.startsWith("deny_user:") ||
    data.startsWith("revoke_user:") ||
    data.startsWith("focus_start:") ||
    data.startsWith("remind_toggle") || 
    data.startsWith("remind_quick_timer:") || 
    data.startsWith("remind_shift:") || 
    data.startsWith("remind_set_time:") || 
    data.startsWith("remind_set_rel:") || 
    data.startsWith("remind_freq:") || 
    data.startsWith("remind_del:") || 
    data.startsWith("remind_snooze:") || 
    data.startsWith("remind_done:") || 
    data.startsWith("work_del_") || 
    data.startsWith("set_cur_") || 
    data.startsWith("wl_");

    if (!hasCustomToast) {
        await answerCallback(env, callback.id);
    }

    if (!chatId) return;

    // --- Dynamic User Access Management (Boss & Guest Workflow) ---
    if (data.startsWith("request_access")) {
        const fromUser = callback.from || {};
        const requesterId = String(fromUser.id || userId);
        const name = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ") || "Guest";
        const username = fromUser.username ? `@${fromUser.username}` : "None";

        await addOrUpdateAuthorizedUser(env.DB, {
            userId: requesterId,
            username: fromUser.username || "",
            firstName: fromUser.first_name || name,
            role: "guest",
            status: "pending",
            approvedBy: ""
        });

        await answerCallback(env, callback.id, {
            text: "✅ Access request forwarded to Boss!",
            show_alert: true
        });

        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⏳ *Access Request Submitted*\n\nHello ${name}! Your request has been forwarded directly to Boss.\n\nYou will receive a notification as soon as it's reviewed!`,
            { parse_mode: "Markdown" }
        );

        // Notify Boss
        const ownerId = env?.OWNER_ID || env?.OWNER_TELEGRAM_ID || OWNER_USER_ID;
        await sendMessage(
            env,
            ownerId,
            `🔔 *New Access Request Received*\n\n👤 *Name:* ${cleanMd(name)}\n💬 *Username:* ${username}\n🆔 *User ID:* \`${requesterId}\`\n\nWould you like to grant guest access to F.R.I.D.A.Y.?`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ Approve as Guest", callback_data: `approve_user:${requesterId}` },
                            { text: "❌ Deny", callback_data: `deny_user:${requesterId}` }
                        ]
                    ]
                }
            }
        ).catch(e => console.warn("Failed to notify owner:", e.message));
        return;
    }

    if (data.startsWith("approve_user:")) {
        if (!isOwner(userId, env)) {
            await answerCallback(env, callback.id, { text: "⛔ Only Boss can approve users.", show_alert: true });
            return;
        }

        const targetId = data.replace("approve_user:", "").trim();
        const existing = await getAuthorizedUser(env.DB, targetId);
        const targetName = existing?.first_name || "Guest";

        await addOrUpdateAuthorizedUser(env.DB, {
            userId: targetId,
            username: existing?.username || "",
            firstName: targetName,
            role: "guest",
            status: "active",
            approvedBy: userId
        });

        await answerCallback(env, callback.id, { text: `✅ ${targetName} approved as Guest!` });

        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `✅ *Access Granted*\n\n👤 *User:* ${cleanMd(targetName)} (\`${targetId}\`)\n🛡️ *Role:* Guest (Standard AI Persona, no Boss data access)\n\n_User has been notified and can now chat with F.R.I.D.A.Y._`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "👥 Manage Users", callback_data: "manage_users" }],
                        [{ text: "🏠 Main Hub", callback_data: "hub" }]
                    ]
                }
            }
        );

        // Send welcome message to guest
        await sendMessage(
            env,
            targetId,
            `🎉 *Welcome to F.R.I.D.A.Y.!*\n\nHello ${targetName}! Boss has approved your access.\n\nI'm F.R.I.D.A.Y., your intelligent AI assistant. Feel free to ask me questions, search the live web, check weather, or chat anytime.\n\nHow can I help you today?`,
            { parse_mode: "Markdown" }
        ).catch(() => {});
        return;
    }

    if (data.startsWith("deny_user:")) {
        if (!isOwner(userId, env)) {
            await answerCallback(env, callback.id, { text: "⛔ Only Boss can deny users.", show_alert: true });
            return;
        }

        const targetId = data.replace("deny_user:", "").trim();
        await setAuthorizedUserStatus(env.DB, targetId, "revoked");

        await answerCallback(env, callback.id, { text: `❌ Access denied for user ${targetId}` });

        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `❌ *Access Denied*\n\nRequest from user \`${targetId}\` was declined.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "👥 Manage Users", callback_data: "manage_users" }],
                        [{ text: "🏠 Main Hub", callback_data: "hub" }]
                    ]
                }
            }
        );

        await sendMessage(
            env,
            targetId,
            `⛔ *Access Request Status*\n\nYour request to access F.R.I.D.A.Y. was declined.`,
            { parse_mode: "Markdown" }
        ).catch(() => {});
        return;
    }

    if (data === "manage_users") {
        if (!isOwner(userId, env)) {
            await answerCallback(env, callback.id, { text: "⛔ User management is restricted to Boss.", show_alert: true });
            return;
        }
        await sendUserManagementMenu(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("revoke_user:")) {
        if (!isOwner(userId, env)) {
            await answerCallback(env, callback.id, { text: "⛔ Only Boss can revoke users.", show_alert: true });
            return;
        }

        const targetId = data.replace("revoke_user:", "").trim();
        await setAuthorizedUserStatus(env.DB, targetId, "revoked");
        await answerCallback(env, callback.id, { text: `🚫 Revoked access for ${targetId}`, show_alert: true });
        await sendUserManagementMenu(env, chatId, userId, messageId);
        return;
    }

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

    // --- Work & Tasks Callbacks ---
    if (data === "tasks_today" || data === "work_hub" || data === "work_today") {
        await handleListTodayTasksCommand(env, chatId, userId, messageId);
        return;
    }

    if (data.startsWith("work_del:")) {
        const id = parseInt(data.slice(9), 10);
        await env.DB.prepare("DELETE FROM work_logs WHERE id = ? AND user_id = ?").bind(id, userId).run();
        await answerCallback(env, callback.id, { text: "🗑️ Task deleted." });
        await handleListTodayTasksCommand(env, chatId, userId, messageId);
        return;
    }

    if (data === "work_standup" || data === "work_standup_copy" || data === "work_standup_polish" || data.startsWith("work_report")) {
        await answerCallback(env, callback.id, { text: "Scrum standups and reports removed." });
        await handleListTodayTasksCommand(env, chatId, userId, messageId);
        return;
    }

    // --- Retired Movie Recommender & Watchlist Callbacks ---
    if (data === "movie_hub" || data === "watchlist" || data.startsWith("wl_")) {
        await answerCallback(env, callback.id, { text: "Watchlist feature has been retired." });
        await sendMainHub(env, chatId, userId, callback.from, origin, messageId);
        return;
    }

    if (data === "copilot_help") {
        await handleAiCopilotQuery(env, chatId, userId, "", callback.from, messageId);
        return;
    }

    if (data === "daily_briefing" || data === "friday_briefing") {
        await answerCallback(env, callback.id, { text: "Preparing daily briefing..." });
        await sendFridayTacticalBriefing(env, chatId, userId);
        return;
    }

    if (data === "speak_status") {
        await answerCallback(env, callback.id, { text: "Synthesizing spoken voice..." });
        await handleAiCopilotQuery(env, chatId, userId, "Give me a quick tactical voice briefing, Boss.", callback.from, null, true);
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
            `🎯 *Monthly Budget Setting*\n\n` +
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
        const txId = await addExpenseRecord(env.DB, userId, amount, category, "expense", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "expense", amount, displayCurrency, category, messageId, { txId });
        return;
    }

    if (data.startsWith("quick_inc:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        const displayCurrency = await getDisplayCurrency(env.DB, userId);
        const txId = await addExpenseRecord(env.DB, userId, amount, category, "income", displayCurrency);
        await sendTransactionReceipt(env, chatId, userId, "income", amount, displayCurrency, category, messageId, { txId });
        return;
    }

    // --- 1-Tap Re-log from Recent Favorites or Default Presets ---
    if (data.startsWith("relog_tx:")) {
        const txId = parseInt(data.replace("relog_tx:", ""), 10);
        const row = await env.DB.prepare(
            "SELECT amount, category, type, currency, merchant FROM expenses WHERE id = ? AND user_id = ?"
        ).bind(txId, userId).first();

        if (row) {
            await answerCallback(env, callback.id, { text: `✅ Re-logged ${row.category}!` });
            const newTxId = await addExpenseRecord(
                env.DB,
                userId,
                row.amount,
                row.category,
                row.type || "expense",
                row.currency || "USD",
                null,
                row.merchant || null
            );
            await sendTransactionReceipt(env, chatId, userId, row.type || "expense", row.amount, row.currency || "USD", row.category, messageId, {
                txId: newTxId,
                merchant: row.merchant
            });
            return;
        }
    }

    if (data.startsWith("relog_def:")) {
        const parts = data.split(":");
        const rType = parts[1] === "inc" || parts[1] === "income" ? "income" : "expense";
        const rAmount = parseFloat(parts[2]) || 0;
        const rCurrency = parts[3] || "USD";
        const rCategory = parts[4] || "Other";

        if (rAmount > 0) {
            await answerCallback(env, callback.id, { text: `✅ Logged ${rCategory}!` });
            const newTxId = await addExpenseRecord(
                env.DB,
                userId,
                rAmount,
                rCategory,
                rType,
                rCurrency
            );
            await sendTransactionReceipt(env, chatId, userId, rType, rAmount, rCurrency, rCategory, messageId, {
                txId: newTxId
            });
            return;
        }
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

    // --- Undo / Delete Transaction Callback ---
    if (data.startsWith("undo_tx:")) {
        if (!isOwner(userId, env)) {
            await answerCallback(env, callback.id, { text: "🔒 Undo is restricted to the bot owner (Boss).", show_alert: true });
            return;
        }
        const txId = parseInt(data.slice(8), 10);
        const deleted = await deleteExpenseById(env.DB, userId, txId);
        if (deleted) {
            await answerCallback(env, callback.id, { text: "🗑️ Transaction undone!" });
            const symbol = deleted.currency === "USD" ? "$" : "";
            const suffix = deleted.currency === "KHR" ? " ៛" : "";
            const amtStr = `${symbol}${formatMoney(deleted.amount)}${suffix}`;
            const header = deleted.type === "income" ? "❌ *Income Undone / Removed*" : "❌ *Expense Undone / Removed*";
            await safeEditOrSendMessage(env, chatId, messageId, [
                header,
                ``,
                `• *Amount:*   ~${amtStr}~`,
                `• *Category:* ~${capitalize(deleted.category)}~`,
                `• *Date:*     ~${deleted.date}~`,
                ``,
                `_This transaction was successfully removed from your ledger._`
            ].join("\n"), {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🧾 Re-enter Expense", callback_data: "add_expense" },
                            { text: "📋 Today's Ledger", callback_data: "view_transactions" }
                        ],
                        [
                            { text: "‹ Back to Finance", callback_data: "finance_hub" },
                            { text: "🏠 Main Hub", callback_data: "hub" }
                        ]
                    ]
                }
            });
        } else {
            await answerCallback(env, callback.id, { text: "⚠️ Transaction already deleted or not found." });
        }
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
                    ``,
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
                    ``,
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
                    ``,
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

    if (data === "remind_focus") {
        await sendFocusMenu(env, chatId, messageId);
        return;
    }

    if (data.startsWith("focus_start:")) {
        const parts = data.split(":");
        const mins = parseInt(parts[1], 10) || 25;
        const title = parts.slice(2).join(":") || `${mins}m Focus Sprint`;
        const now = new Date();
        const targetDate = new Date(now.getTime() + mins * 60 * 1000);
        const targetTimeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(targetDate);
        const dateStr = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(targetDate);

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, target_date, frequency, type, is_active)
            VALUES (?, ?, ?, ?, ?, 'once', 'focus', 1)
        `).bind(userId, String(chatId), title, targetTimeStr, dateStr).run();

        await answerCallback(env, callback.id, { text: `🎯 ${title} started! Alert at ${targetTimeStr}.` });
        await sendRemindersMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "remind_routines") {
        await sendRoutinesMenu(env, chatId, userId, messageId);
        return;
    }

    if (data === "remind_add_standup" || data === "remind_add_standup_routines") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'standup' LIMIT 1"
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
                VALUES (?, ?, 'Morning Standup Sync', '09:00', 'weekdays', 'standup', 1)
            `).bind(userId, String(chatId)).run();
        }

        const toast = newActive ? "🔔 Morning Standup alarm ENABLED (09:00 Mon–Fri)!" : "🔕 Morning Standup alarm DISABLED.";
        await answerCallback(env, callback.id, { text: toast });
        if (data.endsWith("_routines")) {
            await sendRoutinesMenu(env, chatId, userId, messageId);
        } else {
            await sendRemindersMenu(env, chatId, userId, messageId);
        }
        return;
    }

    if (data === "remind_add_lunchbox" || data === "remind_add_lunchbox_routines") {
        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT id, is_active FROM reminders WHERE user_id = ? AND type = 'lunchbox' LIMIT 1"
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
                VALUES (?, ?, 'Departure & Lunchbox', '17:30', 'weekdays', 'lunchbox', 1)
            `).bind(userId, String(chatId)).run();
        }

        const toast = newActive ? "🔔 Departure alarm ENABLED (17:30 Mon–Fri)!" : "🔕 Departure alarm DISABLED.";
        await answerCallback(env, callback.id, { text: toast });
        if (data.endsWith("_routines")) {
            await sendRoutinesMenu(env, chatId, userId, messageId);
        } else {
            await sendRemindersMenu(env, chatId, userId, messageId);
        }
        return;
    }

    if (data.startsWith("remind_quick_timer:")) {
        const mins = parseInt(data.slice(19), 10) || 15;
        const now = new Date();
        const targetDate = new Date(now.getTime() + mins * 60 * 1000);
        const targetTimeStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }).format(targetDate);

        const dateStr = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(targetDate);

        const timerTitle = mins >= 60 ? `${mins / 60}h Countdown Timer` : `${mins}m Countdown Timer`;

        await ensureTables(env.DB);
        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, target_date, frequency, type, is_active)
            VALUES (?, ?, ?, ?, ?, 'once', 'custom', 1)
        `).bind(userId, String(chatId), timerTitle, targetTimeStr, dateStr).run();

        await answerCallback(env, callback.id, { text: `⏱️ ${timerTitle} set for ${targetTimeStr}!` });
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

    if (data.startsWith("remind_toggle_inspect:")) {
        const id = parseInt(data.slice(22), 10);
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
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
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

    if (data === "toggle_expense_reminder" || data === "toggle_expense_reminder_routines") {
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

        const stateTxt = newActive ? "🔔 Daily expense reminder ENABLED (21:00)!" : "🔕 Daily expense reminder DISABLED.";
        await answerCallback(env, callback.id, { text: stateTxt });
        if (data.endsWith("_routines")) {
            await sendRoutinesMenu(env, chatId, userId, messageId);
        } else {
            await sendRemindersMenu(env, chatId, userId, messageId);
        }
        return;
    }

    if (data.startsWith("remind_shift:")) {
        const parts = data.split(":");
        const id = parseInt(parts[1], 10);
        const addMins = parseInt(parts[2], 10) || 15;

        await ensureTables(env.DB);
        const existing = await env.DB.prepare(
            "SELECT reminder_time FROM reminders WHERE id = ? AND user_id = ?"
        ).bind(id, userId).first();

        if (existing) {
            const now = new Date();
            let baseDate = now;
            const timeParts = (existing.reminder_time || "").split(":");
            if (timeParts.length === 2) {
                const targetToday = new Date(now);
                targetToday.setHours(parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0, 0);
                if (targetToday.getTime() > now.getTime() - 10 * 60 * 1000) {
                    baseDate = targetToday;
                }
            }
            const newDate = new Date(baseDate.getTime() + addMins * 60 * 1000);
            const newTimeStr = new Intl.DateTimeFormat("en-GB", {
                timeZone: TIME_ZONE,
                hour: "2-digit",
                minute: "2-digit",
                hour12: false
            }).format(newDate);

            await env.DB.prepare(
                "UPDATE reminders SET reminder_time = ?, is_active = 1, chat_id = ? WHERE id = ? AND user_id = ?"
            ).bind(newTimeStr, String(chatId), id, userId).run();

            await answerCallback(env, callback.id, { text: `⏰ Shifted +${addMins}m to ${newTimeStr}!` });
        }
        await sendReminderTimeMenu(env, chatId, userId, id, messageId);
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
        const parts = data.slice(14).split(":");
        const id = parseInt(parts[0], 10);
        const mins = parts[1] ? parseInt(parts[1], 10) : 15;
        const now = new Date();
        const snoozeTime = new Date(now.getTime() + mins * 60 * 1000);
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
            if (r?.title) title = r.title.replace(/\s*\(Snoozed\)/i, "");
        }

        await env.DB.prepare(`
            INSERT INTO reminders (user_id, chat_id, title, reminder_time, frequency, type, is_active)
            VALUES (?, ?, ?, ?, 'once', 'custom', 1)
        `).bind(userId, String(chatId), `${title} (Snoozed)`, snoozeStr).run();

        await answerCallback(env, callback.id, { text: `⏰ Snoozed ${mins}m (until ${snoozeStr})` });
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: callback.message.message_id,
                text: [
                    `⏰ *Reminder Snoozed*`,
                    ``,
                    `🔔 *${title}*`,
                    `Alert snoozed for ${mins} minutes.`,
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
                    ``,
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

    if (data === "view_history" || data.startsWith("history:")) {
        const page = data === "view_history" ? 1 : (parseInt(data.slice(8), 10) || 1);
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

    if (data === "summary_all") {
        await sendSummary(env, chatId, userId, "all", messageId);
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
            ``,
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

    if (data === "export_csv" || data === "backup_csv") {
        await handleExportLedgerCommand(env, chatId, userId);
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

    // --- F.R.I.D.A.Y. Memory Callbacks ---
    if (data === "view_memories") {
        const memories = await getUserMemories(env.DB, userId, 25);
        if (!memories || memories.length === 0) {
            await safeEditOrSendMessage(
                env,
                chatId,
                messageId,
                `🧠 *F.R.I.D.A.Y. • Long-Term Memory*\n\nNo personal memories stored yet, Boss.\n\nTeach me with \`/remember <fact>\`!`,
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                    }
                }
            );
            return;
        }

        const lines = memories.map(m => {
            const catEmoji = m.category === "work" ? "💼" :
                             m.category === "identity" ? "👤" :
                             m.category === "goal" ? "🎯" :
                             m.category === "rule" ? "⚠️" : "✨";
            return `${catEmoji} *#${m.id}* [${(m.category || "pref").toUpperCase()}]: ${m.fact}`;
        });

        const card = [
            `🧠 *F.R.I.D.A.Y. • Long-Term Memory Matrix*`,
            ``,
            `Here are the personal facts and directives I keep on record:`,
            ``,
            ...lines,
            ``,
            `💡 *Controls:* \`/remember <fact>\` • \`/forget <id>\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, card, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🗑️ Wipe Memories", callback_data: "clear_memories_warn" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    if (data === "clear_memories_warn") {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *Wipe Memory Matrix Confirmation*\n\nBoss, are you sure you want to erase all personal preferences and facts I've learned about you?\n\n_This cannot be undone._`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🗑️ Yes, Wipe All Memories", callback_data: "confirm_clear_memories" }],
                        [{ text: "✕ Cancel", callback_data: "view_memories" }]
                    ]
                }
            }
        );
        return;
    }

    if (data === "confirm_clear_memories") {
        await clearUserMemories(env.DB, userId);
        await answerCallback(env, callback.id, { text: "🧠 Memory matrix wiped" });
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `🗑️ *Memory Matrix Erased*\n\nAll personal preferences and learned facts have been wiped, Boss. Starting fresh!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                }
            }
        );
        return;
    }

    // --- Voice & Speech Callbacks ---
    if (data === "speak_last") {
        await answerCallback(env, callback.id, { text: "🎙️ Reading aloud..." });
        try {
            const textToSpeak = callback.message?.text || await getLastModelChatMessage(env.DB, userId);
            if (textToSpeak) {
                const audioBuffer = await generateSpeechAudio(textToSpeak);
                if (audioBuffer) {
                    await sendTelegramVoice(env, chatId, audioBuffer, "🎙️ F.R.I.D.A.Y. Transmission");
                    return;
                }
            }
            await sendMessage(env, chatId, "⚠️ Unable to synthesize voice for this message, Boss.", { parse_mode: "Markdown" });
        } catch (err) {
            console.error("speak_last callback error:", err);
            await sendMessage(env, chatId, "⚠️ Voice link timed out. Please try again.", { parse_mode: "Markdown" });
        }
        return;
    }

    if (data === "toggle_voice_mode") {
        const curMode = await getUserVoiceMode(env.DB, userId);
        const newMode = curMode === "on" ? "off" : "on";
        await setUserVoiceMode(env.DB, userId, newMode);
        await answerCallback(env, callback.id, { 
            text: newMode === "on" ? "🎙️ Auto-Voice Mode: ENABLED" : "📝 Auto-Voice Mode: DISABLED" 
        });
        await sendSettingsMenu(env, chatId, userId, messageId);
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

    // --- Bank PDF Statement Callbacks ---
    if (data.startsWith("stmt_import:")) {
        const stmtId = parseInt(data.slice(12), 10);
        await handleStatementImport(env, chatId, userId, stmtId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("stmt_view:")) {
        const stmtId = parseInt(data.slice(10), 10);
        await handleStatementViewBreakdown(env, chatId, userId, stmtId, callback.message?.message_id, callback.id);
        return;
    }

    if (data.startsWith("stmt_back:")) {
        const stmtId = parseInt(data.slice(10), 10);
        await renderPendingStatementCard(env, chatId, stmtId, callback.message?.message_id);
        return;
    }

    if (data.startsWith("stmt_del:")) {
        const stmtId = parseInt(data.slice(9), 10);
        await handleStatementDiscard(env, chatId, userId, stmtId, callback.message?.message_id, callback.id);
        return;
    }
}
