import { describe, it, expect, vi } from "vitest";
import { GEMINI_MODELS, isUserAuthorized, getAllowedUserIds, DEFAULT_ALLOWED_USERS } from "../src/config/constants.js";
import { normalizeReminderTime } from "../src/utils/time.js";
import { isCompoundOrMultiAction } from "../src/utils/natural.js";
import { buildSmartLocalFallback, handleAiCopilotQuery } from "../src/modules/copilot/handler.js";
import { parseCopilotResponse, buildCopilotPrompt } from "../src/services/ai.js";
import { ensureTables, resetTablesEnsuredForTest } from "../src/db/schema.js";
import { handleMessage } from "../src/handlers/message.js";
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
});
