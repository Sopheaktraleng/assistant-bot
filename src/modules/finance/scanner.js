import { EXCHANGE_RATE, QUICK_EXPENSE_CATS } from "../../config/constants.js";
import { today, formatCambodiaDateTime } from "../../utils/time.js";
import { cleanMd, formatMoney, capitalize, getCategoryIcon, normalizeCategory } from "../../utils/format.js";
import { arrayBufferToBase64 } from "../../utils/crypto.js";
import { 
    addExpenseRecord, 
    savePendingStatement, 
    getPendingStatement, 
    deletePendingStatement, 
    importPendingStatementTransactions 
} from "../../db/queries.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, answerCallback, safeEditOrSendMessage } from "../../services/telegram.js";
import { parseReceiptImage, analyzeImageWithAi, parseStatementOrInvoicePdfWithGemini } from "../../services/ai.js";
import { sendTransactionReceipt } from "./views.js";

export function formatPendingScanText(scan) {
    const isIncome = scan.type === "income";
    const sign = isIncome ? "+" : "-";
    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const mainAmt = `${sign}${symbol}${formatMoney(scan.amount)}${suffix}`;

    let altAmt = "";
    if (scan.currency === "USD") {
        altAmt = ` (~${formatMoney(scan.amount * EXCHANGE_RATE)} ៛)`;
    } else {
        altAmt = ` (~$${formatMoney(scan.amount / EXCHANGE_RATE)})`;
    }

    const icon = getCategoryIcon(scan.category, scan.type);
    const bankName = scan.bank || "Bank Transfer";
    const merchant = scan.merchant ? scan.merchant : "Merchant / Store";
    const note = scan.note ? `\n📝 *Note:* ${cleanMd(scan.note)}` : "";
    const cambodiaDate = formatCambodiaDateTime(scan.date || null);

    return [
        `🧾 *Slip / Receipt Detected*`,
        ``,
        `● *Bank:*        ${cleanMd(bankName)}`,
        `● *${isIncome ? "Payer" : "Merchant"}:*   ${cleanMd(merchant)}`,
        `● *Amount:*      \`${mainAmt}\`${altAmt}`,
        `● *Category:*    ${icon} *${capitalize(scan.category)}*`,
        `● *Date & Time:* 📅 \`${cambodiaDate.full} ICT\`${note}`,
        ``,
        `_Tap below to confirm and record:_`
    ].join("\n");
}

export function getPendingScanKeyboard(scan) {
    const isIncome = scan.type === "income";
    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const amtStr = `${symbol}${formatMoney(scan.amount)}${suffix}`;

    return {
        inline_keyboard: [
            [
                {
                    text: `✓ Confirm (${amtStr})`,
                    callback_data: `scan_ok:${scan.id}`
                }
            ],
            [
                {
                    text: `🏷️ ${getCategoryIcon(scan.category, scan.type)} ${capitalize(scan.category)}`,
                    callback_data: `scan_cat:${scan.id}`
                },
                {
                    text: isIncome ? "⇄ To Expense" : "⇄ To Income",
                    callback_data: `scan_type:${scan.id}`
                }
            ],
            [
                {
                    text: "✕ Discard",
                    callback_data: `scan_del:${scan.id}`
                }
            ]
        ]
    };
}

export async function renderPendingScanCard(env, chatId, scanOrId, messageId) {
    let scan = null;
    if (scanOrId && typeof scanOrId === "object") {
        scan = scanOrId;
    } else {
        const idToFind = scanOrId || 0;
        if (idToFind) {
            scan = await env.DB.prepare(
                "SELECT * FROM pending_scans WHERE id = ?"
            ).bind(idToFind).first();
        }
        if (!scan) {
            scan = await env.DB.prepare(
                "SELECT * FROM pending_scans WHERE chat_id = ? ORDER BY id DESC LIMIT 1"
            ).bind(String(chatId)).first();
        }
    }

    if (!scan) {
        console.error("renderPendingScanCard: No pending scan found for chat", chatId);
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Could not display receipt details. Please try sending the image again.");
        return;
    }

    const text = formatPendingScanText(scan);
    const markup = getPendingScanKeyboard(scan);

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: markup
    });
}

export async function sendScanHelp(env, chatId, messageId = null) {
    const text = [
        `📸 *Receipt & Slip Scanner*`,
        ``,
        `Simply send or forward any payment screenshot or receipt photo directly into this chat!`,
        ``,
        `✅ *Supported Slips & Receipts:*`,
        `• 🏦 *ABA Mobile* (KHQR transfers & merchant payments)`,
        `• 🇰🇭 *Bakong* (KHQR payments & transfers)`,
        `• 💳 *Acleda ToanChet, Wing, TrueMoney, Canadia*`,
        `• 🧾 *Store & Cafe Receipts* (Brown Coffee, Starbucks, Supermarkets)`,
        ``,
        `💡 *How it works:*`,
        `1. Send your bank slip screenshot`,
        `2. AI automatically detects the amount, merchant, and category`,
        `3. Tap *[✓ Confirm]* to record it to your ledger!`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💳 Finance", callback_data: "finance_hub" },
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function handleScanConfirm(env, chatId, userId, scanId, messageId, callbackId) {
    await ensureTables(env.DB);
    const scan = await env.DB.prepare(
        "SELECT * FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).first();

    if (!scan) {
        if (callbackId) await answerCallback(env, callbackId, { text: "⚠️ Scan not found or already processed." });
        if (messageId) {
            try {
                await telegram(env, "editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: "⚠️ *This scan was already processed or has expired.*",
                    parse_mode: "Markdown"
                });
            } catch (e) {}
        }
        return;
    }

    const txId = await addExpenseRecord(
        env.DB,
        userId,
        scan.amount,
        scan.category,
        scan.type,
        scan.currency,
        scan.date,
        scan.merchant || null,
        scan.note || null
    );

    await env.DB.prepare("DELETE FROM pending_scans WHERE id = ?").bind(scanId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: "✅ Slip recorded to cashflow!" });

    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const amtStr = `${symbol}${formatMoney(scan.amount)}${suffix}`;
    const icon = getCategoryIcon(scan.category, scan.type);
    const cambodiaDate = formatCambodiaDateTime(scan.date || null);

    if (messageId) {
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: [
                    `✅ *Receipt Recorded*`,
                    ``,
                    `● *Amount:*      \`${amtStr}\``,
                    `● *Category:*    ${icon} *${capitalize(scan.category)}*`,
                    `● *Source:*      ${cleanMd(scan.bank || "Bank Transfer")}`,
                    scan.merchant ? `● *Merchant:*    🏪 *${cleanMd(scan.merchant)}*` : "",
                    `● *Date & Time:* 📅 \`${cambodiaDate.full} ICT\``,
                    ``,
                    `_Saved to your ledger._`
                ].filter(Boolean).join("\n"),
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }

    await sendTransactionReceipt(
        env,
        chatId,
        userId,
        scan.type,
        scan.amount,
        scan.currency,
        scan.category,
        null,
        { merchant: scan.merchant, note: scan.note, txId, customDate: scan.date }
    );
}

export async function sendScanCategoryPicker(env, chatId, scanId, messageId) {
    const scan = await env.DB.prepare(
        "SELECT * FROM pending_scans WHERE id = ?"
    ).bind(scanId).first();

    if (!scan) return;

    const rows = [];
    for (let i = 0; i < QUICK_EXPENSE_CATS.length; i += 2) {
        const row = [
            {
                text: `${QUICK_EXPENSE_CATS[i].icon} ${QUICK_EXPENSE_CATS[i].name}`,
                callback_data: `scan_set_cat:${scanId}:${QUICK_EXPENSE_CATS[i].name}`
            }
        ];
        if (i + 1 < QUICK_EXPENSE_CATS.length) {
            row.push({
                text: `${QUICK_EXPENSE_CATS[i + 1].icon} ${QUICK_EXPENSE_CATS[i + 1].name}`,
                callback_data: `scan_set_cat:${scanId}:${QUICK_EXPENSE_CATS[i + 1].name}`
            });
        }
        rows.push(row);
    }
    rows.push([
        { text: "⬅️ Back to Slip", callback_data: `scan_view:${scanId}` }
    ]);

    await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `🏷️ *Select Category for this Slip:*\nCurrent: *${getCategoryIcon(scan.category, scan.type)} ${capitalize(scan.category)}*`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows }
    });
}

export async function handleScanSetCategory(env, chatId, userId, scanId, newCat, messageId, callbackId) {
    await env.DB.prepare(
        "UPDATE pending_scans SET category = ? WHERE id = ? AND user_id = ?"
    ).bind(normalizeCategory(newCat), scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: `Category set to ${newCat}!` });
    await renderPendingScanCard(env, chatId, scanId, messageId);
}

export async function handleScanToggleType(env, chatId, userId, scanId, messageId, callbackId) {
    const scan = await env.DB.prepare(
        "SELECT type FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).first();

    if (!scan) return;
    const newType = scan.type === "income" ? "expense" : "income";
    await env.DB.prepare(
        "UPDATE pending_scans SET type = ? WHERE id = ? AND user_id = ?"
    ).bind(newType, scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: `Switched to ${newType === "income" ? "Income" : "Expense"}!` });
    await renderPendingScanCard(env, chatId, scanId, messageId);
}

export async function handleScanDiscard(env, chatId, userId, scanId, messageId, callbackId) {
    await env.DB.prepare(
        "DELETE FROM pending_scans WHERE id = ? AND user_id = ?"
    ).bind(scanId, userId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: "🗑️ Scan discarded." });
    if (messageId) {
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: "🗑️ *Bank slip scan discarded.*",
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }
}

export async function handleImageReceipt(message, env, origin) {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const caption = (message.caption || "").trim();

    await ensureTables(env.DB);

    let fileId = null;
    let mimeType = "image/jpeg";
    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
        fileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.document && message.document.mime_type && message.document.mime_type.startsWith("image/")) {
        fileId = message.document.file_id;
        mimeType = message.document.mime_type;
    }

    if (!fileId) return;

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    let statusMsg = null;
    try {
        statusMsg = await sendMessage(
            env,
            chatId,
            `🔍 *Scanning bank slip / receipt...*\n_Reading transaction details with AI OCR..._`,
            { parse_mode: "Markdown" }
        );
    } catch (e) {}
    const statusMsgId = statusMsg?.result?.message_id;

    try {
        const fileInfo = await telegram(env, "getFile", { file_id: fileId });
        const filePath = fileInfo.result?.file_path;
        if (!filePath) {
            throw new Error("Could not retrieve file path from Telegram.");
        }

        if (filePath.endsWith(".png")) mimeType = "image/png";
        else if (filePath.endsWith(".webp")) mimeType = "image/webp";

        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const imgResponse = await fetch(fileUrl);
        if (!imgResponse.ok) {
            throw new Error("Failed to download image file from Telegram.");
        }

        const arrayBuffer = await imgResponse.arrayBuffer();
        const base64Data = arrayBufferToBase64(arrayBuffer);

        const parsed = await parseReceiptImage(env, base64Data, mimeType, caption);

        if (!parsed || !parsed.amount || parsed.amount <= 0 || parsed.is_slip === false) {
            // Check if this is a general image, code error, or query for Friday
            try {
                const analysis = await analyzeImageWithAi(
                    env,
                    base64Data,
                    mimeType,
                    caption || "Analyze this image, explain what is shown, and provide tactical recommendations."
                );

                if (analysis && analysis.length > 5) {
                    await safeEditOrSendMessage(env, chatId, statusMsgId, analysis, {
                        parse_mode: "Markdown",
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: "🛡️ Tactical Briefing", callback_data: "friday_briefing" },
                                    { text: "🏠 Main Hub", callback_data: "hub" }
                                ]
                            ]
                        }
                    });
                    return;
                }
            } catch (visionErr) {
                console.warn("Friday vision analysis fallback error:", visionErr);
            }

            const notFoundText = [
                `⚠️ *Amount Not Detected*`,
                ``,
                `We couldn't clearly identify an amount or bank slip in this image.`,
                ``,
                `💡 *Tips for best results:*`,
                `• Send a clear screenshot of your ABA Bank, Bakong, or KHQR transfer slip.`,
                `• For restaurant/store receipts, ensure the total amount is visible.`,
                `• Or type directly: \`5 coffee\` or \`/add 5 usd lunch\``
            ].join("\n");

            await safeEditOrSendMessage(env, chatId, statusMsgId, notFoundText, { parse_mode: "Markdown" });
            return;
        }

        const insertResult = await env.DB.prepare(`
            INSERT INTO pending_scans (user_id, chat_id, amount, currency, category, type, merchant, bank, note, date, message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            userId,
            String(chatId),
            parsed.amount,
            parsed.currency,
            parsed.category,
            parsed.type,
            parsed.merchant || null,
            parsed.bank || null,
            parsed.note || null,
            parsed.date || today(),
            statusMsgId || null
        ).run();

        const scanId = insertResult.meta?.last_row_id || 
            (await env.DB.prepare("SELECT id FROM pending_scans WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first())?.id;

        const scanObj = {
            id: scanId,
            user_id: userId,
            chat_id: String(chatId),
            amount: parsed.amount,
            currency: parsed.currency,
            category: parsed.category,
            type: parsed.type,
            merchant: parsed.merchant || null,
            bank: parsed.bank || null,
            note: parsed.note || null,
            date: parsed.date || today()
        };

        await renderPendingScanCard(env, chatId, scanObj, statusMsgId);

    } catch (err) {
        console.error("Receipt scan error:", err);
        const errMsg = [
            `⚠️ *Scan processing error:* ${cleanMd(err.message)}`,
            ``,
            `💡 You can still log manually: \`5 coffee\` or \`/add 5 usd lunch\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, statusMsgId, errMsg, { parse_mode: "Markdown" });
    }
}

export function formatPendingStatementText(stmt) {
    const periodStr = stmt.period ? `\n● *Period:*    \`${cleanMd(stmt.period)}\`` : "";
    const accountStr = stmt.account_name ? `\n● *Account:*   \`${cleanMd(stmt.account_name)}\`` : "";
    const symbol = stmt.currency === "USD" ? "$" : "";
    const suffix = stmt.currency === "KHR" ? " ៛" : "";

    const inflowStr = `+${symbol}${formatMoney(stmt.total_inflow)}${suffix}`;
    const outflowStr = `-${symbol}${formatMoney(stmt.total_outflow)}${suffix}`;

    let summaryStr = "";
    if (stmt.summary_markdown) {
        summaryStr = `\n\n💡 _${cleanMd(stmt.summary_markdown)}_`;
    }

    return [
        `📄 *${cleanMd(stmt.bank || "Bank Statement")} Detected*`,
        ``,
        `● *Bank:*      *${cleanMd(stmt.bank || "Bank Statement")}*${accountStr}${periodStr}`,
        `● *Inflow:*    \`${inflowStr}\``,
        `● *Outflow:*   \`${outflowStr}\``,
        `● *Total Txns:* *${stmt.transaction_count} transactions*`,
        summaryStr,
        ``,
        `_Boss, tap below to record all transactions into your cashflow ledger:_`
    ].join("\n");
}

export function getPendingStatementKeyboard(stmt) {
    return {
        inline_keyboard: [
            [
                {
                    text: `✓ Import All (${stmt.transaction_count} Txns)`,
                    callback_data: `stmt_import:${stmt.id}`
                }
            ],
            [
                {
                    text: "📋 View Breakdown",
                    callback_data: `stmt_view:${stmt.id}`
                },
                {
                    text: "✕ Discard",
                    callback_data: `stmt_del:${stmt.id}`
                }
            ]
        ]
    };
}

export async function renderPendingStatementCard(env, chatId, stmtOrId, messageId) {
    let stmt = null;
    if (stmtOrId && typeof stmtOrId === "object") {
        stmt = stmtOrId;
    } else {
        stmt = await getPendingStatement(env.DB, stmtOrId, chatId);
        if (!stmt) {
            stmt = await env.DB.prepare(
                "SELECT * FROM pending_statements WHERE chat_id = ? ORDER BY id DESC LIMIT 1"
            ).bind(String(chatId)).first();
        }
    }

    if (!stmt) {
        await safeEditOrSendMessage(env, chatId, messageId, "⚠️ Could not find statement details. Please try sending the document again.");
        return;
    }

    const text = formatPendingStatementText(stmt);
    const keyboard = getPendingStatementKeyboard(stmt);
    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
}

export async function handleStatementImport(env, chatId, userId, stmtId, messageId, callbackId) {
    const stmt = await getPendingStatement(env.DB, stmtId, userId);
    if (!stmt) {
        if (callbackId) await answerCallback(env, callbackId, { text: "Statement not found or expired.", show_alert: true });
        return;
    }

    const result = await importPendingStatementTransactions(env.DB, stmtId, userId);
    if (!result.success) {
        if (callbackId) await answerCallback(env, callbackId, { text: "Import failed: " + (result.error || "unknown error"), show_alert: true });
        return;
    }

    if (callbackId) await answerCallback(env, callbackId, { text: `✅ Recorded ${result.count} transactions into ledger!` });

    const symbol = stmt.currency === "USD" ? "$" : "";
    const suffix = stmt.currency === "KHR" ? " ៛" : "";
    const inflowStr = `+${symbol}${formatMoney(stmt.total_inflow)}${suffix}`;
    const outflowStr = `-${symbol}${formatMoney(stmt.total_outflow)}${suffix}`;

    const text = [
        `✅ *Bank Statement Transactions Recorded*`,
        ``,
        `Boss, successfully imported *${result.count} transactions* from *${cleanMd(stmt.bank)}* into your cashflow ledger!`,
        ``,
        `● *Total Inflow:*   \`${inflowStr}\``,
        `● *Total Outflow:*  \`${outflowStr}\``,
        ``,
        `_All items are now live in your itemized ledger and summaries._`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📊 Month Summary", callback_data: "summary_month" },
                    { text: "📅 Today's Ledger", callback_data: "transactions_today" }
                ],
                [
                    { text: "🏠 Main Hub", callback_data: "hub" }
                ]
            ]
        }
    });
}

export async function handleStatementViewBreakdown(env, chatId, userId, stmtId, messageId, callbackId) {
    const stmt = await getPendingStatement(env.DB, stmtId, userId);
    if (!stmt) {
        if (callbackId) await answerCallback(env, callbackId, { text: "Statement not found.", show_alert: true });
        return;
    }

    if (callbackId) await answerCallback(env, callbackId);

    let transactions = [];
    try {
        transactions = JSON.parse(stmt.transactions_json);
    } catch (_) {}

    const sample = transactions.slice(0, 10);
    const lines = sample.map(t => {
        const sign = t.type === "income" ? "+" : "-";
        const sym = t.currency === "USD" ? "$" : "";
        const suf = t.currency === "KHR" ? " ៛" : "";
        return `• \`${t.date || "--"}\`: \`${sign}${sym}${formatMoney(t.amount)}${suf}\` *${cleanMd(t.merchant || "Bank")}* _(${t.category})_`;
    });

    if (transactions.length > 10) {
        lines.push(`_...and ${transactions.length - 10} more transactions_`);
    }

    const text = [
        `📋 *${cleanMd(stmt.bank)} • Transaction Breakdown*`,
        ``,
        `Period: \`${cleanMd(stmt.period || "Current")}\``,
        `Total: *${stmt.transaction_count} transactions*`,
        ``,
        ...lines,
        ``,
        `_Ready to import directly to ledger:_`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: `✓ Import All (${stmt.transaction_count} Txns)`, callback_data: `stmt_import:${stmt.id}` }
                ],
                [
                    { text: "⬅️ Back to Statement", callback_data: `stmt_back:${stmt.id}` },
                    { text: "✕ Discard", callback_data: `stmt_del:${stmt.id}` }
                ]
            ]
        }
    });
}

export async function handleStatementDiscard(env, chatId, userId, stmtId, messageId, callbackId) {
    await deletePendingStatement(env.DB, stmtId, userId);
    if (callbackId) await answerCallback(env, callbackId, { text: "🗑️ Statement discarded." });
    await safeEditOrSendMessage(env, chatId, messageId, "🗑️ *Bank statement scan discarded.*", {
        parse_mode: "Markdown"
    });
}

export async function handlePdfDocument(message, env, origin) {
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);
    const caption = (message.caption || "").trim();
    const fileName = message.document?.file_name || "document.pdf";
    const fileId = message.document?.file_id;

    if (!fileId) return;
    await ensureTables(env.DB);

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (_) {}

    let statusMsg = null;
    try {
        statusMsg = await sendMessage(
            env,
            chatId,
            `📄 *Scanning PDF document...*\n_Analyzing ${cleanMd(fileName)} with Gemini AI..._`,
            { parse_mode: "Markdown" }
        );
    } catch (_) {}
    const statusMsgId = statusMsg?.result?.message_id;

    try {
        const fileInfo = await telegram(env, "getFile", { file_id: fileId });
        const filePath = fileInfo.result?.file_path;
        if (!filePath) {
            throw new Error("Could not retrieve file path from Telegram.");
        }

        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const pdfResp = await fetch(fileUrl);
        if (!pdfResp.ok) {
            throw new Error("Failed to download PDF file from Telegram.");
        }

        const arrayBuffer = await pdfResp.arrayBuffer();
        const base64Data = arrayBufferToBase64(arrayBuffer);

        const parsed = await parseStatementOrInvoicePdfWithGemini(env, base64Data, fileName, caption);
        if (!parsed) {
            await safeEditOrSendMessage(
                env,
                chatId,
                statusMsgId,
                `⚠️ *Could not extract financial data from this PDF.*\n\nMake sure the document is a bank statement (ABA, Bakong, Acleda) or an official invoice with clear amounts.`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        if (parsed.is_statement === true) {
            // Multi-transaction statement
            const stmtId = await savePendingStatement(env.DB, {
                userId,
                chatId,
                bank: parsed.bank,
                period: parsed.period,
                currency: parsed.currency,
                totalInflow: parsed.total_inflow,
                totalOutflow: parsed.total_outflow,
                transactionCount: parsed.transaction_count,
                transactionsJson: JSON.stringify(parsed.transactions)
            });

            const stmtObj = {
                id: stmtId,
                user_id: userId,
                chat_id: String(chatId),
                bank: parsed.bank,
                account_name: parsed.account_name,
                period: parsed.period,
                currency: parsed.currency,
                total_inflow: parsed.total_inflow,
                total_outflow: parsed.total_outflow,
                transaction_count: parsed.transaction_count,
                summary_markdown: parsed.summary_markdown
            };

            await renderPendingStatementCard(env, chatId, stmtObj, statusMsgId);
            return;
        }

        // Single invoice or slip in PDF form
        const single = parsed.single_transaction || parsed;
        const insertResult = await env.DB.prepare(`
            INSERT INTO pending_scans (user_id, chat_id, amount, currency, category, type, merchant, bank, note, date, message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            userId,
            String(chatId),
            single.amount,
            single.currency,
            single.category,
            single.type,
            single.merchant || null,
            single.bank || null,
            single.note || null,
            single.date || today(),
            statusMsgId || null
        ).run();

        const scanId = insertResult.meta?.last_row_id || 
            (await env.DB.prepare("SELECT id FROM pending_scans WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first())?.id;

        const scanObj = {
            id: scanId,
            user_id: userId,
            chat_id: String(chatId),
            amount: single.amount,
            currency: single.currency,
            category: single.category,
            type: single.type,
            merchant: single.merchant || null,
            bank: single.bank || null,
            note: single.note || null,
            date: single.date || today()
        };

        await renderPendingScanCard(env, chatId, scanObj, statusMsgId);

    } catch (err) {
        console.error("PDF statement scan error:", err);
        await safeEditOrSendMessage(
            env,
            chatId,
            statusMsgId,
            `⚠️ *PDF Scan error:* ${cleanMd(err.message)}`,
            { parse_mode: "Markdown" }
        );
    }
}

