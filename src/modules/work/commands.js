import { today, currentTime, monthPrefix, monthLabel } from "../../utils/time.js";
import { capitalize, getWorkCategoryIcon } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { sendMessage, safeEditOrSendMessage } from "../../services/telegram.js";

/**
 * Clean, frictionless task logger.
 * Responds with a minimal, zero-button confirmation.
 */
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
        `✅ *Task Logged:* ${finalContent}`,
        `🏆 *${monthCount} tasks* this month (${icon} ${category})`
    ].join("\n");

    // Clean, zero-button confirmation to eliminate chat clutter
    await sendMessage(env, chatId, message, {
        parse_mode: "Markdown"
    });
}

/**
 * Clean viewer for today's completed tasks.
 */
export async function handleListTodayTasksCommand(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const todayDate = today();
    const monthStr = monthPrefix();

    const [todayRows, monthRow] = await Promise.all([
        env.DB.prepare(
            "SELECT id, time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY id ASC"
        ).bind(userId, todayDate).all(),
        env.DB.prepare(
            "SELECT COUNT(*) as count FROM work_logs WHERE user_id = ? AND date LIKE ?"
        ).bind(userId, `${monthStr}%`).first()
    ]);

    const tasks = todayRows.results || [];
    const monthCount = monthRow?.count || 0;

    let taskList = "";
    if (tasks.length === 0) {
        taskList = "_No tasks logged today yet._\n\n_💡 Log anytime:_ `done <task description>`";
    } else {
        taskList = tasks.map((t, idx) => {
            const icon = getWorkCategoryIcon(t.category);
            return `${idx + 1}. \`${t.time}\` ${icon} ${t.content}`;
        }).join("\n");
    }

    const text = [
        `📋 *Today's Completed Tasks*`,
        `🗓️ \`${todayDate}\``,
        `────────────────────`,
        taskList,
        `────────────────────`,
        `🏆 *${monthCount} tasks* logged this month (${monthLabel()})`
    ].join("\n");

    const inline_keyboard = [];
    if (tasks.length > 0) {
        const lastTask = tasks[tasks.length - 1];
        inline_keyboard.push([
            { text: "🗑️ Delete Last Task", callback_data: `work_del:${lastTask.id}` }
        ]);
    }
    inline_keyboard.push([
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard
        }
    });
}
