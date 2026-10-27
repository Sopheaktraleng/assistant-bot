import { describe, it, expect } from "vitest";
import {
    formatMoney,
    formatAmount,
    capitalize,
    normalizeCategory,
    cleanMd,
    sanitizeMd,
    generateTextProgressBar,
    getCategoryIcon,
    getWorkCategoryIcon
} from "../src/utils/format.js";
import {
    today,
    monthPrefix,
    monthLabel,
    dateDaysAgo,
    getPreviousWorkdayDate,
    formatCambodiaDateTime,
    formatTimeFromCreatedAt
} from "../src/utils/time.js";
import { timingSafeEqual, validateTelegramInitData } from "../src/utils/crypto.js";

describe("Formatting Utilities", () => {
    describe("formatMoney", () => {
        it("should format integers with thousands commas", () => {
            expect(formatMoney(1000)).toBe("1,000");
            expect(formatMoney(1000000)).toBe("1,000,000");
            expect(formatMoney(4500)).toBe("4,500");
        });

        it("should handle zero and negative numbers", () => {
            expect(formatMoney(0)).toBe("0");
            expect(formatMoney(-500)).toBe("-500");
        });

        it("should format decimals correctly", () => {
            expect(formatMoney(1234.56)).toBe("1,234.56");
            expect(formatMoney(0.75)).toBe("0.75");
        });

        it("should return '0' for falsy or invalid input", () => {
            expect(formatMoney(null)).toBe("0");
            expect(formatMoney(undefined)).toBe("0");
            expect(formatMoney("abc")).toBe("0");
        });
    });

    describe("formatAmount", () => {
        it("should format USD amounts with dollar sign", () => {
            expect(formatAmount(20000, "USD")).toBe("$5");
            expect(formatAmount(4000, "USD")).toBe("$1");
            expect(formatAmount(5000, "USD")).toBe("$1.25");
            expect(formatAmount(2000, "USD")).toBe("$0.50"); // 0.5 USD formatted cleanly as $0.50
        });

        it("should format negative amounts correctly with sign preceding symbol", () => {
            expect(formatAmount(-163080, "USD")).toBe("-$40.77"); // Not $-40.77
            expect(formatAmount(-4000, "KHR")).toBe("-4,000 ៛");
        });

        it("should format KHR amounts with Riel symbol", () => {
            expect(formatAmount(4000, "KHR")).toBe("4,000 ៛");
            expect(formatAmount(20000, "KHR")).toBe("20,000 ៛");
        });
    });

    describe("capitalize", () => {
        it("should capitalize the first character", () => {
            expect(capitalize("food")).toBe("Food");
            expect(capitalize("transport")).toBe("Transport");
            expect(capitalize("hello world")).toBe("Hello world");
        });

        it("should handle empty or null values", () => {
            expect(capitalize("")).toBe("");
            expect(capitalize(null)).toBe("");
            expect(capitalize(undefined)).toBe("");
        });
    });

    describe("normalizeCategory", () => {
        it("should standardize category case", () => {
            expect(normalizeCategory("grab")).toBe("Grab");
            expect(normalizeCategory("coffee")).toBe("Coffee");
            expect(normalizeCategory("FOOD")).toBe("Food");
            expect(normalizeCategory("  lunch  ")).toBe("Lunch");
        });

        it("should fallback to Other when empty", () => {
            expect(normalizeCategory("")).toBe("Other");
            expect(normalizeCategory(null)).toBe("Other");
        });
    });

    describe("cleanMd & sanitizeMd", () => {
        it("cleanMd should escape Markdown special formatting characters", () => {
            const raw = "*Bold* and _italic_ with `code` [link](url)";
            const cleaned = cleanMd(raw);
            expect(cleaned).toBe("\\*Bold\\* and \\_italic\\_ with \\`code\\` \\[link\\]\\(url\\)");
        });

        it("sanitizeMd should replace markdown special characters with spaces", () => {
            const raw = "10*5_2`[test]";
            const sanitized = sanitizeMd(raw);
            expect(sanitized).toBe("10 5 2  test ");
        });
    });

    describe("generateTextProgressBar", () => {
        it("should generate empty bar for 0 percent", () => {
            const bar = generateTextProgressBar(0);
            expect(bar).toBe("▱▱▱▱▱▱");
        });

        it("should generate half filled bar for 50 percent", () => {
            const bar = generateTextProgressBar(50);
            expect(bar).toBe("▰▰▰▱▱▱");
        });

        it("should generate full bar for 100 percent or higher", () => {
            expect(generateTextProgressBar(100)).toBe("▰▰▰▰▰▰");
            expect(generateTextProgressBar(150)).toBe("▰▰▰▰▰▰");
        });
    });

    describe("Category Icons", () => {
        it("should return correct icons for finance categories", () => {
            expect(getCategoryIcon("Food")).toBe("🍔");
            expect(getCategoryIcon("Coffee")).toBe("☕");
            expect(getCategoryIcon("Salary")).toBe("💼");
            expect(getCategoryIcon("UnknownCat")).toBe("💸");
            expect(getCategoryIcon("UnknownCat", "income")).toBe("💵");
        });

        it("should return correct icons for work categories", () => {
            expect(getWorkCategoryIcon("Bugfix")).toBe("🐞");
            expect(getWorkCategoryIcon("Meeting")).toBe("👥");
            expect(getWorkCategoryIcon("Deploy")).toBe("🚀");
            expect(getWorkCategoryIcon("General")).toBe("✅");
        });
    });
});

describe("Time Utilities", () => {
    it("today should return format YYYY-MM-DD", () => {
        const d = today();
        expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("monthPrefix should return format YYYY-MM", () => {
        const m = monthPrefix();
        expect(m).toMatch(/^\d{4}-\d{2}$/);
    });

    it("monthLabel should return readable Month YYYY", () => {
        const label = monthLabel();
        expect(label).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    });

    it("dateDaysAgo(0) should equal today()", () => {
        expect(dateDaysAgo(0)).toBe(today());
    });

    it("dateDaysAgo(1) should return a valid previous date", () => {
        const prev = dateDaysAgo(1);
        expect(prev).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(prev).not.toBe(today());
    });

    it("getPreviousWorkdayDate should return a valid date format", () => {
        const prevWorkday = getPreviousWorkdayDate();
        expect(prevWorkday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("Crypto & Security Utilities", () => {
    describe("timingSafeEqual", () => {
        it("should return true for identical strings", () => {
            expect(timingSafeEqual("hello-world-secret", "hello-world-secret")).toBe(true);
            expect(timingSafeEqual("", "")).toBe(true);
        });

        it("should return false for different length strings", () => {
            expect(timingSafeEqual("short", "longer_string")).toBe(false);
        });

        it("should return false for same length different strings", () => {
            expect(timingSafeEqual("abc1234", "abc1235")).toBe(false);
        });

        it("should return false for non-string inputs", () => {
            expect(timingSafeEqual(null, "test")).toBe(false);
            expect(timingSafeEqual("test", undefined)).toBe(false);
            expect(timingSafeEqual(123, 123)).toBe(false);
        });
    });

    describe("validateTelegramInitData", () => {
        it("should return null for empty or missing inputs", async () => {
            expect(await validateTelegramInitData("", "bot_token")).toBeNull();
            expect(await validateTelegramInitData("data", "")).toBeNull();
            expect(await validateTelegramInitData("no_hash=true", "bot_token")).toBeNull();
        });

        it("should return null for invalid hash signature", async () => {
            const fakeData = "query_id=123&user=%7B%22id%22%3A12345%7D&auth_date=1700000000&hash=invalidhash1234567890abcdef";
            const result = await validateTelegramInitData(fakeData, "fake_bot_token");
            expect(result).toBeNull();
        });
    });

    describe("Cambodia Date & Time Formatting", () => {
        it("should format date and 12-hour time in Asia/Phnom_Penh", () => {
            const dt = formatCambodiaDateTime("2026-10-27T08:15:00Z");
            expect(dt.date).toBe("27 Oct 2026");
            expect(dt.time).toMatch(/3:15\s*PM/i);
            expect(dt.full).toContain("27 Oct 2026");
            expect(dt.full).toMatch(/3:15\s*PM/i);
        });

        it("should extract 12-hour time from SQLite UTC created_at timestamp", () => {
            const timeStr = formatTimeFromCreatedAt("2026-10-27 08:30:00");
            expect(timeStr).toMatch(/3:30\s*PM/i);
        });

        it("should handle null or invalid timestamps gracefully", () => {
            expect(formatTimeFromCreatedAt(null)).toBe("");
            expect(formatTimeFromCreatedAt("")).toBe("");
        });
    });
});
