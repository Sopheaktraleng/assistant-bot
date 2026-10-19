import { sanitizeMd } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, sendMessage, safeEditOrSendMessage } from "../../services/telegram.js";
import { callAiTextModel, parseMovieJson } from "../../services/ai.js";

export async function handleAddMovieCommand(env, chatId, userId, titleInput) {
    await ensureTables(env.DB);
    const title = titleInput.trim();
    if (!title) {
        await sendMessage(env, chatId, "❌ Please specify a title to add, e.g. `/watch add Inception`", { parse_mode: "Markdown" });
        return;
    }

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const systemPrompt = `You are a film database assistant. Given a movie or series title, return pure JSON with year, genre, rating, runtime, platforms, and a 1-2 sentence synopsis. Respond with PURE JSON ONLY:
{"title": "Clean Title", "year": "Release Year", "genre": "Genre", "rating": "IMDb Rating", "runtime": "Runtime or Seasons", "platforms": "Popular Platforms", "synopsis": "Short hook synopsis"}`;

    let movieData = null;
    const aiResp = await callAiTextModel(env, systemPrompt, `Title: "${title}"`, 0.2);
    if (aiResp) {
        movieData = parseMovieJson(aiResp);
    }

    const cleanTitle = movieData?.title || title;
    const year = movieData?.year || "";
    const genre = movieData?.genre || "Movie";
    const rating = movieData?.rating || "";
    const runtime = movieData?.runtime || "";
    const platforms = movieData?.platforms || "";
    const synopsis = movieData?.synopsis || "Added to watchlist.";

    const res = await env.DB.prepare(`
        INSERT INTO watchlist (user_id, title, year, genre, rating, runtime, platforms, synopsis, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'plan_to_watch')
    `).bind(userId, cleanTitle, year, genre, rating, runtime, platforms, synopsis).run();

    const newId = res.meta?.last_row_id;

    const text = [
        `⭐ *Added to Watchlist!*`,
        `────────────────────`,
        `🎬 *${sanitizeMd(cleanTitle)}* ${year ? `(${sanitizeMd(year)})` : ""}`,
        rating ? `⭐ \`${sanitizeMd(rating)}\`` : "",
        genre ? `🎭 *Genre:* ${sanitizeMd(genre)}` : "",
        runtime ? `⏱️ *Length:* ${sanitizeMd(runtime)}` : "",
        synopsis ? `\n📝 _${sanitizeMd(synopsis)}_` : "",
        `────────────────────`
    ].filter(Boolean).join("\n");

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🍿 Mark Watched", callback_data: `wl_watched:${newId}` },
                    { text: "📋 View Watchlist", callback_data: "watchlist" }
                ],
                [
                    { text: "🍿 Movie Hub", callback_data: "movie_hub" }
                ]
            ]
        }
    });
}

export async function handlePickRandomMovie(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const row = await env.DB.prepare(
        "SELECT id, title, year, genre, rating, runtime, platforms, synopsis, why_love FROM watchlist WHERE user_id = ? AND status = 'plan_to_watch' ORDER BY RANDOM() LIMIT 1"
    ).bind(userId).first();

    if (!row) {
        const text = [
            `🎲 *No Unwatched Titles Available!*`,
            `────────────────────`,
            `You don't have any unwatched titles in your watchlist yet.`,
            ``,
            `💡 Tap **Get Recommendation** to discover something great!`,
            `────────────────────`
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, text, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🍿 Get Movie Recommendation", callback_data: "movie_hub" }],
                    [{ text: "📋 View Watchlist", callback_data: "watchlist" }]
                ]
            }
        });
        return;
    }

    const text = [
        `🎲 *Tonight's Random Watch Pick!*`,
        `────────────────────`,
        `🎬 *${sanitizeMd(row.title)}* ${row.year ? `(${sanitizeMd(row.year)})` : ""}`,
        row.rating ? `⭐ \`${sanitizeMd(row.rating)}\`` : "",
        row.genre ? `🎭 *Genre:* ${sanitizeMd(row.genre)}` : "",
        row.runtime ? `⏱️ *Length:* ${sanitizeMd(row.runtime)} • 📺 ${sanitizeMd(row.platforms || "Various")}` : "",
        `────────────────────`,
        row.synopsis ? `📝 *Synopsis:*\n${sanitizeMd(row.synopsis)}\n` : "",
        row.why_love ? `💡 *Why You'll Love It:*\n_${sanitizeMd(row.why_love)}_\n` : "",
        `────────────────────`
    ].filter(Boolean).join("\n");

    const keyboard = [
        [
            { text: "🍿 Mark Watched", callback_data: `wl_watched:${row.id}` },
            { text: "🎲 Roll Another Saved", callback_data: "wl_pick" }
        ],
        [
            { text: "📋 Back to Watchlist", callback_data: "watchlist" },
            { text: "🍿 Movie Hub", callback_data: "movie_hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}
