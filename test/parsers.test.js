import { describe, it, expect } from "vitest";
import {
    parseExtractedJson,
    parseCopilotResponse,
    parseMovieJson
} from "../src/services/ai.js";

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

        it("should fallback gracefully for plain markdown response", () => {
            const raw = "You have spent $120 total this month. Consider saving more!";
            const result = parseCopilotResponse(raw);
            expect(result.reply).toBe(raw);
            expect(result.action).toBeNull();
        });
    });

    describe("parseMovieJson", () => {
        it("should parse valid movie JSON", () => {
            const raw = JSON.stringify({
                title: "Inception",
                year: "2010",
                genre: "Sci-Fi / Action",
                rating: "8.8/10",
                runtime: "2h 28m",
                platforms: "Netflix",
                synopsis: "A thief who enters the dreams of others.",
                why_love: "Mind-bending visuals and incredible score."
            });
            const result = parseMovieJson(raw);
            expect(result.title).toBe("Inception");
            expect(result.year).toBe("2010");
            expect(result.genre).toBe("Sci-Fi / Action");
        });

        it("should return null when invalid", () => {
            expect(parseMovieJson("Not a movie JSON")).toBeNull();
        });
    });
});

describe("Natural Language Command Parsers", () => {
    describe("Natural Income Regexes", () => {
        const parseIncome = (text) => {
            const incMatch = text.match(/^\+([0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s*(.*)$/i) ||
                             text.match(/^income\s+([0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s*(.*)$/i);
            if (!incMatch) return null;
            return {
                amount: Number(incMatch[1]),
                currency: (incMatch[3] || "").toUpperCase(),
                category: incMatch[4]?.trim() || "Income"
            };
        };

        it("should match +<amount> syntax", () => {
            const res1 = parseIncome("+500 salary");
            expect(res1).toEqual({ amount: 500, currency: "", category: "salary" });

            const res2 = parseIncome("+250.50 usd freelance");
            expect(res2).toEqual({ amount: 250.5, currency: "USD", category: "freelance" });

            const res3 = parseIncome("+1000000 khr bonus");
            expect(res3).toEqual({ amount: 1000000, currency: "KHR", category: "bonus" });
        });

        it("should match income <amount> syntax", () => {
            const res = parseIncome("income 1200 usd client project");
            expect(res).toEqual({ amount: 1200, currency: "USD", category: "client project" });
        });
    });

    describe("Natural Expense Regexes", () => {
        const parseExpense = (text) => {
            const expMatch3 = text.match(/^(?:i\s+)?(?:spent|paid|bought)\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?\s*(?:on|for)?\s*([a-zA-Z\s]+)$/i);
            const expMatch4 = text.match(/^(?:i\s+)?(?:spent|paid|bought)\s+([a-zA-Z\s]+)\s+(?:for|at)?\s+(\$?[0-9]+(?:\.[0-9]+)?)\s*(usd|khr|\$|dollars|riel)?$/i);
            const expMatch1 = text.match(/^(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?\s+([a-zA-Z\s]+)$/i);
            const expMatch2 = text.match(/^([a-zA-Z\s]+)\s+(\$?[0-9]+(\.[0-9]+)?)\s*(usd|khr|\$)?$/i);

            if (expMatch3) {
                return {
                    amount: Number(expMatch3[1].replace("$", "")),
                    category: expMatch3[3].trim()
                };
            }
            if (expMatch4) {
                return {
                    amount: Number(expMatch4[2].replace("$", "")),
                    category: expMatch4[1].trim()
                };
            }
            if (expMatch1) {
                return {
                    amount: Number(expMatch1[1].replace("$", "")),
                    category: expMatch1[4].trim()
                };
            }
            if (expMatch2) {
                return {
                    amount: Number(expMatch2[2].replace("$", "")),
                    category: expMatch2[1].trim()
                };
            }
            return null;
        };

        it("should parse '<amount> <category>'", () => {
            expect(parseExpense("5 coffee")).toEqual({ amount: 5, category: "coffee" });
            expect(parseExpense("$12 lunch")).toEqual({ amount: 12, category: "lunch" });
            expect(parseExpense("15000 groceries")).toEqual({ amount: 15000, category: "groceries" });
        });

        it("should parse '<category> <amount>'", () => {
            expect(parseExpense("coffee 5")).toEqual({ amount: 5, category: "coffee" });
            expect(parseExpense("taxi 10000")).toEqual({ amount: 10000, category: "taxi" });
        });

        it("should parse conversational spending sentences", () => {
            expect(parseExpense("spent $15 on dinner")).toEqual({ amount: 15, category: "dinner" });
            expect(parseExpense("paid 20000 for gas")).toEqual({ amount: 20000, category: "gas" });
            expect(parseExpense("bought coffee for $4")).toEqual({ amount: 4, category: "coffee" });
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
