export async function telegram(env, method, payload) {
    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram ${method} failed: ${response.status} ${detail}`);
    }

    return response.json();
}

export async function sendMessage(env, chatId, text, extra = {}) {
    try {
        return await telegram(env, "sendMessage", {
            chat_id: chatId,
            text,
            ...extra,
        });
    } catch (err) {
        if (extra.parse_mode) {
            console.warn("Telegram sendMessage failed with parse_mode, retrying as plain text:", err.message);
            const { parse_mode, ...fallbackExtra } = extra;
            const cleanText = text.replace(/[*`_]/g, "");
            return await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: cleanText,
                ...fallbackExtra,
            });
        }
        throw err;
    }
}

export async function answerCallback(env, callbackQueryId, extra = {}) {
    if (!callbackQueryId) return null;
    try {
        return await telegram(env, "answerCallbackQuery", {
            callback_query_id: callbackQueryId,
            ...extra,
        });
    } catch (err) {
        console.warn("answerCallback warning (non-fatal):", err.message);
        return null;
    }
}

export async function safeEditOrSendMessage(env, chatId, messageId, text, extra = {}) {
    if (messageId) {
        try {
            return await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                ...extra
            });
        } catch (err) {
            console.warn("editMessageText failed with error:", err.message);
            if (extra.parse_mode) {
                try {
                    const { parse_mode, ...fallbackExtra } = extra;
                    const cleanText = text.replace(/[*`_]/g, "");
                    return await telegram(env, "editMessageText", {
                        chat_id: chatId,
                        message_id: messageId,
                        text: cleanText,
                        ...fallbackExtra
                    });
                } catch (err2) {
                    console.warn("editMessageText plain fallback failed:", err2.message);
                }
            }
        }
    }

    return await sendMessage(env, chatId, text, extra);
}

export async function sendTelegramDocument(env, chatId, file, caption = "") {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", file);
    if (caption) {
        formData.append("caption", caption);
    }

    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
        {
            method: "POST",
            body: formData,
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram sendDocument failed with status ${response.status}: ${detail}`);
    }

    return response.json();
}

export async function sendChatAction(env, chatId, action = "typing") {
    try {
        return await telegram(env, "sendChatAction", { chat_id: chatId, action });
    } catch (_) {
        return null;
    }
}
