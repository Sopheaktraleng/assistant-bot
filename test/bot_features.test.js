import { describe, it, expect, vi } from "vitest";
import { GEMINI_MODELS } from "../src/config/constants.js";
import { ensureTables, resetTablesEnsuredForTest } from "../src/db/schema.js";
import { handleMessage } from "../src/handlers/message.js";
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
});
