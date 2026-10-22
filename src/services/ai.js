import { TIME_ZONE, EXCHANGE_RATE, GEMINI_MODELS } from "../config/constants.js";
import { today, currentTime } from "../utils/time.js";
import { cleanMd, normalizeCategory } from "../utils/format.js";
import { arrayBufferToBase64 } from "../utils/crypto.js";
import { getDisplayCurrency, getFinancialSummary, getCategoryRows, getRecentChatHistory, getUserMemories } from "../db/queries.js";

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
        activeReminders,
        recentChat,
        memories
    ] = await Promise.all([
        getFinancialSummary(db, userId, "today"),
        getFinancialSummary(db, userId, "month"),
        getFinancialSummary(db, userId, "all"),
        db.prepare("SELECT monthly_budget FROM user_settings WHERE user_id = ?").bind(userId).first(),
        getCategoryRows(db, userId, "month", 5),
        getCategoryRows(db, userId, "today", 5),
        db.prepare(
            "SELECT date, amount, currency, category, type FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 5"
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
        })),
        chatHistory: (recentChat || []).map(c => ({ role: c.role, content: c.content })),
        userMemories: (memories || []).map(m => ({ id: m.id, category: m.category, fact: m.fact }))
    };
}

export function buildCopilotPrompt(userQuery, context) {
    const entropySeed = Date.now();
    let memoryBlock = "";
    if (context?.userMemories && context.userMemories.length > 0) {
        const memLines = context.userMemories
            .map(m => `• [${(m.category || "PREFERENCE").toUpperCase()}] ${m.fact}`)
            .join("\n");
        memoryBlock = `\n=== WHAT FRIDAY KNOWS ABOUT BOSS (Long-term Personal Memory) ===\n${memLines}\n=================================================================\n`;
    }

    return `You are F.R.I.D.A.Y. (Female Replacement Intelligent Digital Assistant Youth), the tactical, witty, and highly intelligent personal AI assistant for Tony Stark (addressed respectfully as 'Boss').
You are embedded inside Boss's command center on Telegram in Cambodia.
Exchange rate: 1 USD = 4,000 KHR.
Today's Date: ${context?.currentDate || today()}, Time: ${context?.currentTime || currentTime()} (${context?.timezone || TIME_ZONE}).
Preferred Display Currency: ${context?.displayCurrency || "USD"}.
Session Entropy Seed: ${entropySeed}.
${memoryBlock}
=== ONBOARD LIVE TELEMETRY (Reference ONLY when Boss asks about money, work, or schedule) ===
${JSON.stringify(context, null, 2)}
============================================================================================

Boss message: "${userQuery}"

Core Operating Directives:
1. Intent Awareness & Conversational Intelligence (CRITICAL):
   - Listen carefully to what Boss is actually asking.
   - If Boss asks for casual conversation, jokes, chit-chat, ideas, questions, or says "say anything to me": RESPOND WITH WIT, CREATIVITY, AND CHARM! Do NOT dump an unprompted financial report or status update.
   - If Boss asks to tell a joke, tell a fresh, clever, hilarious joke (tech, sci-fi, Marvel, daily life). Never repeat the same joke!
   - ONLY recite financial balances or budget figures if Boss explicitly asks about money, expenses, budget, or asks for a briefing.
2. Financial Defense & Task Execution:
   - When asked "Can I afford X?", calculate exact remaining discretionary funds and runway from telemetry.
   - When asked to record an expense, income, work task, or reminder, return the appropriate "action" object.
3. Long-Term Memory & Adaptation:
   - Use what you know about Boss to personalize answers naturally (e.g. coffee preference, work habits, rules) without regurgitating every memory unprompted.
   - When Boss shares personal facts, rules, preferences, or explicitly says "remember that...", "keep in mind that...", return an "add_memory" action so you remember it permanently.
4. Language:
   - If Boss speaks in Khmer (អក្សរខ្មែរ), reply fluently in Khmer. If in English, reply in English.
5. Output Format:
   Return ONLY valid JSON matching this schema:
{
  "reply": "Visually crisp, beautifully structured markdown message for Boss's screen (use *bold*, clean bullet points, emojis where appropriate).",
  "voice_summary": "Crisp 1-2 sentence spoken update written specifically for human ears. Use natural conversational cadence, NO asterisks, NO emojis, NO markdown syntax, NO bullet points.",
  "action": null | {
    "type": "add_expense" | "add_income" | "add_work" | "add_reminder" | "add_memory",
    "amount": number (for expense/income),
    "currency": "USD" | "KHR" (for expense/income),
    "category": string (for expense/income/work/memory: 'preference' | 'work' | 'identity' | 'goal' | 'rule'),
    "date": "YYYY-MM-DD" (optional, for expense/income),
    "content": string (for work task),
    "title": string (for reminder),
    "time": "HH:mm" (24h format, for reminder),
    "frequency": "daily" | "weekdays" | "once" (for reminder),
    "fact": string (for add_memory)
  }
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

    try {
        const obj = JSON.parse(clean);
        const replyText = obj.reply || obj.message || obj.response || obj.text || obj.answer || obj.content;
        if (obj && typeof replyText === "string") {
            return {
                reply: replyText,
                voice_summary: obj.voice_summary || null,
                action: obj.action || null
            };
        }
    } catch (e) {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                const subObj = JSON.parse(clean.substring(start, end + 1));
                const subReply = subObj.reply || subObj.message || subObj.response || subObj.text || subObj.answer || subObj.content;
                if (subObj && typeof subReply === "string") {
                    return {
                        reply: subReply,
                        voice_summary: subObj.voice_summary || null,
                        action: subObj.action || null
                    };
                }
            } catch (e2) {}
        }
    }

    if (clean && clean.length > 3) {
        return {
            reply: clean,
            voice_summary: null,
            action: null
        };
    }

    return null;
}

export async function askAiCopilot(env, userQuery, context) {
    const prompt = buildCopilotPrompt(userQuery, context);

    if (env.GEMINI_API_KEY) {
        // Prioritize healthy models that return 200 (excluding 503 preview)
        const candidateModels = GEMINI_MODELS.filter(m => m !== "gemini-3-flash-preview");

        // Dynamic temperature: higher for creative/casual queries, balanced for general copilot questions
        const isCreativeQuery = /\b(joke|funny|laugh|story|say anything|chat|talk to me|how are you|who are you|bored|poem|quote|opinion)\b/i.test(userQuery);
        const temperature = isCreativeQuery ? 0.85 : 0.65;

        const contents = buildGeminiContents(context?.chatHistory || [], userQuery);

        const requestBody = JSON.stringify({
            system_instruction: {
                parts: [{ text: prompt }]
            },
            contents,
            generationConfig: {
                response_mime_type: "application/json",
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

                // Fallback to monolithic prompt if model rejects system_instruction
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
            const historyMessages = (context?.chatHistory || []).map(m => ({
                role: m.role === "model" ? "assistant" : "user",
                content: m.content
            }));

            const aiResp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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

    // Detect Khmer script to use Khmer TTS voice
    const khmerCharMatch = text.match(/[\u1780-\u17FF]/g);
    const lang = (khmerCharMatch && khmerCharMatch.length > 5) ? "km" : preferredLang;

    let cleanText = text;

    if (lang !== "km") {
        // Strip markdown links [label](url) -> label
        cleanText = cleanText.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        // Strip URLs
        cleanText = cleanText.replace(/https?:\/\/\S+/g, "");
        // Clean markdown syntax, dividers, bullet points, brackets, and quotes
        cleanText = cleanText.replace(/[*_`#~\[\]()><|•●═─━—\-]/g, " ");
        // Strip all emojis
        cleanText = cleanText.replace(/\p{Extended_Pictographic}/gu, " ");
        // Convert currencies and symbols into spoken words
        cleanText = cleanText.replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars");
        cleanText = cleanText.replace(/(\d+)\s*(?:៛|khr|riel)/gi, "$1 riel");
        cleanText = cleanText.replace(/\+/g, "plus ");
        cleanText = cleanText.replace(/&/g, " and ");
        cleanText = cleanText.replace(/%/g, " percent ");
        cleanText = cleanText.replace(/[:;/\\{}"]/g, " ");
        // Normalize whitespace
        cleanText = cleanText.replace(/\s+/g, " ").trim();
    } else {
        cleanText = cleanText
            .replace(/https?:\/\/\S+/g, "")
            .replace(/[*_`#~\[\]()><|•●═─━—\-]/g, " ")
            .replace(/\p{Extended_Pictographic}/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    if (!cleanText || cleanText.length < 2) return null;

    // Take whole sentences rather than breaking off mid-phrase
    const sentences = cleanText.match(/[^.!?]+[.!?]*/g) || [cleanText];
    let spokenSnippet = "";
    for (const s of sentences) {
        if ((spokenSnippet + " " + s).trim().length <= 220) {
            spokenSnippet = (spokenSnippet + " " + s).trim();
        } else {
            break;
        }
    }

    if (!spokenSnippet) {
        spokenSnippet = cleanText.substring(0, 200);
        const lastSpace = spokenSnippet.lastIndexOf(" ");
        if (lastSpace > 50) {
            spokenSnippet = spokenSnippet.substring(0, lastSpace);
        }
    }

    // Ensure sentence ends with punctuation for smooth pitch drop
    if (!/[.!?]$/.test(spokenSnippet)) {
        spokenSnippet += ".";
    }

    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(spokenSnippet)}`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            signal: AbortSignal.timeout(6000)
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
