import { ensureTables } from "../../db/schema.js";
import { getDisplayCurrency, getFinancialSummary } from "../../db/queries.js";
import { monthPrefix, monthLabel } from "../../utils/time.js";
import { formatAmount } from "../../utils/format.js";
import { safeEditOrSendMessage } from "../../services/telegram.js";

export async function sendMainHub(env, chatId, userId, from, origin, messageId = null) {
    await ensureTables(env.DB);
    const rawUsername = from?.first_name || from?.username || "Friend";
    const cleanUsername = rawUsername.replace(/[_*`[\]]/g, " ").trim() || "Friend";
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");
    const monthStr = monthPrefix();

    const workRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();
    const workCount = workRow?.count || 0;

    const { results: allReminders } = await env.DB.prepare(
        "SELECT id, title, reminder_time, is_active FROM reminders WHERE user_id = ? ORDER BY id ASC"
    ).bind(userId).all();
    const remList = allReminders || [];
    const activeRems = remList.filter(r => r.is_active);
    let remStatus = "○ None";
    if (activeRems.length > 0) {
        const first = activeRems[0];
        const shortTitle = first.title.length > 14 ? first.title.slice(0, 13) + "…" : first.title;
        remStatus = `● ${activeRems.length} active (${first.reminder_time} ${shortTitle})`;
    }

    const wlRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM watchlist WHERE user_id = ? AND status = 'plan_to_watch'"
    ).bind(userId).first();
    const wlCount = wlRow?.count || 0;

    const text = [
        `*Personal Assistant Hub*`,
        `────────────────────`,
        `● *Balance:*   \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `● *Today:*     \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\``,
        `● *Work:*      \`${workCount} tasks\` in ${monthLabel()}`,
        `● *Watchlist:* \`${wlCount} to watch\``,
        `● *Alerts:*    \`${remStatus}\``,
        `────────────────────`,
        `_Select a workspace below or type naturally:_`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(cleanUsername)}`;

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "＋ Expense", callback_data: "add_expense" },
                    { text: "＋ Income", callback_data: "add_income" }
                ],
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "⚡ Work Log", callback_data: "work_hub" }
                ],
                [
                    { text: "✨ AI Copilot", callback_data: "copilot_help" },
                    { text: "⏰ Reminders", callback_data: "reminders" }
                ],
                [
                    { text: `🍿 Movies (${wlCount})`, callback_data: "movie_hub" },
                    { text: "🌐 Dashboard", web_app: { url: webAppUrl } }
                ],
                [
                    { text: "⚙️ Settings", callback_data: "settings" },
                    { text: "💡 Guide & Shortcuts", callback_data: "help" }
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
    const settingsRow = await env.DB.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    ).bind(userId).first();

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const budgetStr = budgetKhr > 0 ? formatAmount(budgetKhr, displayCurrency) : "Off (No limit)";
    const toggleLabel = displayCurrency === "USD" ? "💱 Switch to KHR (៛)" : "💱 Switch to USD ($)";

    const text = [
        `⚙️ *System Settings*`,
        `────────────────────`,
        `● *Display Currency:*  \`${displayCurrency}\``,
        `● *Monthly Budget:*   \`${budgetStr}\``,
        `────────────────────`,
        `_Configure preferences or manage your records below:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: toggleLabel, callback_data: "toggle_currency" }],
                [{ text: "🎯 Set Monthly Budget", callback_data: "budget_help" }],
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
        `💡 *Personal Assistant Guide*`,
        `────────────────────`,
        `🎙️ *Hands-Free Voice Notes*`,
        `• Press & hold 🎙️ to speak: _"Spent $4 on iced coffee"_, _"Done code review"_, _"Remind 17:30 call mom"_`,
        `• English, Khmer (*អក្សរខ្មែរ*), and mixed speech fully supported!`,
        ``,
        `⚡ *Natural Typing (No Commands Needed)*`,
        `• Reminders: \`remind 17:30 Bring lunch box\` or \`remind in 30m Check oven\``,
        `• Expense: \`5 coffee\` or \`10000 lunch\` or \`3.50 grab\``,
        `• Income: \`+500 salary\` or \`+50 bonus\``,
        `• Work log: \`done Fixed checkout bug\` or \`done Team sprint planning\``,
        `• Today ledger: \`today\` or \`ledger\``,
        `• Main menu: \`menu\` or \`hub\``,
        ``,
        `✨ *AI Copilot (Khmer & English)*`,
        `• \`/ask <question>\` or \`/ai <question>\``,
        `• Ask: *"How much did I spend this week?"*, *"Can I afford a $50 dinner?"*`,
        ``,
        `⏰ *Reminders & Alarms*`,
        `• \`remind 17:30 <task>\` — Daily recurring reminder`,
        `• \`remind in 15m <task>\` — Quick one-time timer`,
        `• \`/reminders\` — Open Reminders Workspace`,
        ``,
        `⚡ *Work Log, Standup & AI Reports*`,
        `• \`done <task>\` — Record accomplishment instantly (supports \`#tag\`)`,
        `• \`/standup\` — Daily standup generator (Yesterday, Today, Blockers)`,
        `• \`/standup polish\` — AI-polished standup for Slack / Teams`,
        `• \`/report\` — Generate monthly manager accomplishment report`,
        `• \`/report polish\` — AI executive accomplishment synthesis`,
        `• \`/report export\` — Download report as .txt file`,
        `• \`/work\` — Open Work Journal Workspace`,
        ``,
        `🧾 *Smart Receipt & Slip Scanner*`,
        `• Send or forward ABA Bank, Bakong, or KHQR slips to record automatically!`,
        `• Send paper receipt photos to extract itemized totals`,
        ``,
        `💳 *Finance & Cashflow*`,
        `• \`/add 5 usd coffee\` or \`/income 500 usd salary\``,
        `• \`/today\` — Today's transactions`,
        `• \`/summary\` — Spending statistics & breakdown`,
        `• \`/settings\` — Currency toggle & budget limit`,
        ``,
        `🍿 *Movies, Series & Watchlist*`,
        `• \`/watch <vibe>\` — AI movie recommendations (e.g. \`/watch sci-fi thriller\`)`,
        `• \`/watch add <title>\` — Save a movie/show directly (e.g. \`/watch add Dune 2\`)`,
        `• \`/watch\` — Browse recommender by genres & moods`,
        `• \`/watchlist\` — View saved movies, mark watched, or pick one for tonight`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Standup", callback_data: "work_standup" },
                    { text: "⚡ Work Log", callback_data: "work_hub" }
                ],
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "⏰ Reminders", callback_data: "reminders" }
                ],
                [
                    { text: "🍿 Movies", callback_data: "movie_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}
