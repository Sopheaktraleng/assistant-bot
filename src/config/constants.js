export const TIME_ZONE = "Asia/Phnom_Penh";
export const CURRENCY = "KHR";
export const EXCHANGE_RATE = 4000; // 1 USD = 4000 KHR

// Stable production models ordered by speed and multimodal capability
export const GEMINI_MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-2.5-flash",
    "gemini-flash-latest"
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
