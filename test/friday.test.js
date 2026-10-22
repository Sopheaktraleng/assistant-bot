import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSpeechAudio, analyzeImageWithAi, buildCopilotPrompt } from "../src/services/ai.js";
import { sendTelegramVoice } from "../src/services/telegram.js";
import { sendFridayTacticalBriefing } from "../src/modules/copilot/briefing.js";
import { handleMessage } from "../src/handlers/message.js";
import { buildSmartLocalFallback } from "../src/modules/copilot/handler.js";

describe("F.R.I.D.A.Y. Tactical Assistant Engine", () => {
    let fetchSpy;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        if (fetchSpy) fetchSpy.mockRestore();
    });

    describe("Voice Synthesis (TTS) - generateSpeechAudio", () => {
        it("should synthesize speech audio buffer with cleaned text and English/British accent", async () => {
            const fakeAudioBuffer = new Uint8Array([0xFF, 0xFB, 0x90, 0x64]).buffer;
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(fakeAudioBuffer, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
            );

            const result = await generateSpeechAudio("**Boss**, *all systems* `green`! https://example.com", "en-gb");

            expect(fetchSpy).toHaveBeenCalled();
            const calledUrl = fetchSpy.mock.calls[0][0];
            expect(calledUrl).toContain("translate_tts");
            expect(calledUrl).toContain("tl=en-gb");
            expect(calledUrl).not.toContain("**");
            expect(calledUrl).not.toContain("example.com");
            expect(result).toBeInstanceOf(ArrayBuffer);
        });

        it("should auto-detect Khmer script and switch TTS language to 'km'", async () => {
            const fakeAudioBuffer = new Uint8Array([1, 2, 3]).buffer;
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(fakeAudioBuffer, { status: 200 })
            );

            await generateSpeechAudio("សួស្តី Boss ថ្ងៃនេះអ្នកចាយអស់ ៥ ដុល្លារ", "en-gb");

            expect(fetchSpy).toHaveBeenCalled();
            const calledUrl = fetchSpy.mock.calls[0][0];
            expect(calledUrl).toContain("tl=km");
        });

        it("should return null gracefully on network failure without throwing", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network timeout"));

            const result = await generateSpeechAudio("Systems check, Boss.");
            expect(result).toBeNull();
        });
    });

    describe("Telegram Voice Transmission - sendTelegramVoice", () => {
        it("should send voice via multipart sendVoice endpoint", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 })
            );

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            const fakeAudio = new Uint8Array([1, 2, 3, 4]).buffer;
            const res = await sendTelegramVoice(mockEnv, 123456, fakeAudio, "All systems operational, Boss.");

            expect(fetchSpy).toHaveBeenCalled();
            expect(fetchSpy.mock.calls[0][0]).toContain("/sendVoice");
            expect(res.ok).toBe(true);
        });

        it("should fallback to sendAudio if sendVoice endpoint fails", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response("Bad Request: unsupported voice format", { status: 400 }))
                .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 1000 } }), { status: 200 }));

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            const fakeAudio = new Uint8Array([1, 2, 3, 4]).buffer;
            const res = await sendTelegramVoice(mockEnv, 123456, fakeAudio, "Voice fallback test");

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(fetchSpy.mock.calls[1][0]).toContain("/sendAudio");
            expect(res.ok).toBe(true);
        });
    });

    describe("Multimodal Vision Analysis - analyzeImageWithAi", () => {
        it("should analyze image using Gemini multimodal API and return tactical explanation", async () => {
            const fakeGeminiResponse = {
                candidates: [
                    {
                        content: {
                            parts: [
                                { text: "Boss, line 42 has a syntax error: missing closing parenthesis." }
                            ]
                        }
                    }
                ]
            };

            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify(fakeGeminiResponse), { status: 200 })
            );

            const mockEnv = { GEMINI_API_KEY: "fake_gemini_key" };
            const result = await analyzeImageWithAi(mockEnv, "base64data", "image/png", "Explain this error");

            expect(fetchSpy).toHaveBeenCalled();
            expect(result).toContain("Boss, line 42 has a syntax error");
        });
    });

    describe("F.R.I.D.A.Y. Persona & Tactical Briefings", () => {
        it("buildCopilotPrompt should infuse F.R.I.D.A.Y. persona and address user as Boss", () => {
            const prompt = buildCopilotPrompt("Can I afford a $100 watch?", {
                currentDate: "2026-10-22",
                currentTime: "09:30",
                timezone: "Asia/Phnom_Penh",
                displayCurrency: "USD",
                summary: { totalExpenses: 200, totalIncome: 1000 }
            });

            expect(prompt).toContain("F.R.I.D.A.Y.");
            expect(prompt).toContain("Boss");
            expect(prompt).toContain("Financial Defense");
        });

        it("sendFridayTacticalBriefing should compile live metrics into structured briefing", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({ results: [] }),
                        first: vi.fn().mockResolvedValue({ total_amount: 50, count: 2 }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendFridayTacticalBriefing(mockEnv, 123456, "user_boss");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("F.R.I.D.A.Y. Tactical Briefing");
            expect(payload.text).toContain("All systems green, Boss");
            expect(payload.text).toContain("Financial Defense");
        });
    });

    describe("F.R.I.D.A.Y. Command Routing", () => {
        it("should route /friday and /briefing to tactical briefing handler", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({ results: [] }),
                        first: vi.fn().mockResolvedValue({ total_amount: 0, count: 0 }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/friday"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("F.R.I.D.A.Y. Tactical Briefing");
        });
    });

    describe("Smart Deterministic Fallback - buildSmartLocalFallback", () => {
        const mockContext = {
            displayCurrency: "USD",
            summary: { totalIncome: 1000, totalExpenses: 200 },
            todayExpenses: [{ amount: 15 }],
            todayWorkTasks: [{ time: "09:30", task: "Setup CI/CD pipeline" }],
            activeReminders: [{ title: "Team sync", reminder_time: "15:00" }]
        };

        it("should calculate affordability when user asks 'Can I afford $50' with positive balance", () => {
            const fallback = buildSmartLocalFallback("Can I afford a $50 dinner?", mockContext);
            expect(fallback.reply).toContain("Affirmative, Boss");
            expect(fallback.reply).toContain("$50");
            expect(fallback.voice_summary).toContain("safely afford 50 dollars");
        });

        it("should warn caution when purchase exceeds net balance", () => {
            const tightContext = {
                ...mockContext,
                summary: { totalIncome: 50, totalExpenses: 40 } // net balance is only $10
            };
            const fallback = buildSmartLocalFallback("Can I afford to buy $80 headphones?", tightContext);
            expect(fallback.reply).toContain("Caution, Boss");
            expect(fallback.voice_summary).toContain("Caution Boss");
        });

        it("should provide exact database expense telemetry when asked about spending", () => {
            const fallback = buildSmartLocalFallback("How much did I spend today?", mockContext);
            expect(fallback.reply).toContain("Local Expense Telemetry");
            expect(fallback.reply).toContain("$15");
            expect(fallback.voice_summary).toContain("spent 15 dollars");
        });

        it("should list tasks from database when asked about work or tasks", () => {
            const fallback = buildSmartLocalFallback("What tasks did I log today?", mockContext);
            expect(fallback.reply).toContain("Local Operations Telemetry");
            expect(fallback.reply).toContain("Setup CI/CD pipeline");
            expect(fallback.voice_summary).toContain("1 tasks logged");
        });
    });
});
