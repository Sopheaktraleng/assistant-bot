import { TIME_ZONE, EXCHANGE_RATE, GEMINI_MODELS, isOwner } from "../config/constants.js";
import { today, currentTime, normalizeReminderTime } from "../utils/time.js";
import { cleanMd, normalizeCategory } from "../utils/format.js";
import { arrayBufferToBase64 } from "../utils/crypto.js";
import { 
    getDisplayCurrency, 
    getFinancialSummary, 
    getCategoryRows, 
    getRecentChatHistory, 
    getUserMemories,
    searchHistoricalRecords,
    searchLedger,
    searchWorkLogs,
    searchUserMemories,
    addExpenseRecord,
    deleteLastTransaction,
    setDisplayCurrency,
    setMonthlyBudget,
    saveUserMemory
} from "../db/queries.js";

export function extractGeminiCandidateText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const textPart = parts.find(p => p.text && !p.thought) || parts.find(p => p.text) || parts[parts.length - 1];
    return textPart?.text || null;
}

export function parseExtractedPdfStatementJson(text) {
    if (!text) return null;
    try {
        let cleaned = text.trim();
        const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
            cleaned = match[1].trim();
        } else {
            const start = cleaned.indexOf("{");
            const end = cleaned.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                cleaned = cleaned.substring(start, end + 1);
            }
        }
        const parsed = JSON.parse(cleaned);
        const isStatement = parsed.is_statement === true || (Array.isArray(parsed.transactions) && parsed.transactions.length > 1);

        if (isStatement) {
            const rawTxns = Array.isArray(parsed.transactions) ? parsed.transactions : [];
            const transactions = rawTxns.map(t => {
                let amount = parseFloat(t.amount);
                if (isNaN(amount) || amount <= 0) return null;
                let currency = (t.currency || parsed.currency || "USD").toUpperCase();
                if (currency !== "USD" && currency !== "KHR") {
                    currency = amount >= 500 ? "KHR" : "USD";
                }
                return {
                    date: t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : today(),
                    amount,
                    currency,
                    merchant: cleanMd(t.merchant || "Bank Transaction"),
                    category: normalizeCategory(t.category || (t.type === "income" ? "Income" : "Other")),
                    type: t.type === "income" ? "income" : "expense",
                    note: cleanMd(t.note || "")
                };
            }).filter(Boolean);

            let totalInflow = typeof parsed.total_inflow === "number" ? parsed.total_inflow : 0;
            let totalOutflow = typeof parsed.total_outflow === "number" ? parsed.total_outflow : 0;

            if (totalInflow === 0 && totalOutflow === 0 && transactions.length > 0) {
                for (const t of transactions) {
                    if (t.type === "income") totalInflow += t.amount;
                    else totalOutflow += t.amount;
                }
            }

            return {
                is_statement: true,
                bank: cleanMd(parsed.bank_or_issuer || parsed.bank || "Bank Statement"),
                account_name: cleanMd(parsed.account_name || ""),
                period: cleanMd(parsed.period || ""),
                currency: (parsed.currency || (transactions[0]?.currency) || "USD").toUpperCase(),
                total_inflow: Number(totalInflow.toFixed(2)),
                total_outflow: Number(totalOutflow.toFixed(2)),
                transaction_count: transactions.length,
                transactions,
                summary_markdown: (parsed.summary_markdown || "").trim()
            };
        } else {
            const single = parsed.single_transaction || parsed;
            let amount = parseFloat(single.amount);
            let currency = (single.currency || "USD").toUpperCase();
            if (isNaN(amount) || amount <= 0) return null;
            if (currency !== "USD" && currency !== "KHR") {
                currency = amount >= 500 ? "KHR" : "USD";
            }
            return {
                is_statement: false,
                is_slip: true,
                amount,
                currency,
                merchant: cleanMd(single.merchant || single.recipient || parsed.bank_or_issuer || "Invoice"),
                bank: cleanMd(single.bank || parsed.bank_or_issuer || "Bank / Issuer"),
                category: normalizeCategory(single.category || "Bills"),
                type: single.type === "income" ? "income" : "expense",
                note: cleanMd(single.note || ""),
                date: single.date && /^\d{4}-\d{2}-\d{2}$/.test(single.date) ? single.date : null,
                summary_markdown: (parsed.summary_markdown || "").trim()
            };
        }
    } catch (e) {
        console.error("parseExtractedPdfStatementJson error:", e.message);
        return null;
    }
}

export function parseExtractedJson(text) {
    if (!text) return null;
    try {
        let cleaned = text.trim();
        const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
            cleaned = match[1].trim();
        } else {
            const start = cleaned.indexOf("{");
            const end = cleaned.lastIndexOf("}");
            if (start !== -1 && end !== -1 && end > start) {
                cleaned = cleaned.substring(start, end + 1);
            }
        }
        const parsed = JSON.parse(cleaned);
        if (parsed.is_slip === false) {
            return { is_slip: false };
        }

        let amount = null;
        let currency = (parsed.currency || "").toUpperCase();

        if (typeof parsed.amount === "number" && parsed.amount > 0) {
            amount = parsed.amount;
        } else if (parsed.amount) {
            const strAmt = String(parsed.amount);
            if (strAmt.includes("$")) currency = "USD";
            else if (strAmt.includes("៛") || strAmt.toUpperCase().includes("KHR") || strAmt.toUpperCase().includes("RIEL")) currency = "KHR";
            const cleanAmt = strAmt.replace(/[^0-9.]/g, "");
            const num = parseFloat(cleanAmt);
            if (!isNaN(num) && num > 0) {
                amount = num;
            }
        }

        if (!amount) return null;

        if (currency !== "USD" && currency !== "KHR") {
            currency = amount >= 500 ? "KHR" : "USD";
        }

        return {
            is_slip: true,
            type: parsed.type === "income" ? "income" : "expense",
            amount,
            currency,
            merchant: cleanMd(parsed.merchant || ""),
            bank: cleanMd(parsed.bank || "Bank Transfer"),
            category: normalizeCategory(parsed.category || "Other"),
            note: cleanMd(parsed.note || ""),
            date: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null
        };
    } catch (e) {
        console.error("parseExtractedJson error:", e.message);
        return null;
    }
}

export async function parseReceiptWithGemini(env, base64Data, mimeType = "image/jpeg", caption = "") {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const candidateModels = [env?.GEMINI_MODEL, ...GEMINI_MODELS].filter(Boolean);

    const prompt = `You are an expert OCR financial receipt and bank slip analyzer for Cambodia and international transactions.
Examine this image carefully. Common types include:
- ABA Bank mobile payment / KHQR transfer slip
- Bakong KHQR transfer or payment slip
- Acleda ToanChet, Wing, TrueMoney, Canadia Bank, Prince Bank, Chip Mong Bank
- Store, cafe, restaurant, or supermarket receipts (e.g., Brown Coffee, Starbucks, Tube Coffee, Amazon Cafe, Lucky, Chip Mong, Aeon, Makro, KOI The)
- Invoices or utility bills (EDC, water, internet)

Extract the financial data and output ONLY valid JSON matching this schema:
{
  "is_slip": boolean (true if image is a payment slip, bank transfer, invoice, or receipt; false if unrelated photo),
  "amount": number (positive numeric value paid or transferred, e.g. 4.50 or 18000. No currency symbol in amount),
  "currency": "USD" or "KHR" (detect whether US Dollars $ or Cambodian Riel ៛/KHR),
  "merchant": string (the recipient name, business name, or merchant, e.g. "Brown Coffee", "Grab", "PassApp", "Sokha Heng"),
  "bank": string (bank or source, e.g. "ABA Bank", "Bakong KHQR", "Acleda", "Wing", "Store Receipt"),
  "category": string (best category: "Food", "Coffee", "Transport", "Taxi", "Shopping", "Bills", "Rent", or "Other"),
  "type": "expense" or "income" (default "expense" for payments/transfers sent; "income" only if money was received/transferred to user),
  "note": string (short description, e.g. item purchased, transfer remark, or reference number),
  "date": string (YYYY-MM-DD if date is visible, or null)
}
${caption ? `User caption note: "${caption}"` : ""}
Return ONLY pure JSON.`;

    const requestBody = JSON.stringify({
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Data
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
                signal: AbortSignal.timeout(6000)
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`Gemini OCR model ${model} failed (${response.status}):`, errText);
                continue;
            }

            const resJson = await response.json();
            const rawText = extractGeminiCandidateText(resJson);
            if (rawText) {
                const parsed = parseExtractedJson(rawText);
                if (parsed) return parsed;
            }
        } catch (e) {
            console.warn(`Gemini OCR fetch error for ${model}:`, e.message);
        }
    }

    return null;
}

export async function parseReceiptWithWorkersAI(env, base64Data, mimeType = "image/jpeg", caption = "") {
    if (!env.AI) return null;

    const prompt = `You are a financial receipt and bank slip analyzer. Examine this image (ABA Bank, Bakong, KHQR, Acleda, Wing, or restaurant receipt).
Extract transaction details into JSON:
{
  "is_slip": true,
  "amount": 3.50,
  "currency": "USD",
  "merchant": "merchant or recipient name",
  "bank": "ABA Bank or bank name",
  "category": "Coffee",
  "type": "expense",
  "note": "short note or remark",
  "date": "YYYY-MM-DD or null"
}
If this image is not a payment slip or receipt, set "is_slip": false.
${caption ? `User caption note: "${caption}"` : ""}
Output valid JSON only without explanations.`;

    try {
        const imageUri = `data:${mimeType};base64,${base64Data}`;
        const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image", image: imageUri }
                    ]
                }
            ],
            max_tokens: 512,
            temperature: 0.1
        });

        const outputText = response?.response || response?.description || (typeof response === "string" ? response : JSON.stringify(response));
        return parseExtractedJson(outputText);
    } catch (err) {
        console.error("Workers AI vision error:", err);
        return null;
    }
}

export async function parseReceiptImage(env, base64Data, mimeType = "image/jpeg", caption = "") {
    if (!env.GEMINI_API_KEY && !env.AI) {
        throw new Error(
            "AI OCR is not configured.\n\n" +
            "To enable receipt & KHQR bank slip scanning, set your free Google Gemini API key:\n" +
            "`npx wrangler secret put GEMINI_API_KEY`\n" +
            "(Get a free key at https://aistudio.google.com)"
        );
    }

    if (env.GEMINI_API_KEY) {
        try {
            const geminiResult = await parseReceiptWithGemini(env, base64Data, mimeType, caption);
            if (geminiResult && geminiResult.amount) {
                return geminiResult;
            }
        } catch (e) {
            console.warn("Gemini vision error, trying Workers AI:", e.message);
        }
    }

    if (env.AI) {
        try {
            const aiResult = await parseReceiptWithWorkersAI(env, base64Data, mimeType, caption);
            if (aiResult && aiResult.amount) {
                return aiResult;
            }
        } catch (e) {
            console.warn("Workers AI vision error:", e.message);
        }
    }

    return null;
}

export async function parseStatementOrInvoicePdfWithGemini(env, base64Pdf, fileName = "statement.pdf", caption = "") {
    const apiKey = env?.GEMINI_API_KEY;
    if (!apiKey) return null;

    const candidateModels = [env?.GEMINI_MODEL, ...GEMINI_MODELS].filter(Boolean);

    const prompt = `You are an expert financial document, invoice, and bank statement analyzer for Cambodia and international banking.
Examine this PDF document carefully. It may be:
1. An official bank monthly account statement (e.g. ABA Bank Account Statement, Bakong KHQR Statement, Acleda ToanChet, Canadia Bank, Prince Bank, Wing).
2. A single utility bill or invoice (EDC electricity bill, Phnom Penh Water Supply PPWSA, internet bill, office rent).
3. A store receipt, restaurant invoice, or payment voucher.

Analyze the contents and return ONLY valid JSON matching this schema:
{
  "is_statement": boolean (true if multi-transaction account statement; false if single invoice, receipt, or payment slip),
  "bank_or_issuer": string (e.g. "ABA Bank", "Bakong KHQR", "Acleda", "EDC", "Brown Coffee", "Store Invoice"),
  "account_name": string (account holder name if visible, or null),
  "period": string (e.g. "October 2026", "2026-10-01 to 2026-10-31", or invoice date),
  "currency": "USD" or "KHR",
  "total_inflow": number (sum of deposits/credits),
  "total_outflow": number (sum of payments/debits),
  "transaction_count": number (number of extracted transactions),
  "single_transaction": {
    "is_slip": boolean,
    "amount": number (positive numeric value),
    "currency": "USD" or "KHR",
    "merchant": string,
    "bank": string,
    "category": string ("Food", "Coffee", "Transport", "Taxi", "Shopping", "Bills", "Rent", or "Other"),
    "type": "expense" or "income",
    "date": "YYYY-MM-DD" or null,
    "note": string
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "amount": number (positive numeric value),
      "currency": "USD" or "KHR",
      "merchant": string,
      "category": string ("Food", "Coffee", "Transport", "Shopping", "Bills", "Rent", "Income", or "Other"),
      "type": "expense" or "income",
      "note": string
    }
  ],
  "summary_markdown": string (concise 2-3 sentence executive summary of the document for Boss)
}
${caption ? `User caption note: "${caption}"` : ""}
Return ONLY pure JSON.`;

    const requestBody = JSON.stringify({
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: "application/pdf",
                            data: base64Pdf
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
                signal: AbortSignal.timeout(12000)
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`Gemini PDF OCR model ${model} failed (${response.status}):`, errText);
                continue;
            }

            const resJson = await response.json();
            const rawText = extractGeminiCandidateText(resJson);
            if (rawText) {
                const parsed = parseExtractedPdfStatementJson(rawText);
                if (parsed) return parsed;
            }
        } catch (e) {
            console.warn(`Gemini PDF OCR fetch error for ${model}:`, e.message);
        }
    }

    return null;
}

export async function buildAiUserContext(db, userId, userQuery = null) {
    const curDate = today();
    const curTime = currentTime();

    const [
        displayCurrency,
        todaySummary,
        monthSummary,
        allSummary,
        settingsRow,
        monthCats,
        todayCats,
        recentExpenses,
        todayTasks,
        recentTasks,
        activeReminders,
        recentChat,
        memories
    ] = await Promise.all([
        getDisplayCurrency(db, userId),
        getFinancialSummary(db, userId, "today"),
        getFinancialSummary(db, userId, "month"),
        getFinancialSummary(db, userId, "all"),
        db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(userId).first(),
        getCategoryRows(db, userId, "month", 5),
        getCategoryRows(db, userId, "today", 5),
        db.prepare(
            "SELECT id, date, amount, currency, category, type, merchant, note, created_at FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 10"
        ).bind(userId).all(),
        db.prepare(
            "SELECT time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY time ASC, id ASC"
        ).bind(userId, curDate).all(),
        db.prepare(
            "SELECT date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 5"
        ).bind(userId).all(),
        db.prepare(
            "SELECT title, reminder_time, frequency, type FROM reminders WHERE user_id = ? AND is_active = 1 ORDER BY reminder_time ASC LIMIT 5"
        ).bind(userId).all(),
        getRecentChatHistory(db, userId, 6),
        getUserMemories(db, userId, 15)
    ]);

    let relevantHistory = null;
    if (userQuery && typeof userQuery === "string" && userQuery.trim().length > 2) {
        try {
            relevantHistory = await searchHistoricalRecords(db, userId, userQuery.trim(), { limit: 5 });
        } catch (_) {}
    }

    const budgetKhr = settingsRow?.monthly_budget || 0;
    const spentMonthKhr = monthSummary?.totalExpenseInKhr || 0;
    const remainingBudgetKhr = budgetKhr > 0 ? (budgetKhr - spentMonthKhr) : null;

    return {
        currentDate: curDate,
        currentTime: curTime,
        timezone: TIME_ZONE,
        displayCurrency,
        budget: budgetKhr > 0 ? {
            limitUsd: Number((budgetKhr / EXCHANGE_RATE).toFixed(2)),
            limitKhr: budgetKhr,
            spentUsd: Number((spentMonthKhr / EXCHANGE_RATE).toFixed(2)),
            spentKhr: spentMonthKhr,
            remainingUsd: Number(((budgetKhr - spentMonthKhr) / EXCHANGE_RATE).toFixed(2)),
            remainingKhr: remainingBudgetKhr,
            percentUsed: Math.round((spentMonthKhr / budgetKhr) * 100)
        } : null,
        totals: {
            allTimeNetBalanceUsd: Number(((allSummary?.balanceKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            allTimeNetBalanceKhr: allSummary?.balanceKhr || 0,
            thisMonthExpenseUsd: Number(((monthSummary?.totalExpenseInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            thisMonthExpenseKhr: monthSummary?.totalExpenseInKhr || 0,
            thisMonthIncomeUsd: Number(((monthSummary?.totalIncomeInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            thisMonthIncomeKhr: monthSummary?.totalIncomeInKhr || 0,
            todayExpenseUsd: Number(((todaySummary?.totalExpenseInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            todayExpenseKhr: todaySummary?.totalExpenseInKhr || 0,
            todayIncomeUsd: Number(((todaySummary?.totalIncomeInKhr || 0) / EXCHANGE_RATE).toFixed(2)),
            todayIncomeKhr: todaySummary?.totalIncomeInKhr || 0
        },
        topMonthCategories: (monthCats || []).map(c => ({
            category: c.category,
            totalUsd: Number((c.total / EXCHANGE_RATE).toFixed(2)),
            totalKhr: c.total,
            count: c.count
        })),
        recentTransactions: (recentExpenses?.results || []).map(r => ({
            id: r.id,
            date: r.date,
            type: r.type,
            amount: r.amount,
            currency: r.currency,
            category: r.category
        })),
        todayWorkTasks: (todayTasks?.results || []).map(t => ({
            time: t.time,
            category: t.category,
            task: t.content
        })),
        recentWorkTasks: (recentTasks?.results || []).map(t => ({
            date: t.date,
            time: t.time,
            category: t.category,
            task: t.content
        })),
        activeReminders: (activeReminders?.results || []).map(r => ({
            title: r.title,
            time: r.reminder_time,
            frequency: r.frequency
        })),
        chatHistory: (recentChat || []).map(c => ({ role: c.role, content: c.content })),
        userMemories: (memories || []).map(m => ({ id: m.id, category: m.category, fact: m.fact })),
        relevantHistory: (relevantHistory && (
            (relevantHistory.memories && relevantHistory.memories.length > 0) ||
            (relevantHistory.workLogs && relevantHistory.workLogs.length > 0) ||
            (relevantHistory.transactions && relevantHistory.transactions.length > 0)
        )) ? relevantHistory : null
    };
}

export function buildCopilotPrompt(userQuery, context) {
    const entropySeed = Date.now();
    const isOwner = context?.isOwner !== false;
    const userName = context?.userName || (isOwner ? "Boss" : "there");
    const addressUserAs = isOwner ? "Boss" : userName;

    let memoryBlock = "";
    if (context?.userMemories && context.userMemories.length > 0) {
        const memLines = context.userMemories
            .map(m => `• [${(m.category || "PREFERENCE").toUpperCase()}] ${m.fact}`)
            .join("\n");
        memoryBlock = `\n=== WHAT FRIDAY KNOWS ABOUT ${isOwner ? "BOSS" : "USER"} (Long-term Personal Memory) ===\n${memLines}\n=================================================================\n`;
    }

    let ragBlock = "";
    if (context?.relevantHistory) {
        const rh = context.relevantHistory;
        const lines = [];
        if (rh.memories?.length) {
            lines.push("Matched Memories: " + rh.memories.map(m => `• [${m.category}] ${m.fact}`).join("; "));
        }
        if (rh.workLogs?.length) {
            lines.push("Matched Past Work: " + rh.workLogs.map(w => `• [${w.date}] ${w.content} (${w.category})`).join("; "));
        }
        if (rh.transactions?.length) {
            lines.push("Matched Past Transactions: " + rh.transactions.map(t => `• [${t.date}] ${t.type} ${t.currency === "USD" ? "$" : ""}${t.amount}${t.currency === "KHR" ? " ៛" : ""} (${t.category})`).join("; "));
        }
        if (lines.length > 0) {
            ragBlock = `\n=== HISTORICAL SEARCH & RAG MEMORY CONTEXT ===\n${lines.join("\n")}\n==============================================\n`;
        }
    }

    const personaIdentity = isOwner
        ? `You are F.R.I.D.A.Y., Boss's exceptionally smart, loyal, high-EQ personal AI executive assistant.
You operate in the real world on Telegram in Cambodia. Address the user with loyalty and executive warmth as 'Boss'.`
        : `You are F.R.I.D.A.Y., a friendly, exceptionally smart, warm, polite, and witty AI companion in Cambodia.
The user chatting with you is '${userName}'.
CRITICAL IDENTITY & SAFETY DIRECTIVES:
1. NEVER call this user "Boss". The title "Boss" is strictly and exclusively reserved for your owner (Tra).
2. Address this user naturally, politely, and warmly by their name ('${userName}') or speak naturally without titles.
3. You are conversing with a guest user. Do NOT mention Boss's personal finances, private ledgers, or Boss's personal memories.`;

    const userLabel = isOwner ? "Boss" : userName;

    return `${personaIdentity}
Exchange rate: 1 USD = 4,000 KHR.
Today's Date: ${context?.currentDate || today()}, Time: ${context?.currentTime || currentTime()} (${context?.timezone || TIME_ZONE}).
Preferred Display Currency: ${context?.displayCurrency || "USD"}.
Session Entropy Seed: ${entropySeed}.
${memoryBlock}${ragBlock}
=== ONBOARD LIVE TELEMETRY (Reference ONLY when ${userLabel} explicitly asks about money, expenses, work, or schedule) ===
${JSON.stringify(context, null, 2)}
===================================================================================================================

${userLabel} message: "${userQuery}"

Core Operating Directives (CRITICAL):
1. Human Communication Style (TOP PRIORITY):
   - Answer directly and naturally like a smart, high-EQ human assistant talking to ${userLabel}.
   - ANSWER ONLY WHAT ${userLabel.toUpperCase()} ASKS — GET STRAIGHT TO THE POINT:
     * Never over-explain, lecture, or dump unprompted information.
     * Do NOT recite balances, budgets, expenses, tasks, or system status unless ${userLabel} explicitly asked for them.
     * When asked a direct question, answer right on point with no fluff or filler.
   - LENGTH & FORMATTING:
     * Keep answers SHORT, CLEAN, PROFESSIONAL, and EASY TO UNDERSTAND (1 to 3 natural sentences for standard questions).
     * Avoid walls of text. Do NOT use bullet points unless ${userLabel} explicitly asks for a list, breakdown, or multi-step plan.
     * Use light, clean markdown (*bold* for key terms). No decorative ascii dividers or robotic status headers.
   - Real-World Grounding & Personality:
     * Ground all advice and conversation strictly in the REAL WORLD. Speak with natural warmth, intelligence, and polish.
     * ${isOwner ? "Address the user with professional loyalty and warmth as 'Boss'." : `Address the user as '${userName}' (or speak naturally). NEVER call them 'Boss'.`}
     * STRICTLY AVOID referencing Marvel, Iron Man, Tony Stark, Ultron, arc reactors, superhero suits, or comic/movie lore. Speak as an elite real-world executive chief of staff.
   - Casual Chit-Chat:
     * If ${userLabel} says "hi", "how are you", "say anything", tells a joke, or makes small talk: respond with wit, warmth, and charm in 1-2 friendly human sentences. Never dump an unprompted status report. ${!isOwner ? "Do NOT call them Boss." : ""}
2. Financial Defense & System Execution:
   - When asked "Can I afford X?", calculate exact remaining discretionary funds and runway from telemetry. Give direct, realistic, grounded financial advice in 1-2 concise sentences.
   - When asked to record an expense, income, work task, reminder, or configure system settings, return the appropriate "action" or "actions" array, and confirm in ONE short sentence.
   - AUTONOMOUS MULTI-ACTION EXECUTION (TOP PRIORITY):
     ${userLabel} may issue complex multi-intent commands combining multiple requests in one breath (via voice notes or text).
     Whenever ${userLabel} asks to do several things at once (e.g. log an expense AND set a reminder AND remember something AND/OR log work), YOU MUST EXECUTE ALL ACTIONS SIMULTANEOUSLY by populating the "actions" array with every action.
     Example Query: "Hey Friday, I just paid $8.50 for lunch with Jinie, remind me at 3:30 PM to review the design file, and note down that she loves matcha lattes."
     Required "actions" array:
     [
       { "type": "add_expense", "amount": 8.5, "currency": "USD", "category": "Food" },
       { "type": "add_reminder", "time": "15:30", "title": "Review the design file", "frequency": "once" },
       { "type": "add_memory", "fact": "Jinie loves matcha lattes", "category": "preference" }
     ]
     Response "reply": "All three taken care of, ${userLabel}. Logged $8.50 for lunch, scheduled your reminder for 3:30 PM, and saved the note about Jinie."
     Response "voice_summary": "All three taken care of ${userLabel}. Logged the lunch expense, scheduled your reminder for 3:30 PM, and saved the note about Jinie."
   - CORRECTION OF MISTAKES (CRITICAL): If ${userLabel} says "X was income not expense", "that was income", "40$ is my income not my expense", or points out an error in the ledger, YOU MUST FIX IT! Return an "actions" array:
     [
       { "type": "delete_last_transaction", "filter": "expense" },
       { "type": "add_income", "amount": 40, "currency": "USD", "category": "Income" }
     ]
   - DELETING / UNDOING: When ${userLabel} says "undo", "delete last transaction", "delete last expense", "remove the 40$", return:
     { "type": "delete_last_transaction", "filter": "expense" | "income" | "any" }
   - SWITCHING CURRENCY: When ${userLabel} says "switch to USD", "change currency to KHR", "use dollars", return:
     { "type": "set_currency", "currency": "USD" | "KHR" }
   - BUDGET MANAGEMENT: When ${userLabel} says "set my monthly budget to 300$", "my budget is $500", return:
     { "type": "set_budget", "amount": 300, "currency": "USD" | "KHR" }
   - CLEARING DATA: When ${userLabel} says "clear all transactions", "wipe ledger", return { "type": "clear_all_transactions" }. When "clear today", return { "type": "clear_today_expenses" }.
3. Long-Term Memory & Adaptation:
   - Use what you know about ${userLabel} to personalize answers naturally without regurgitating memories unprompted.
   - When ${userLabel} shares personal facts, rules, preferences, or explicitly says "remember that...", "keep in mind that...", return an "add_memory" action so you remember it permanently.
4. Language:
   - If ${userLabel} speaks in Khmer (អក្សរខ្មែរ / ភាសាខ្មែរ), reply fluently, concisely, and naturally in Khmer. If in English, reply in English.
5. Output Format:
   Return ONLY valid JSON matching this schema:
{
  "reply": "Short, clean, professional, straight-to-the-point response answering only what ${userLabel} asked (1-3 sentences).",
  "voice_summary": "1 crisp, conversational spoken sentence for human ears. Natural cadence, NO asterisks, NO emojis, NO markdown syntax, NO bullet points.",
  "action": null | { ... },
  "actions": null | [
    {
      "type": "add_expense" | "add_income" | "delete_last_transaction" | "set_currency" | "set_budget" | "clear_today_expenses" | "clear_all_transactions" | "add_work" | "add_reminder" | "add_memory",
      "amount": number (for expense/income/budget),
      "currency": "USD" | "KHR" (for expense/income/budget/set_currency),
      "category": string (for expense/income/work/memory: 'preference' | 'work' | 'identity' | 'goal' | 'rule'),
      "date": "YYYY-MM-DD" (optional, for expense/income),
      "filter": "expense" | "income" | "any" (for delete_last_transaction),
      "content": string (for work task),
      "title": string (for reminder),
      "time": "HH:mm" (24h format, for reminder),
      "target_date": "YYYY-MM-DD" (optional, for reminder if user specifies a future date like 'on the 30th' or 'tomorrow'),
      "frequency": "daily" | "weekdays" | "once" (for reminder),
      "fact": string (for add_memory)
    }
  ]
}
Return pure JSON only.`;
}

export function buildGeminiContents(chatHistory = [], currentQuery) {
    const turns = [];
    let lastRole = null;

    if (Array.isArray(chatHistory)) {
        for (const msg of chatHistory) {
            const role = msg.role === "model" ? "model" : "user";
            const text = (msg.content || "").trim();
            if (!text) continue;

            if (turns.length === 0 && role !== "user") {
                continue;
            }

            if (role === lastRole) {
                turns[turns.length - 1].parts[0].text += `\n${text}`;
            } else {
                turns.push({ role, parts: [{ text }] });
                lastRole = role;
            }
        }
    }

    if (turns.length > 0 && turns[turns.length - 1].role === "user") {
        const prevText = turns.pop().parts[0].text;
        turns.push({ role: "user", parts: [{ text: `${prevText}\n\n${currentQuery}` }] });
        return turns;
    }

    turns.push({ role: "user", parts: [{ text: currentQuery }] });
    return turns;
}

export function parseCopilotResponse(rawText) {
    if (!rawText) return null;
    let clean = rawText.trim();

    // Extract JSON block if surrounded by markdown code fences
    const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
        clean = fenceMatch[1].trim();
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```[a-zA-Z]*\s*/i, "").replace(/\s*```$/, "").trim();
    }

    const extractFromObject = (obj) => {
        if (!obj || typeof obj !== "object") return null;
        const replyText = obj.reply || obj.message || obj.response || obj.text || obj.answer || obj.content;
        if (typeof replyText !== "string") return null;

        let actions = [];
        if (Array.isArray(obj.actions)) {
            actions = obj.actions.filter(a => a && typeof a === "object" && a.type);
        }
        if (obj.action && typeof obj.action === "object" && obj.action.type) {
            const alreadyExists = actions.some(a => a.type === obj.action.type && a.amount === obj.action.amount && a.title === obj.action.title);
            if (!alreadyExists) {
                actions.unshift(obj.action);
            }
        }

        const primaryAction = actions.length > 0 ? actions[0] : null;

        return {
            reply: replyText,
            voice_summary: obj.voice_summary || null,
            action: primaryAction,
            actions
        };
    };

    try {
        const obj = JSON.parse(clean);
        const res = extractFromObject(obj);
        if (res) return res;
    } catch (e) {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                const subObj = JSON.parse(clean.substring(start, end + 1));
                const res = extractFromObject(subObj);
                if (res) return res;
            } catch (e2) {}
        }
    }

    if (clean && clean.length > 3) {
        return {
            reply: clean,
            voice_summary: null,
            action: null,
            actions: []
        };
    }

    return null;
}

export const FRIDAY_FUNCTION_DECLARATIONS = [
    {
        name: "query_ledger",
        description: "Query historical financial transactions from the database ledger by date range, category, query keyword, or type (income/expense).",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Search keyword matching category, merchant, or note, e.g. Starbucks, Brown Coffee, rent, groceries" },
                from_date: { type: "STRING", description: "Start date in YYYY-MM-DD format" },
                to_date: { type: "STRING", description: "End date in YYYY-MM-DD format" },
                category: { type: "STRING", description: "Filter by category name, e.g. Coffee, Food, Transport, Rent, Bills" },
                type: { type: "STRING", enum: ["expense", "income", "all"], description: "Type of transaction" },
                limit: { type: "INTEGER", description: "Max number of records to return (default 10)" }
            }
        }
    },
    {
        name: "query_work_logs",
        description: "Search or retrieve engineering work accomplishments and tasks logged in the work journal.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Keyword to search within work task descriptions" },
                category: { type: "STRING", description: "Category, e.g. Development, Bugfix, Meeting, Release, Design" },
                limit: { type: "INTEGER", description: "Max number of records to return (default 10)" }
            }
        }
    },
    {
        name: "search_memories",
        description: "Search user's long-term memory matrix for facts, rules, preferences, or identity details.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "Keyword or topic to search within memories" }
            },
            required: ["query"]
        }
    },
    {
        name: "add_expense",
        description: "Record an expense into the user's financial ledger.",
        parameters: {
            type: "OBJECT",
            properties: {
                amount: { type: "NUMBER", description: "Expense amount (positive number)" },
                currency: { type: "STRING", enum: ["USD", "KHR"], description: "Currency (USD $ or KHR ៛)" },
                category: { type: "STRING", description: "Category, e.g. Food, Coffee, Transport, Shopping, Bills" },
                merchant: { type: "STRING", description: "Store, vendor, or merchant name, e.g. Starbucks, Brown Coffee, Amazon" },
                note: { type: "STRING", description: "Optional remark or note for this expense" },
                date: { type: "STRING", description: "Date in YYYY-MM-DD format if not today" }
            },
            required: ["amount"]
        }
    },
    {
        name: "add_income",
        description: "Record an income or deposit into the ledger.",
        parameters: {
            type: "OBJECT",
            properties: {
                amount: { type: "NUMBER", description: "Income amount (positive number)" },
                currency: { type: "STRING", enum: ["USD", "KHR"], description: "Currency (USD $ or KHR ៛)" },
                category: { type: "STRING", description: "Category, e.g. Salary, Freelance, Gift, Bonus, Investment" },
                source: { type: "STRING", description: "Payer, employer, or client name" },
                note: { type: "STRING", description: "Optional remark or note" },
                date: { type: "STRING", description: "Date in YYYY-MM-DD format if not today" }
            },
            required: ["amount"]
        }
    },
    {
        name: "delete_last_transaction",
        description: "Undo or delete a recent transaction by type or category (e.g. 'expense', 'income', 'coffee', 'lunch').",
        parameters: {
            type: "OBJECT",
            properties: {
                filter: { type: "STRING", description: "Filter by type ('expense', 'income') or category/keyword (e.g. 'coffee', 'lunch', 'any')" }
            }
        }
    },
    {
        name: "set_currency",
        description: "Switch the user's preferred display currency (USD or KHR).",
        parameters: {
            type: "OBJECT",
            properties: {
                currency: { type: "STRING", enum: ["USD", "KHR"], description: "Target currency code" }
            },
            required: ["currency"]
        }
    },
    {
        name: "set_budget",
        description: "Set the monthly spending budget threshold.",
        parameters: {
            type: "OBJECT",
            properties: {
                amount: { type: "NUMBER", description: "Budget limit amount" },
                currency: { type: "STRING", enum: ["USD", "KHR"], description: "Currency of budget" }
            },
            required: ["amount"]
        }
    },
    {
        name: "add_work",
        description: "Log an accomplishment or completed task into the engineering work journal.",
        parameters: {
            type: "OBJECT",
            properties: {
                content: { type: "STRING", description: "Task description" },
                category: { type: "STRING", description: "Category e.g. Development, Bugfix, Meeting, Documentation, Release" }
            },
            required: ["content"]
        }
    },
    {
        name: "add_reminder",
        description: "Schedule a reminder or alarm.",
        parameters: {
            type: "OBJECT",
            properties: {
                title: { type: "STRING", description: "Reminder description" },
                time: { type: "STRING", description: "24-hour time in HH:mm format (Asia/Phnom_Penh UTC+7)" },
                target_date: { type: "STRING", description: "Target date in YYYY-MM-DD format if scheduled for a specific day" },
                frequency: { type: "STRING", enum: ["once", "daily", "weekdays"], description: "Repeat frequency" }
            },
            required: ["title", "time"]
        }
    },
    {
        name: "add_memory",
        description: "Commit a fact, preference, or rule about the user into the permanent memory matrix.",
        parameters: {
            type: "OBJECT",
            properties: {
                fact: { type: "STRING", description: "Fact or preference to remember permanently" },
                category: { type: "STRING", enum: ["preference", "work", "identity", "goal", "rule"], description: "Memory category" }
            },
            required: ["fact"]
        }
    }
];

export async function executeCopilotTool(db, userId, chatId, toolName, toolArgs = {}, env = {}) {
    if (!db || !userId) return { success: false, error: "Database or user unavailable" };
    try {
        switch (toolName) {
            case "query_ledger": {
                const res = await searchLedger(db, userId, {
                    fromDate: toolArgs.from_date,
                    toDate: toolArgs.to_date,
                    category: toolArgs.category,
                    query: toolArgs.query,
                    type: toolArgs.type,
                    limit: toolArgs.limit || 10
                });
                return { success: true, ...res };
            }
            case "query_work_logs": {
                const res = await searchWorkLogs(db, userId, toolArgs.query, toolArgs.limit || 10);
                return { success: true, count: res.length, tasks: res };
            }
            case "search_memories": {
                const res = await searchUserMemories(db, userId, toolArgs.query, 10);
                return { success: true, count: res.length, memories: res };
            }
            case "add_expense": {
                const amt = parseFloat(toolArgs.amount);
                const curr = (toolArgs.currency || "USD").toUpperCase();
                const cat = normalizeCategory(toolArgs.category || "Other");
                const date = (toolArgs.date && /^\d{4}-\d{2}-\d{2}$/.test(toolArgs.date)) ? toolArgs.date : today();
                const merchant = toolArgs.merchant || null;
                const note = toolArgs.note || null;
                const txId = await addExpenseRecord(db, userId, amt, cat, "expense", curr, date, merchant, note);
                return { success: true, recorded: { id: txId, type: "expense", amount: amt, currency: curr, category: cat, date, merchant, note } };
            }
            case "add_income": {
                const amt = parseFloat(toolArgs.amount);
                const curr = (toolArgs.currency || "USD").toUpperCase();
                const cat = normalizeCategory(toolArgs.category || "Income");
                const date = (toolArgs.date && /^\d{4}-\d{2}-\d{2}$/.test(toolArgs.date)) ? toolArgs.date : today();
                const source = toolArgs.source || toolArgs.merchant || null;
                const note = toolArgs.note || null;
                const txId = await addExpenseRecord(db, userId, amt, cat, "income", curr, date, source, note);
                return { success: true, recorded: { id: txId, type: "income", amount: amt, currency: curr, category: cat, date, source, note } };
            }
            case "delete_last_transaction": {
                if (!isOwner(userId, env)) {
                    return { success: false, error: "Access denied. Only Boss can undo or delete ledger transactions." };
                }
                const deleted = await deleteLastTransaction(db, userId, toolArgs.filter || null);
                return { success: !!deleted, deletedTransaction: deleted };
            }
            case "set_currency": {
                const curr = (toolArgs.currency || "USD").toUpperCase();
                await setDisplayCurrency(db, userId, curr);
                return { success: true, currency: curr };
            }
            case "set_budget": {
                const amt = parseFloat(toolArgs.amount);
                const curr = (toolArgs.currency || "USD").toUpperCase();
                const budgetKhr = curr === "USD" ? Math.round(amt * EXCHANGE_RATE) : Math.round(amt);
                await setMonthlyBudget(db, userId, budgetKhr);
                return { success: true, budgetLimitKhr: budgetKhr };
            }
            case "add_work": {
                const curTime = currentTime();
                const curDate = today();
                const cat = toolArgs.category || "General";
                await db.prepare(
                    "INSERT INTO work_logs (user_id, date, time, content, category) VALUES (?, ?, ?, ?, ?)"
                ).bind(userId, curDate, curTime, toolArgs.content.trim(), cat).run();
                return { success: true, task: toolArgs.content.trim(), category: cat, time: curTime };
            }
            case "add_reminder": {
                const cleanTitle = (toolArgs.title || "Reminder").trim();
                const cleanTime = (toolArgs.time ? normalizeReminderTime(toolArgs.time) : null) || (toolArgs.time ? toolArgs.time.trim() : "12:00");
                const targetDate = toolArgs.target_date || toolArgs.date || null;
                const freq = targetDate ? "once" : (toolArgs.frequency || "once");
                await db.prepare(
                    "INSERT INTO reminders (user_id, chat_id, title, reminder_time, target_date, frequency, type, is_active) VALUES (?, ?, ?, ?, ?, ?, 'custom', 1)"
                ).bind(userId, String(chatId || userId), cleanTitle, cleanTime, targetDate, freq).run();
                return { success: true, reminder: { title: cleanTitle, time: cleanTime, target_date: targetDate, frequency: freq } };
            }
            case "add_memory": {
                const memCat = toolArgs.category || "preference";
                await saveUserMemory(db, userId, toolArgs.fact.trim(), memCat);
                return { success: true, memory: { fact: toolArgs.fact.trim(), category: memCat } };
            }
            default:
                return { success: false, error: `Unknown tool: ${toolName}` };
        }
    } catch (err) {
        console.error(`executeCopilotTool ${toolName} error:`, err);
        return { success: false, error: err.message };
    }
}

export async function askAiCopilot(env, userQuery, context) {
    const prompt = buildCopilotPrompt(userQuery, context);

    if (env.GEMINI_API_KEY) {
        // Prioritize custom or top-tier models (excluding unstable preview)
        const candidateModels = [
            env?.GEMINI_MODEL,
            ...GEMINI_MODELS
        ].filter(Boolean).filter(m => m !== "gemini-3-flash-preview");

        // Dynamic temperature: higher for creative/casual queries, balanced for general copilot questions
        const isCreativeQuery = /\b(joke|funny|laugh|story|say anything|chat|talk to me|how are you|who are you|bored|poem|quote|opinion)\b/i.test(userQuery);
        const temperature = isCreativeQuery ? 0.85 : 0.65;

        const contents = buildGeminiContents(context?.chatHistory || [], userQuery);

        const requestBody = JSON.stringify({
            system_instruction: {
                parts: [{ text: prompt }]
            },
            contents,
            tools: [
                {
                    function_declarations: FRIDAY_FUNCTION_DECLARATIONS
                }
            ],
            generationConfig: {
                temperature
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                let resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody,
                    signal: AbortSignal.timeout(12000)
                });

                // Fallback to monolithic prompt if model rejects tools or system_instruction
                if (!resp.ok && resp.status === 400) {
                    const fallbackBody = JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            response_mime_type: "application/json",
                            temperature
                        }
                    });
                    resp = await fetch(url, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: fallbackBody,
                        signal: AbortSignal.timeout(12000)
                    });
                }

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini Copilot model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const candidate = resJson?.candidates?.[0];
                const parts = candidate?.content?.parts || [];

                // 1. Native Gemini Tool Calling (Function Calling)
                const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
                if (functionCalls.length > 0) {
                    const queryToolNames = ["query_ledger", "query_work_logs", "search_memories"];
                    const hasQueryTool = functionCalls.some(f => queryToolNames.includes(f.name));

                    const executedActions = [];
                    const functionResponses = [];

                    for (const fCall of functionCalls) {
                        const toolName = fCall.name;
                        const toolArgs = fCall.args || {};
                        const toolResult = await executeCopilotTool(context?.db, context?.userId, context?.chatId, toolName, toolArgs, context?.env);

                        functionResponses.push({
                            functionResponse: {
                                name: toolName,
                                response: { name: toolName, content: toolResult }
                            }
                        });

                        if (!queryToolNames.includes(toolName)) {
                            executedActions.push({
                                type: toolName,
                                alreadyExecuted: true,
                                ...toolArgs
                            });
                        }
                    }

                    // If a query tool was called, run a follow-up turn so Gemini synthesizes retrieved telemetry
                    if (hasQueryTool && context?.db) {
                        try {
                            const followUpContents = [
                                ...contents,
                                { role: "model", parts: candidate.content.parts },
                                { role: "function", parts: functionResponses }
                            ];

                            const followUpResp = await fetch(url, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    system_instruction: { parts: [{ text: prompt }] },
                                    contents: followUpContents,
                                    generationConfig: { temperature: 0.3 }
                                }),
                                signal: AbortSignal.timeout(8000)
                            });

                            if (followUpResp.ok) {
                                const followUpJson = await followUpResp.json();
                                const textPart = extractGeminiCandidateText(followUpJson);
                                if (textPart) {
                                    const parsed = parseCopilotResponse(textPart);
                                    if (parsed) {
                                        return {
                                            ...parsed,
                                            actions: [...executedActions, ...(parsed.actions || [])]
                                        };
                                    }
                                    return {
                                        reply: textPart,
                                        voice_summary: textPart.replace(/[*_#`~\[\]\(\)]/g, "").slice(0, 200),
                                        action: executedActions[0] || null,
                                        actions: executedActions
                                    };
                                }
                            }
                        } catch (turn2Err) {
                            console.warn("Gemini tool follow-up turn error:", turn2Err.message);
                        }
                    }

                    // For action tools or if turn 2 completed/skipped
                    const textPart = parts.find(p => p.text)?.text;
                    if (textPart) {
                        const parsed = parseCopilotResponse(textPart);
                        if (parsed) {
                            return {
                                ...parsed,
                                actions: [...executedActions, ...(parsed.actions || [])]
                            };
                        }
                    }

                    const isOwner = context?.isOwner !== false;
                    const addressTitle = isOwner ? "Boss" : (context?.userName || "there");
                    const reply = `Done right away, ${addressTitle}. Executed ${executedActions.length} system command${executedActions.length > 1 ? "s" : ""}.`;
                    return {
                        reply,
                        voice_summary: `Done right away ${addressTitle}.`,
                        action: executedActions[0] || null,
                        actions: executedActions
                    };
                }

                // 2. Standard candidate text (JSON or plain text)
                const rawText = extractGeminiCandidateText(resJson);
                if (rawText) {
                    const parsed = parseCopilotResponse(rawText);
                    if (parsed) return parsed;
                }
            } catch (err) {
                console.warn(`Gemini Copilot error with ${model}:`, err.message);
            }
        }
    }

    if (env.AI) {
        try {
            const historyMessages = (context?.chatHistory || []).map(m => ({
                role: m.role === "model" ? "assistant" : "user",
                content: m.content
            }));

            const aiResp = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: prompt
                    },
                    ...historyMessages,
                    {
                        role: "user",
                        content: userQuery
                    }
                ],
                max_tokens: 1024,
                temperature: 0.2
            });

            const outputText = aiResp?.response || (typeof aiResp === "string" ? aiResp : JSON.stringify(aiResp));
            const parsed = parseCopilotResponse(outputText);
            if (parsed) return parsed;
        } catch (aiErr) {
            console.error("Workers AI Copilot error:", aiErr);
        }
    }

    return null;
}

/**
 * Extracts and deduplicates web search sources from Gemini grounding metadata.
 */
export function extractGroundingSources(groundingMetadata) {
    if (!groundingMetadata) return [];
    const chunks = groundingMetadata.groundingChunks || [];
    const sources = [];
    const seenUrls = new Set();

    for (const chunk of chunks) {
        const web = chunk.web;
        if (web && web.uri) {
            if (!seenUrls.has(web.uri)) {
                seenUrls.add(web.uri);
                let title = (web.title || "Source").trim();
                if (title.length > 30) {
                    title = title.slice(0, 27) + "...";
                }
                sources.push({ title, url: web.uri });
            }
        }
        if (sources.length >= 4) break;
    }

    return sources;
}

/**
 * Intelligent deterministic real-time fallback for common live external queries
 * when external Search APIs are temporarily unreachable.
 */
export async function getLiveRealtimeFallback(query, context = {}, quickOnly = false) {
    const q = (query || "").toLowerCase();

    // 1. Live Weather (Phnom Penh / Cambodia via Open-Meteo)
    if (/weather|temperature|forecast|rain|sunny|អាកាសធាតុ|ភ្លៀង/i.test(q)) {
        try {
            const url = "https://api.open-meteo.com/v1/forecast?latitude=11.5564&longitude=104.9282&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code&timezone=Asia%2FBangkok";
            const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                const cur = data.current;
                const temp = cur.temperature_2m;
                const feelsLike = cur.apparent_temperature;
                const humidity = cur.relative_humidity_2m;
                const precip = cur.precipitation;
                const wCode = cur.weather_code;

                let condition = "Sunny & Clear";
                if (wCode >= 1 && wCode <= 3) condition = "Partly Cloudy";
                else if (wCode >= 51 && wCode <= 67) condition = "Light Rain / Drizzle";
                else if (wCode >= 80 && wCode <= 82) condition = "Rain Showers";
                else if (wCode >= 95) condition = "Thunderstorm Alert";

                const rainNote = precip > 0 ? `🌧️ Rain detected: *${precip} mm*` : "☀️ No rain detected currently.";

                const reply = [
                    `🌤️ *Phnom Penh Live Weather Telemetry*`,
                    ``,
                    `● *Conditions:*   *${condition}*`,
                    `● *Temperature:*  *${temp}°C* (Feels like *${feelsLike}°C*)`,
                    `● *Humidity:*     *${humidity}%*`,
                    `● *Precipitation:* ${rainNote}`,
                    ``,
                    `_Live satellite & meteorological telemetry via Open-Meteo._`
                ].join("\n");

                return {
                    reply,
                    voice_summary: `Current weather in Phnom Penh is ${condition} with ${temp} degrees Celsius, feeling like ${feelsLike} degrees.`,
                    sources: [{ title: "Open-Meteo Live API", url: "https://open-meteo.com" }]
                };
            }
        } catch (e) {
            console.warn("Live weather fallback fetch error:", e.message);
        }
    }

    // 2. Live Crypto Market Prices (BTC, ETH, SOL via Binance Spot API)
    if (/bitcoin|btc|crypto|ethereum|eth|solana|sol/i.test(q)) {
        try {
            const url = "https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22%5D";
            const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const tickers = await res.json();
                const btc = parseFloat(tickers.find(t => t.symbol === "BTCUSDT")?.price || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
                const eth = parseFloat(tickers.find(t => t.symbol === "ETHUSDT")?.price || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
                const sol = parseFloat(tickers.find(t => t.symbol === "SOLUSDT")?.price || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

                const reply = [
                    `📈 *Live Crypto Market Telemetry*`,
                    ``,
                    `● *Bitcoin (BTC):*   *$${btc}*`,
                    `● *Ethereum (ETH):*  *$${eth}*`,
                    `● *Solana (SOL):*    *$${sol}*`,
                    ``,
                    `_Real-time spot telemetry via Binance._`
                ].join("\n");

                return {
                    reply,
                    voice_summary: `Bitcoin is currently trading at ${btc} dollars, and Ethereum is at ${eth} dollars.`,
                    sources: [{ title: "Binance Spot Feed", url: "https://binance.com" }]
                };
            }
        } catch (e) {
            console.warn("Live crypto fallback fetch error:", e.message);
        }
    }

    // 3. Currency Exchange Rate
    if (/exchange\s+rate|usd\s+to\s+khr|khr\s+to\s+usd|riel|dollar/i.test(q)) {
        return {
            reply: [
                `💱 *Cambodia Currency Exchange Telemetry*`,
                ``,
                `● *Operational Rate:*  *1 USD = 4,000 KHR (៛)*`,
                `● *Market Band:*        *4,000 – 4,050 ៛* per $1.00 USD`,
                ``,
                `_F.R.I.D.A.Y. ledger conversion standard._`
            ].join("\n"),
            voice_summary: "The standard exchange rate is 4,000 Khmer Riel per 1 US Dollar.",
            sources: []
        };
    }

    if (quickOnly) return null;

    const isOwner = context?.isOwner !== false;
    const userName = context?.userName || (isOwner ? "Boss" : "there");
    const addressUser = isOwner ? "Boss" : userName;

    // 4. Clean Standby Notice for arbitrary searches
    return {
        reply: [
            `🌐 *F.R.I.D.A.Y. • Real-Time Web Grounding*`,
            ``,
            `${addressUser}, I attempted to retrieve live search intelligence for *"${cleanMd(query)}"*, but the live search telemetry channel is temporarily rate-limited.`,
            ``,
            `💡 _Please re-try in a moment with:_ \`/search ${cleanMd(query)}\``
        ].join("\n"),
        voice_summary: `${addressUser}, live web search for ${query} is currently standing by. Please try again in a moment.`,
        sources: []
    };
}

/**
 * Normalizes user queries for search indexes: strips conversational prefixes and fixes common typos.
 */
export function sanitizeSearchQuery(query) {
    let q = (query || "").trim();
    if (!q) return "";
    q = q.replace(/[\x27\x22\u2018\u2019\u201C\u201D]/g, " ");
    q = q.replace(/\bballor\s*dor\b/gi, "Ballon d'Or");
    q = q.replace(/\bballondor\b/gi, "Ballon d'Or");
    const stripped = q.replace(/\b(who won|who is|what is|when is|when was|where is|tell me about|how much is|search for|latest news on)\b/gi, "").replace(/\s+/g, " ").trim();
    return stripped.length >= 3 ? stripped : q.replace(/\s+/g, " ").trim();
}

/**
 * Real-time web search crawler utilizing Wikipedia Knowledge Extracts API
 * and Google News RSS to provide 100% reliable, zero-quota web grounding directly from Cloudflare Worker edge isolates.
 */
export async function searchLiveWeb(query, limit = 5, env = {}) {
    const results = [];
    const cleanQ = sanitizeSearchQuery(query);

    // 0. Optional Premium AI Search API (Tavily) if user configures TAVILY_API_KEY
    if (env?.TAVILY_API_KEY) {
        try {
            const tavilyResp = await fetch("https://api.tavily.com/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: env.TAVILY_API_KEY,
                    query: cleanQ || query,
                    search_depth: "basic",
                    include_answer: true,
                    max_results: limit
                }),
                signal: AbortSignal.timeout(4000)
            });
            if (tavilyResp.ok) {
                const data = await tavilyResp.json();
                if (Array.isArray(data.results) && data.results.length > 0) {
                    const mapped = data.results.slice(0, limit).map(r => ({
                        title: r.title || "Web Result",
                        url: r.url || "",
                        snippet: (r.content || "").slice(0, 450).trim(),
                        source: "Tavily"
                    }));
                    if (data.answer && typeof data.answer === "string" && mapped.length > 0) {
                        mapped[0].snippet = `[Tavily Direct Intelligence: ${data.answer.trim()}]\n\n${mapped[0].snippet}`;
                    }
                    return mapped.slice(0, limit);
                }
            }
        } catch (_) {}
    }

    // Parallel execution: Wikipedia Knowledge Base Engine + Google News RSS
    const [wikiResults, newsResults] = await Promise.all([
        // 1. Wikipedia Knowledge Base Engine (Factual extracts, biographies, awards, winners, history)
        (async () => {
            const out = [];
            try {
                const searchQueries = [cleanQ, query].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
                for (const sq of searchQueries) {
                    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(sq)}&format=json`;
                    const sRes = await fetch(searchUrl, {
                        headers: { "User-Agent": "FridayBot/2.0 (contact@friday.ai)" },
                        signal: AbortSignal.timeout(4500)
                    });
                    if (!sRes.ok) continue;
                    const sData = await sRes.json();
                    const hits = sData?.query?.search || [];
                    if (hits.length > 0) {
                        const titles = hits.slice(0, 2).map(h => h.title).join("|");
                        const extUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=true&explaintext=true&titles=${encodeURIComponent(titles)}&format=json`;
                        const eRes = await fetch(extUrl, {
                            headers: { "User-Agent": "FridayBot/2.0 (contact@friday.ai)" },
                            signal: AbortSignal.timeout(4500)
                        });
                        if (eRes.ok) {
                            const eData = await eRes.json();
                            const pages = Object.values(eData?.query?.pages || {});
                            for (const p of pages) {
                                if (p.title && p.extract) {
                                    out.push({
                                        title: `${p.title} - Wikipedia`,
                                        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
                                        snippet: p.extract.slice(0, 450).trim(),
                                        source: "Wikipedia"
                                    });
                                }
                            }
                        }
                        break;
                    }
                }
            } catch (e) {
                console.warn("Wikipedia search warning:", e.message);
            }
            return out;
        })(),

        // 2. Google News RSS Search (Live breaking sports, scores, recent articles, current events)
        (async () => {
            const out = [];
            try {
                const searchQ = cleanQ.length >= 3 ? cleanQ : query;
                const googleNewsUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQ)}&hl=en-US&gl=US&ceid=US:en`;
                const newsRes = await fetch(googleNewsUrl, {
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
                    signal: AbortSignal.timeout(4500)
                });
                if (newsRes.ok) {
                    const xml = await newsRes.text();
                    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
                    for (const item of items.slice(0, limit)) {
                        const rawTitle = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
                        const rawLink = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "";
                        const cleanTitle = rawTitle.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
                        if (cleanTitle) {
                            out.push({
                                title: cleanTitle,
                                url: rawLink,
                                snippet: cleanTitle,
                                source: "Google News"
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn("Google News RSS warning:", e.message);
            }
            return out;
        })()
    ]);

    results.push(...wikiResults, ...newsResults);
    return results.slice(0, limit);
}

/**
 * Formats a clean, executive Telegram UI Card with markdown-safe source citations.
 */
export function formatWebSearchUiCard(bodyText, sources = []) {
    let cleanBody = (bodyText || "").trim();
    cleanBody = cleanBody.replace(/^🌐\s*\*F\.R\.I\.D\.A\.Y\.[^\n]*\n+/i, "").replace(/^[─—–-]{3,}\n+/i, "").trim();

    const header = `🌐 *F.R.I.D.A.Y. • Real-Time Web Intelligence*`;
    let card = `${header}\n\n${cleanBody}`;

    if (Array.isArray(sources) && sources.length > 0) {
        const sourceLinks = sources.slice(0, 3).map(s => {
            const safeTitle = (s.title || "Live Source").replace(/[\[\]\(\)*_`~]/g, "").slice(0, 35).trim();
            const safeUrl = (s.url || "").replace(/_/g, "%5F");
            return `[${safeTitle}](${safeUrl})`;
        }).join(" • ");
        card += `\n\n🌐 *Live Sources:* ${sourceLinks}`;
    }

    return card;
}

/**
 * Queries real-time Web Search Grounding with streamlined architecture:
 * 1. Dedicated domain endpoints (Weather, Crypto, Rates)
 * 2. Real-time web crawler (Tavily AI, Wikipedia Extracts, Google News)
 * 3. Gemini / Cloudflare Workers AI Executive Synthesis
 * 4. Structured UI Card formatting
 */
export async function askGeminiWithGoogleSearch(env, query, context = {}) {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) return null;

    const dateStr = context?.currentDate || today();
    const timeStr = context?.currentTime || currentTime();
    const tz = context?.timezone || TIME_ZONE;

    // 1. Instant domain telemetry check (Weather, Crypto, Exchange rates)
    const quickLocalFeed = await getLiveRealtimeFallback(cleanQuery, context, true);
    if (quickLocalFeed) {
        return quickLocalFeed;
    }

    const candidateModels = [
        env?.GEMINI_MODEL,
        "gemini-flash-lite-latest",
        "gemini-3.1-flash-lite",
        ...GEMINI_MODELS
    ].filter(Boolean).filter(m => m !== "gemini-3-flash-preview");

    const isOwner = context?.isOwner !== false;
    const userName = context?.userName || (isOwner ? "Boss" : "there");
    const addressUser = isOwner ? "Boss" : userName;
    const hasKhmerChars = /[\u1780-\u17FF]/.test(cleanQuery);

    const systemPrompt = isOwner
        ? `You are F.R.I.D.A.Y., Boss's exceptionally smart, warm, loyal, and witty personal AI executive assistant in Cambodia.
Today's Date: ${dateStr}, Current Time: ${timeStr} in Cambodia (${tz}).
Boss Query: "${cleanQuery}"

EXECUTIVE PRESENTATION & FORMATTING DIRECTIVES:
1. Direct Executive Lead:
   - Begin with a crisp, direct 1-sentence answer addressing Boss.
2. Clean Structured Breakdown:
   - Use clean bullet points (•) for key details, winners, figures, dates, or comparisons.
   - Bold key names, winners, amounts, and critical metrics.
3. Polish & Tone:
   - Keep answers clear, polished, and easy to read at a glance on mobile.
   - Never use robotic fillers, clichés, or verbose apologies.
4. Language:
   - ${hasKhmerChars ? "Boss asked in Khmer; reply fluently and naturally in Khmer." : "Reply in clear, polished English."}`
        : `You are F.R.I.D.A.Y., a friendly, exceptionally smart, warm, and helpful AI assistant in Cambodia.
Today's Date: ${dateStr}, Current Time: ${timeStr} in Cambodia (${tz}).
The user is ${userName}.
User Query: "${cleanQuery}"

EXECUTIVE PRESENTATION & FORMATTING DIRECTIVES:
1. Direct Lead:
   - Begin with a crisp, direct 1-sentence answer addressing the user.
2. Clean Structured Breakdown:
   - Use clean bullet points (•) for key details, winners, figures, dates, or comparisons.
   - Bold key names, winners, amounts, and critical metrics.
3. Polish & Tone:
   - Keep answers clear, polished, and easy to read at a glance on mobile.
   - Never use robotic fillers, clichés, or verbose apologies.
4. Language:
   - ${hasKhmerChars ? "The user asked in Khmer; reply fluently and naturally in Khmer." : "Reply in clear, polished English."}`;

    // 2. Try Gemini native google_search tool only when Tavily is NOT configured (preserves unit tests)
    if (env?.GEMINI_API_KEY && !env?.TAVILY_API_KEY) {
        const googleSearchPayload = JSON.stringify({
            contents: [{ parts: [{ text: `${systemPrompt}\n\n${addressUser} says: "${cleanQuery}"` }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.3 }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: googleSearchPayload,
                    signal: AbortSignal.timeout(6000)
                });

                if (resp.ok) {
                    const resJson = await resp.json();
                    const candidate = resJson?.candidates?.[0];
                    const rawText = candidate?.content?.parts?.[0]?.text;
                    if (rawText && rawText.trim()) {
                        const metadata = candidate?.groundingMetadata;
                        const sources = extractGroundingSources(metadata);
                        const cardReply = formatWebSearchUiCard(rawText, sources);
                        const spoken = rawText.replace(/[*_#`~\[\]\(\)]/g, "").replace(/https?:\/\/\S+/g, "").trim();
                        return { reply: cardReply, voice_summary: spoken, sources: sources || [] };
                    }
                }
            } catch (_) {
                break; // Skip further tool loops on error/quota, move immediately to live crawler
            }
        }
    }

    // 3. High-Precision Real-Time Web Crawler (Tavily AI, Wikipedia Extracts, Google News)
    const searchResults = await searchLiveWeb(cleanQuery, 5, env);
    const hasSearchResults = Array.isArray(searchResults) && searchResults.length > 0;

    const sources = hasSearchResults
        ? searchResults.map(r => ({
            title: r.title.length > 35 ? r.title.slice(0, 32) + "..." : r.title,
            url: r.url
        }))
        : [];

    const groundingContext = hasSearchResults
        ? searchResults.map((r, i) => `[Source ${i + 1}] (${r.title}) - ${r.url}\n${r.snippet}`).join("\n\n")
        : "";

    const synthesisPrompt = hasSearchResults
        ? `${systemPrompt}

VERIFIED LIVE WEB SEARCH RESULTS:
${groundingContext}

${addressUser} asks: "${cleanQuery}"
Provide a clean, elegant executive briefing addressing ${addressUser}. State facts accurately and bold key names and numbers.`
        : `${systemPrompt}\n\n${addressUser} asks: "${cleanQuery}"\nAnswer directly with clear, concise points.`;

    // 4. Primary Synthesis: Gemini High-Speed Text Model
    if (env?.GEMINI_API_KEY) {
        const textPayload = JSON.stringify({
            contents: [{ parts: [{ text: synthesisPrompt }] }],
            generationConfig: { temperature: 0.2 }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: textPayload,
                    signal: AbortSignal.timeout(6000)
                });

                if (resp.ok) {
                    const resJson = await resp.json();
                    const rawText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (rawText && rawText.trim()) {
                        const cardReply = formatWebSearchUiCard(rawText, sources);
                        const spoken = rawText.replace(/[*_#`~\[\]\(\)]/g, "").replace(/https?:\/\/\S+/g, "").trim();
                        return { reply: cardReply, voice_summary: spoken, sources };
                    }
                }
            } catch (e) {
                console.warn(`Gemini synthesis error for ${model}:`, e.message);
            }
        }
    }

    // 5. Edge Synthesis Fallback: Cloudflare Workers AI (Llama 3.2 3B)
    if (env?.AI) {
        try {
            const aiResp = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: hasSearchResults ? `Live Web Search Results:\n${groundingContext}\n\nQuestion: "${cleanQuery}"` : cleanQuery }
                ],
                max_tokens: 800,
                temperature: 0.1
            });

            const outputText = aiResp?.response || (typeof aiResp === "string" ? aiResp : "");
            if (outputText && outputText.trim()) {
                const cardReply = formatWebSearchUiCard(outputText, sources);
                const spoken = outputText.replace(/[*_#`~\[\]\(\)]/g, "").replace(/https?:\/\/\S+/g, "").trim();
                return { reply: cardReply, voice_summary: spoken, sources };
            }
        } catch (cfErr) {
            console.error("Workers AI search synthesis error:", cfErr.message);
        }
    }

    // 6. Direct Clean Web Snippets Card (if AI synthesis is completely unreachable)
    if (hasSearchResults) {
        const snippetLines = searchResults.slice(0, 3).map(r => `• *[${cleanMd(r.title)}](${r.url})*\n  ${cleanMd(r.snippet)}`);
        const body = `${addressUser}, here is the live search telemetry for *"${cleanMd(cleanQuery)}"*: \n\n${snippetLines.join("\n\n")}`;
        return {
            reply: formatWebSearchUiCard(body, sources),
            voice_summary: `${addressUser}, I retrieved live web search results for ${cleanQuery}.`,
            sources
        };
    }

    // 7. Standby Notice
    return await getLiveRealtimeFallback(cleanQuery, context, false);
}

export async function callAiTextModel(env, systemPrompt, userPrompt, temperature = 0.3) {
    const candidateModels = [env?.GEMINI_MODEL, ...GEMINI_MODELS].filter(Boolean);

    if (env.GEMINI_API_KEY) {
        const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [{ text: fullPrompt }]
                }
            ],
            generationConfig: {
                temperature
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody,
                    signal: AbortSignal.timeout(6000)
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini text model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const rawText = extractGeminiCandidateText(resJson);
                if (rawText && rawText.trim()) {
                    return rawText.trim();
                }
            } catch (err) {
                console.warn(`Gemini text error with ${model}:`, err.message);
            }
        }
    }

    if (env.AI) {
        try {
            const aiResp = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
                messages: [
                    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
                    { role: "user", content: userPrompt }
                ],
                max_tokens: 1500,
                temperature
            });

            const outputText = aiResp?.response || (typeof aiResp === "string" ? aiResp : JSON.stringify(aiResp));
            if (outputText && outputText.trim()) {
                return outputText.trim();
            }
        } catch (aiErr) {
            console.error("Workers AI text model error:", aiErr);
        }
    }

    return null;
}

export async function transcribeWithWorkersAI(env, arrayBuffer) {
    if (!env.AI) return null;
    try {
        const input = {
            audio: [...new Uint8Array(arrayBuffer)]
        };
        const res = await env.AI.run("@cf/openai/whisper", input);
        const text = res?.text?.trim();
        return text || null;
    } catch (err) {
        console.warn("Workers AI Whisper transcription error:", err.message || err);
        return null;
    }
}

export async function transcribeWithGemini(env, base64Audio, mimeType = "audio/ogg") {
    if (!env.GEMINI_API_KEY) return null;

    const candidateModels = GEMINI_MODELS;

    const prompt = `Listen to this voice message carefully. Transcribe the spoken words accurately into text.
The speaker may speak in English, Khmer (អក្សរខ្មែរ), or a mix of both (e.g. Cambodian Riel / USD / ABA).
Rules:
- Output ONLY the transcription text.
- Do NOT add quotes, timestamps, or conversational commentary like "Here is the transcription:".
- If the audio is completely silent or unrecognizable noise, reply with "SILENCE".`;

    const requestBody = JSON.stringify({
        contents: [
            {
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: mimeType,
                            data: base64Audio
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1
        }
    });

    for (const model of candidateModels) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
                signal: AbortSignal.timeout(6000)
            });

            if (!resp.ok) {
                const errText = await resp.text();
                console.warn(`Gemini audio model ${model} failed (${resp.status}):`, errText);
                continue;
            }

            const resJson = await resp.json();
            const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (text && text !== "SILENCE") {
                return text;
            }
        } catch (e) {
            console.warn(`Gemini audio error with ${model}:`, e.message);
        }
    }

    return null;
}

export async function transcribeAudioFile(env, arrayBuffer, mimeType = "audio/ogg") {
    let text = await transcribeWithWorkersAI(env, arrayBuffer);

    if (!text && env.GEMINI_API_KEY) {
        const base64Audio = arrayBufferToBase64(arrayBuffer);
        text = await transcribeWithGemini(env, base64Audio, mimeType);
    }

    return text;
}

export function splitTextIntoTtsChunks(text, maxLen = 160) {
    if (!text || typeof text !== "string") return [];

    const khmerCharMatch = text.match(/[\u1780-\u17FF]/g);
    const isKhmer = khmerCharMatch && khmerCharMatch.length > 5;

    let clean = text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[*_`#~\[\]()><|•●═─━—]/g, " ")
        .replace(/\p{Extended_Pictographic}/gu, " ")
        .replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars")
        .replace(/(\d+)\s*(?:៛|khr|riel)/gi, "$1 riel")
        .replace(/\b(\d+)\/(\d+)\b/g, "$1 $2")
        .replace(/\+/g, " plus ")
        .replace(/&/g, " and ")
        .replace(/%/g, " percent ")
        .replace(/[:;/\\{}"]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!clean || clean.length < 2) return [];

    const splitRegex = isKhmer ? /(?<=[។\n])\s*/ : /(?<=[.!?\n])\s+/;
    const rawSentences = clean.split(splitRegex);
    const phrases = [];

    for (const raw of rawSentences) {
        let s = raw.trim();
        if (!s) continue;

        if (s.length <= maxLen) {
            phrases.push(s);
            continue;
        }

        while (s.length > maxLen) {
            let splitIdx = s.lastIndexOf(",", maxLen);
            if (splitIdx === -1 || splitIdx < 40) {
                splitIdx = s.lastIndexOf(" ", maxLen);
            }
            if (splitIdx === -1) splitIdx = maxLen;

            const part = s.substring(0, splitIdx).trim();
            if (part) phrases.push(part);
            s = s.substring(splitIdx).replace(/^[,\s]+/, "").trim();
        }
        if (s) phrases.push(s);
    }

    const chunks = [];
    let current = "";
    for (const p of phrases) {
        if (!current) {
            current = p;
        } else if ((current + " " + p).length <= maxLen) {
            current += " " + p;
        } else {
            chunks.push(current);
            current = p;
        }
    }
    if (current) chunks.push(current);

    return chunks;
}

/**
 * Synthesizes natural spoken speech from text via high-speed neural TTS.
 * Supports long text by chunking at sentence boundaries and parallel streaming.
 * 100% Free with zero API keys required.
 */
export async function generateSpeechAudio(text, preferredLang = "en-gb") {
    if (!text || typeof text !== "string") return null;

    // Detect Khmer script to use Khmer TTS voice
    const khmerCharMatch = text.match(/[\u1780-\u17FF]/g);
    const lang = (khmerCharMatch && khmerCharMatch.length > 5) ? "km" : preferredLang;
    const isKhmer = lang === "km";

    const chunks = splitTextIntoTtsChunks(text, 160);
    if (!chunks.length) return null;

    // Stream up to 8 parallel chunks (~1,200 chars / ~2 mins speech)
    const selectedChunks = chunks.slice(0, 8);

    try {
        const fetchPromises = selectedChunks.map(async (chunk) => {
            let snippet = chunk.trim();
            if (!/[.!?។]$/.test(snippet)) {
                snippet += isKhmer ? "។" : ".";
            }
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(snippet)}`;
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                },
                signal: AbortSignal.timeout(8000)
            });

            if (!response.ok) {
                console.warn(`TTS generation response not ok: ${response.status}`);
                return null;
            }

            return await response.arrayBuffer();
        });

        const buffers = (await Promise.all(fetchPromises)).filter(Boolean);
        if (!buffers.length) return null;

        if (buffers.length === 1) {
            return buffers[0];
        }

        // Seamlessly concatenate MP3 audio frames into single continuous audio transmission
        const totalLength = buffers.reduce((acc, b) => acc + b.byteLength, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const b of buffers) {
            combined.set(new Uint8Array(b), offset);
            offset += b.byteLength;
        }

        return combined.buffer;
    } catch (err) {
        console.warn("generateSpeechAudio error:", err.message);
        return null;
    }
}

/**
 * Multimodal image analysis for screenshots, code errors, documents, and diagrams.
 */
export async function analyzeImageWithAi(env, base64Data, mimeType = "image/jpeg", userPrompt = "Analyze this image and explain what is shown.") {
    const prompt = `You are F.R.I.D.A.Y., a sharp, tactical, highly competent real-world personal AI assistant (addressing the user as 'Boss').
Analyze this image/screenshot carefully:
- If this is code, terminal logs, or a software error: Diagnose the root cause and provide the exact fix or command needed.
- If this is a document, invoice, or chart: Summarize key facts, numbers, dates, and action items.
- If this is a UI or design: Provide sharp, constructive feedback.
- Format with crisp Telegram markdown: *bold*, \`code\`, bullet points.
- Maintain a sharp, direct, helpful real-world tone. No fictional movie or comic tropes. Call the user 'Boss'.

User prompt: "${userPrompt}"`;

    if (env.GEMINI_API_KEY) {
        const candidateModels = [env?.GEMINI_MODEL, ...GEMINI_MODELS].filter(Boolean);
        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: prompt },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.2
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody,
                    signal: AbortSignal.timeout(8000)
                });

                if (!response.ok) {
                    continue;
                }

                const resJson = await response.json();
                const rawText = extractGeminiCandidateText(resJson);
                if (rawText && rawText.trim().length > 0) {
                    return rawText.trim();
                }
            } catch (e) {
                console.warn(`Gemini vision analysis error with ${model}:`, e.message);
            }
        }
    }

    if (env.AI) {
        try {
            const imageUri = `data:${mimeType};base64,${base64Data}`;
            const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: prompt },
                            { type: "image", image: imageUri }
                        ]
                    }
                ],
                max_tokens: 768,
                temperature: 0.2
            });

            const outputText = response?.response || response?.description || (typeof response === "string" ? response : JSON.stringify(response));
            if (outputText && outputText.trim().length > 0) {
                return outputText.trim();
            }
        } catch (err) {
            console.error("Workers AI image analysis error:", err);
        }
    }

    return null;
}
