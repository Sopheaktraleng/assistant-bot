import { EXCHANGE_RATE } from "../config/constants.js";

export function cleanMd(text) {
    if (!text) return "";
    return text.replace(/([_*[\]()~`>#+\\|{}!])/g, "\\$1");
}

export function sanitizeMd(str) {
    if (!str) return "";
    return String(str).replace(/([_*`[\]])/g, " ");
}

export function formatMoney(value, minDecimals = 0, maxDecimals = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("en-US", {
        minimumFractionDigits: minDecimals,
        maximumFractionDigits: maxDecimals,
    });
}

export function formatAmount(amountInKhr, displayCurrency, forceDecimals = false) {
    const numKhr = Number(amountInKhr) || 0;
    if (displayCurrency === "USD") {
        const usd = numKhr / EXCHANGE_RATE;
        const isNegative = usd < 0;
        const absUsd = Math.abs(usd);
        const hasCents = absUsd % 1 !== 0;
        const formatted = absUsd.toLocaleString("en-US", {
            minimumFractionDigits: (forceDecimals || hasCents) ? 2 : 0,
            maximumFractionDigits: 2,
        });
        return isNegative ? `-$${formatted}` : `$${formatted}`;
    }
    const isNegative = numKhr < 0;
    const absKhr = Math.abs(numKhr);
    const formatted = absKhr.toLocaleString("en-US", {
        maximumFractionDigits: 0,
    });
    return isNegative ? `-${formatted} ៛` : `${formatted} ៛`;
}

export function capitalize(value) {
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1);
}

export function normalizeCategory(value) {
    const category = String(value || "").trim().replace(/\s+/g, " ");
    if (!category) return "Other";
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

export function getCategoryIcon(category, type = "expense") {
    const cat = (category || "").toLowerCase();
    if (cat.includes("food") || cat.includes("lunch") || cat.includes("dinner") || cat.includes("breakfast") || cat.includes("meal")) return "🍔";
    if (cat.includes("coffee") || cat.includes("tea") || cat.includes("cafe") || cat.includes("drink")) return "☕";
    if (cat.includes("transport") || cat.includes("bus") || cat.includes("gas") || cat.includes("fuel")) return "🚗";
    if (cat.includes("taxi") || cat.includes("passapp") || cat.includes("grab")) return "🚕";
    if (cat.includes("rent") || cat.includes("house") || cat.includes("room")) return "🏠";
    if (cat.includes("shop") || cat.includes("cloth") || cat.includes("buy")) return "🛍️";
    if (cat.includes("bill") || cat.includes("electric") || cat.includes("water") || cat.includes("internet") || cat.includes("wifi")) return "💡";
    if (cat.includes("salary") || cat.includes("wage") || cat.includes("paycheck")) return "💼";
    if (cat.includes("freelance") || cat.includes("client") || cat.includes("project")) return "💻";
    if (cat.includes("gift")) return "🎁";
    if (cat.includes("invest") || cat.includes("stock") || cat.includes("crypto") || cat.includes("dividend")) return "📈";
    if (cat.includes("bonus")) return "💰";
    return type === "income" ? "💵" : "💸";
}

export function getWorkCategoryIcon(category) {
    const cat = (category || "").toLowerCase();
    if (cat.includes("bug")) return "🐞";
    if (cat.includes("meet") || cat.includes("call") || cat.includes("sync") || cat.includes("standup")) return "👥";
    if (cat.includes("release") || cat.includes("deploy") || cat.includes("ship")) return "🚀";
    if (cat.includes("doc") || cat.includes("spec") || cat.includes("report") || cat.includes("manual")) return "📝";
    if (cat.includes("test") || cat.includes("qa") || cat.includes("audit")) return "🧪";
    if (cat.includes("design") || cat.includes("ui") || cat.includes("ux") || cat.includes("figma")) return "🎨";
    if (cat.includes("dev") || cat.includes("code") || cat.includes("api") || cat.includes("feature") || cat.includes("refactor")) return "💻";
    return "✅";
}

export function generateTextProgressBar(percent) {
    const totalBars = 6;
    const filled = Math.min(totalBars, Math.max(0, Math.round((percent / 100) * totalBars)));
    const empty = totalBars - filled;
    return "▰".repeat(filled) + "▱".repeat(empty);
}

export function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}
