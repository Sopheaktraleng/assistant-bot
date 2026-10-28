import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSpeechAudio, analyzeImageWithAi, buildCopilotPrompt, buildGeminiContents, extractGeminiCandidateText, askAiCopilot } from "../src/services/ai.js";
import { sendTelegramVoice } from "../src/services/telegram.js";
import { sendFridayTacticalBriefing, sendFridayWakeupCall, sendDailyScheduledWakeup, getHumanWakeupFallback } from "../src/modules/copilot/briefing.js";
import { handleMessage, handleUndoLastTransaction } from "../src/handlers/message.js";
import { buildSmartLocalFallback } from "../src/modules/copilot/handler.js";
import {
    saveChatMessage,
    getRecentChatHistory,
    clearChatHistory,
    saveUserMemory,
    getUserMemories,
    deleteUserMemory,
    clearUserMemories,
    deleteLastTransaction,
    claimDailyBroadcast
} from "../src/db/queries.js";

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

        it("should chunk long multi-paragraph text and concatenate audio chunks seamlessly", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { "Content-Type": "audio/mpeg" } }))
            );

            const longText = [
                "Boss, if you're pulling weekend shifts until Sunday, your schedule is a pressure cooker waiting to blow.",
                "Working straight through without a system leads to diminishing returns and severe cognitive fatigue.",
                "1. The Time-Boxing Protocol: Work in strict 50-minute blocks of deep focus, then take a mandatory 10-minute hard break.",
                "2. The Hard Midday Cutoff: Carve out a solid 2-hour window in the afternoon to eat a decent meal and recharge."
            ].join("\n\n");

            const result = await generateSpeechAudio(longText, "en-gb");
            expect(result).toBeInstanceOf(ArrayBuffer);
            // Verify multiple chunks were fetched and each chunk query was strictly <= 200 chars
            expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
            for (const call of fetchSpy.mock.calls) {
                const url = new URL(call[0]);
                const queryText = url.searchParams.get("q");
                expect(queryText.length).toBeLessThanOrEqual(200);
            }
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
            expect(prompt).toContain("ANSWER ONLY WHAT BOSS ASKS — GET STRAIGHT TO THE POINT");
            expect(prompt).toContain("SHORT, CLEAN, PROFESSIONAL, and EASY TO UNDERSTAND");
        });

        it("extractGeminiCandidateText should extract text correctly and ignore thought parts", () => {
            const standardResp = {
                candidates: [{
                    content: {
                        parts: [{ text: "Direct response text" }]
                    }
                }]
            };
            expect(extractGeminiCandidateText(standardResp)).toBe("Direct response text");

            const thinkingResp = {
                candidates: [{
                    content: {
                        parts: [
                            { text: "Internal thinking...", thought: true },
                            { text: "Final human response text" }
                        ]
                    }
                }]
            };
            expect(extractGeminiCandidateText(thinkingResp)).toBe("Final human response text");

            expect(extractGeminiCandidateText(null)).toBeNull();
            expect(extractGeminiCandidateText({})).toBeNull();
        });

        it("askAiCopilot should prioritize custom GEMINI_MODEL when provided in env", async () => {
            let modelCalled = "";
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                modelCalled = String(url);
                return Promise.resolve(new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{ text: JSON.stringify({ reply: "Yes Boss, right away.", voice_summary: "Right away." }) }]
                        }
                    }]
                }), { status: 200 }));
            });

            const mockEnv = {
                GEMINI_API_KEY: "mock_key",
                GEMINI_MODEL: "gemini-3.1-pro-preview"
            };

            const res = await askAiCopilot(mockEnv, "Hello Friday", {});
            expect(res).toBeDefined();
            expect(modelCalled).toContain("gemini-3.1-pro-preview");
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
            expect(payload.text).toContain("Good morning, Boss");
            expect(payload.text).toContain("Finances");
        });

        it("should handle /briefing on and /briefing off to configure daily broadcasts", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            
            // Test /briefing off
            await handleMessage({
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/briefing off"
            }, mockEnv, "https://example.com");

            let payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Morning Briefing: DISABLED");

            // Test /briefing on
            await handleMessage({
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/briefing on"
            }, mockEnv, "https://example.com");

            payload = JSON.parse(fetchSpy.mock.calls[1][1].body);
            expect(payload.text).toContain("Morning Briefing: ENABLED");
        });

        it("sendFridayWakeupCall should send energetic 07:50 AM wake up call with voice note", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token" };
            await sendFridayWakeupCall(mockEnv, 123456, "user_boss");

            expect(fetchSpy).toHaveBeenCalled();
            const textCall = fetchSpy.mock.calls.find(c => {
                try {
                    const body = JSON.parse(c[1]?.body);
                    return body.text && body.text.includes("Wake Up, Boss");
                } catch (e) {
                    return false;
                }
            });
            expect(textCall).toBeDefined();
            const parsed = JSON.parse(textCall[1].body);
            expect(parsed.reply_markup.inline_keyboard[0][0].text).toContain("I'm Awake");
        });

        it("sendFridayWakeupCall should generate smart AI-driven message when Gemini API is available", async () => {
            const aiReply = "⏰ *Wake Up, Boss!*\n\nMorning Boss! Grab some water, stretch, and let's conquer today.";
            const aiVoice = "Good morning Boss. It is 7:50 AM. Drink some water and ease out of bed.";

            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                if (typeof url === "string" && url.includes("generativelanguage.googleapis.com")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [{ text: JSON.stringify({ reply: aiReply, voice_summary: aiVoice }) }]
                            }
                        }]
                    }), { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
            });

            const mockEnv = { TELEGRAM_BOT_TOKEN: "mock_token", GEMINI_API_KEY: "mock_gemini_key" };
            await sendFridayWakeupCall(mockEnv, 123456, "user_boss");

            const textCall = fetchSpy.mock.calls.find(c => {
                try {
                    const body = JSON.parse(c[1]?.body);
                    return body.text && body.text.includes("conquer today");
                } catch (e) {
                    return false;
                }
            });
            expect(textCall).toBeDefined();
        });

        it("claimDailyBroadcast should atomically prevent duplicate broadcasts on same date", async () => {
            const logs = new Set();
            const mockDb = {
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockImplementation((userId, type, date) => ({
                        first: vi.fn().mockImplementation(async () => {
                            const key = `${userId}:${type}:${date}`;
                            return logs.has(key) ? { 1: 1 } : null;
                        }),
                        run: vi.fn().mockImplementation(async () => {
                            const key = `${userId}:${type}:${date}`;
                            if (logs.has(key)) {
                                return { meta: { changes: 0 } };
                            }
                            logs.add(key);
                            return { meta: { changes: 1 } };
                        })
                    }))
                }))
            };

            // First broadcast claim on 2026-10-25 should succeed
            const claim1 = await claimDailyBroadcast(mockDb, "user_boss", "wakeup", "2026-10-25");
            expect(claim1).toBe(true);

            // Duplicate broadcast claim on same day should be blocked
            const claim2 = await claimDailyBroadcast(mockDb, "user_boss", "wakeup", "2026-10-25");
            expect(claim2).toBe(false);

            // Different type (e.g. briefing) on same day should succeed once
            const claimBriefing = await claimDailyBroadcast(mockDb, "user_boss", "briefing", "2026-10-25");
            expect(claimBriefing).toBe(true);

            // Next day wakeup should succeed
            const claimNextDay = await claimDailyBroadcast(mockDb, "user_boss", "wakeup", "2026-10-26");
            expect(claimNextDay).toBe(true);
        });

        it("sendDailyScheduledWakeup should skip users if wake-up call was already claimed today", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            let alreadyDispatched = false;
            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockImplementation((sql) => ({
                    bind: vi.fn().mockImplementation((...args) => ({
                        all: vi.fn().mockImplementation(async () => {
                            if (sql.includes("SELECT DISTINCT user_id")) {
                                return { results: [{ user_id: "user_boss" }] };
                            }
                            return { results: [] };
                        }),
                        first: vi.fn().mockImplementation(async () => {
                            if (sql.includes("daily_broadcast_logs")) {
                                return alreadyDispatched ? { 1: 1 } : null;
                            }
                            if (sql.includes("user_settings")) {
                                return { briefing_mode: "on" };
                            }
                            return null;
                        }),
                        run: vi.fn().mockImplementation(async () => {
                            if (sql.includes("daily_broadcast_logs")) {
                                if (alreadyDispatched) return { meta: { changes: 0 } };
                                alreadyDispatched = true;
                                return { meta: { changes: 1 } };
                            }
                            return { meta: { changes: 1 } };
                        })
                    }))
                }))
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };

            // Run 1: Should send message
            await sendDailyScheduledWakeup(mockEnv);
            const callCountAfterRun1 = fetchSpy.mock.calls.length;
            expect(callCountAfterRun1).toBeGreaterThan(0);

            // Run 2: Duplicate invocation (simulating Cloudflare double cron trigger) -> MUST skip!
            await sendDailyScheduledWakeup(mockEnv);
            const callCountAfterRun2 = fetchSpy.mock.calls.length;
            expect(callCountAfterRun2).toBe(callCountAfterRun1); // No new fetch calls made!
        });

        it("getHumanWakeupFallback should provide thoughtful day-specific human messages", () => {
            const monday = getHumanWakeupFallback("Monday", {});
            expect(monday.reply).toContain("Wake Up, Boss!");
            expect(monday.reply).toContain("Monday");
            expect(monday.reply).toContain("water");
            expect(monday.voice_summary).toContain("Monday");

            const friday = getHumanWakeupFallback("Friday", {});
            expect(friday.reply).toContain("Wake Up, Boss!");
            expect(friday.reply).toContain("Friday");
            expect(friday.voice_summary).toContain("Friday");

            const weekend = getHumanWakeupFallback("Sunday", {});
            expect(weekend.reply).toContain("Wake Up, Boss!");
            expect(weekend.reply).toContain("Sunday");
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
            expect(payload.text).toContain("Good morning, Boss");
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

    describe("Multi-Turn Conversation Memory - buildGeminiContents", () => {
        it("should return a single user turn when history is empty", () => {
            const contents = buildGeminiContents([], "Hello Friday");
            expect(contents).toEqual([
                { role: "user", parts: [{ text: "Hello Friday" }] }
            ]);
        });

        it("should construct strictly alternating user and model turns", () => {
            const history = [
                { role: "user", content: "Tell me a joke" },
                { role: "model", content: "Why did the robot cross the road? To recharge." }
            ];
            const contents = buildGeminiContents(history, "Tell me another one");
            expect(contents).toHaveLength(3);
            expect(contents[0].role).toBe("user");
            expect(contents[0].parts[0].text).toBe("Tell me a joke");
            expect(contents[1].role).toBe("model");
            expect(contents[1].parts[0].text).toBe("Why did the robot cross the road? To recharge.");
            expect(contents[2].role).toBe("user");
            expect(contents[2].parts[0].text).toBe("Tell me another one");
        });

        it("should discard leading model turns so the first turn is always role user", () => {
            const history = [
                { role: "model", content: "Welcome Boss" },
                { role: "user", content: "Check budget" },
                { role: "model", content: "All green" }
            ];
            const contents = buildGeminiContents(history, "Can I buy lunch?");
            expect(contents[0].role).toBe("user");
            expect(contents[0].parts[0].text).toBe("Check budget");
            expect(contents).toHaveLength(3);
        });

        it("should merge trailing user turns with the current query so role alternates properly", () => {
            const history = [
                { role: "user", content: "First query" },
                { role: "model", content: "First reply" },
                { role: "user", content: "Second query unanswered" }
            ];
            const contents = buildGeminiContents(history, "Third query");
            expect(contents).toHaveLength(3);
            expect(contents[0].role).toBe("user");
            expect(contents[1].role).toBe("model");
            expect(contents[2].role).toBe("user");
            expect(contents[2].parts[0].text).toBe("Second query unanswered\n\nThird query");
        });
    });

    describe("Long-Term Memory Matrix & Prompts", () => {
        it("buildCopilotPrompt should inject user memories block into prompt when present", () => {
            const prompt = buildCopilotPrompt("What should I have for breakfast?", {
                currentDate: "2026-10-22",
                currentTime: "10:00",
                timezone: "Asia/Phnom_Penh",
                displayCurrency: "USD",
                userMemories: [
                    { id: 1, category: "preference", fact: "Boss prefers black coffee without sugar" },
                    { id: 2, category: "work", fact: "Boss is building a Cloudflare AI assistant" }
                ]
            });

            expect(prompt).toContain("WHAT FRIDAY KNOWS ABOUT BOSS");
            expect(prompt).toContain("Boss prefers black coffee without sugar");
            expect(prompt).toContain("Boss is building a Cloudflare AI assistant");
            expect(prompt).toContain("add_memory");
        });
    });

    describe("Memory & Conversation Reset Commands", () => {
        it("should handle /remember command and persist personal fact", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/remember I prefer dark roast coffee"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Memory Matrix Updated");
            expect(payload.text).toContain("I prefer dark roast coffee");
        });

        it("should handle /memory command and display formatted list", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 1, category: "preference", fact: "Drinks green tea" },
                                { id: 2, category: "work", fact: "Lead architect at startup" }
                            ]
                        })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/memory"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("F.R.I.D.A.Y. • Long-Term Memory Matrix");
            expect(payload.text).toContain("Drinks green tea");
            expect(payload.text).toContain("Lead architect at startup");
        });

        it("should handle /forget command and delete specific memory", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/forget 42"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Memory *#42* erased");
        });

        it("should handle /reset command and flush conversation buffer", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 5 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/reset"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Conversation Buffer Flushed");
        });
    });

    describe("Database Memory Queries", () => {
        it("should prevent duplicate memories on saveUserMemory", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ id: 99 }),
                        run: vi.fn()
                    })
                })
            };

            const result = await saveUserMemory(mockDb, "user1", "I love spicy noodles", "preference");
            expect(result).toBe(99);
        });

        it("should retrieve recent chat history ordered chronologically", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { role: "user", content: "Hi" },
                                { role: "model", content: "Hello Boss" }
                            ]
                        })
                    })
                })
            };

            const history = await getRecentChatHistory(mockDb, "user1", 6);
            expect(history).toHaveLength(2);
            expect(history[0].role).toBe("user");
            expect(history[1].role).toBe("model");
        });
    });

    describe("Voice UX & Auto-Voice Mode", () => {
        it("should read last model response when /speak is invoked with no arguments", async () => {
            const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
            fetchSpy = vi.spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response(fakeAudio, { status: 200 })) // TTS
                .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })); // Telegram sendVoice

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue({ content: "Boss, dropping $45 will put you in prototype debt." }),
                        run: vi.fn().mockResolvedValue({})
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/speak"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const voiceCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("/sendVoice") || String(c[0]).includes("/sendAudio"));
            expect(voiceCall).toBeDefined();
        });

        it("should enable auto-voice mode via /voice on command", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                    })
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 123456 },
                text: "/voice on"
            };

            await handleMessage(message, mockEnv, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Auto-Voice Mode: ENABLED");
        });
    });

    describe("Ledger System Control & Mistake Correction", () => {
        it("deleteLastTransaction should query and delete the latest transaction for the user", async () => {
            const mockRow = {
                id: 169,
                amount: 40,
                category: "Is my income not my expensse",
                type: "expense",
                currency: "USD",
                date: "2026-10-22"
            };

            const mockDb = {
                prepare: vi.fn((sql) => {
                    if (sql.includes("SELECT")) {
                        return {
                            bind: vi.fn().mockReturnValue({
                                first: vi.fn().mockResolvedValue(mockRow)
                            })
                        };
                    }
                    if (sql.includes("DELETE")) {
                        return {
                            bind: vi.fn().mockReturnValue({
                                run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                            })
                        };
                    }
                    return { bind: vi.fn().mockReturnThis() };
                })
            };

            const deleted = await deleteLastTransaction(mockDb, 849550186);
            expect(deleted).toEqual(mockRow);
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("SELECT id, amount"));
            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM expenses"));
        });

        it("handleUndoLastTransaction should delete last transaction and send confirmation", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
                new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
            );

            const mockRow = {
                id: 169,
                amount: 40,
                category: "Is my income not my expensse",
                type: "expense",
                currency: "USD",
                date: "2026-10-22"
            };

            const mockDb = {
                prepare: vi.fn((sql) => {
                    if (sql.includes("SELECT")) {
                        return {
                            bind: vi.fn().mockReturnValue({
                                first: vi.fn().mockResolvedValue(mockRow)
                            })
                        };
                    }
                    return {
                        bind: vi.fn().mockReturnValue({
                            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
                        })
                    };
                })
            };

            const mockEnv = { DB: mockDb, TELEGRAM_BOT_TOKEN: "mock_token" };
            await handleUndoLastTransaction(mockEnv, 123456, 849550186);

            expect(fetchSpy).toHaveBeenCalled();
            const payload = JSON.parse(fetchSpy.mock.calls[0][1].body);
            expect(payload.text).toContain("Transaction Undone");
            expect(payload.text).toContain("$40");
            expect(payload.text).toContain("Is my income not my expensse");
        });

        it("buildSmartLocalFallback should generate correction actions when Boss says 'income not expense'", () => {
            const fallback = buildSmartLocalFallback("40$ is my income not my expensse", {
                displayCurrency: "USD"
            });

            expect(fallback.reply).toContain("Ledger Correction");
            expect(fallback.voice_summary).toContain("removed the wrongful expense");
            expect(fallback.actions).toHaveLength(2);
            expect(fallback.actions[0]).toEqual({ type: "delete_last_transaction", filter: "expense" });
            expect(fallback.actions[1]).toEqual({ type: "add_income", amount: 40, currency: "USD", category: "Income" });
        });

        it("buildSmartLocalFallback should generate undo action when Boss says 'undo'", () => {
            const fallback = buildSmartLocalFallback("undo", { displayCurrency: "USD" });
            expect(fallback.reply).toContain("purged from your ledger");
            expect(fallback.action).toEqual({ type: "delete_last_transaction", filter: "any" });
        });

        it("buildSmartLocalFallback should generate currency action when Boss says 'switch to USD'", () => {
            const fallback = buildSmartLocalFallback("switch to USD", { displayCurrency: "KHR" });
            expect(fallback.reply).toContain("USD");
            expect(fallback.action).toEqual({ type: "set_currency", currency: "USD" });
        });

        it("buildSmartLocalFallback should generate budget action when Boss says 'set monthly budget to 300'", () => {
            const fallback = buildSmartLocalFallback("budget is $300", { displayCurrency: "USD" });
            expect(fallback.reply).toContain("300");
            expect(fallback.action).toEqual({ type: "set_budget", amount: 300, currency: "USD" });
        });

        it("buildSmartLocalFallback should generate clear all action when Boss says 'clear all'", () => {
            const fallback = buildSmartLocalFallback("clear all transactions", { displayCurrency: "USD" });
            expect(fallback.reply).toContain("purged");
            expect(fallback.action).toEqual({ type: "clear_all_transactions" });
        });
    });
});
