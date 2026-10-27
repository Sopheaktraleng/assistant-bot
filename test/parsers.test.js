import { describe, it, expect } from "vitest";
import {
    parseExtractedJson,
    parseCopilotResponse,
    parseExtractedPdfStatementJson
} from "../src/services/ai.js";
import {
    isConversationalOrCorrection,
    parseNaturalIncome,
    parseNaturalExpense
} from "../src/utils/natural.js";

describe("AI Parser Utilities", () => {
    describe("parseExtractedJson", () => {
        it("should parse pure JSON object and populate defaults", () => {
            const raw = '{"amount": 15.5, "category": "Food", "currency": "USD"}';
            const parsed = parseExtractedJson(raw);
            expect(parsed).toEqual({
                is_slip: true,
                type: "expense",
                amount: 15.5,
                currency: "USD",
                category: "Food",
                bank: "Bank Transfer",
                merchant: "",
                note: "",
                date: null
            });
        });

        it("should parse JSON wrapped in markdown code fence", () => {
            const raw = "```json\n{\n  \"amount\": 25000,\n  \"currency\": \"KHR\",\n  \"merchant\": \"Brown Coffee\"\n}\n```";
            const parsed = parseExtractedJson(raw);
            expect(parsed).toEqual({
                is_slip: true,
                type: "expense",
                amount: 25000,
                currency: "KHR",
                category: "Other",
                merchant: "Brown Coffee",
                bank: "Bank Transfer",
                note: "",
                date: null
            });
        });

        it("should extract JSON embedded in conversational AI text", () => {
            const raw = "Here is the extracted information from your receipt:\n```json\n{\"amount\": 3.5, \"category\": \"Coffee\"}\n```\nLet me know if you need any adjustments!";
            const parsed = parseExtractedJson(raw);
            expect(parsed).toEqual({
                is_slip: true,
                type: "expense",
                amount: 3.5,
                currency: "USD",
                category: "Coffee",
                bank: "Bank Transfer",
                merchant: "",
                note: "",
                date: null
            });
        });

        it("should extract raw JSON without code block in noisy text", () => {
            const raw = "Receipt detected: {\"amount\": 12, \"category\": \"Taxi\"}. Have a good day.";
            const parsed = parseExtractedJson(raw);
            expect(parsed).toEqual({
                is_slip: true,
                type: "expense",
                amount: 12,
                currency: "USD",
                category: "Taxi",
                bank: "Bank Transfer",
                merchant: "",
                note: "",
                date: null
            });
        });

        it("should return null for non-JSON text", () => {
            expect(parseExtractedJson("Just some regular text without brackets.")).toBeNull();
            expect(parseExtractedJson("")).toBeNull();
            expect(parseExtractedJson(null)).toBeNull();
        });
    });

    describe("parseCopilotResponse", () => {
        it("should parse copilot JSON structure", () => {
            const raw = JSON.stringify({
                reply: "You spent $45 on food this week.",
                action: {
                    type: "add_expense",
                    amount: 45,
                    currency: "USD",
                    category: "Food"
                }
            });
            const result = parseCopilotResponse(raw);
            expect(result.reply).toBe("You spent $45 on food this week.");
            expect(result.action).toEqual({
                type: "add_expense",
                amount: 45,
                currency: "USD",
                category: "Food"
            });
        });

        it("should parse multiple actions in copilot JSON", () => {
            const raw = JSON.stringify({
                reply: "Corrected your ledger Boss.",
                voice_summary: "Corrected ledger Boss.",
                actions: [
                    { type: "delete_last_transaction", filter: "expense" },
                    { type: "add_income", amount: 40, currency: "USD", category: "Income" }
                ]
            });
            const result = parseCopilotResponse(raw);
            expect(result.reply).toBe("Corrected your ledger Boss.");
            expect(result.actions).toHaveLength(2);
            expect(result.actions[0].type).toBe("delete_last_transaction");
            expect(result.actions[1].type).toBe("add_income");
            expect(result.action).toEqual(result.actions[0]);
        });

        it("should fallback gracefully for plain markdown response", () => {
            const raw = "You have spent $120 total this month. Consider saving more!";
            const result = parseCopilotResponse(raw);
            expect(result.reply).toBe(raw);
            expect(result.action).toBeNull();
        });
    });

    describe("parseExtractedPdfStatementJson", () => {
        it("should parse valid single invoice PDF JSON", () => {
            const raw = JSON.stringify({
                is_statement: false,
                amount: 45.5,
                currency: "USD",
                merchant: "Brown Coffee",
                category: "Coffee"
            });
            const result = parseExtractedPdfStatementJson(raw);
            expect(result.is_statement).toBe(false);
            expect(result.amount).toBe(45.5);
            expect(result.currency).toBe("USD");
            expect(result.merchant).toBe("Brown Coffee");
        });

        it("should return null when invalid", () => {
            expect(parseExtractedPdfStatementJson("Not a PDF statement JSON")).toBeNull();
        });
    });
});

describe("Natural Language Command Parsers", () => {
    describe("isConversationalOrCorrection", () => {
        it("should detect correction and negation phrases", () => {
            expect(isConversationalOrCorrection("40$ is my income not my expensse")).toBe(true);
            expect(isConversationalOrCorrection("that was income not expense")).toBe(true);
            expect(isConversationalOrCorrection("40$ is my income")).toBe(true);
            expect(isConversationalOrCorrection("why did you add expense")).toBe(true);
            expect(isConversationalOrCorrection("undo that")).toBe(true);
            expect(isConversationalOrCorrection("delete last transaction")).toBe(true);
        });

        it("should detect questions and financial inquiries", () => {
            expect(isConversationalOrCorrection("Can I afford a $45 mechanical keyboard?")).toBe(true);
            expect(isConversationalOrCorrection("how much did I spend today?")).toBe(true);
            expect(isConversationalOrCorrection("what is my budget?")).toBe(true);
            expect(isConversationalOrCorrection("switch to USD")).toBe(true);
            expect(isConversationalOrCorrection("set budget to 300$")).toBe(true);
        });

        it("should return false for pure expense entries", () => {
            expect(isConversationalOrCorrection("5 coffee")).toBe(false);
            expect(isConversationalOrCorrection("$12 lunch")).toBe(false);
            expect(isConversationalOrCorrection("15000 groceries")).toBe(false);
            expect(isConversationalOrCorrection("coffee 5")).toBe(false);
            expect(isConversationalOrCorrection("spent $15 on dinner")).toBe(false);
        });
    });

    describe("Natural Income Regexes", () => {
        it("should match +<amount> syntax", () => {
            const res1 = parseNaturalIncome("+500 salary");
            expect(res1).toEqual({ amount: 500, currency: null, category: "Salary" });

            const res2 = parseNaturalIncome("+250.50 usd freelance");
            expect(res2).toEqual({ amount: 250.5, currency: "USD", category: "Freelance" });

            const res3 = parseNaturalIncome("+1000000 khr bonus");
            expect(res3).toEqual({ amount: 1000000, currency: "KHR", category: "Bonus" });
        });

        it("should match income <amount> syntax", () => {
            const res = parseNaturalIncome("income 1200 usd client project");
            expect(res).toEqual({ amount: 1200, currency: "USD", category: "client project" });
        });

        it("should match '<amount> income' and '<amount> salary' syntax", () => {
            expect(parseNaturalIncome("40$ income")).toEqual({
                amount: 40,
                currency: "USD",
                category: "Income"
            });
            expect(parseNaturalIncome("$40 income")).toEqual({
                amount: 40,
                currency: "USD",
                category: "Income"
            });
            expect(parseNaturalIncome("500$ salary")).toEqual({
                amount: 500,
                currency: "USD",
                category: "Salary"
            });
            expect(parseNaturalIncome("salary 500$")).toEqual({
                amount: 500,
                currency: "USD",
                category: "Salary"
            });
        });

        it("should match earned and received syntax", () => {
            expect(parseNaturalIncome("earned $50 freelance")).toEqual({
                amount: 50,
                currency: "USD",
                category: "Freelance"
            });
            expect(parseNaturalIncome("received 100 bonus")).toEqual({
                amount: 100,
                currency: null,
                category: "Bonus"
            });
            expect(parseNaturalIncome("got paid $1200")).toEqual({
                amount: 1200,
                currency: "USD",
                category: "Income"
            });
        });

        it("should return null for corrective messages so AI Copilot can undo the mistake", () => {
            expect(parseNaturalIncome("40$ is my income not my expensse")).toBeNull();
        });
    });

    describe("Natural Expense Regexes", () => {
        it("should parse standard quick expenses", () => {
            expect(parseNaturalExpense("5 coffee")).toEqual({ amount: 5, currency: null, category: "coffee" });
            expect(parseNaturalExpense("$12 lunch")).toEqual({ amount: 12, currency: "USD", category: "lunch" });
            expect(parseNaturalExpense("15000 groceries")).toEqual({ amount: 15000, currency: null, category: "groceries" });
            expect(parseNaturalExpense("coffee 5")).toEqual({ amount: 5, currency: null, category: "coffee" });
            expect(parseNaturalExpense("spent $15 on dinner")).toEqual({ amount: 15, currency: "USD", category: "dinner" });
            expect(parseNaturalExpense("paid 20000 for gas")).toEqual({ amount: 20000, currency: null, category: "gas" });
        });

        it("should extract merchant and note when specified", () => {
            expect(parseNaturalExpense("5 coffee at starbucks")).toEqual({
                amount: 5,
                currency: null,
                category: "coffee",
                merchant: "starbucks"
            });
            expect(parseNaturalExpense("15 lunch (team meetup)")).toEqual({
                amount: 15,
                currency: null,
                category: "lunch",
                note: "team meetup"
            });
        });

        it("CRITICAL: should NEVER parse '40$ is my income not my expensse' as an expense", () => {
            expect(parseNaturalExpense("40$ is my income not my expensse")).toBeNull();
        });

        it("CRITICAL: should NEVER parse income entries as expenses", () => {
            expect(parseNaturalExpense("40$ income")).toBeNull();
            expect(parseNaturalExpense("$40 income")).toBeNull();
            expect(parseNaturalExpense("500$ salary")).toBeNull();
            expect(parseNaturalExpense("salary 500$")).toBeNull();
            expect(parseNaturalExpense("earned $50 freelance")).toBeNull();
            expect(parseNaturalExpense("40$ add my net bonus to")).toBeNull();
        });

        it("should reject conversational questions and advice queries", () => {
            expect(parseNaturalExpense("can I afford a 45$ mechanical keyboard?")).toBeNull();
            expect(parseNaturalExpense("how much did I spend?")).toBeNull();
        });
    });

    describe("Work Task Logging Prefix", () => {
        const parseWorkLog = (text) => {
            const match = text.match(/^(done|did|finished|completed|log)\s+(.*)$/i);
            if (!match) return null;
            const content = match[2].trim();
            const bracketMatch = content.match(/^\[(.*?)\]\s*(.*)$/);
            if (bracketMatch) {
                return {
                    category: bracketMatch[1].trim(),
                    task: bracketMatch[2].trim()
                };
            }
            return {
                category: "General",
                task: content
            };
        };

        it("should parse done / did / finished work logs", () => {
            expect(parseWorkLog("done fixed mobile crash")).toEqual({
                category: "General",
                task: "fixed mobile crash"
            });
            expect(parseWorkLog("finished [Bugfix] resolved 404 error on checkout")).toEqual({
                category: "Bugfix",
                task: "resolved 404 error on checkout"
            });
            expect(parseWorkLog("did [Meeting] team sprint retro")).toEqual({
                category: "Meeting",
                task: "team sprint retro"
            });
        });
    });
});
