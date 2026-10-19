import { EXCHANGE_RATE, QUICK_EXPENSE_CATS } from "../../config/constants.js";
import { today } from "../../utils/time.js";
import { cleanMd, formatMoney, capitalize, getCategoryIcon, normalizeCategory } from "../../utils/format.js";
import { arrayBufferToBase64 } from "../../utils/crypto.js";
import { addExpenseRecord } from "../../db/queries.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, answerCallback, safeEditOrSendMessage } from "../../services/telegram.js";
import { parseReceiptImage } from "../../services/ai.js";
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
    const date = scan.date || today();

    return [
        `🧾 *Slip / Receipt Detected*`,
        `────────────────────`,
        `● *Bank:*     ${cleanMd(bankName)}`,
        `● *${isIncome ? "Payer" : "Merchant"}:*  ${cleanMd(merchant)}`,
        `● *Amount:*   \`${mainAmt}\`${altAmt}`,
        `● *Category:* ${icon} *${capitalize(scan.category)}*`,
        `● *Date:*     \`${date}\`${note}`,
        `────────────────────`,
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
        `────────────────────`,
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

    await addExpenseRecord(
        env.DB,
        userId,
        scan.amount,
        scan.category,
        scan.type,
        scan.currency,
        scan.date
    );

    await env.DB.prepare("DELETE FROM pending_scans WHERE id = ?").bind(scanId).run();

    if (callbackId) await answerCallback(env, callbackId, { text: "✅ Slip recorded to cashflow!" });

    const symbol = scan.currency === "USD" ? "$" : "";
    const suffix = scan.currency === "KHR" ? " ៛" : "";
    const amtStr = `${symbol}${formatMoney(scan.amount)}${suffix}`;
    const icon = getCategoryIcon(scan.category, scan.type);

    if (messageId) {
        try {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: [
                    `✅ *Receipt Recorded*`,
                    `────────────────────`,
                    `● *Amount:*   \`${amtStr}\``,
                    `● *Category:* ${icon} *${capitalize(scan.category)}*`,
                    `● *Source:*   ${cleanMd(scan.bank || "Bank Transfer")}`,
                    scan.merchant ? `● *Merchant:* *${cleanMd(scan.merchant)}*` : "",
                    `● *Date:*     \`${scan.date || today()}\``,
                    `────────────────────`,
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
        scan.category
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

        if (!parsed || !parsed.amount || parsed.amount <= 0) {
            const notFoundText = [
                `⚠️ *Amount Not Detected*`,
                `────────────────────`,
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
