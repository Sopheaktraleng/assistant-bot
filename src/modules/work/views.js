import { TIME_ZONE } from "../../config/constants.js";
import { today, currentTime, monthPrefix, monthLabel, lastMonthPrefix, lastMonthLabel, dateDaysAgo, getPreviousWorkdayDate } from "../../utils/time.js";
import { getWorkCategoryIcon } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, answerCallback, safeEditOrSendMessage } from "../../services/telegram.js";
import { callAiTextModel } from "../../services/ai.js";

export async function sendWorkHub(env, chatId, userId, from, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";

    const todayDate = today();
    const monthStr = monthPrefix();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

    const monthRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();

    const monthCount = monthRow?.count || 0;
    const mLabel = monthLabel();

    const todayList = todayLogs.length > 0
        ? todayLogs.map((item) => `• \`${item.time}\` *${item.content}*`).join("\n")
        : "_No tasks logged today yet._";

    const text = [
        `⚡ *Work Journal*`,
        `────────────────────`,
        `● *This Month:*  \`${monthCount} tasks\` in ${mLabel}`,
        `● *Today:*       \`${todayLogs.length} logged\``,
        `────────────────────`,
        `*Today's Activity:*`,
        todayList,
        `────────────────────`,
        `_Log anytime with: \`done <task description>\`_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish Report", callback_data: "work_report_polish_this" }
                ],
                [
                    { text: "📊 Monthly Report", callback_data: "work_report_this" },
                    { text: "📄 Export .txt", callback_data: "work_export_this" }
                ],
                [
                    { text: "⏪ Last Month", callback_data: "work_report_last" },
                    { text: "🗑️ Delete Task", callback_data: "work_delete_menu" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendTodayWork(env, chatId, userId, from, messageId = null) {
    return sendWorkHub(env, chatId, userId, from, messageId);
}

export async function sendWorkReport(env, chatId, userId, period = "this_month", from, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "You";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "You";

    let label = "";
    let isMonth = false;
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        isMonth = true;
        label = monthLabel();
        const prefix = monthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    } else if (period === "last_month") {
        isMonth = true;
        label = lastMonthLabel();
        const prefix = lastMonthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    } else if (period === "this_week") {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    } else if (period.match(/^\d{4}-\d{2}$/)) {
        isMonth = true;
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    } else {
        isMonth = true;
        label = monthLabel();
        const prefix = monthPrefix();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${prefix}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        const text = [
            `📋 *Monthly Work Report*`,
            `🗓️ *Period:* \`${label}\``,
            `────────────────────`,
            `_No accomplishments logged for this period yet._`,
            ``,
            `💡 *How to log work:*`,
            `\`/done <task description>\``,
            `_Example:_ \`/done Completed API migration for auth service\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "＋ How to Log", callback_data: "work_log_prompt" },
                        { text: "⏪ Last Month", callback_data: "work_report_last" }
                    ],
                    [
                        { text: "⚡ Work Log", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        return;
    }

    const activeDays = new Set(logs.map(r => r.date)).size;
    const catMap = {};
    for (const r of logs) {
        catMap[r.category] = (catMap[r.category] || 0) + 1;
    }
    const catBreakdown = Object.entries(catMap)
        .map(([cat, cnt]) => `${getWorkCategoryIcon(cat)} ${cat}: ${cnt}`)
        .join(" • ");

    const lines = [
        `📋 *Monthly Work Report*`,
        `────────────────────`,
        `● *Period:*  \`${label}\``,
        `● *User:*    ${cleanUsername}`,
        `● *Summary:* \`${logs.length} tasks\` across \`${activeDays} days\``,
        `● *Focus:*   ${catBreakdown}`,
        `────────────────────`
    ];

    if (isMonth) {
        const weeks = [
            { name: "Week 1 (Days 01–07)", min: 1, max: 7, items: [] },
            { name: "Week 2 (Days 08–14)", min: 8, max: 14, items: [] },
            { name: "Week 3 (Days 15–21)", min: 15, max: 21, items: [] },
            { name: "Week 4+ (Days 22–End)", min: 22, max: 31, items: [] }
        ];

        for (const item of logs) {
            const dayNum = parseInt(item.date.slice(8, 10), 10) || 1;
            const w = weeks.find(wk => dayNum >= wk.min && dayNum <= wk.max) || weeks[3];
            w.items.push(item);
        }

        for (const w of weeks) {
            if (w.items.length === 0) continue;
            lines.push(`📅 *${w.name}:*`);
            for (const item of w.items) {
                const shortDate = item.date.slice(5);
                const icon = getWorkCategoryIcon(item.category);
                lines.push(`• \`${shortDate}\` ${icon} ${item.content}`);
            }
            lines.push(``);
        }
    } else {
        let currentDate = "";
        for (const item of logs) {
            if (item.date !== currentDate) {
                currentDate = item.date;
                lines.push(`📅 *${currentDate}:*`);
            }
            const icon = getWorkCategoryIcon(item.category);
            lines.push(`• \`${item.time}\` ${icon} ${item.content}`);
        }
        lines.push(``);
    }

    lines.push(`────────────────────`);
    lines.push(`_Ready for your monthly review or manager 1-on-1._`);

    const fullMessage = lines.join("\n");
    const exportCb = period === "last_month" ? "work_export_last" : "work_export_this";
    const switchMonthText = period === "last_month" ? "⏩ This Month" : "⏪ Last Month";
    const switchMonthCb = period === "last_month" ? "work_report_this" : "work_report_last";
    const polishCb = period === "last_month" ? "work_report_polish_last" : "work_report_polish_this";

    if (fullMessage.length > 3800) {
        const preview = lines.slice(0, 30).join("\n") + "\n\n⚠️ _Report is extensive. Full report sent as file below..._";
        await sendMessage(env, chatId, preview, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✨ AI Polish", callback_data: polishCb },
                        { text: "📄 Export .txt", callback_data: exportCb }
                    ],
                    [
                        { text: switchMonthText, callback_data: switchMonthCb },
                        { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                    ],
                    [
                        { text: "⚡ Work Log", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        await sendWorkReportFile(env, chatId, userId, period, from);
        return;
    }

    await safeEditOrSendMessage(env, chatId, messageId, fullMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✨ AI Polish", callback_data: polishCb },
                    { text: "📄 Export .txt", callback_data: exportCb }
                ],
                [
                    { text: switchMonthText, callback_data: switchMonthCb },
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Log", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function sendWorkReportFile(env, chatId, userId, period = "this_month", from) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "User";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "User";

    let label = "";
    let isMonth = false;
    let query = "";
    let bindArgs = [];
    let fileSuffix = "";

    if (period === "this_month") {
        isMonth = true;
        label = monthLabel();
        fileSuffix = monthPrefix().replace("-", "_");
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        isMonth = true;
        label = lastMonthLabel();
        fileSuffix = lastMonthPrefix().replace("-", "_");
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        fileSuffix = "rolling_7d";
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        await sendMessage(env, chatId, `No tasks recorded for ${label} to export.`);
        return;
    }

    const activeDays = new Set(logs.map(r => r.date)).size;
    const catMap = {};
    for (const r of logs) {
        catMap[r.category] = (catMap[r.category] || 0) + 1;
    }
    const catSummary = Object.entries(catMap)
        .map(([cat, cnt]) => `${cat}: ${cnt}`)
        .join(" | ");

    let content = [
        "================================================================================",
        "                        MONTHLY ACCOMPLISHMENT REPORT",
        "================================================================================",
        `Period:          ${label}`,
        `Prepared By:     ${cleanUsername}`,
        `Generated At:    ${today()} ${currentTime()} (Phnom Penh)`,
        `Total Completed: ${logs.length} tasks`,
        `Active Days:     ${activeDays} days`,
        `Focus Breakdown: ${catSummary}`,
        "================================================================================",
        ""
    ];

    if (isMonth) {
        const weeks = [
            { name: "WEEK 1 (Days 01 - 07)", min: 1, max: 7, items: [] },
            { name: "WEEK 2 (Days 08 - 14)", min: 8, max: 14, items: [] },
            { name: "WEEK 3 (Days 15 - 21)", min: 15, max: 21, items: [] },
            { name: "WEEK 4+ (Days 22 - End)", min: 22, max: 31, items: [] }
        ];

        for (const item of logs) {
            const dayNum = parseInt(item.date.slice(8, 10), 10) || 1;
            const w = weeks.find(wk => dayNum >= wk.min && dayNum <= wk.max) || weeks[3];
            w.items.push(item);
        }

        for (const w of weeks) {
            if (w.items.length === 0) continue;
            content.push(`[${w.name}]`);
            for (const item of w.items) {
                content.push(`  • ${item.date} (${item.time}) [${item.category}] ${item.content}`);
            }
            content.push("");
        }
    } else {
        let currentDate = "";
        for (const item of logs) {
            if (item.date !== currentDate) {
                currentDate = item.date;
                content.push(`[${currentDate}]`);
            }
            content.push(`  • ${item.time} [${item.category}] ${item.content}`);
        }
        content.push("");
    }

    content.push("================================================================================");
    content.push("Generated by Personal Assistant Bot");
    content.push("================================================================================");

    const textFileStr = content.join("\n");
    const filename = `work_report_${fileSuffix}.txt`;

    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([textFileStr], filename, { type: "text/plain" });
    formData.append("document", file);
    formData.append("caption", `📄 Monthly Accomplishment Report (${label})\n${logs.length} tasks ready for your manager! 🚀`);

    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: formData,
    });

    if (!resp.ok) {
        const detail = await resp.text();
        console.error("sendDocument error:", detail);
        await sendMessage(env, chatId, "❌ Failed to upload report file. Please try viewing it in chat with /report.");
    }
}

export async function sendWorkDeletePicker(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const { results } = await env.DB.prepare(
        "SELECT id, date, content, category FROM work_logs WHERE user_id = ? ORDER BY id DESC LIMIT 5"
    ).bind(userId).all();

    const logs = results || [];
    if (logs.length === 0) {
        await safeEditOrSendMessage(env, chatId, messageId, "No recent tasks found to delete.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "‹ Back to Work Log", callback_data: "work_hub" }],
                    [{ text: "🏠 Main Hub", callback_data: "hub" }]
                ]
            }
        });
        return;
    }

    const buttons = logs.map(item => [
        {
            text: `✕ ${item.date}: ${item.content.slice(0, 30)}${item.content.length > 30 ? "..." : ""}`,
            callback_data: `work_del:${item.id}`
        }
    ]);

    buttons.push([
        { text: "‹ Back to Work Log", callback_data: "work_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, [
        `🗑️ *Delete Recent Task*`,
        `────────────────────`,
        `_Select an accomplishment below to remove:_`
    ].join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
    });
}

export async function sendStandupReport(env, chatId, userId, from, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    const todayDate = today();
    const now = new Date();
    const weekdayStr = new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        weekday: "long"
    }).format(now);

    const prevWorkday = getPreviousWorkdayDate();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

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

    const prevList = prevLogs.length > 0
        ? prevLogs.map(item => `• \`${item.time}\` ${getWorkCategoryIcon(item.category)} ${item.content}`).join("\n")
        : "_No tasks recorded for previous session._";

    const todayList = todayLogs.length > 0
        ? todayLogs.map(item => `• \`${item.time}\` ${getWorkCategoryIcon(item.category)} ${item.content}`).join("\n")
        : "_No tasks logged today yet. Type:_ \`done <task>\`";

    const text = [
        `🗣️ *Daily Standup*`,
        `────────────────────`,
        `● *Engineer:*   ${cleanUsername}`,
        `● *Date:*       \`${todayDate}\` (${weekdayStr})`,
        `────────────────────`,
        `⏮️ *Previous Focus (${effectivePrevDate}):*`,
        prevList,
        ``,
        `🎯 *Today's Focus:*`,
        todayList,
        ``,
        `🚧 *Blockers:*`,
        `• _None reported (all on track)_`,
        `────────────────────`,
        `_Ready for your daily team sync!_`
    ].join("\n");

    const buttons = [
        [
            { text: "📋 Copy Block", callback_data: "work_standup_copy" },
            { text: "✨ AI Polish Standup", callback_data: "work_standup_polish" }
        ],
        [
            { text: "＋ Log Today's Task", callback_data: "work_log_prompt" },
            { text: "⏰ Standup Alarm", callback_data: "remind_add_standup" }
        ],
        [
            { text: "⚡ Work Journal", callback_data: "work_hub" },
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

export async function sendStandupCopyBlock(env, chatId, userId, from, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "📋 1-tap copy block generated!" });
    }

    const rawUsername = from?.first_name || from?.username || "Team Member";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Team Member";
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

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

    const prevBullets = prevLogs.length > 0
        ? prevLogs.map(item => `  - [${item.category}] ${item.content}`).join("\n")
        : "  - Continued regular deliverables";

    const todayBullets = todayLogs.length > 0
        ? todayLogs.map(item => `  - [${item.category}] ${item.content}`).join("\n")
        : "  - Continue development and scheduled sprint tasks";

    const copyBlock = [
        `Daily Standup - ${todayDate}`,
        `Name: ${cleanUsername}`,
        ``,
        `1. Yesterday / Previous (${effectivePrevDate}):`,
        prevBullets,
        ``,
        `2. Today:`,
        todayBullets,
        ``,
        `3. Blockers: None`
    ].join("\n");

    const message = [
        `📋 *Tap the block below to copy:*`,
        ``,
        `\`\`\``,
        copyBlock,
        `\`\`\``,
        `_Paste directly into Slack, Microsoft Teams, or Telegram!_`
    ].join("\n");

    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "⚡ Work Journal", callback_data: "work_hub" }
                ]
            ]
        }
    });
}

export async function handleAiPolishStandup(env, chatId, userId, from, messageId = null, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "🧠 Polishing with AI..." });
    }
    await ensureTables(env.DB);

    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";
    const todayDate = today();
    const prevWorkday = getPreviousWorkdayDate();

    const todayRows = await env.DB.prepare(
        "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
    ).bind(userId, todayDate).all();
    const todayLogs = todayRows.results || [];

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

    if (prevLogs.length === 0 && todayLogs.length === 0) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *No work logs available to polish.*\n\nLog tasks with \`/done <task>\` first (e.g. \`/done Fixed checkout bug\`), then tap **✨ AI Polish Standup**!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Standup", callback_data: "work_standup" }]
                    ]
                }
            }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const rawPrevText = prevLogs.map(i => `[${i.category}] ${i.content}`).join("\n") || "No explicit logs";
    const rawTodayText = todayLogs.map(i => `[${i.category}] ${i.content}`).join("\n") || "Continue scheduled tasks & review";

    const systemPrompt = `You are an elite software engineering manager and executive communicator.
Transform messy or casual work logs into a top-tier, impact-oriented daily engineering standup update.
Keep it concise, actionable, and professional. Use active verbs (Implemented, Resolved, Streamlined, Spearheaded).`;

    const userPrompt = `Engineer: ${cleanUsername}
Date: ${todayDate}
Previous Work Session (${effectivePrevDate}):
${rawPrevText}

Today's Tasks:
${rawTodayText}

Please write a polished, professional daily standup for Slack/Teams.
Include:
1. 🚀 Yesterday / Previous Focus (High impact, clear outcomes)
2. 🎯 Today's Planned Focus (Clear deliverables)
3. 🚧 Blockers / Dependencies (State 'None (All on track)' if none mentioned)

Format cleanly in Telegram Markdown with emojis and bullet points.`;

    const polishedText = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);

    if (!polishedText) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *AI Standup Polish was unavailable.*\n\nPlease verify your \`GEMINI_API_KEY\` or Workers AI binding.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Standup", callback_data: "work_standup" }]
                    ]
                }
            }
        );
        return;
    }

    const responseText = [
        `✨ *AI-Polished Daily Standup*`,
        `────────────────────`,
        polishedText,
        `────────────────────`,
        `_Copy to clipboard or share with your team:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, responseText, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📋 Copy Block", callback_data: "work_standup_copy" },
                    { text: "‹ Raw Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Journal", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function handleAiPolishWorkReport(env, chatId, userId, period = "this_month", from, messageId = null, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "🧠 Polishing report with Gemini AI..." });
    }
    await ensureTables(env.DB);

    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    let label = "";
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        label = monthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        label = lastMonthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else if (period === "this_week") {
        const start = dateDaysAgo(6);
        const end = today();
        label = `Rolling 7 Days (${start} to ${end})`;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, start, end];
    } else {
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];

    if (logs.length === 0) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *No work accomplishments found for ${label} to polish.*\n\nLog tasks with \`/done <task>\` first!`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "⚡ Work Journal", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const formattedTasks = logs.map(l => `• [${l.date}] [${l.category}] ${l.content}`).join("\n");

    const systemPrompt = `You are a Principal Engineering Lead and Executive Performance Coach.
Transform the provided work logs into an inspiring, executive-level Monthly Accomplishment Report suitable for high-stakes 1-on-1s and annual performance reviews.
Group related tasks into impactful business deliverables. Emphasize engineering excellence, business impact, and proactive leadership.`;

    const userPrompt = `Candidate: ${cleanUsername}
Period: ${label}
Completed Work Logs (${logs.length} tasks):
${formattedTasks}

Instructions:
Produce a structured Executive Accomplishment Report formatted in Telegram Markdown:
1. 🏆 Executive Summary: A punchy 2-sentence synthesis of key velocity and high-level milestones.
2. 🚀 Core Deliverables & Features Shipped: Group tasks into major themes/initiatives, detailing the technical outcome and value.
3. 🔧 Operational Excellence & Reliability: Bugfixes, refactors, tooling, performance improvements.
4. 🤝 Collaboration & Leadership: Cross-functional syncs, documentation, mentorship, code reviews.
5. 📈 Recommended Strategic Focus for Next Month: 2 high-leverage forward-looking opportunities.

Use bullet points, emojis, bold headings, and impactful action verbs.`;

    const polishedReport = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);

    if (!polishedReport) {
        await safeEditOrSendMessage(
            env,
            chatId,
            messageId,
            `⚠️ *AI Report Polish was unable to respond.*\n\nPlease verify your \`GEMINI_API_KEY\` or Workers AI binding.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "‹ Back to Work Hub", callback_data: "work_hub" }]
                    ]
                }
            }
        );
        return;
    }

    const exportCb = period === "last_month" ? "work_report_polish_export_last" : "work_report_polish_export_this";
    const rawCb = period === "last_month" ? "work_report_last" : "work_report_this";
    const switchMonthText = period === "last_month" ? "⏩ Polish This Month" : "⏪ Polish Last Month";
    const switchMonthCb = period === "last_month" ? "work_report_polish_this" : "work_report_polish_last";

    const header = [
        `✨ *Executive Accomplishment Report*`,
        `────────────────────`,
        `● *Period:*  \`${label}\``,
        `● *Engineer:* ${cleanUsername}`,
        `● *Input:*    \`${logs.length} completed tasks\``,
        `────────────────────`,
        ``
    ].join("\n");

    const fullMessage = header + polishedReport;

    if (fullMessage.length > 3800) {
        const preview = fullMessage.slice(0, 3200) + "\n\n⚠️ _Report is extensive. Full polished file sent below..._";
        await sendMessage(env, chatId, preview, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "📄 Export Polished .txt", callback_data: exportCb },
                        { text: "📊 Raw Report", callback_data: rawCb }
                    ],
                    [
                        { text: "⚡ Work Journal", callback_data: "work_hub" },
                        { text: "🏠 Main Hub", callback_data: "hub" }
                    ]
                ]
            }
        });
        await sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedReport);
        return;
    }

    await safeEditOrSendMessage(env, chatId, messageId, fullMessage, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📄 Export Polished .txt", callback_data: exportCb },
                    { text: "📊 Raw Report", callback_data: rawCb }
                ],
                [
                    { text: switchMonthText, callback_data: switchMonthCb },
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" }
                ],
                [
                    { text: "⚡ Work Journal", callback_data: "work_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function handleAiPolishWorkReportExport(env, chatId, userId, period = "this_month", from, callbackId = null) {
    if (callbackId) {
        await answerCallback(env, callbackId, { text: "📄 Preparing polished export..." });
    }
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Engineer";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Engineer";

    let label = "";
    let query = "";
    let bindArgs = [];

    if (period === "this_month") {
        label = monthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${monthPrefix()}%`];
    } else if (period === "last_month") {
        label = lastMonthLabel();
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${lastMonthPrefix()}%`];
    } else {
        label = period;
        query = "SELECT id, date, time, content, category FROM work_logs WHERE user_id = ? AND date LIKE ? ORDER BY date ASC, time ASC, id ASC";
        bindArgs = [userId, `${period}%`];
    }

    const { results } = await env.DB.prepare(query).bind(...bindArgs).all();
    const logs = results || [];
    if (logs.length === 0) {
        await sendMessage(env, chatId, `⚠️ No work accomplishments found for ${label} to export.`);
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "upload_document" });
    } catch (e) {}

    const formattedTasks = logs.map(l => `• [${l.date}] [${l.category}] ${l.content}`).join("\n");
    const systemPrompt = `You are a Principal Engineering Lead and Executive Performance Coach.
Transform the provided work logs into an inspiring, executive-level Monthly Accomplishment Report suitable for high-stakes 1-on-1s and annual performance reviews.
Group related tasks into impactful business deliverables. Emphasize engineering excellence, business impact, and proactive leadership.`;

    const userPrompt = `Candidate: ${cleanUsername}
Period: ${label}
Completed Work Logs (${logs.length} tasks):
${formattedTasks}

Instructions:
Produce a structured Executive Accomplishment Report formatted with clear headings:
1. Executive Summary: 2-sentence synthesis of key velocity and high-level milestones.
2. Core Deliverables & Features Shipped: Group tasks into major themes/initiatives, detailing the technical outcome and value.
3. Operational Excellence & Reliability: Bugfixes, refactors, tooling, performance improvements.
4. Collaboration & Leadership: Cross-functional syncs, documentation, mentorship, code reviews.
5. Recommended Strategic Focus for Next Period: 2 high-leverage forward-looking opportunities.`;

    const polishedReport = await callAiTextModel(env, systemPrompt, userPrompt, 0.3);
    if (!polishedReport) {
        await sendMessage(env, chatId, "⚠️ AI was unable to generate the polished export. Please try again.");
        return;
    }

    await sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedReport);
}

export async function sendPolishedWorkReportFile(env, chatId, cleanUsername, label, period, polishedContent) {
    const fileSuffix = period.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `executive_accomplishment_report_${fileSuffix}.txt`;

    const fileText = [
        "================================================================================",
        "                   EXECUTIVE ACCOMPLISHMENT REPORT (AI POLISHED)",
        "================================================================================",
        `Period:          ${label}`,
        `Prepared For:    ${cleanUsername}`,
        `Generated At:    ${today()} ${currentTime()} (Phnom Penh)`,
        "================================================================================",
        "",
        polishedContent.replace(/[*_`#]/g, ""),
        "",
        "================================================================================",
        "Generated with AI Executive Polish by Personal Assistant Bot",
        "================================================================================"
    ].join("\n");

    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([fileText], filename, { type: "text/plain" });
    formData.append("document", file);
    formData.append("caption", `✨ Executive Accomplishment Report (${label})\nAI-polished & formatted for performance reviews! 🚀`);

    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: formData,
    });

    if (!resp.ok) {
        const detail = await resp.text();
        console.error("sendPolishedWorkReportFile error:", detail);
        await sendMessage(env, chatId, "❌ Failed to upload polished report file.");
    }
}
