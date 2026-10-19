import { cleanMd } from "../../utils/format.js";
import { telegram, sendMessage, safeEditOrSendMessage } from "../../services/telegram.js";
import { transcribeAudioFile } from "../../services/ai.js";

export async function sendVoiceHelp(env, chatId, messageId = null) {
    const text = [
        `🎙️ *Hands-Free Voice Notes*`,
        `────────────────────`,
        `Speak directly to your personal assistant instead of typing!`,
        ``,
        `💡 *What you can say:*`,
        `• 💰 *Log Spending:* _"Spent 5 dollars on iced coffee"_ or _"10000 lunch"_`,
        `• 💵 *Log Income:* _"+500 freelance project"_`,
        `• 💼 *Work Task:* _"Done: finished api authentication bugfix"_`,
        `• ⏰ *Reminders:* _"Remind me in 30 minutes to check the oven"_`,
        `• ✨ *Questions:* _"How much did I spend this week?"_ or _"Can I afford dinner?"_`,
        ``,
        `🗣️ *Languages Supported:* English, Khmer (*អក្សរខ្មែរ*), and mixed.`,
        ``,
        `👉 *To start:* Simply press and hold the 🎙️ **Microphone button** in Telegram and speak!`
    ].join("\n");

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🏠 Main Hub", callback_data: "hub" },
                    { text: "✨ AI Copilot", callback_data: "copilot_help" }
                ]
            ]
        }
    });
}

export async function handleVoiceMessage(message, env, origin, onTranscribedMessage) {
    const chatId = message.chat.id;

    let fileId = null;
    let mimeType = "audio/ogg";
    let duration = 0;
    let fileSize = 0;

    if (message.voice) {
        fileId = message.voice.file_id;
        mimeType = message.voice.mime_type || "audio/ogg";
        duration = message.voice.duration || 0;
        fileSize = message.voice.file_size || 0;
    } else if (message.audio) {
        fileId = message.audio.file_id;
        mimeType = message.audio.mime_type || "audio/mp3";
        duration = message.audio.duration || 0;
        fileSize = message.audio.file_size || 0;
    } else if (message.document && message.document.mime_type && message.document.mime_type.startsWith("audio/")) {
        fileId = message.document.file_id;
        mimeType = message.document.mime_type;
        fileSize = message.document.file_size || 0;
    }

    if (!fileId) return;

    if (duration > 180 || fileSize > 15 * 1024 * 1024) {
        await sendMessage(
            env,
            chatId,
            `⚠️ *Voice note is too long*\nPlease send a voice message shorter than 3 minutes.`,
            { parse_mode: "Markdown" }
        );
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "record_voice" });
    } catch (_) {}

    let statusMsg = null;
    try {
        statusMsg = await sendMessage(
            env,
            chatId,
            `🎙️ *Listening to your voice note...*\n_Transcribing with AI..._`,
            { parse_mode: "Markdown" }
        );
    } catch (_) {}
    const statusMsgId = statusMsg?.result?.message_id;

    try {
        const fileInfo = await telegram(env, "getFile", { file_id: fileId });
        const filePath = fileInfo.result?.file_path;
        if (!filePath) {
            throw new Error("Could not retrieve voice file path from Telegram.");
        }

        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const audioResponse = await fetch(fileUrl);
        if (!audioResponse.ok) {
            throw new Error("Failed to download voice file from Telegram.");
        }

        const arrayBuffer = await audioResponse.arrayBuffer();
        const rawTranscription = await transcribeAudioFile(env, arrayBuffer, mimeType);
        const transcribedText = (rawTranscription || "").replace(/[.,!?;]+$/, "").trim();

        if (!transcribedText || transcribedText.length < 2) {
            const noRecognizeMsg = [
                `⚠️ *Could not understand audio*`,
                `────────────────────`,
                `Please try speaking closer to the microphone, or type your message directly.`,
                ``,
                `💡 *Try saying:*`,
                `• _"5 coffee"_ or _"Spent $4 on iced coffee"_`,
                `• _"Done finished authentication bugfix"_`,
                `• _"Remind me in 30 minutes to check oven"_`,
                `• _"How much did I spend this week?"_`
            ].join("\n");

            await safeEditOrSendMessage(env, chatId, statusMsgId, noRecognizeMsg, { parse_mode: "Markdown" });
            return;
        }

        // Display recognized transcript block
        if (statusMsgId) {
            await telegram(env, "editMessageText", {
                chat_id: chatId,
                message_id: statusMsgId,
                text: `🎙️ _"${cleanMd(transcribedText)}"_`,
                parse_mode: "Markdown"
            }).catch(() => {});
        }

        // Pass transcribed text into handler
        const syntheticMessage = {
            ...message,
            text: transcribedText,
            voice: undefined,
            audio: undefined,
            isFromVoice: true
        };

        if (typeof onTranscribedMessage === "function") {
            await onTranscribedMessage(syntheticMessage, env, origin);
        }
    } catch (err) {
        console.error("handleVoiceMessage error:", err);
        const errMsg = [
            `⚠️ *Voice processing error:* ${cleanMd(err.message)}`,
            ``,
            `💡 You can still type directly: \`5 coffee\` or \`/hub\``
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, statusMsgId, errMsg, { parse_mode: "Markdown" });
    }
}
