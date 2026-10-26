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
