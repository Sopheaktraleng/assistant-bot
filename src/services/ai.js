import { TIME_ZONE, EXCHANGE_RATE } from "../config/constants.js";
import { today, currentTime } from "../utils/time.js";
import { cleanMd, normalizeCategory } from "../utils/format.js";
import { arrayBufferToBase64 } from "../utils/crypto.js";
import { getDisplayCurrency, getFinancialSummary, getCategoryRows } from "../db/queries.js";

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

    const candidateModels = [
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gemini-flash-latest",
        "gemini-2.5-flash"
    ];

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
                body: requestBody
            });

            if (!response.ok) {
                const errText = await response.text();
                console.warn(`Gemini OCR model ${model} failed (${response.status}):`, errText);
                continue;
            }

            const resJson = await response.json();
            const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
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

export async function buildAiUserContext(db, userId) {
    const curDate = today();
    const curTime = currentTime();
    const displayCurrency = await getDisplayCurrency(db, userId);

    const [
        todaySummary,
        monthSummary,
        allSummary,
        settingsRow,
        monthCats,
        todayCats,
        recentExpenses,
        todayTasks,
        recentTasks,
        activeReminders
    ] = await Promise.all([
        getFinancialSummary(db, userId, "today"),
        getFinancialSummary(db, userId, "month"),
        getFinancialSummary(db, userId, "all"),
        db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(userId).first(),
        getCategoryRows(db, userId, "month", 10),
        getCategoryRows(db, userId, "today", 6),
        db.prepare(
            "SELECT date, amount, currency, category, type FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 25"
        ).bind(userId).all(),
        db.prepare(
            "SELECT time, content, category FROM work_logs WHERE user_id = ? AND date = ? ORDER BY time ASC, id ASC"
        ).bind(userId, curDate).all(),
        db.prepare(
            "SELECT date, time, content, category FROM work_logs WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 20"
        ).bind(userId).all(),
        db.prepare(
            "SELECT title, reminder_time, frequency, type FROM reminders WHERE user_id = ? AND is_active = 1 ORDER BY reminder_time ASC"
        ).bind(userId).all()
    ]);

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
        }))
    };
}

export function buildCopilotPrompt(userQuery, context) {
    return `You are the intelligent AI Personal Financial & Work Copilot for a Telegram assistant bot in Cambodia.
Exchange rate: 1 USD = 4,000 KHR.
Today's Date: ${context.currentDate}, Time: ${context.currentTime} (${context.timezone}).
Preferred Display Currency: ${context.displayCurrency}.

=== USER LIVE FINANCIAL & WORK DATA ===
${JSON.stringify(context, null, 2)}
=======================================

User message: "${userQuery}"

Instructions:
1. Provide a direct, helpful, and natural response formatted for Telegram (use markdown: *bold*, \`code\`, bullet points, emojis).
2. Use the live data above accurately. Mention amounts in both USD ($) and Cambodian Riel (៛) when helpful. Do NOT invent numbers that contradict the data.
3. If the user asks for their daily standup or to summarize accomplishments, synthesize recent and today's tasks into a crisp 3-part update (Yesterday, Today, Blockers), and recommend /standup or /report polish.
4. If the user asks in Khmer (អក្សរខ្មែរ), reply fluently in Khmer. If in English, reply in English.
5. If the user explicitly asks to record an expense, log work, or set a reminder that is NOT already recorded, return an "action" object. Otherwise, set "action" to null.
6. You MUST return ONLY valid JSON matching this schema:
{
  "reply": "Conversational markdown message to the user.",
  "action": null | {
    "type": "add_expense" | "add_income" | "add_work" | "add_reminder",
    "amount": number (for expense/income),
    "currency": "USD" | "KHR" (for expense/income),
    "category": string (for expense/income/work),
    "date": "YYYY-MM-DD" (optional, for expense/income),
    "content": string (for work task),
    "title": string (for reminder),
    "time": "HH:mm" (24h format, for reminder),
    "frequency": "daily" | "weekdays" | "once" (for reminder)
  }
}
Return pure JSON only.`;
}

export function parseCopilotResponse(rawText) {
    if (!rawText) return null;
    let clean = rawText.trim();
    if (clean.startsWith("```json")) {
        clean = clean.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    try {
        const obj = JSON.parse(clean);
        if (obj && typeof obj.reply === "string") {
            return {
                reply: obj.reply,
                action: obj.action || null
            };
        }
    } catch (e) {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                const subObj = JSON.parse(clean.substring(start, end + 1));
                if (subObj && typeof subObj.reply === "string") {
                    return {
                        reply: subObj.reply,
                        action: subObj.action || null
                    };
                }
            } catch (e2) {}
        }
    }

    if (clean && clean.length > 3) {
        return {
            reply: clean,
            action: null
        };
    }

    return null;
}

export async function askAiCopilot(env, userQuery, context) {
    const prompt = buildCopilotPrompt(userQuery, context);

    if (env.GEMINI_API_KEY) {
        const candidateModels = [
            "gemini-2.5-flash",
            "gemini-2.0-flash",
            "gemini-1.5-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.8-flash",
            "gemini-flash-latest"
        ];

        const requestBody = JSON.stringify({
            contents: [
                {
                    parts: [{ text: prompt }]
                }
            ],
            generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.2
            }
        });

        for (const model of candidateModels) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: requestBody
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini Copilot model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
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
            const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are a personal financial and productivity copilot. Return valid JSON only with 'reply' and 'action'."
                    },
                    {
                        role: "user",
                        content: prompt
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

export async function callAiTextModel(env, systemPrompt, userPrompt, temperature = 0.3) {
    const candidateModels = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gemini-flash-latest"
    ];

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
                    body: requestBody
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    console.warn(`Gemini text model ${model} failed (${resp.status}):`, errText);
                    continue;
                }

                const resJson = await resp.json();
                const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
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
            const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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

    const candidateModels = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash"
    ];

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
                body: requestBody
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

export function parseMovieJson(rawText) {
    if (!rawText) return null;
    let clean = rawText.trim();
    if (clean.startsWith("```json")) {
        clean = clean.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    } else if (clean.startsWith("```")) {
        clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    try {
        return JSON.parse(clean);
    } catch (e) {
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch (_) {}
        }
        return null;
    }
}
