import { ensureTables } from "../../db/schema.js";
import { getDisplayCurrency, getFinancialSummary, getUserVoiceMode } from "../../db/queries.js";
import { monthPrefix, monthLabel } from "../../utils/time.js";
import { formatAmount } from "../../utils/format.js";
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

    const text = [
        `⚡ *F.R.I.D.A.Y. • COMMAND CENTER*`,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `👤 *Commander:* \`${cleanUsername}\``,
        `🟢 *Status:* \`All Systems Nominal\``,
        ``,
        `💳 *FINANCIAL DEFENSE*`,
        `● *Net Balance:*  \`${balanceStr}\``,
        `● *Spent Today:*  \`${todayStr}\``,
        ``,
        `⚡ *OPERATIONS & AGENDA*`,
        `● *Work Logged:*  \`${workCount} tasks\` _(${monthLabel()})_`,
        `● *Active Alerts:* ${remLine}`,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `_Hold 🎙️ to talk, use \`/speak\`, or select a module:_`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(cleanUsername)}`;

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🛡️ Tactical Briefing", callback_data: "friday_briefing" },
                    { text: "🗣️ Voice Check", callback_data: "speak_status" }
                ],
                [
                    { text: "💳 Finance Hub", callback_data: "finance_hub" },
                    { text: "💼 Work Journal", callback_data: "work_hub" }
                ],
                [
                    { text: "⏰ Reminders", callback_data: "reminders" },
                    { text: "📱 Web Dashboard", web_app: { url: webAppUrl } }
                ],
                [
                    { text: "⚙️ Settings", callback_data: "settings" },
                    { text: "💡 Help & Guide", callback_data: "help" }
                ]
            ]
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
    const toggleLabel = displayCurrency === "USD" ? "💱 Switch to KHR (៛)" : "💱 Switch to USD ($)";
    const voiceToggleLabel = voiceMode === "on" ? "🎙️ Auto-Voice: ON (Always Speak)" : "📝 Auto-Voice: OFF (Tap to Enable)";

    const text = [
        `⚙️ *System Settings*`,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `💱 *Display Currency:* \`${displayCurrency}\``,
        `🎯 *Monthly Budget:*   \`${budgetStr}\``,
        `🎙️ *Auto-Voice Mode:*  \`${voiceMode === "on" ? "Enabled (Always Speak)" : "Disabled (Text + On-demand)"}\``,
        `━━━━━━━━━━━━━━━━━━━━━`,
        `_Configure preferences or manage your records below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: toggleLabel, callback_data: "toggle_currency" }],
                [{ text: voiceToggleLabel, callback_data: "toggle_voice_mode" }],
                [{ text: "🎯 Set Monthly Budget", callback_data: "budget_help" }],
                [{ text: "📥 Export CSV Backup", callback_data: "export_csv" }],
                [
                    { text: "🗑️ Clear Today", callback_data: "clear_today_warn" },
                    { text: "⚠️ Wipe All History", callback_data: "clear_all_warn" }
                ],
                [{ text: "🏠 Main Hub", callback_data: "hub" }]
            ]
        }
    });
}

export async function sendHelpMessage(env, chatId, messageId = null) {
    const text = [
        `💡 *Help & Shortcuts Guide*`,
        `────────────────────`,
        `⚡ *Fast Natural Logging (No Commands Needed)*`,
        `• *Expense:* \`5 coffee\` or \`12000 lunch\` or \`3.50 grab\``,
        `• *Income:* \`+500 salary\` or \`+50 freelance\``,
        `• *Work Task:* \`done Fixed payment timeout bug\``,
        `• *Reminder:* \`remind 17:30 Daily sync\` or \`remind in 25m Review PR\``,
        ``,
        `🎙️ *Hands-Free Voice & Slip Scanner*`,
        `• *Voice Note:* Hold 🎙️ and speak in English or Khmer (*អក្សរខ្មែរ*)`,
        `• *Receipt OCR:* Send ABA Bank, Bakong, KHQR, or receipt photos`,
        ``,
        `💼 *Work Journal & Daily Standup*`,
        `• \`/standup\` — Yesterday, Today & Blockers sync`,
        `• \`/standup polish\` — AI-polished update for Slack / Teams`,
        `• \`/report\` — Monthly manager accomplishment report`,
        `• \`/work\` — Open Work Journal dashboard`,
        ``,
        `💳 *Finance & Cashflow*`,
        `• \`/today\` — Today's transactions & balance`,
        `• \`/summary\` — Monthly spending breakdown & analytics`,
        `• \`/settings\` — Currency toggle (USD / KHR) & monthly budget`,
        ``,
        `🤖 *F.R.I.D.A.Y. Tactical Assistant*`,
        `• \`/briefing\` or \`/friday\` — Tactical morning/status briefing`,
        `• \`/remember <fact>\` — Teach Friday personal preferences & habits`,
        `• \`/memory\` — Inspect Friday's long-term memory matrix`,
        `• \`/reset\` — Clear active multi-turn conversation context`,
        `• *Two-Way Voice:* Send a voice note, Friday speaks back!`,
        `• *Vision & Error Debugger:* Send code screenshots or error photos`,
        `• \`/ask <question>\` — e.g. _"Friday, can I afford a $60 dinner?"_`,
        `────────────────────`,
        `_Tap any button below to jump directly to that workspace:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "⚡ Work Journal", callback_data: "work_hub" }
                ],
                [
                    { text: "💳 Finance Hub", callback_data: "finance_hub" },
                    { text: "⏰ Reminders", callback_data: "reminders" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}
