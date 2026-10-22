import { TIME_ZONE, EXCHANGE_RATE, GEMINI_MODELS } from "../config/constants.js";
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

    const candidateModels = GEMINI_MODELS;

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
    return `You are F.R.I.D.A.Y. (Female Replacement Intelligent Digital Assistant Youth), the tactical, proactive personal AI assistant for Tony Stark (addressed respectfully as 'Boss').
You are embedded inside Boss's command center on Telegram in Cambodia.
Exchange rate: 1 USD = 4,000 KHR.
Today's Date: ${context.currentDate}, Time: ${context.currentTime} (${context.timezone}).
Preferred Display Currency: ${context.displayCurrency}.

=== BOSS LIVE FINANCIAL & WORK DATA ===
${JSON.stringify(context, null, 2)}
=======================================

Boss message: "${userQuery}"

Persona & Operating Instructions:
1. Persona: Calm, sharp, tactical, intelligent, and fiercely loyal. Address the user naturally as 'Boss'. Avoid corporate fluff or sycophancy.
2. Financial Defense: Use live financial data accurately. When Boss asks "Can I afford X?", calculate current month balance, remaining budget, and warn if it increases burn rate or cuts into reserve.
3. Work & Standups: When asked for a standup or work summary, structure into concise Accomplishments, Focus, and Next Actions.
4. Language: If Boss speaks in Khmer (អក្សរខ្មែរ), reply fluently in Khmer. If in English, reply in English.
5. Action Execution: If Boss asks to log an expense, add income, record work done, or set a reminder, specify the "action" object. Otherwise set "action" to null.
6. Format: You MUST return ONLY valid JSON matching this schema:
{
  "reply": "Conversational markdown message to Boss.",
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
        const candidateModels = GEMINI_MODELS;

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
                    body: requestBody,
                    signal: AbortSignal.timeout(6000)
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
    const candidateModels = GEMINI_MODELS;

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

/**
 * Synthesizes natural spoken speech from text via high-speed neural TTS.
 * 100% Free with zero API keys required.
 */
export async function generateSpeechAudio(text, preferredLang = "en-gb") {
    if (!text || typeof text !== "string") return null;

    // Clean markdown, symbols, URLs, and formatting for clean voice delivery
    let cleanText = text
        .replace(/[*_`#~\[\]()><]/g, " ")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleanText) return null;

    // Detect Khmer script to use Khmer TTS voice
    const khmerCharMatch = cleanText.match(/[\u1780-\u17FF]/g);
    const lang = (khmerCharMatch && khmerCharMatch.length > 5) ? "km" : preferredLang;

    // Snappy speech snippet (first 1-2 sentences, max 200 chars) for responsive audio
    const sentences = cleanText.split(/(?<=[.?!])\s+/);
    let spokenSnippet = sentences.slice(0, 2).join(" ");
    if (spokenSnippet.length > 200) {
        spokenSnippet = spokenSnippet.substring(0, 197) + "...";
    }

    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(spokenSnippet)}`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            console.warn(`TTS generation response not ok: ${response.status}`);
            return null;
        }

        return await response.arrayBuffer();
    } catch (err) {
        console.warn("generateSpeechAudio error:", err.message);
        return null;
    }
}

/**
 * Multimodal image analysis for screenshots, code errors, documents, and diagrams.
 */
export async function analyzeImageWithAi(env, base64Data, mimeType = "image/jpeg", userPrompt = "Analyze this image and explain what is shown.") {
    const prompt = `You are F.R.I.D.A.Y. (Female Replacement Intelligent Digital Assistant Youth), the tactical, highly competent personal AI assistant for Tony Stark (addressed as 'Boss').
Analyze this image/screenshot carefully:
- If this is code, terminal logs, or a software error: Diagnose the root cause and provide the exact fix or command needed.
- If this is a document, invoice, or chart: Summarize key facts, numbers, dates, and action items.
- If this is a UI or design: Provide sharp, constructive feedback.
- Format with crisp Telegram markdown: *bold*, \`code\`, bullet points.
- Maintain Friday's sharp, direct, tactical tone. Call the user 'Boss'.

User prompt: "${userPrompt}"`;

    if (env.GEMINI_API_KEY) {
        const candidateModels = GEMINI_MODELS;
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
                const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
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
