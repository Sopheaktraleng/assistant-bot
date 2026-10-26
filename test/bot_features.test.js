import { describe, it, expect, vi } from "vitest";
import { GEMINI_MODELS, isUserAuthorized, isUserAuthorizedAsync, isOwner, OWNER_USER_ID, getAllowedUserIds, DEFAULT_ALLOWED_USERS } from "../src/config/constants.js";
import { addOrUpdateAuthorizedUser, listAuthorizedUsers, setAuthorizedUserStatus } from "../src/db/queries.js";
import { normalizeReminderTime } from "../src/utils/time.js";
import { isCompoundOrMultiAction, isRealTimeSearchQuery, isConversationalOrCorrection } from "../src/utils/natural.js";
import { buildSmartLocalFallback, handleAiCopilotQuery } from "../src/modules/copilot/handler.js";
import { parseCopilotResponse, buildCopilotPrompt, extractGroundingSources, getLiveRealtimeFallback, askGeminiWithGoogleSearch } from "../src/services/ai.js";
import { ensureTables, resetTablesEnsuredForTest } from "../src/db/schema.js";
import { handleMessage, handleRealTimeSearchCommand } from "../src/handlers/message.js";
import worker from "../src/worker.js";
import { handleCallback } from "../src/handlers/callback.js";
import { answerCallback } from "../src/services/telegram.js";
import { sendRemindersMenu, sendPromptAddReminder, sendReminderTimeMenu } from "../src/modules/reminders/views.js";
import { handleAddWorkLogCommand, handleListTodayTasksCommand } from "../src/modules/work/commands.js";

describe("Bot Improvements & Stability", () => {
    describe("AI Configuration", () => {
        it("should have higher intelligence Gemini production models ordered by capability and reliability", () => {
            expect(GEMINI_MODELS).toContain("gemini-3.5-flash");
            expect(GEMINI_MODELS).toContain("gemini-3.6-flash");
            expect(GEMINI_MODELS).toContain("gemini-3.5-flash-lite");
            expect(GEMINI_MODELS[0]).toBe("gemini-3.5-flash");
        });
    });

    describe("Telegram Callback Resilience", () => {
        it("should silently handle failed or duplicate answerCallbackQuery without throwing", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({
                    ok: false,
                    error_code: 400,
                    description: "Bad Request: query is too old and response timeout expired or query ID is invalid"
                }), { status: 400 })
            );

            const result = await answerCallback({ TELEGRAM_BOT_TOKEN: "mock_token" }, "expired_query_123", { text: "Hello" });
            expect(result).toBeNull();
            fetchSpy.mockRestore();
        });
    });

    describe("Reminders & Alerts UI", () => {
        it("should render clean Reminders Hub with smart automation toggles and quick timers", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 1, title: "Morning Standup Sync", reminder_time: "09:00", frequency: "weekdays", type: "standup", is_active: 1 },
                                { id: 2, title: "Departure & Lunchbox", reminder_time: "17:30", frequency: "weekdays", type: "lunchbox", is_active: 0 },
                                { id: 3, title: "Team sync with designer", reminder_time: "14:00", frequency: "once", type: "custom", is_active: 1 }
                            ]
                        }),
                        first: vi.fn().mockResolvedValue(null),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendRemindersMenu(mockEnv, 123456, "user_1");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Reminders & Alerts Hub");
            expect(payload.text).toContain("Daily Routine Automations");
            expect(payload.text).toContain("Team sync with designer");

            // Verify clean buttons exist
            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("＋ New Reminder");
            expect(buttonTexts).toContain("⏱️ Quick Timers");
            expect(buttonTexts).toContain("🟢 Standup 09:00");
            expect(buttonTexts).toContain("⚪ Departure 17:30");
            expect(buttonTexts).toContain("⚙️ Edit");

            fetchSpy.mockRestore();
        });

        it("should render 1-tap quick timer countdown buttons in sendPromptAddReminder", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendPromptAddReminder(mockEnv, 123456);

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Quick Timers & Reminders");
            expect(payload.text).toContain("1-Tap Countdown Timers");

            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("⏱️ In 10 Mins");
            expect(buttonTexts).toContain("⏱️ In 15 Mins");
            expect(buttonTexts).toContain("⏱️ In 30 Mins");
            expect(buttonTexts).toContain("⏱️ In 1 Hour");

            fetchSpy.mockRestore();
        });
    });

    describe("Database Optimization", () => {
        it("should execute ensureTables via db.batch in a single round-trip", async () => {
            resetTablesEnsuredForTest();
            const batchSpy = vi.fn().mockResolvedValue([]);
            const prepareSpy = vi.fn().mockReturnValue({ run: vi.fn() });
            const mockDb = {
                batch: batchSpy,
                prepare: prepareSpy
            };
            await ensureTables(mockDb);
            expect(batchSpy).toHaveBeenCalled();
        });
    });

    describe("Group Chat Safety & Message Routing", () => {
        it("should ignore casual natural language in group chats if not directed to bot", async () => {
            const groupMsg = {
                chat: { id: -1001234567, type: "group" },
                from: { id: 9999 },
                text: "5 coffee"
            };
            const mockEnv = {
                DB: {
                    prepare: vi.fn().mockReturnValue({
                        bind: vi.fn().mockReturnValue({
                            run: vi.fn().mockResolvedValue({}),
                            all: vi.fn().mockResolvedValue({ results: [] }),
                            first: vi.fn().mockResolvedValue(null)
                        })
                    })
                }
            };

            // Should return without error and without touching DB expenses
            await handleMessage(groupMsg, mockEnv, "https://example.com");
            expect(mockEnv.DB.prepare).not.toHaveBeenCalled();
        });

        it("should normalize command containing bot username in groups", async () => {
            const helpMsg = {
                chat: { id: -1001234567, type: "group" },
                from: { id: 9999 },
                text: "/help@cashflow_bot"
            };
            const mockEnv = {
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            // Mock global fetch for Telegram sendMessage
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            await handleMessage(helpMsg, mockEnv, "https://example.com");
            expect(fetchSpy).toHaveBeenCalled();
            fetchSpy.mockRestore();
        });
    });

    describe("Streamlined Task Logging (Zero Clutter)", () => {
        it("should log task and respond with clean zero-button confirmation", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({}),
                        first: vi.fn().mockResolvedValue({ count: 5 }),
                        all: vi.fn().mockResolvedValue({ results: [] })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleAddWorkLogCommand(mockEnv, 123456, "user_1", "/done Fixed checkout timeout", { first_name: "Boss" });

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("✅ *Task Logged:* Fixed checkout timeout");
            expect(payload.text).toContain("5 tasks");
            // Zero button clutter!
            expect(payload.reply_markup).toBeUndefined();

            fetchSpy.mockRestore();
        });

        it("should render clean today's tasks list with handleListTodayTasksCommand", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockImplementation((query) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            run: vi.fn().mockResolvedValue({}),
                            first: vi.fn().mockResolvedValue({ count: 12 }),
                            all: vi.fn().mockResolvedValue({
                                results: [
                                    { id: 101, time: "09:30", content: "Fixed auth token expiration", category: "Bugfix" },
                                    { id: 102, time: "14:00", content: "Architecture review sync", category: "Meeting" }
                                ]
                            })
                        })
                    };
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleListTodayTasksCommand(mockEnv, 123456, "user_1");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Today's Completed Tasks");
            expect(payload.text).toContain("Fixed auth token expiration");
            expect(payload.text).toContain("Architecture review sync");
            expect(payload.text).toContain("12 tasks");

            // Check buttons: Only Delete Last and Main Hub
            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("🗑️ Delete Last Task");
            expect(buttonTexts).toContain("🏠 Main Hub");
            expect(buttonTexts).not.toContain("Daily Standup");

            fetchSpy.mockRestore();
        });
    });

    describe("Personal Assistant Security & Access Control", () => {
        it("should correctly resolve allowed user IDs from environment or default", () => {
            expect(getAllowedUserIds({ ALLOWED_USER_IDS: "12345, 67890" })).toEqual(["12345", "67890"]);
            expect(getAllowedUserIds({ OWNER_TELEGRAM_ID: "849550186" })).toEqual(["849550186"]);
            expect(DEFAULT_ALLOWED_USERS).toContain("849550186");
        });

        it("isUserAuthorized should allow whitelisted users and reject others", () => {
            const env = { ALLOWED_USER_IDS: "849550186, 111222" };
            expect(isUserAuthorized("849550186", env)).toBe(true);
            expect(isUserAuthorized(849550186, env)).toBe(true);
            expect(isUserAuthorized("111222", env)).toBe(true);
            expect(isUserAuthorized("8250070483", env)).toBe(false);
            expect(isUserAuthorized("unknown_stranger", env)).toBe(false);
            expect(isUserAuthorized(null, env)).toBe(false);
        });

        it("handleMessage should reject unauthorized messages with Access Restricted notice", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockEnv = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186"
            };

            const unauthorizedMsg = {
                chat: { id: 8250070483, type: "private" },
                from: { id: 8250070483 },
                text: "Hello, good morning!"
            };

            await handleMessage(unauthorizedMsg, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Access Restricted");
            expect(payload.text).toContain("private");

            fetchSpy.mockRestore();
        });

        it("handleCallback should reject unauthorized button interactions with alert toast", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockEnv = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186"
            };

            const unauthorizedCallback = {
                id: "cb_unauth_123",
                from: { id: 999999999 },
                message: { chat: { id: 999999999 }, message_id: 42 },
                data: "hub"
            };

            await handleCallback(unauthorizedCallback, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const calledUrl = fetchSpy.mock.calls[0][0];
            expect(calledUrl).toContain("answerCallbackQuery");
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Access denied");
            expect(payload.show_alert).toBe(true);

            fetchSpy.mockRestore();
        });

        it("sendDailyScheduledWakeup should never dispatch to unauthorized users", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            // DB contains an unauthorized user
            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [{ user_id: "unauthorized_user_8250070483" }]
                        }),
                        first: vi.fn().mockResolvedValue({ briefing_mode: "on" }),
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                    })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186" // Only owner allowed
            };

            const { sendDailyScheduledWakeup } = await import("../src/modules/copilot/briefing.js");
            await sendDailyScheduledWakeup(mockEnv);

            // The unauthorized user must have been skipped
            const telegramCalls = fetchSpy.mock.calls.filter(call => {
                const url = typeof call[0] === "string" ? call[0] : "";
                return url.includes("sendMessage") || url.includes("sendVoice");
            });
            expect(telegramCalls.length).toBe(0);

            fetchSpy.mockRestore();
        });
    });

    describe("Gemini AI Autonomous Multi-Action & Tool Calling", () => {
        it("normalizeReminderTime should convert 12-hour AM/PM and 24-hour formats accurately", () => {
            expect(normalizeReminderTime("15:30")).toBe("15:30");
            expect(normalizeReminderTime("3:30 PM")).toBe("15:30");
            expect(normalizeReminderTime("3:30pm")).toBe("15:30");
            expect(normalizeReminderTime("9am")).toBe("09:00");
            expect(normalizeReminderTime("09:00 AM")).toBe("09:00");
            expect(normalizeReminderTime("12pm")).toBe("12:00");
            expect(normalizeReminderTime("12:00 PM")).toBe("12:00");
            expect(normalizeReminderTime("12am")).toBe("00:00");
            expect(normalizeReminderTime("invalid_time")).toBeNull();
        });

        it("isCompoundOrMultiAction should detect complex multi-intent requests and bypass single regexes", () => {
            const prompt1 = "Hey Friday, I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes.";
            expect(isCompoundOrMultiAction(prompt1)).toBe(true);

            const prompt2 = "I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes.";
            expect(isCompoundOrMultiAction(prompt2)).toBe(true);

            const prompt3 = "Done fixed checkout bug, and remind me at 5pm to deploy to staging";
            expect(isCompoundOrMultiAction(prompt3)).toBe(true);

            // Single intents should NOT trigger compound routing
            expect(isCompoundOrMultiAction("5 coffee")).toBe(false);
            expect(isCompoundOrMultiAction("remind 17:30 Bring lunch box")).toBe(false);
            expect(isCompoundOrMultiAction("done wrote documentation")).toBe(false);
        });

        it("buildSmartLocalFallback should parse compound queries into multiple discrete system actions", () => {
            const query = "I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes.";
            const fallback = buildSmartLocalFallback(query, { displayCurrency: "USD" });

            expect(fallback.actions.length).toBe(3);
            expect(fallback.actions[0]).toEqual({
                type: "add_expense",
                amount: 8.5,
                currency: "USD",
                category: "Food"
            });
            expect(fallback.actions[1]).toEqual({
                type: "add_reminder",
                time: "15:30",
                title: "review the design file",
                frequency: "once"
            });
            expect(fallback.actions[2]).toEqual({
                type: "add_memory",
                fact: "she loves matcha lattes",
                category: "preference"
            });

            expect(fallback.reply).toContain("All three taken care of, Boss");
            expect(fallback.voice_summary).toContain("All three taken care of Boss");
        });

        it("handleAiCopilotQuery should execute all multi-action tools and reply cleanly", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const executedSql = [];
            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockImplementation((sql) => {
                    executedSql.push(sql);
                    return {
                        bind: vi.fn().mockReturnValue({
                            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
                            first: vi.fn().mockResolvedValue(null),
                            all: vi.fn().mockResolvedValue({ results: [] })
                        })
                    };
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            const query = "Hey Friday, I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes.";
            await handleAiCopilotQuery(mockEnv, 123456, "849550186", query, { id: 849550186, first_name: "Boss" });

            // 1. Should insert into expenses
            const hasExpenseInsert = executedSql.some(sql => sql.includes("INSERT INTO expenses"));
            expect(hasExpenseInsert).toBe(true);

            // 2. Should insert into reminders
            const hasReminderInsert = executedSql.some(sql => sql.includes("INSERT INTO reminders"));
            expect(hasReminderInsert).toBe(true);

            // 3. Should save to user_memories
            const hasMemoryInsert = executedSql.some(sql => sql.includes("user_memories"));
            expect(hasMemoryInsert).toBe(true);

            // 4. Should confirm via Telegram sendMessage
            expect(fetchSpy).toHaveBeenCalled();
            const sendMessageCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text !== undefined;
            });
            expect(sendMessageCall).toBeDefined();
            const payload = JSON.parse(sendMessageCall[1].body);
            expect(payload.text).toContain("All three taken care of, Boss");

            fetchSpy.mockRestore();
        });
    });

    describe("Real-Time Live Google Search Grounding", () => {
        it("isRealTimeSearchQuery should detect weather, sports, crypto, news, and search commands", () => {
            expect(isRealTimeSearchQuery("/search what is the weather today")).toBe(true);
            expect(isRealTimeSearchQuery("/weather")).toBe(true);
            expect(isRealTimeSearchQuery("/google bitcoin price")).toBe(true);
            expect(isRealTimeSearchQuery("/web who won premier league")).toBe(true);

            expect(isRealTimeSearchQuery("Is it going to rain this afternoon?")).toBe(true);
            expect(isRealTimeSearchQuery("What is the weather in Phnom Penh right now?")).toBe(true);
            expect(isRealTimeSearchQuery("What is the Bitcoin price today?")).toBe(true);
            expect(isRealTimeSearchQuery("Who won the Arsenal match last night?")).toBe(true);
            expect(isRealTimeSearchQuery("Latest tech news in Cambodia")).toBe(true);
            expect(isRealTimeSearchQuery("What movies are playing at Legend Cinema?")).toBe(true);

            // Internal ledger / task queries must NOT be classified as web searches
            expect(isRealTimeSearchQuery("5 coffee")).toBe(false);
            expect(isRealTimeSearchQuery("remind 17:30 Bring lunch box")).toBe(false);
            expect(isRealTimeSearchQuery("done fixed checkout bug")).toBe(false);
            expect(isRealTimeSearchQuery("how much did I spend today")).toBe(false);
            expect(isRealTimeSearchQuery("can I afford a 50$ dinner")).toBe(false);
        });

        it("extractGroundingSources should deduplicate and truncate source URLs into clean citations", () => {
            const mockMetadata = {
                groundingChunks: [
                    { web: { uri: "https://weather.com/phnom-penh", title: "Weather.com: Phnom Penh Forecast" } },
                    { web: { uri: "https://weather.com/phnom-penh", title: "Duplicate URL should be skipped" } },
                    { web: { uri: "https://accuweather.com/en/kh", title: "AccuWeather Live Real-Time Weather in Cambodia" } }
                ]
            };

            const sources = extractGroundingSources(mockMetadata);
            expect(sources.length).toBe(2);
            expect(sources[0].url).toBe("https://weather.com/phnom-penh");
            expect(sources[0].title).toBe("Weather.com: Phnom Penh For...");
            expect(sources[1].url).toBe("https://accuweather.com/en/kh");
        });

        it("askGeminiWithGoogleSearch should format answer with live search citations", async () => {
            const mockGeminiResponse = {
                candidates: [
                    {
                        content: {
                            parts: [
                                { text: "Phnom Penh is currently **31°C** with sunny skies and a light breeze, Boss." }
                            ]
                        },
                        groundingMetadata: {
                            webSearchQueries: ["phnom penh weather right now"],
                            groundingChunks: [
                                { web: { uri: "https://weather.com/kh", title: "Weather.com" } }
                            ]
                        }
                    }
                ]
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify(mockGeminiResponse), { status: 200 }))
            );

            const result = await askGeminiWithGoogleSearch(
                { GEMINI_API_KEY: "fake_key", GEMINI_MODEL: "gemini-3.8-flash" },
                "What is the weather in Phnom Penh right now?"
            );

            expect(result).toBeDefined();
            expect(result.reply).toContain("31°C");
            expect(result.reply).toContain("🌐 *Live Sources:* [Weather.com](https://weather.com/kh)");
            expect(result.voice_summary).toContain("31°C");
            expect(result.sources.length).toBe(1);

            fetchSpy.mockRestore();
        });

        it("handleRealTimeSearchCommand should deliver live search telemetry and support voice output", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                const urlStr = typeof url === "string" ? url : "";
                if (urlStr.includes("generativelanguage.googleapis.com")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: { parts: [{ text: "Bitcoin is currently trading at **$80,250**, Boss." }] },
                            groundingMetadata: {
                                groundingChunks: [{ web: { uri: "https://binance.com", title: "Binance Feed" } }]
                            }
                        }]
                    }), { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
            });

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ voice_mode: "off" }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                GEMINI_API_KEY: "mock_key"
            };

            await handleRealTimeSearchCommand(
                mockEnv,
                123456,
                "849550186",
                "What is the Bitcoin price right now?",
                { chat: { id: 123456 } }
            );

            expect(fetchSpy).toHaveBeenCalled();
            const sendMessageCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text !== undefined;
            });
            expect(sendMessageCall).toBeDefined();
            const payload = JSON.parse(sendMessageCall[1].body);
            expect(payload.text).toContain("Bitcoin is currently trading at");
            expect(payload.text).toContain("Binance Feed");

            fetchSpy.mockRestore();
        });
    });

    describe("Webhook Security & Secret Verification", () => {
        it("should reject webhook request if WEBHOOK_SECRET is set but header is missing", async () => {
            const req = new Request("https://cashflow.workers.dev/webhook", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ update_id: 1 })
            });

            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                WEBHOOK_SECRET: "super_secret_token"
            };

            const res = await worker.fetch(req, env, {});
            expect(res.status).toBe(401);
            const data = await res.json();
            expect(data.error).toBe("Unauthorized");
        });

        it("should reject webhook request if header does not match WEBHOOK_SECRET", async () => {
            const req = new Request("https://cashflow.workers.dev/webhook", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Telegram-Bot-Api-Secret-Token": "wrong_secret"
                },
                body: JSON.stringify({ update_id: 1 })
            });

            const env = {
                TELEGRAM_BOT_TOKEN: "mock_token",
                WEBHOOK_SECRET: "super_secret_token"
            };

            const res = await worker.fetch(req, env, {});
            expect(res.status).toBe(401);
        });

        it("should allow webhook request if header matches WEBHOOK_SECRET", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const req = new Request("https://cashflow.workers.dev/webhook", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Telegram-Bot-Api-Secret-Token": "super_secret_token"
                },
                body: JSON.stringify({ update_id: 999999, message: { chat: { id: 123456 }, from: { id: 849550186 }, text: "/unknown" } })
            });

            const env = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                WEBHOOK_SECRET: "super_secret_token",
                ALLOWED_USER_IDS: "849550186"
            };

            const res = await worker.fetch(req, env, {});
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.ok).toBe(true);

            fetchSpy.mockRestore();
        });
    });

    describe("AI Conversational Personality vs System Dashboard", () => {
        it("isConversationalOrCorrection should identify greetings and small talk", () => {
            expect(isConversationalOrCorrection("hi")).toBe(true);
            expect(isConversationalOrCorrection("hello")).toBe(true);
            expect(isConversationalOrCorrection("hey")).toBe(true);
            expect(isConversationalOrCorrection("good morning")).toBe(true);
            expect(isConversationalOrCorrection("good afternoon")).toBe(true);
            expect(isConversationalOrCorrection("how are you today?")).toBe(true);
            expect(isConversationalOrCorrection("yo")).toBe(true);

            // System menu / ledger commands must not be identified as greetings
            expect(isConversationalOrCorrection("menu")).toBe(false);
            expect(isConversationalOrCorrection("hub")).toBe(false);
            expect(isConversationalOrCorrection("5 coffee")).toBe(false);
            expect(isConversationalOrCorrection("+500 salary")).toBe(false);
        });

        it("handleMessage should answer 'hi' with conversational AI instead of system dashboard buttons", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                const urlStr = typeof url === "string" ? url : "";
                if (urlStr.includes("generativelanguage.googleapis.com")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [{ text: JSON.stringify({ reply: "Good afternoon, Boss! How are things going with you today?", voice_summary: "Good afternoon Boss!" }) }]
                            }
                        }]
                    }), { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
            });

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ voice_mode: "off" }),
                        all: vi.fn().mockResolvedValue({ results: [] }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                GEMINI_API_KEY: "mock_gemini_key",
                ALLOWED_USER_IDS: "849550186"
            };

            await handleMessage(
                { chat: { id: 123456, type: "private" }, from: { id: 849550186, first_name: "Tra" }, text: "hi" },
                mockEnv,
                "https://cashflow.workers.dev"
            );

            expect(fetchSpy).toHaveBeenCalled();
            const sendMessageCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text !== undefined;
            });
            expect(sendMessageCall).toBeDefined();
            const payload = JSON.parse(sendMessageCall[1].body);

            // Must NOT contain system dashboard text or buttons
            expect(payload.text).toContain("Good afternoon, Boss!");
            expect(payload.text).not.toContain("Ledger: +");
            expect(payload.text).not.toContain("Work Done:");
            expect(payload.reply_markup?.inline_keyboard?.[0]?.[0]?.text).not.toBe("⚡ Daily Briefing");

            fetchSpy.mockRestore();
        });
    });

    describe("Dynamic User Management & Guest Persona Separation", () => {
        it("isOwner should strictly identify owner ID 849550186", () => {
            expect(isOwner("849550186")).toBe(true);
            expect(isOwner(849550186)).toBe(true);
            expect(isOwner("999999999")).toBe(false);
            expect(isOwner(null)).toBe(false);
        });

        it("isUserAuthorizedAsync should authorize active guests from D1 and block revoked users", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn((uid) => ({
                        first: vi.fn().mockImplementation(async () => {
                            if (uid === "777777") return { status: "active" };
                            if (uid === "888888") return { status: "revoked" };
                            return null;
                        })
                    }))
                })
            };

            const env = { ALLOWED_USER_IDS: "849550186" };

            // Owner is always authorized
            expect(await isUserAuthorizedAsync(mockDb, "849550186", env)).toBe(true);

            // Active guest is authorized via D1
            expect(await isUserAuthorizedAsync(mockDb, "777777", env)).toBe(true);

            // Revoked guest is rejected
            expect(await isUserAuthorizedAsync(mockDb, "888888", env)).toBe(false);

            // Unknown user is rejected
            expect(await isUserAuthorizedAsync(mockDb, "123456", env)).toBe(false);
        });

        it("buildCopilotPrompt should tailor persona: 'Boss' for owner vs friendly name for guest (never 'Boss')", () => {
            // 1. Owner Prompt
            const ownerPrompt = buildCopilotPrompt("What's up?", { isOwner: true, userName: "Boss" });
            expect(ownerPrompt).toContain("Boss's exceptionally smart, loyal, high-EQ personal AI executive assistant");
            expect(ownerPrompt).toContain("Address the user with loyalty and executive warmth as 'Boss'");
            expect(ownerPrompt).not.toContain("NEVER call this user \"Boss\"");

            // 2. Guest Prompt (e.g. Jinie)
            const guestPrompt = buildCopilotPrompt("How is the weather?", { isOwner: false, userName: "Jinie" });
            expect(guestPrompt).toContain("The user chatting with you is 'Jinie'");
            expect(guestPrompt).toContain("NEVER call this user \"Boss\"");
            expect(guestPrompt).toContain("Do NOT mention Boss's personal finances");
            expect(guestPrompt).not.toContain("Boss's exceptionally smart, loyal");
        });

        it("handleCallback should allow unauthorized guest to trigger request_access and notify Boss", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186",
                OWNER_ID: "849550186"
            };

            await handleCallback(
                {
                    id: "cb_req_1",
                    data: "request_access:987654321",
                    from: { id: 987654321, first_name: "Jinie", username: "jinie_t" },
                    message: { chat: { id: 987654321 }, message_id: 111 }
                },
                mockEnv,
                "https://cashflow.workers.dev"
            );

            expect(fetchSpy).toHaveBeenCalled();
            // Boss should have received a notification with approval buttons
            const bossNotification = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.chat_id === "849550186" && body.text?.includes("New Access Request Received");
            });
            expect(bossNotification).toBeDefined();
            const payload = JSON.parse(bossNotification[1].body);
            expect(payload.text).toContain("Jinie");
            expect(payload.text).toContain("987654321");
            expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("approve_user:987654321");

            fetchSpy.mockRestore();
        });

        it("handleCallback should allow Boss to approve guest with 1-tap and notify the guest", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ user_id: "987654321", first_name: "Jinie", username: "jinie_t" }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186",
                OWNER_ID: "849550186"
            };

            // Boss taps approve
            await handleCallback(
                {
                    id: "cb_app_1",
                    data: "approve_user:987654321",
                    from: { id: 849550186, first_name: "Tra" },
                    message: { chat: { id: 849550186 }, message_id: 222 }
                },
                mockEnv,
                "https://cashflow.workers.dev"
            );

            expect(fetchSpy).toHaveBeenCalled();
            // Guest should receive welcome message
            const guestWelcome = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.chat_id === "987654321" && body.text?.includes("Welcome to F.R.I.D.A.Y.!");
            });
            expect(guestWelcome).toBeDefined();
            const payload = JSON.parse(guestWelcome[1].body);
            expect(payload.text).toContain("Boss has approved your access");

            fetchSpy.mockRestore();
        });
    });
});
