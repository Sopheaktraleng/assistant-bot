import dashboardHtml from "./dashboard_html.js";
import { json } from "./utils/format.js";
import { timingSafeEqual } from "./utils/crypto.js";
import { wasUpdateProcessed } from "./db/queries.js";
import { handleApiRequest } from "./handlers/api.js";
import { handleMessage } from "./handlers/message.js";
import { handleCallback } from "./handlers/callback.js";
import { processDueReminders } from "./modules/reminders/cron.js";
import { sendWeeklyScheduledReports } from "./modules/finance/views.js";
import { sendDailyScheduledWakeup, sendDailyScheduledBriefings } from "./modules/copilot/briefing.js";
import { sendMessage, answerCallback } from "./services/telegram.js";
import { isUserAuthorizedAsync } from "./config/constants.js";

/**
 * Safely processes Telegram updates with idempotency check against duplicate deliveries.
 */
async function handleUpdateSafely(update, env, origin) {
    try {
        const isDuplicate = await wasUpdateProcessed(env.DB, update.update_id);
        if (isDuplicate) {
            return;
        }

        // Authorization check: ensure only the owner/authorized users can use this assistant
        const userId = String(
            update.message?.from?.id ||
            update.message?.chat?.id ||
            update.callback_query?.from?.id ||
            update.callback_query?.message?.chat?.id ||
            ""
        );

        const isAuth = await isUserAuthorizedAsync(env.DB, userId, env);
        if (userId && !isAuth) {
            // Allow unauthenticated users to trigger the request_access callback
            if (update.callback_query?.data?.startsWith("request_access")) {
                await handleCallback(update.callback_query, env, origin);
                return;
            }

            console.warn(`Unauthorized access attempt by user ${userId}`);
            const chatType = update.message?.chat?.type || "private";
            if (update.message?.chat?.id && chatType === "private") {
                const requesterName = update.message?.from?.first_name || "Friend";
                await sendMessage(
                    env,
                    update.message.chat.id,
                    `🔒 *F.R.I.D.A.Y. • Access Restricted*\n\nHello ${requesterName}! This personal assistant is currently private and managed by Boss.\n\nWould you like to request guest access?`,
                    {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "📩 Request Access from Boss", callback_data: `request_access:${userId}` }]
                            ]
                        }
                    }
                ).catch(() => {});
            } else if (update.callback_query?.id) {
                await answerCallback(env, update.callback_query.id, {
                    text: "⛔ Access denied: This assistant is private.",
                    show_alert: true
                }).catch(() => {});
            }
            return;
        }

        if (update.message) {
            await handleMessage(update.message, env, origin);
            return;
        }

        if (update.callback_query) {
            await handleCallback(update.callback_query, env, origin);
        }
    } catch (error) {
        console.error("Failed to handle Telegram update:", error);
        const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
        if (chatId) {
            await sendMessage(
                env,
                chatId,
                `🛡️ *F.R.I.D.A.Y. Diagnostic Status*\n\nBoss, an unexpected anomaly occurred while processing your request. All ledgers and settings remain safe.\n\nQuick Recovery:\n• View Ledgers: \`/today\` or \`/summary\`\n• Open Command Center: \`/start\` or \`/hub\``,
                {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [[{ text: "🏠 Main Hub", callback_data: "hub" }]]
                    }
                }
            ).catch(() => {});
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Static Dashboard Mini-App Delivery
        if (request.method === "GET" || request.method === "HEAD") {
            if (url.pathname === "/dashboard") {
                return new Response(request.method === "HEAD" ? null : dashboardHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }
        }

        // 2. Authenticated Mini-App API Endpoints
        if (url.pathname.startsWith("/api/")) {
            return handleApiRequest(request, env);
        }

        // 3. Webhook endpoint (POST)
        if (request.method === "POST" && url.pathname === "/webhook") {
            if (!env.TELEGRAM_BOT_TOKEN) {
                return json({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN" }, 500);
            }

            if (env.WEBHOOK_SECRET) {
                const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
                const expectedSecret = env.WEBHOOK_SECRET.trim();
                if (secret && !timingSafeEqual(secret, expectedSecret)) {
                    console.warn("Unauthorized webhook request: secret token mismatch.");
                    return json({ ok: false, error: "Unauthorized" }, 401);
                }
            }

            const bodyText = await request.text();
            let update;
            try {
                update = JSON.parse(bodyText);
            } catch (e) {
                console.error("Failed to parse update JSON:", e);
                return json({ ok: false, error: "Invalid JSON" }, 400);
            }

            if (ctx && typeof ctx.waitUntil === "function") {
                ctx.waitUntil(handleUpdateSafely(update, env, url.origin));
                return json({ ok: true });
            }

            await handleUpdateSafely(update, env, url.origin);
            return json({ ok: true });
        }

        // 4. Healthcheck endpoint
        if (request.method === "GET") {
            return json({ ok: true, service: "cashflow-bot" });
        }

        return json({ ok: false, error: "Not found" }, 404);
    },

    async scheduled(event, env) {
        try {
            await processDueReminders(env);
        } catch (error) {
            console.error("Scheduled reminder check failed:", error);
        }

        try {
            const now = new Date();
            const utcHours = now.getUTCHours();
            const utcMinutes = now.getUTCMinutes();

            // Cloudflare cron dispatch checks
            const isDedicatedWakeup = event.cron === "50 0 * * *";
            const isDedicatedBriefing = event.cron === "0 1 * * *";
            const isGeneralMinuteCron = event.cron === "* * * * *" || !event.cron;

            // 1. Daily at 00:50 UTC (7:50 AM ICT) - Morning Wake-Up Call
            const isWakeupSlot = isDedicatedWakeup || (isGeneralMinuteCron && utcHours === 0 && utcMinutes === 50);
            if (isWakeupSlot) {
                await sendDailyScheduledWakeup(env);
            }

            // 2. Daily at 01:00 UTC (8:00 AM ICT) - Good Morning Check-In & Coffee
            const isBriefingSlot = isDedicatedBriefing || (isGeneralMinuteCron && utcHours === 1 && utcMinutes === 0);
            if (isBriefingSlot) {
                await sendDailyScheduledBriefings(env);

                // Monday Weekly Spending Report
                if (now.getUTCDay() === 1) {
                    await sendWeeklyScheduledReports(env);
                }
            }
        } catch (error) {
            console.error("Scheduled report/briefing failed:", error);
        }
    },
};
