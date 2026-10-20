import { describe, it, expect, vi } from "vitest";
import { GEMINI_MODELS } from "../src/config/constants.js";
import { ensureTables } from "../src/db/schema.js";
import { handleMessage } from "../src/handlers/message.js";
import { answerCallback } from "../src/services/telegram.js";

describe("Bot Improvements & Stability", () => {
    describe("AI Configuration", () => {
        it("should have valid, active Gemini production models ordered by speed", () => {
            expect(GEMINI_MODELS).toContain("gemini-3.5-flash-lite");
            expect(GEMINI_MODELS).toContain("gemini-3-flash-preview");
            expect(GEMINI_MODELS).toContain("gemini-3.5-flash");
            expect(GEMINI_MODELS[0]).toBe("gemini-3.5-flash-lite");
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

    describe("Database Optimization", () => {
        it("should execute ensureTables via db.batch in a single round-trip", async () => {
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
});
