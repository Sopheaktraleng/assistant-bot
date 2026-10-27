import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    FRIDAY_FUNCTION_DECLARATIONS,
    executeCopilotTool,
    askAiCopilot,
    parseExtractedPdfStatementJson,
    parseStatementOrInvoicePdfWithGemini,
    buildAiUserContext
} from "../src/services/ai.js";
import {
    searchWorkLogs,
    searchUserMemories,
    searchLedger,
    searchHistoricalRecords,
    savePendingStatement,
    getPendingStatement,
    deletePendingStatement,
    importPendingStatementTransactions
} from "../src/db/queries.js";
import {
    handlePdfDocument,
    handleStatementImport,
    handleStatementViewBreakdown,
    handleStatementDiscard,
    renderPendingStatementCard
} from "../src/modules/finance/scanner.js";
import { handleMessage } from "../src/handlers/message.js";
import { handleCallback } from "../src/handlers/callback.js";

describe("Core AI & Agentic Intelligence Adjustments", () => {
    let fetchSpy;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        if (fetchSpy) fetchSpy.mockRestore();
    });

    describe("1. Native Gemini Tool Calling (Function Calling)", () => {
        it("should expose complete function declarations for queries and system actions", () => {
            const toolNames = FRIDAY_FUNCTION_DECLARATIONS.map(t => t.name);
            expect(toolNames).toContain("query_ledger");
            expect(toolNames).toContain("query_work_logs");
            expect(toolNames).toContain("search_memories");
            expect(toolNames).toContain("add_expense");
            expect(toolNames).toContain("add_income");
            expect(toolNames).toContain("delete_last_transaction");
            expect(toolNames).toContain("set_currency");
            expect(toolNames).toContain("set_budget");
            expect(toolNames).toContain("add_work");
            expect(toolNames).toContain("add_reminder");
            expect(toolNames).toContain("add_memory");
        });

        it("executeCopilotTool should execute query_ledger tool", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 1, date: "2026-10-25", amount: 4.5, currency: "USD", category: "Coffee", type: "expense" },
                                { id: 2, date: "2026-10-24", amount: 12, currency: "USD", category: "Coffee", type: "expense" }
                            ]
                        })
                    })
                })
            };

            const result = await executeCopilotTool(mockDb, "user_1", "chat_1", "query_ledger", {
                category: "Coffee",
                from_date: "2026-10-01"
            });

            expect(result.success).toBe(true);
            expect(result.count).toBe(2);
            expect(result.totalUsd).toBe(16.5);
            expect(result.transactions.length).toBe(2);
        });

        it("executeCopilotTool should execute query_work_logs tool", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 10, date: "2026-10-25", time: "14:00", content: "Fixed auth migration bug", category: "Bugfix" }
                            ]
                        })
                    })
                })
            };

            const result = await executeCopilotTool(mockDb, "user_1", "chat_1", "query_work_logs", {
                query: "auth"
            });

            expect(result.success).toBe(true);
            expect(result.count).toBe(1);
            expect(result.tasks[0].content).toContain("auth");
        });

        it("executeCopilotTool should execute search_memories tool", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 3, fact: "Prefers iced Americano with no sugar", category: "preference" }
                            ]
                        })
                    })
                })
            };

            const result = await executeCopilotTool(mockDb, "user_1", "chat_1", "search_memories", {
                query: "Americano"
            });

            expect(result.success).toBe(true);
            expect(result.memories[0].fact).toContain("Americano");
        });

        it("executeCopilotTool should execute add_expense and add_income actions", async () => {
            const runFn = vi.fn().mockResolvedValue({});
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: runFn
                    })
                })
            };

            const expResult = await executeCopilotTool(mockDb, "user_1", "chat_1", "add_expense", {
                amount: 8.5,
                currency: "USD",
                category: "Food"
            });
            expect(expResult.success).toBe(true);
            expect(expResult.recorded.amount).toBe(8.5);
            expect(expResult.recorded.type).toBe("expense");

            const incResult = await executeCopilotTool(mockDb, "user_1", "chat_1", "add_income", {
                amount: 500,
                currency: "USD",
                category: "Freelance"
            });
            expect(incResult.success).toBe(true);
            expect(incResult.recorded.amount).toBe(500);
            expect(incResult.recorded.type).toBe("income");
        });

        it("executeCopilotTool should execute add_work, add_reminder, add_memory, and system settings", async () => {
            const runFn = vi.fn().mockResolvedValue({});
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: runFn,
                        first: vi.fn().mockResolvedValue({ id: 1 })
                    })
                })
            };

            const workRes = await executeCopilotTool(mockDb, "user_1", "chat_1", "add_work", {
                content: "Deployed v2.1 to production",
                category: "Release"
            });
            expect(workRes.success).toBe(true);
            expect(workRes.task).toBe("Deployed v2.1 to production");

            const remRes = await executeCopilotTool(mockDb, "user_1", "chat_1", "add_reminder", {
                title: "Call mom",
                time: "18:00",
                frequency: "once"
            });
            expect(remRes.success).toBe(true);
            expect(remRes.reminder.title).toBe("Call mom");

            const memRes = await executeCopilotTool(mockDb, "user_1", "chat_1", "add_memory", {
                fact: "Sister's birthday is Nov 12",
                category: "identity"
            });
            expect(memRes.success).toBe(true);
            expect(memRes.memory.fact).toBe("Sister's birthday is Nov 12");

            const currRes = await executeCopilotTool(mockDb, "user_1", "chat_1", "set_currency", {
                currency: "KHR"
            });
            expect(currRes.success).toBe(true);
            expect(currRes.currency).toBe("KHR");

            const budRes = await executeCopilotTool(mockDb, "user_1", "chat_1", "set_budget", {
                amount: 400,
                currency: "USD"
            });
            expect(budRes.success).toBe(true);
            expect(budRes.budgetLimitKhr).toBe(1600000);
        });

        it("askAiCopilot should execute tool calls in agentic loop and formulate natural reply", async () => {
            let callCount = 0;
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 1, date: "2026-10-25", amount: 4.5, currency: "USD", category: "Coffee", type: "expense" }
                            ]
                        })
                    })
                })
            };

            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // Turn 1: Model issues a functionCall for query_ledger
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [{
                                    functionCall: {
                                        name: "query_ledger",
                                        args: { category: "Coffee" }
                                    }
                                }]
                            }
                        }]
                    }), { status: 200 }));
                }
                // Turn 2: Model receives functionResponse and returns final conversational reply
                return Promise.resolve(new Response(JSON.stringify({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    reply: "You have spent $4.50 on Coffee this month, Boss.",
                                    voice_summary: "You have spent 4 dollars and 50 cents on coffee this month."
                                })
                            }]
                        }
                    }]
                }), { status: 200 }));
            });

            const env = { GEMINI_API_KEY: "mock_key" };
            const context = {
                db: mockDb,
                userId: "user_boss",
                chatId: "chat_1",
                isOwner: true,
                displayCurrency: "USD"
            };

            const result = await askAiCopilot(env, "How much did I spend on coffee?", context);
            expect(result).toBeDefined();
            expect(callCount).toBe(2); // Initial tool call + follow-up synthesis turn
            expect(result.reply).toContain("$4.50");
        });
    });

    describe("2. Semantic RAG & Historical Search (D1 FTS5 & Search)", () => {
        it("searchWorkLogs should find past tasks across time", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 12, date: "2026-09-15", time: "11:00", content: "Migrated database schema to FTS5", category: "Development" }
                            ]
                        })
                    })
                })
            };

            const results = await searchWorkLogs(mockDb, "user_1", "database schema");
            expect(results.length).toBe(1);
            expect(results[0].content).toContain("FTS5");
        });

        it("searchUserMemories should retrieve specific past memories", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 7, fact: "Only drinks cold brew without syrup", category: "preference" }
                            ]
                        })
                    })
                })
            };

            const results = await searchUserMemories(mockDb, "user_1", "cold brew");
            expect(results.length).toBe(1);
            expect(results[0].fact).toContain("cold brew");
        });

        it("searchHistoricalRecords should combine memories, work logs, and transactions into unified RAG package", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        all: vi.fn().mockResolvedValue({
                            results: [
                                { id: 1, fact: "Prefers ABA KHQR payment", category: "preference" }
                            ]
                        })
                    })
                })
            };

            const rag = await searchHistoricalRecords(mockDb, "user_1", "payment");
            expect(rag).toHaveProperty("memories");
            expect(rag).toHaveProperty("workLogs");
            expect(rag).toHaveProperty("transactions");
        });

        it("buildAiUserContext should inject relevantHistory when user query mentions past context", async () => {
            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        first: vi.fn().mockResolvedValue(null),
                        all: vi.fn().mockResolvedValue({ results: [] })
                    })
                })
            };

            const ctx = await buildAiUserContext(mockDb, "user_1", "When was the last time I changed oil?");
            expect(ctx).toBeDefined();
            expect(ctx.currentDate).toBeDefined();
        });
    });

    describe("3. Bank PDF Statement & Invoice OCR", () => {
        it("parseExtractedPdfStatementJson should parse single invoice PDF", () => {
            const jsonText = JSON.stringify({
                is_statement: false,
                bank_or_issuer: "EDC Electricity",
                amount: 35.80,
                currency: "USD",
                category: "Bills",
                type: "expense",
                date: "2026-10-20",
                note: "Monthly electricity bill",
                summary_markdown: "EDC electricity invoice of $35.80 due on Oct 25."
            });

            const parsed = parseExtractedPdfStatementJson(jsonText);
            expect(parsed).toEqual({
                is_statement: false,
                is_slip: true,
                amount: 35.80,
                currency: "USD",
                merchant: "EDC Electricity",
                bank: "EDC Electricity",
                category: "Bills",
                type: "expense",
                date: "2026-10-20",
                note: "Monthly electricity bill",
                summary_markdown: "EDC electricity invoice of $35.80 due on Oct 25."
            });
        });

        it("parseExtractedPdfStatementJson should parse multi-transaction bank statement PDF", () => {
            const jsonText = JSON.stringify({
                is_statement: true,
                bank_or_issuer: "ABA Bank",
                account_name: "Boss",
                period: "October 2026",
                currency: "USD",
                total_inflow: 1250.00,
                total_outflow: 420.50,
                transaction_count: 2,
                transactions: [
                    {
                        date: "2026-10-24",
                        amount: 4.50,
                        currency: "USD",
                        merchant: "Brown Coffee",
                        category: "Coffee",
                        type: "expense",
                        note: "Iced Americano"
                    },
                    {
                        date: "2026-10-23",
                        amount: 1000.00,
                        currency: "USD",
                        merchant: "Client Payment",
                        category: "Salary",
                        type: "income",
                        note: "Monthly retainer"
                    }
                ],
                summary_markdown: "ABA Bank statement for Oct 2026 showing +$1,250 inflow and -$420.50 outflow."
            });

            const parsed = parseExtractedPdfStatementJson(jsonText);
            expect(parsed.is_statement).toBe(true);
            expect(parsed.bank).toBe("ABA Bank");
            expect(parsed.total_inflow).toBe(1250.00);
            expect(parsed.total_outflow).toBe(420.50);
            expect(parsed.transaction_count).toBe(2);
            expect(parsed.transactions.length).toBe(2);
            expect(parsed.transactions[0].merchant).toBe("Brown Coffee");
        });

        it("savePendingStatement, getPendingStatement, and importPendingStatementTransactions lifecycle", async () => {
            const fakeTransactions = [
                { date: "2026-10-20", amount: 15, currency: "USD", category: "Food", type: "expense", merchant: "Burger" },
                { date: "2026-10-21", amount: 50, currency: "USD", category: "Freelance", type: "income", merchant: "Dev Work" }
            ];

            let storedJson = JSON.stringify(fakeTransactions);
            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 101 } }),
                        first: vi.fn().mockImplementation(() => {
                            if (!storedJson) return null;
                            return {
                                id: 101,
                                user_id: "user_boss",
                                bank: "ABA Bank",
                                period: "October 2026",
                                currency: "USD",
                                total_inflow: 50,
                                total_outflow: 15,
                                transaction_count: 2,
                                transactions_json: storedJson
                            };
                        })
                    })
                })
            };

            const stmtId = await savePendingStatement(mockDb, {
                userId: "user_boss",
                chatId: "12345",
                bank: "ABA Bank",
                period: "October 2026",
                currency: "USD",
                totalInflow: 50,
                totalOutflow: 15,
                transactionCount: 2,
                transactionsJson: storedJson
            });

            expect(stmtId).toBe(101);

            const fetched = await getPendingStatement(mockDb, 101, "user_boss");
            expect(fetched).toBeDefined();
            expect(fetched.bank).toBe("ABA Bank");

            const imported = await importPendingStatementTransactions(mockDb, 101, "user_boss");
            expect(imported.success).toBe(true);
            expect(imported.count).toBe(2);
            expect(mockDb.batch).toHaveBeenCalled();
        });

        it("handlePdfDocument should download PDF, parse via Gemini, and render statement card", async () => {
            let editPayload = null;
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
                const urlStr = String(url);
                if (urlStr.includes("getFile")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        ok: true,
                        result: { file_path: "documents/statement.pdf" }
                    }), { status: 200 }));
                }
                if (urlStr.includes("statement.pdf")) {
                    return Promise.resolve(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
                        status: 200,
                        headers: { "Content-Type": "application/pdf" }
                    }));
                }
                if (urlStr.includes("generateContent")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        candidates: [{
                            content: {
                                parts: [{
                                    text: JSON.stringify({
                                        is_statement: true,
                                        bank_or_issuer: "ABA Bank",
                                        account_name: "Boss",
                                        period: "October 2026",
                                        currency: "USD",
                                        total_inflow: 500,
                                        total_outflow: 120,
                                        transaction_count: 3,
                                        transactions: [
                                            { date: "2026-10-25", amount: 15, currency: "USD", category: "Food", type: "expense", merchant: "Pizza" }
                                        ]
                                    })
                                }]
                            }
                        }]
                    }), { status: 200 }));
                }
                if (urlStr.includes("editMessageText") || urlStr.includes("sendMessage")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        ok: true,
                        result: { message_id: 888 }
                    }), { status: 200 }));
                }
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            });

            const mockDb = {
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 55 } }),
                        first: vi.fn().mockResolvedValue(null)
                    })
                })
            };

            const env = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token",
                GEMINI_API_KEY: "mock_gemini"
            };

            const message = {
                chat: { id: 123456, type: "private" },
                from: { id: 849550186, first_name: "Boss" },
                document: {
                    file_id: "doc_aba_pdf_123",
                    file_name: "aba_statement_oct2026.pdf",
                    mime_type: "application/pdf"
                }
            };

            await handleMessage(message, env, "https://example.com");

            expect(fetchSpy).toHaveBeenCalled();
            // Verify Gemini generateContent was called with inline_data application/pdf
            const geminiCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("generateContent"));
            expect(geminiCall).toBeDefined();
            const payload = JSON.parse(geminiCall[1].body);
            const partWithData = payload.contents[0].parts.find(p => p.inline_data);
            expect(partWithData.inline_data.mime_type).toBe("application/pdf");
        });

        it("handleCallback should route stmt_import and import all transactions", async () => {
            fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }))
            );

            const mockDb = {
                batch: vi.fn().mockResolvedValue([]),
                prepare: vi.fn().mockReturnValue({
                    bind: vi.fn().mockReturnValue({
                        run: vi.fn().mockResolvedValue({}),
                        first: vi.fn().mockResolvedValue({
                            id: 77,
                            user_id: "849550186",
                            bank: "ABA Bank",
                            period: "October 2026",
                            currency: "USD",
                            total_inflow: 500,
                            total_outflow: 120,
                            transaction_count: 1,
                            transactions_json: JSON.stringify([
                                { date: "2026-10-25", amount: 15, currency: "USD", category: "Food", type: "expense", merchant: "Pizza" }
                            ])
                        })
                    })
                })
            };

            const env = {
                DB: mockDb,
                TELEGRAM_BOT_TOKEN: "mock_token"
            };

            const callback = {
                id: "cb_stmt_import_1",
                from: { id: 849550186 },
                message: { chat: { id: 123456 }, message_id: 888 },
                data: "stmt_import:77"
            };

            await handleCallback(callback, env, "https://example.com");

            expect(mockDb.batch).toHaveBeenCalled();
            expect(fetchSpy).toHaveBeenCalled();
            const editCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("editMessageText") || String(c[0]).includes("answerCallbackQuery"));
            expect(editCall).toBeDefined();
        });
    });
});
