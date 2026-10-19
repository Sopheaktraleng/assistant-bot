import { today, currentTime, monthPrefix } from "../../utils/time.js";
import { capitalize, getWorkCategoryIcon } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { sendMessage } from "../../services/telegram.js";
import { sendWorkReport, sendWorkReportFile, handleAiPolishWorkReport } from "./views.js";

export async function handleAddWorkLogCommand(env, chatId, userId, text, from) {
    await ensureTables(env.DB);
    const content = text.replace(/^\/\w+\s*/, "").trim();
    if (!content) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:* \`/done <task description>\`\n\n` +
            `Examples:\n` +
            `• \`/done Fixed checkout payment failure bug\`\n` +
            `• \`/done Completed API migration for auth service\`\n` +
            `• \`/done Sprint planning meeting with design team\`\n` +
            `• \`/done [Bugfix] Fixed mobile crash on iOS 18\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    let category = "General";
    let finalContent = content;

    const bracketMatch = content.match(/^\[(.*?)\]\s*(.*)$/);
    if (bracketMatch) {
        category = capitalize(bracketMatch[1].trim());
        finalContent = bracketMatch[2].trim() || content;
    } else {
        const lower = content.toLowerCase();
        if (lower.includes("fix") || lower.includes("bug") || lower.includes("issue") || lower.includes("resolve") || lower.includes("patch") || lower.includes("error") || lower.includes("#bug")) {
            category = "Bugfix";
        } else if (lower.includes("meet") || lower.includes("sync") || lower.includes("call") || lower.includes("standup") || lower.includes("discuss") || lower.includes("1-on-1") || lower.includes("1:1")) {
            category = "Meeting";
        } else if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish") || lower.includes("ship") || lower.includes("#release")) {
            category = "Release";
        } else if (lower.includes("doc") || lower.includes("report") || lower.includes("write") || lower.includes("spec") || lower.includes("manual")) {
            category = "Documentation";
        } else if (lower.includes("test") || lower.includes("qa") || lower.includes("verify") || lower.includes("audit")) {
            category = "Testing";
        } else if (lower.includes("design") || lower.includes("ui") || lower.includes("ux") || lower.includes("figma") || lower.includes("mockup")) {
            category = "Design";
        } else if (lower.includes("code") || lower.includes("api") || lower.includes("feature") || lower.includes("develop") || lower.includes("implement") || lower.includes("refactor") || lower.includes("build") || lower.includes("service") || lower.includes("#dev")) {
            category = "Development";
        }
    }

    const todayDate = today();
    const timeStr = currentTime();

    await env.DB.prepare(
        "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
    ).bind(userId, todayDate, timeStr, finalContent, category).run();

    const monthStr = monthPrefix();
    const countRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
    ).bind(userId, `${monthStr}%`).first();
    const monthCount = countRow?.count || 1;

    const icon = getWorkCategoryIcon(category);
    const message = [
        `✅ *Logged:* ${finalContent}`,
        `🏆 *${monthCount} tasks* this month (${icon} ${category})`
    ].join("\n");

    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🗣️ Daily Standup", callback_data: "work_standup" },
                    { text: "✨ AI Polish", callback_data: "work_report_polish_this" }
                ],
                [
                    { text: "📋 Today's Work", callback_data: "work_today" },
                    { text: "📊 Monthly Report", callback_data: "work_report_this" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function handleReportCommand(env, chatId, userId, text, from) {
    const parts = text.split(/\s+/);
    const arg = (parts[1] || "").toLowerCase();

    if (arg === "polish" || arg === "ai") {
        const subArg = (parts[2] || "").toLowerCase();
        const targetPeriod = (subArg === "last" || subArg === "prev" || subArg === "previous") ? "last_month" : (subArg === "week" || subArg === "7d") ? "this_week" : "this_month";
        await handleAiPolishWorkReport(env, chatId, userId, targetPeriod, from);
        return;
    }

    if (arg === "last" || arg === "prev" || arg === "previous") {
        await sendWorkReport(env, chatId, userId, "last_month", from);
        return;
    }

    if (arg === "week" || arg === "7d") {
        await sendWorkReport(env, chatId, userId, "this_week", from);
        return;
    }

    if (arg === "export" || arg === "file" || arg === "txt") {
        await sendWorkReportFile(env, chatId, userId, "this_month", from);
        return;
    }

    if (arg.match(/^\d{4}-\d{2}$/)) {
        await sendWorkReport(env, chatId, userId, arg, from);
        return;
    }

    await sendWorkReport(env, chatId, userId, "this_month", from);
}
