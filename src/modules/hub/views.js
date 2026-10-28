import { TIME_ZONE, isOwner, OWNER_USER_ID } from "../../config/constants.js";
import { ensureTables } from "../../db/schema.js";
import { getDisplayCurrency, getFinancialSummary, getUserVoiceMode, listAuthorizedUsers } from "../../db/queries.js";
import { monthPrefix, monthLabel } from "../../utils/time.js";
import { formatAmount, cleanMd } from "../../utils/format.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendMainHub(env, chatId, userId, from, origin, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";
    const monthStr = monthPrefix();

    // Fetch all hub data concurrently in parallel roundtrip
    const [
        displayCurrency,
        todaySummary,
        allSummary,
        workRow,
        allReminders
    ] = await Promise.all([
        getDisplayCurrency(env.DB, userId),
        getFinancialSummary(env.DB, userId, "today"),
        getFinancialSummary(env.DB, userId, "all"),
        env.DB.prepare("SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?").bind(userId, `${monthStr}%`).first(),
        env.DB.prepare("SELECT id, title, reminder_time, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC").bind(userId).all()
    ]);

    const workCount = workRow?.count || 0;
    const remList = allReminders?.results || [];
    const activeRems = remList.filter(r => r.is_active);
    let remLine = "_No active reminders_";
    if (activeRems.length > 0) {
        const first = activeRems[0];
        const shortTitle = first.title.length > 20 ? first.title.slice(0, 19) + "…" : first.title;
        remLine = `\`${activeRems.length} active\` _(${first.reminder_time} ${shortTitle})_`;
    }

    const netBalance = allSummary?.balanceKhr || 0;
    const isNegative = netBalance < 0;
    const balanceIndicator = isNegative ? "🔴" : "🟢";
    const balanceStr = formatAmount(netBalance, displayCurrency);
    const todayStr = formatAmount(todaySummary?.totalExpenseInKhr || 0, displayCurrency);

    const now = new Date();
    const ppHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
            timeZone: TIME_ZONE,
            hour: "numeric",
            hour12: false
        }).format(now),
        10
    );

    const isUserOwner = isOwner(userId, env);
    const userTitle = isUserOwner ? "Boss" : cleanUsername;

    let quote = `Everything is running smoothly on my end, ${userTitle}.`;
    if (ppHour >= 5 && ppHour < 12) {
        quote = isUserOwner ? "Good morning, Boss. Fresh start today—everything is lined up." : `Good morning, ${userTitle}. Ready whenever you are.`;
    } else if (ppHour >= 12 && ppHour < 17) {
        quote = isUserOwner ? "Good afternoon, Boss. Keeping everything steady and on track." : `Good afternoon, ${userTitle}. How can I help you today?`;
    } else if (ppHour >= 17 && ppHour < 22) {
        quote = isUserOwner ? "Good evening, Boss. Winding down for the day—here's where we stand." : `Good evening, ${userTitle}. Hope you had a great day.`;
    } else {
        quote = isUserOwner ? "Quiet night, Boss. Standing by whenever you need me." : `Quiet night, ${userTitle}. Standing by if you need anything.`;
    }

    const sign = netBalance > 0 ? "+" : "";
    const balanceColorNote = isNegative ? "in the red" : "in the green";
    const agendaLine = activeRems.length > 0
        ? `\`${activeRems.length} active\` _(${activeRems[0].reminder_time} ${activeRems[0].title.slice(0, 20)})_`
        : `_All clear_`;

    const text = [
        `⚡ *F.R.I.D.A.Y.*`,
        `*"${quote}"*`,
        ``,
        `💳 *Ledger:* \`${sign}${balanceStr}\` _(${balanceColorNote})_`,
        `💸 *Spent Today:* \`${todayStr}\``,
        `📋 *Work Done:* \`${workCount} tasks\` _(${monthLabel()})_`,
        `⏰ *Alarms:* ${agendaLine}`,
        ``,
        `_Standing by whenever you're ready._`
    ].join("\n");

    const hubButtons = [
        [
            { text: "💳 Finance Hub", callback_data: "finance_hub" },
            { text: "📋 Today's Tasks", callback_data: "tasks_today" }
        ],
        [
            { text: "⏰ Reminders", callback_data: "reminders" },
            { text: "💡 Help & Guide", callback_data: "help" }
        ]
    ];

    if (isUserOwner) {
        hubButtons.push([
            { text: "⚙️ Settings", callback_data: "settings" },
            { text: "👥 User Access", callback_data: "manage_users" }
        ]);
    } else {
        hubButtons.push([
            { text: "⚙️ Settings", callback_data: "settings" }
        ]);
    }

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: hubButtons
        }
    });
}

export async function sendMainMenu(env, chatId, userId, from, origin, messageId = null) {
    return sendMainHub(env, chatId, userId, from, origin, messageId);
}

export async function sendSettingsMenu(env, chatId, userId, messageId = null) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const voiceMode = await getUserVoiceMode(env.DB, userId);
    const settingsRow = await env.DB.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    ).bind(userId).first();

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const budgetStr = budgetKhr > 0 ? formatAmount(budgetKhr, displayCurrency) : "Off (No limit)";
    const currencyPill = displayCurrency === "USD" ? "💱 Currency: USD" : "💱 Currency: KHR";
    const voicePill = voiceMode === "on" ? "🎙️ Voice: ON" : "🎙️ Voice: OFF";

    const text = [
        `⚙️ *System Settings*`,
        ``,
        `• *Display Currency:* \`${displayCurrency} (${displayCurrency === "USD" ? "$" : "៛"})\``,
        `• *Monthly Budget:*   \`${budgetStr}\``,
        `• *Auto-Voice Mode:*  \`${voiceMode === "on" ? "Enabled (Always Speak)" : "Disabled (Text)"}\``,
        ``,
        `_Tap any setting below to toggle or reconfigure:_`
    ].join("\n");

    const keyboard = [
        [
            { text: currencyPill, callback_data: "toggle_currency" },
            { text: voicePill, callback_data: "toggle_voice_mode" }
        ],
        [
            { text: "🎯 Set Budget", callback_data: "budget_help" },
            { text: "📥 Export CSV", callback_data: "export_csv" }
        ],
        [
            { text: "🗑️ Reset Data", callback_data: "clear_data" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

export async function sendUserManagementMenu(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const users = await listAuthorizedUsers(env.DB);
    const owner = users.find(u => u.role === "owner") || { user_id: OWNER_USER_ID, first_name: "Boss" };
    const guests = users.filter(u => u.role !== "owner");
    const activeGuests = guests.filter(g => g.status === "active");
    const pendingGuests = guests.filter(g => g.status === "pending");

    const textLines = [
        `👥 *F.R.I.D.A.Y. • User Access Matrix*`,
        ``,
        `👑 *Owner:* ${cleanMd(owner.first_name || "Boss")} (\`${owner.user_id}\`)`,
        ``
    ];

    if (activeGuests.length > 0) {
        textLines.push(`🟢 *Active Guests (${activeGuests.length}):*`);
        for (const g of activeGuests) {
            const uName = g.username ? ` (@${g.username})` : "";
            textLines.push(`• *${cleanMd(g.first_name || "Guest")}*${uName} — \`${g.user_id}\``);
        }
        textLines.push("");
    } else {
        textLines.push(`_No active guests yet._\n`);
    }

    if (pendingGuests.length > 0) {
        textLines.push(`⏳ *Pending Approvals (${pendingGuests.length}):*`);
        for (const p of pendingGuests) {
            const uName = p.username ? ` (@${p.username})` : "";
            textLines.push(`• *${cleanMd(p.first_name || "Guest")}*${uName} — \`${p.user_id}\``);
        }
        textLines.push("");
    }

    textLines.push(`_Manage approvals or revoke guest access below:_`);

    const keyboard = [];

    // Pending approvals
    for (const p of pendingGuests) {
        keyboard.push([
            { text: `✅ Approve ${p.first_name || p.user_id}`, callback_data: `approve_user:${p.user_id}` },
            { text: `❌ Deny`, callback_data: `deny_user:${p.user_id}` }
        ]);
    }

    // Revocation for active guests
    for (const g of activeGuests) {
        keyboard.push([
            { text: `🚫 Revoke ${g.first_name || g.user_id}`, callback_data: `revoke_user:${g.user_id}` }
        ]);
    }

    keyboard.push([
        { text: "🔄 Refresh", callback_data: "manage_users" },
        { text: "⚙️ Settings", callback_data: "settings" }
    ]);
    keyboard.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, textLines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function sendHelpMessage(env, chatId, messageId = null) {
    const text = [
        `💡 *Help & Shortcuts Guide*`,
        ``,
        `⚡ *Fast Natural Logging (No Commands Needed)*`,
        `• *Expense:* \`5 coffee\` or \`12000 lunch\` or \`3.50 grab\``,
        `• *Income:* \`+500 salary\`, \`40$ income\`, or \`earned $50 freelance\``,
        `• *Work Task:* \`done Fixed payment timeout bug\``,
        `• *Reminder:* \`remind 17:30 Daily sync\` or \`remind in 25m Review PR\``,
        `• *Undo Mistake:* \`/undo\` or type \`undo\` to remove the last entry`,
        ``,
        `🎙️ *Hands-Free Voice & Slip Scanner*`,
        `• *Voice Note:* Hold 🎙️ and speak in English or Khmer (*អក្សរខ្មែរ*)`,
        `• *Receipt OCR:* Send ABA Bank, Bakong, KHQR, or receipt photos`,
        ``,
        `💼 *Work & Task Logging*`,
        `• \`done <task>\` — Log completed task (e.g. \`done Fixed login issue\`)`,
        `• \`/tasks\` — View today's completed accomplishments`,
        ``,
        `💳 *Finance & Cashflow*`,
        `• \`/today\` — Today's transactions & balance`,
        `• \`/summary\` — Monthly spending breakdown & analytics`,
        `• \`/settings\` — Currency toggle (USD / KHR) & monthly budget`,
        ``,
        `🤖 *F.R.I.D.A.Y. Tactical Assistant*`,
        `• \`/search <query>\` — Live Google Search grounding (weather, crypto, news, scores)`,
        `• \`/users\` — Dynamic user access matrix & guest approval (Boss only)`,
        `• \`/briefing\` or \`/friday\` — Tactical morning/status briefing`,
        `• \`/remember <fact>\` — Teach Friday personal preferences & habits`,
        `• \`/memory\` — Inspect Friday's long-term memory matrix`,
        `• \`/reset\` — Clear active multi-turn conversation context`,
        `• *Two-Way Voice:* Send a voice note, Friday speaks back!`,
        `• *Vision & Error Debugger:* Send code screenshots or error photos`,
        `• \`/ask <question>\` — e.g. _"Friday, can I afford a $60 dinner?"_`,
        ``,
        `_Tap any button below to jump directly to that workspace:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💳 Finance Hub", callback_data: "finance_hub" },
                    { text: "📋 Today's Tasks", callback_data: "tasks_today" }
                ],
                [
                    { text: "⏰ Reminders", callback_data: "reminders" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}
