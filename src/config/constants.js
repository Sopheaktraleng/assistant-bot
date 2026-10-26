export const TIME_ZONE = "Asia/Phnom_Penh";
export const CURRENCY = "KHR";
export const EXCHANGE_RATE = 4000; // 1 USD = 4000 KHR

// Verified production models ordered by intelligence, reliability, and speed
export const GEMINI_MODELS = [
    "gemini-3.5-flash",       // High intelligence, reliable 200 OK, full reasoning
    "gemini-3.6-flash",       // Next-gen high intelligence flash
    "gemini-3.1-pro-preview", // Pro-tier intelligence (if account has quota/billing)
    "gemini-3.8-flash",       // Flagship flash
    "gemini-3.5-flash-lite"   // Lite speed fallback
];

export const QUICK_EXPENSE_CATS = [
    { name: "Food", icon: "🍔" },
    { name: "Coffee", icon: "☕" },
    { name: "Transport", icon: "🚗" },
    { name: "Taxi", icon: "🚕" },
    { name: "Shopping", icon: "🛍️" },
    { name: "Bills", icon: "💡" },
    { name: "Rent", icon: "🏠" },
    { name: "Other", icon: "✨" }
];

export const QUICK_INCOME_CATS = [
    { name: "Salary", icon: "💼" },
    { name: "Freelance", icon: "💻" },
    { name: "Gift", icon: "🎁" },
    { name: "Investment", icon: "📈" },
    { name: "Bonus", icon: "💰" },
    { name: "Other", icon: "✨" }
];

// Primary Owner Telegram User ID
export const OWNER_USER_ID = "849550186";

// Authorized Telegram User IDs (Personal assistant mode: owner + approved users)
export const DEFAULT_ALLOWED_USERS = ["849550186"];

/**
 * Checks whether a given Telegram user ID is the system Owner (Boss).
 */
export function isOwner(userId, env = {}) {
    if (!userId) return false;
    const ownerId = String(env?.OWNER_ID || env?.OWNER_TELEGRAM_ID || OWNER_USER_ID).trim();
    return String(userId).trim() === ownerId;
}

/**
 * Resolves the list of authorized Telegram user IDs.
 * Checks env.ALLOWED_USER_IDS or env.OWNER_TELEGRAM_ID / env.OWNER_ID,
 * and falls back to DEFAULT_ALLOWED_USERS in production.
 */
export function getAllowedUserIds(env = {}) {
    const raw = env?.ALLOWED_USER_IDS || env?.OWNER_TELEGRAM_ID || env?.OWNER_ID;
    if (typeof raw === "string" && raw.trim()) {
        return raw.split(",").map(id => id.trim()).filter(Boolean);
    }
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.map(String).map(s => s.trim()).filter(Boolean);
    }
    // In automated test environments without explicit ALLOWED_USER_IDS, permit mock users unless specified
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
        return null;
    }
    return DEFAULT_ALLOWED_USERS;
}

/**
 * Synchronous static authorization check (env / owner).
 */
export function isUserAuthorized(userId, env = {}) {
    if (!userId) return false;
    if (isOwner(userId, env)) return true;
    const allowed = getAllowedUserIds(env);
    if (!allowed) return true; // unrestricted test mode
    return allowed.includes(String(userId).trim());
}

/**
 * Asynchronous dynamic authorization check against environment whitelist and D1 authorized_users.
 */
export async function isUserAuthorizedAsync(db, userId, env = {}) {
    if (!userId) return false;
    if (isOwner(userId, env)) return true;
    if (isUserAuthorized(userId, env)) return true;
    if (db) {
        try {
            const row = await db
                .prepare("SELECT status FROM authorized_users WHERE user_id = ?")
                .bind(String(userId))
                .first();
            return row?.status === "active";
        } catch (_) {}
    }
    return false;
}
