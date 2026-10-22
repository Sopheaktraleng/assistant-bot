import dashboardHtml from "./dashboard_html.js";
import { json } from "./utils/format.js";
import { timingSafeEqual } from "./utils/crypto.js";
import { wasUpdateProcessed } from "./db/queries.js";
import { handleApiRequest } from "./handlers/api.js";
import { handleMessage } from "./handlers/message.js";
import { handleCallback } from "./handlers/callback.js";
import { processDueReminders } from "./modules/reminders/cron.js";
import { sendWeeklyScheduledReports } from "./modules/finance/views.js";
import { sendDailyScheduledBriefings } from "./modules/copilot/briefing.js";

/**
 * Safely processes Telegram updates with idempotency check against duplicate deliveries.
 */
async function handleUpdateSafely(update, env, origin) {
    try {
        const isDuplicate = await wasUpdateProcessed(env.DB, update.update_id);
        if (isDuplicate) {
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
    }
}

export default {
    async fetch(request, env) {
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
            // Daily at 01:00 UTC (8:00 AM ICT)
            const isDailySlot = event.cron === "0 1 * * *" || (now.getUTCHours() === 1 && now.getUTCMinutes() === 0);
            
            if (isDailySlot) {
                // Autonomous Morning Tactical Briefing
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
