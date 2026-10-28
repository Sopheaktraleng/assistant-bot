import { describe, it, expect, vi } from "vitest";
import { GEMINI_MODELS, isUserAuthorized, isUserAuthorizedAsync, isOwner, OWNER_USER_ID, getAllowedUserIds, DEFAULT_ALLOWED_USERS } from "../src/config/constants.js";
import { addOrUpdateAuthorizedUser, listAuthorizedUsers, setAuthorizedUserStatus, getBudgetStatus, searchLedger, addExpenseRecord } from "../src/db/queries.js";
import { normalizeReminderTime } from "../src/utils/time.js";
import { isCompoundOrMultiAction, isRealTimeSearchQuery, isConversationalOrCorrection } from "../src/utils/natural.js";
import { buildSmartLocalFallback, handleAiCopilotQuery } from "../src/modules/copilot/handler.js";
import { parseCopilotResponse, buildCopilotPrompt, extractGroundingSources, getLiveRealtimeFallback, askGeminiWithGoogleSearch } from "../src/services/ai.js";
import { ensureTables, resetTablesEnsuredForTest } from "../src/db/schema.js";
import { handleMessage, handleRealTimeSearchCommand } from "../src/handlers/message.js";
import worker from "../src/worker.js";
import { handleCallback } from "../src/handlers/callback.js";
import { answerCallback } from "../src/services/telegram.js";
import { sendRemindersMenu, sendPromptAddReminder, sendReminderTimeMenu, sendFocusMenu } from "../src/modules/reminders/views.js";
import { parseReminderInput } from "../src/modules/reminders/commands.js";
import { sendMainHub, sendSettingsMenu } from "../src/modules/hub/views.js";
import { sendFinanceHub, sendCategoryPicker, sendTransactions } from "../src/modules/finance/views.js";
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
            expect(payload.text).toContain("Reminders & Alerts");
            expect(payload.text).toContain("Team sync with designer");

            // Verify clean buttons exist with less clutter: Quick Timers & Focus Sprint
            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("⏱️ Quick Timers");
            expect(buttonTexts).toContain("🎯 Focus Sprint");
            expect(buttonTexts).toContain("🏠 Main Hub");
            expect(buttonTexts.some(t => t.includes("Team sync"))).toBe(true);
            expect(buttonTexts.some(t => t.includes("Standup"))).toBe(false);

            fetchSpy.mockRestore();
        });

        it("should render clean Focus Sprint menu with Pomodoro and Deep Work blocks", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendFocusMenu(mockEnv, 123456);

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Focus & Deep Work Sprints");

            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("🍅 25m Focus");
            expect(buttonTexts).toContain("⚡ 50m Deep Work");
            expect(buttonTexts).toContain("☕ 10m Break");
            expect(buttonTexts).toContain("‹ Back to Reminders");

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
            expect(payload.text).toContain("Quick Timers");

            const buttonTexts = payload.reply_markup.inline_keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("⏱️ 15 Mins");
            expect(buttonTexts).toContain("⏱️ 30 Mins");
            expect(buttonTexts).toContain("⏱️ 1 Hour");
            expect(buttonTexts).toContain("⏱️ 2 Hours");
            expect(buttonTexts).toContain("‹ Back to Reminders");

            fetchSpy.mockRestore();
        });

        it("should parse natural date, relative time, and calendar day reminders in parseReminderInput", () => {
            const fakeNow = new Date("2026-10-28T09:00:00+07:00");

            // 1. Calendar day e.g. "on 30th at 8am Take the ice"
            const p1 = parseReminderInput("on 30th at 8am to take the ice", fakeNow);
            expect(p1.targetDateStr).toBe("2026-10-30");
            expect(p1.timeStr).toBe("08:00");
            expect(p1.title).toBe("Take the ice");
            expect(p1.frequency).toBe("once");

            // 2. Calendar day without time defaults to 09:00
            const p2 = parseReminderInput("remind me to take the ice on 30th", fakeNow);
            expect(p2.targetDateStr).toBe("2026-10-30");
            expect(p2.timeStr).toBe("09:00");
            expect(p2.title).toBe("Take the ice");

            // 3. Relative timer: "in 20m check oven"
            const p3 = parseReminderInput("in 20m Check oven", fakeNow);
            expect(p3.isRelative).toBe(true);
            expect(p3.mins).toBe(20);
            expect(p3.title).toBe("Check oven");
            expect(p3.frequency).toBe("once");

            // 4. Daily recurring time: "17:30 bring lunch box"
            const p4 = parseReminderInput("17:30 Bring lunch box", fakeNow);
            expect(p4.timeStr).toBe("17:30");
            expect(p4.targetDateStr).toBeNull();
            expect(p4.title).toBe("Bring lunch box");
            expect(p4.frequency).toBe("daily");
        });

        it("should render clean symmetrical 3-row System Settings menu without redundant user access", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ display_currency: "USD", monthly_budget: 0, voice_mode: "off" })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendSettingsMenu(mockEnv, 123456, "849550186");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("System Settings");

            const keyboard = payload.reply_markup.inline_keyboard;
            // Exactly 3 rows
            expect(keyboard.length).toBe(3);
            // Exactly 2 buttons per row
            expect(keyboard[0].length).toBe(2);
            expect(keyboard[1].length).toBe(2);
            expect(keyboard[2].length).toBe(2);

            const buttonTexts = keyboard.flat().map(b => b.text);
            expect(buttonTexts).toContain("💱 Currency: USD");
            expect(buttonTexts).toContain("🎙️ Voice: OFF");
            expect(buttonTexts).toContain("🎯 Set Budget");
            expect(buttonTexts).toContain("📥 Export CSV");
            expect(buttonTexts).toContain("🗑️ Reset Data");
            expect(buttonTexts).toContain("🏠 Main Hub");
            expect(buttonTexts.some(t => t.includes("Manage Users"))).toBe(false);

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

        it("askGeminiWithGoogleSearch should fallback to web crawler when google_search tool encounters 429", async () => {
            const mockNewsXml = `
                <rss version="2.0">
                    <channel>
                        <item>
                            <title>Harry Kane wins 2026 Ballon d'Or award in London</title>
                            <link>https://example.com/ballon-dor</link>
                        </item>
                    </channel>
                </rss>
            `;

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) => {
                const urlStr = typeof url === "string" ? url : "";
                // 1. Gemini with google_search tool returns 429
                if (urlStr.includes("generativelanguage.googleapis.com") && opts?.body?.includes("google_search")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        error: { code: 429, message: "Resource exhausted" }
                    }), { status: 429 }));
                }
                // 2. Google News search crawler returns RSS results
                if (urlStr.includes("news.google.com")) {
                    return Promise.resolve(new Response(mockNewsXml, { status: 200 }));
                }
                // 3. Gemini text synthesis (without google_search tool) succeeds
                if (urlStr.includes("generativelanguage.googleapis.com")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: { parts: [{ text: "Boss, **Harry Kane** won the 2026 Ballon d'Or in London." }] }
                        }]
                    }), { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            });

            const result = await askGeminiWithGoogleSearch(
                { GEMINI_API_KEY: "test_key" },
                "who won ballor'dor in 2026",
                { isOwner: true }
            );

            expect(result).toBeDefined();
            expect(result.reply).toContain("Harry Kane");
            expect(result.reply).toContain("🌐 *Live Sources:*");
            expect(result.sources.length).toBeGreaterThan(0);

            fetchSpy.mockRestore();
        });

        it("searchLiveWeb should sanitize query and parse Wikipedia and Google News results", async () => {
            const mockWikiSearch = {
                query: {
                    search: [{ title: "2024 Ballon d'Or" }]
                }
            };
            const mockWikiExtract = {
                query: {
                    pages: {
                        "123": {
                            title: "2024 Ballon d'Or",
                            extract: "Rodri and Aitana Bonmati claimed top prizes in Paris."
                        }
                    }
                }
            };

            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                const urlStr = typeof url === "string" ? url : "";
                if (urlStr.includes("action=query") && urlStr.includes("list=search")) {
                    return Promise.resolve(new Response(JSON.stringify(mockWikiSearch), { status: 200 }));
                }
                if (urlStr.includes("action=query") && urlStr.includes("prop=extracts")) {
                    return Promise.resolve(new Response(JSON.stringify(mockWikiExtract), { status: 200 }));
                }
                return Promise.resolve(new Response("", { status: 200 }));
            });

            const { searchLiveWeb, sanitizeSearchQuery } = await import("../src/services/ai.js");
            expect(sanitizeSearchQuery("who won ballor'dor in 2024")).toBe("Ballon d'Or in 2024");

            const results = await searchLiveWeb("who won ballor'dor in 2024", 5);

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].title).toBe("2024 Ballon d'Or - Wikipedia");
            expect(results[0].snippet).toContain("Rodri and Aitana Bonmati");
            expect(results[0].source).toBe("Wikipedia");

            fetchSpy.mockRestore();
        });
    });

    describe("Webhook Security & Secret Verification", () => {
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

    describe("Finance System Upgrades (Phases 1-3)", () => {
        it("getBudgetStatus should calculate visual progress bar and safe daily spend rate", async () => {
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            first: vi.fn().mockImplementation(async () => {
                                if (sql.includes("monthly_budget")) return { monthly_budget: 4000000 };
                                if (sql.includes("display_currency")) return { display_currency: "USD" };
                                return null;
                            }),
                            all: vi.fn().mockImplementation(async () => {
                                if (sql.includes("FROM expenses")) {
                                    return { results: [{ total: 420, currency: "USD", type: "expense" }] };
                                }
                                return { results: [] };
                            })
                        })
                    };
                })
            };

            const status = await getBudgetStatus(mockDb, "user_1");
            expect(status).not.toBeNull();
            expect(status.percent).toBe(42);
            expect(status.bar).toBe("▓▓▓▓░░░░░░");
            expect(status.spentStr).toBe("$420");
            expect(status.budgetStr).toBe("$1,000");
            expect(status.daysRemaining).toBeGreaterThanOrEqual(1);
            expect(status.safeDailyStr).toContain("$");
            expect(status.isOver).toBe(false);
        });

        it("searchLedger should filter transactions by keyword query matching merchant or note", async () => {
            const captured = {};
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    captured.sql = sql;
                    return {
                        bind: vi.fn().mockImplementation((...args) => {
                            captured.args = args;
                            return {
                                all: vi.fn().mockResolvedValue({
                                    results: [
                                        { id: 10, date: "2026-10-27", amount: 5, currency: "USD", category: "Coffee", merchant: "Starbucks", note: "Latte" }
                                    ]
                                })
                            };
                        })
                    };
                })
            };

            const result = await searchLedger(mockDb, "user_1", { query: "starbucks" });
            expect(captured.sql).toContain("LOWER(COALESCE(merchant, '')) LIKE ?");
            expect(captured.args).toContain("%starbucks%");
            expect(result.count).toBe(1);
            expect(result.transactions[0].merchant).toBe("Starbucks");
        });

        it("handleCallback should handle undo_tx and remove transaction cleanly", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            first: vi.fn().mockResolvedValue({ id: 99, amount: 5, category: "Coffee", type: "expense", currency: "USD", date: "2026-10-27" }),
                            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                        })
                    };
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
                    id: "cb_undo_1",
                    data: "undo_tx:99",
                    from: { id: 849550186, first_name: "Boss" },
                    message: { chat: { id: 849550186 }, message_id: 333 }
                },
                mockEnv,
                "https://cashflow.workers.dev"
            );

            expect(fetchSpy).toHaveBeenCalled();
            const editCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("Undone");
            });
            expect(editCall).toBeDefined();

            fetchSpy.mockRestore();
        });

        it("sendMainHub should render streamlined hub buttons without redundant Daily Briefing button", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ count: 5 }),
                        all: vi.fn().mockResolvedValue({ results: [] })
                    }),
                    first: vi.fn().mockResolvedValue(null),
                    all: vi.fn().mockResolvedValue([])
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186",
                OWNER_ID: "849550186"
            };

            await sendMainHub(mockEnv, 849550186, 849550186, { first_name: "Boss" }, "https://cashflow.workers.dev");

            expect(fetchSpy).toHaveBeenCalled();
            const hubCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("F.R.I.D.A.Y.");
            });
            expect(hubCall).toBeDefined();

            const payload = JSON.parse(hubCall[1].body);
            const keyboard = payload.reply_markup?.inline_keyboard;
            expect(keyboard).toBeDefined();

            // Flat check: NO daily_briefing button anywhere
            const allButtons = keyboard.flat();
            const dailyBriefingBtn = allButtons.find(b => b.callback_data === "daily_briefing");
            expect(dailyBriefingBtn).toBeUndefined();

            // Row 1 should be core hubs (Finance & Tasks)
            expect(keyboard[0][0].callback_data).toBe("finance_hub");
            expect(keyboard[0][1].callback_data).toBe("tasks_today");

            // Row 2 should be Reminders & Help
            expect(keyboard[1][0].callback_data).toBe("reminders");
            expect(keyboard[1][1].callback_data).toBe("help");

            // Row 3 for owner should be Settings & User Access
            expect(keyboard[2][0].callback_data).toBe("settings");
            expect(keyboard[2][1].callback_data).toBe("manage_users");
            expect(keyboard[2][1].text).toBe("👥 User Access");

            fetchSpy.mockRestore();
        });

        it("sendFinanceHub should render data telemetry buttons instead of clunky category pickers", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        all: vi.fn().mockResolvedValue({ results: [] })
                    }),
                    first: vi.fn().mockResolvedValue(null),
                    all: vi.fn().mockResolvedValue([])
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            await sendFinanceHub(mockEnv, 849550186, 849550186);

            expect(fetchSpy).toHaveBeenCalled();
            const hubCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("Finance & Cashflow");
            });
            expect(hubCall).toBeDefined();

            const payload = JSON.parse(hubCall[1].body);
            const keyboard = payload.reply_markup?.inline_keyboard;
            expect(keyboard).toBeDefined();

            // Flat check: NO add_expense or add_income buttons
            const allButtons = keyboard.flat();
            expect(allButtons.find(b => b.callback_data === "add_expense")).toBeUndefined();
            expect(allButtons.find(b => b.callback_data === "add_income")).toBeUndefined();

            // Row 1: Today's Ledger & Monthly Insights
            expect(keyboard[0][0].callback_data).toBe("view_transactions");
            expect(keyboard[0][1].callback_data).toBe("summary_month");

            // Row 2: All History & Export CSV
            expect(keyboard[1][0].callback_data).toBe("view_history");
            expect(keyboard[1][1].callback_data).toBe("export_csv");

            // Row 3: Back to Main Hub
            expect(keyboard[2][0].callback_data).toBe("hub");

            fetchSpy.mockRestore();
        });

        it("sendCategoryPicker should render 1-tap recent favorites and presets for both expense and income", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { category: "Coffee", amount: 3.5, currency: "USD", merchant: "Brown Coffee", freq: 5, last_id: 101 },
                                { category: "Lunch", amount: 4.5, currency: "USD", merchant: "Park Cafe", freq: 3, last_id: 102 }
                            ]
                        })
                    }),
                    first: vi.fn().mockResolvedValue(null),
                    all: vi.fn().mockResolvedValue({ results: [] })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            // 1. Test Expense
            await sendCategoryPicker(mockEnv, 849550186, "expense", null, 849550186);

            expect(fetchSpy).toHaveBeenCalled();
            const expCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("Add Expense");
            });
            expect(expCall).toBeDefined();

            const expPayload = JSON.parse(expCall[1].body);
            expect(expPayload.text).toContain("Add Expense");
            expect(expPayload.text).toContain("Choose a quick preset below, or simply type / voice what you spent.");
            expect(expPayload.text).not.toContain("• `5 coffee`");
            expect(expPayload.text).not.toContain("💡 *Tip:*");
            const expKeyboard = expPayload.reply_markup?.inline_keyboard;
            expect(expKeyboard).toBeDefined();

            // First favorite should be Brown Coffee with relog_tx:101
            expect(expKeyboard[0][0].callback_data).toBe("relog_tx:101");
            expect(expKeyboard[0][0].text).toContain("$3.50");
            expect(expKeyboard[0][0].text).toContain("Brown Coffee");
            expect(expKeyboard[0][0].text).not.toContain("1-Tap");

            // Navigation at bottom
            const lastRow = expKeyboard[expKeyboard.length - 1];
            expect(lastRow[0].callback_data).toBe("finance_hub");
            expect(lastRow[1].callback_data).toBe("hub");

            // 2. Test Income Option 1 text
            await sendCategoryPicker(mockEnv, 849550186, "income", null, 849550186);
            const incCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("Add Income");
            });
            expect(incCall).toBeDefined();
            const incPayload = JSON.parse(incCall[1].body);
            expect(incPayload.text).toContain("Add Income");
            expect(incPayload.text).toContain("Choose a quick preset below, or simply type / voice what you earned.");
            expect(incPayload.text).not.toContain("💡 *Tip:*");

            fetchSpy.mockRestore();
        });

        it("handleCallback should handle relog_tx and relog_def to record 1-tap transactions", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({
                            amount: 3.5,
                            category: "Coffee",
                            type: "expense",
                            currency: "USD",
                            merchant: "Brown Coffee"
                        }),
                        all: vi.fn().mockResolvedValue({ results: [] }),
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 202 } })
                    }),
                    first: vi.fn().mockResolvedValue(null),
                    all: vi.fn().mockResolvedValue({ results: [] }),
                    run: vi.fn().mockResolvedValue({ meta: { last_row_id: 202 } })
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                ALLOWED_USER_IDS: "849550186",
                OWNER_ID: "849550186"
            };

            // Test relog_tx
            await handleCallback(
                {
                    id: "cb_relog_1",
                    data: "relog_tx:101",
                    from: { id: 849550186, first_name: "Boss" },
                    message: { chat: { id: 849550186 }, message_id: 555 }
                },
                mockEnv,
                "https://cashflow.workers.dev"
            );

            expect(fetchSpy).toHaveBeenCalled();
            const receiptCall = fetchSpy.mock.calls.find(c => {
                const body = JSON.parse(c[1]?.body || "{}");
                return body.text?.includes("Expense Recorded");
            });
            expect(receiptCall).toBeDefined();

            fetchSpy.mockRestore();
        });

        it("sendTransactions should render modern Option 1 ledger UI with spending focus, clean items, and friendly undo button", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            first: vi.fn().mockResolvedValue({ display_currency: "USD" }),
                            all: vi.fn().mockResolvedValue({
                                results: [
                                    {
                                        id: 42,
                                        amount: 5000,
                                        category: "Food",
                                        type: "expense",
                                        currency: "KHR",
                                        merchant: "Burger Joint",
                                        created_at: "2026-10-28 12:33:00"
                                    }
                                ]
                            })
                        })
                    };
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            await sendTransactions(mockEnv, 849550186, 849550186);

            expect(fetchSpy).toHaveBeenCalled();
            const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
            const body = JSON.parse(lastCall[1].body);

            // Verify clean header and ledger text
            expect(body.text).toContain("📋 *Today's Ledger*");
            // Category & icon lead, amount formatted cleanly without multiple dots
            expect(body.text).toContain("🍔 *Food* (Burger Joint)  `-$1.25`");
            expect(body.text).toContain("(5,000 ៛)");

            // Normal day spending summary (no false income: $0 or false in the red)
            expect(body.text).toContain("💸 *Total Spent Today:* `$1.25` _(1 entry)_");
            expect(body.text).not.toContain("Income:");
            expect(body.text).not.toContain("in the red");

            // Buttons: Pure minimalist 3x2 grid (no undo button in UI)
            const buttons = body.reply_markup.inline_keyboard.flat();
            expect(buttons.some(b => b.text === "🧾 + Expense")).toBe(true);
            expect(buttons.some(b => b.text === "💰 + Income")).toBe(true);
            expect(buttons.some(b => b.text === "📊 Month Insights")).toBe(true);
            expect(buttons.some(b => b.text === "📜 History")).toBe(true);
            expect(buttons.some(b => b.text === "‹ Back to Finance")).toBe(true);
            expect(buttons.some(b => b.text === "🏠 Main Hub")).toBe(true);
            expect(buttons.some(b => b.text.includes("Undo"))).toBe(false);

            fetchSpy.mockRestore();
        });

        it("sendTransactions should show Daily Net when income exists today", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            first: vi.fn().mockResolvedValue({ display_currency: "USD" }),
                            all: vi.fn().mockResolvedValue({
                                results: [
                                    {
                                        id: 1,
                                        amount: 500,
                                        category: "Salary",
                                        type: "income",
                                        currency: "USD",
                                        created_at: "2026-10-28 09:00:00"
                                    },
                                    {
                                        id: 2,
                                        amount: 25,
                                        category: "Food",
                                        type: "expense",
                                        currency: "USD",
                                        created_at: "2026-10-28 12:00:00"
                                    }
                                ]
                            })
                        })
                    };
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            await sendTransactions(mockEnv, 849550186, 849550186);

            const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
            const body = JSON.parse(lastCall[1].body);

            expect(body.text).toContain("💵 *Income:* `+$500.00`");
            expect(body.text).toContain("💸 *Spent:*  `$25.00`");
            expect(body.text).toContain("💳 *Daily Net:* `+$475.00` 🟢");

            fetchSpy.mockRestore();
        });

        it("handleUndoLastTransaction should restrict guests and only allow Boss to undo transactions", async () => {
            const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => {
                    return {
                        bind: vi.fn().mockReturnValue({
                            first: vi.fn().mockResolvedValue({
                                id: 88,
                                amount: 2.5,
                                category: "Coffee",
                                type: "expense",
                                currency: "USD",
                                date: "2026-10-28"
                            }),
                            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                        })
                    };
                })
            };

            const mockEnv = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                OWNER_ID: "849550186"
            };

            const guestUserId = 999888777; // Guest
            const guestMessage = {
                from: { id: guestUserId, first_name: "Sarah" }
            };

            const { handleUndoLastTransaction } = await import("../src/handlers/message.js");

            // 1. Guest attempt should be rejected with polite access notice
            await handleUndoLastTransaction(mockEnv, guestUserId, guestUserId, "coffee", guestMessage);
            const guestCall = fetchSpy.mock.calls[0];
            const guestBody = JSON.parse(guestCall[1].body);
            expect(guestBody.text).toContain("Access Restricted");
            expect(guestBody.text).toContain("Sarah");
            expect(guestBody.text).toContain("reserved for Boss");

            // 2. Boss attempt should succeed cleanly
            await handleUndoLastTransaction(mockEnv, 849550186, 849550186, "coffee", null);
            const bossCall = fetchSpy.mock.calls[1];
            const bossBody = JSON.parse(bossCall[1].body);
            expect(bossBody.text).toContain("Transaction Undone");
            expect(bossBody.text).toContain("Boss");
            expect(bossBody.text).toContain("$2.50");
            expect(bossBody.text).toContain("Coffee");

            fetchSpy.mockRestore();
        });
    });
});
