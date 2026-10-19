import { sanitizeMd } from "../../utils/format.js";
import { ensureTables } from "../../db/schema.js";
import { telegram, safeEditOrSendMessage } from "../../services/telegram.js";
import { callAiTextModel, parseMovieJson } from "../../services/ai.js";

export const MOVIE_GENRE_PROMPTS = {
    scifi: "mind-bending sci-fi movie or series with intelligent storytelling and high concept ideas",
    thriller: "gripping, edge-of-your-seat psychological thriller or crime mystery with unexpected twists",
    comedy: "hilarious, feel-good comedy or comedy series with sharp humor and great vibes",
    action: "thrilling high-octane action blockbuster with breathtaking sequences and great direction",
    romance: "heartwarming, emotionally resonant romantic comedy or romance film",
    horror: "acclaimed atmospheric horror, spooky mystery, or supernatural thriller",
    drama: "deeply moving, award-winning dramatic masterpiece with profound emotional depth",
    anime: "visually stunning and critically acclaimed anime film or anime series",
    random: "universally acclaimed, highly entertaining masterpiece movie from any genre"
};

export const MOVIE_FALLBACKS = [
    {
        title: "Interstellar",
        year: "2014",
        genre: "Sci-Fi, Adventure, Drama",
        rating: "8.7/10 IMDb • 87% RT",
        runtime: "2h 49m",
        platforms: "Netflix, Prime Video",
        synopsis: "When Earth becomes uninhabitable, a team of astronauts travels through a wormhole in search of a new home for mankind.",
        why_love: "Visually awe-inspiring, emotionally gripping, with Hans Zimmer's unforgettable score."
    },
    {
        title: "Everything Everywhere All at Once",
        year: "2022",
        genre: "Action, Comedy, Sci-Fi",
        rating: "7.8/10 IMDb • 94% RT",
        runtime: "2h 19m",
        platforms: "Netflix, Apple TV",
        synopsis: "An aging Chinese immigrant gets swept up in an insane adventure where she alone can save existence by exploring alternate universes.",
        why_love: "Mind-blowingly creative, wildly hilarious, yet deeply moving about family love."
    },
    {
        title: "Knives Out",
        year: "2019",
        genre: "Mystery, Comedy, Crime",
        rating: "7.9/10 IMDb • 97% RT",
        runtime: "2h 10m",
        platforms: "Netflix, Prime Video",
        synopsis: "A brilliant detective investigates the death of a wealthy mystery novelist among his eccentric, combative family.",
        why_love: "Razor-sharp wit, brilliant plot twists, and pure popcorn entertainment."
    },
    {
        title: "Spirited Away",
        year: "2001",
        genre: "Animation, Adventure, Fantasy",
        rating: "8.6/10 IMDb • 97% RT",
        runtime: "2h 5m",
        platforms: "Netflix, HBO Max",
        synopsis: "A young girl wanders into a strange world of spirits ruled by an evil witch, where those who disobey are turned into beasts.",
        why_love: "A timeless Hayao Miyazaki masterpiece filled with wonder, empathy, and unmatched artistry."
    },
    {
        title: "Severance",
        year: "2022",
        genre: "Sci-Fi, Psychological Thriller",
        rating: "8.7/10 IMDb • 97% RT",
        runtime: "1 Season, 9 eps",
        platforms: "Apple TV+",
        synopsis: "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
        why_love: "One of the most suspenseful, original, and addictive television shows in modern history."
    }
];

export async function sendMovieRecommenderHub(env, chatId, userId, messageId = null) {
    await ensureTables(env.DB);
    const wlRow = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM watchlist WHERE user_id = ? AND status = 'plan_to_watch'"
    ).bind(userId).first();
    const wlCount = wlRow?.count || 0;

    const text = [
        `🍿 *Movie & Series Recommender*`,
        `────────────────────`,
        `Never run out of great things to watch! Pick a vibe below or tell me what you're in the mood for.`,
        ``,
        `💡 *Ways to search:*`,
        `• \`/watch sci-fi thriller like Inception\``,
        `• \`/watch funny lighthearted sitcom\``,
        `• \`/watch korean crime mystery\``,
        `• \`/watch add Dune 2\` _(add title directly)_`,
        ``,
        `⭐ *Your Watchlist:* \`${wlCount} title(s) to watch\``,
        `────────────────────`
    ].join("\n");

    const keyboard = [
        [
            { text: "🚀 Sci-Fi", callback_data: "wl_genre:scifi" },
            { text: "🔪 Thriller", callback_data: "wl_genre:thriller" },
            { text: "😂 Comedy", callback_data: "wl_genre:comedy" }
        ],
        [
            { text: "💥 Action", callback_data: "wl_genre:action" },
            { text: "💕 Romance", callback_data: "wl_genre:romance" },
            { text: "👻 Horror", callback_data: "wl_genre:horror" }
        ],
        [
            { text: "🍿 Drama", callback_data: "wl_genre:drama" },
            { text: "🎌 Anime", callback_data: "wl_genre:anime" },
            { text: "🎲 Surprise Me!", callback_data: "wl_genre:random" }
        ],
        [
            { text: `⭐ My Watchlist (${wlCount})`, callback_data: "watchlist" },
            { text: "🎲 Pick Saved", callback_data: "wl_pick" }
        ],
        [
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function handleGenerateMovieRecommendation(env, chatId, userId, query = "random", from = null, messageId = null) {
    await ensureTables(env.DB);

    try {
        await telegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    } catch (e) {}

    const genrePrompt = MOVIE_GENRE_PROMPTS[query.toLowerCase()] || query;

    // Fetch user's existing titles to prevent recommending duplicates
    const { results: existingRows } = await env.DB.prepare(
        "SELECT title FROM watchlist WHERE user_id = ? LIMIT 30"
    ).bind(userId).all();
    const existingTitles = (existingRows || []).map(r => r.title).filter(Boolean);
    const excludeHint = existingTitles.length > 0 
        ? `DO NOT recommend any of these titles as the user already has them: ${existingTitles.join(", ")}.` 
        : "";

    const systemPrompt = `You are a film and television critic.
Recommend ONE title that is critically acclaimed or widely beloved.
${excludeHint}
Respond with PURE JSON ONLY without markdown, code fences, or backticks.
The JSON object must strictly follow this schema:
{
  "title": "Movie or Series Title",
  "year": "Release Year (e.g. 2023)",
  "genre": "Genre tags (e.g. Sci-Fi, Thriller)",
  "rating": "IMDb & Rotten Tomatoes rating (e.g. 8.5/10 IMDb • 92% RT)",
  "runtime": "Length or seasons (e.g. 2h 15m or 2 Seasons)",
  "platforms": "Top streaming platforms (e.g. Netflix, Prime Video, HBO Max)",
  "synopsis": "Spoiler-free hook and premise in 2-3 engaging sentences.",
  "why_love": "1-2 sentences on why this fits their vibe and why they will love it."
}`;

    const userPrompt = `I want to watch: "${genrePrompt}". Please give me your best top recommendation.`;

    let movieData = null;
    const aiResp = await callAiTextModel(env, systemPrompt, userPrompt, 0.5);
    if (aiResp) {
        movieData = parseMovieJson(aiResp);
    }

    if (!movieData || !movieData.title) {
        // Fallback pick
        const randIndex = Math.floor(Math.random() * MOVIE_FALLBACKS.length);
        movieData = MOVIE_FALLBACKS[randIndex];
    }

    const title = movieData.title || "Inception";
    const year = movieData.year || "";
    const genre = movieData.genre || "Cinema";
    const rating = movieData.rating || "8.5/10 IMDb";
    const runtime = movieData.runtime || "Feature Film";
    const platforms = movieData.platforms || "Netflix, Prime Video";
    const synopsis = movieData.synopsis || "An extraordinary cinematic journey.";
    const why_love = movieData.why_love || "Captivating storytelling and brilliant performances.";

    // Save as temp recommendation in D1
    const res = await env.DB.prepare(`
        INSERT INTO watchlist (user_id, title, year, genre, rating, runtime, platforms, synopsis, why_love, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'temp_rec')
    `).bind(userId, title, year, genre, rating, runtime, platforms, synopsis, why_love).run();

    const recId = res.meta?.last_row_id || (await env.DB.prepare("SELECT id FROM watchlist WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first())?.id;

    const text = [
        `🍿 *AI Movie Recommendation*`,
        `────────────────────`,
        `🎬 *${sanitizeMd(title)}* ${year ? `(${sanitizeMd(year)})` : ""}`,
        `⭐ \`${sanitizeMd(rating)}\``,
        `🎭 *Genre:* ${sanitizeMd(genre)}`,
        `⏱️ *Length:* ${sanitizeMd(runtime)} • 📺 ${sanitizeMd(platforms)}`,
        `────────────────────`,
        `📝 *Synopsis:*`,
        `${sanitizeMd(synopsis)}`,
        ``,
        `💡 *Why You'll Love It:*`,
        `_${sanitizeMd(why_love)}_`,
        `────────────────────`
    ].join("\n");

    const queryKey = query.length > 20 ? query.slice(0, 18) : query;

    const keyboard = [
        [
            { text: "⭐ Save to Watchlist", callback_data: `wl_save:${recId}` },
            { text: "🍿 Mark Watched", callback_data: `wl_watched:${recId}` }
        ],
        [
            { text: "🎲 Roll Another", callback_data: `wl_roll:${encodeURIComponent(queryKey)}` },
            { text: "📋 Watchlist", callback_data: "watchlist" }
        ],
        [
            { text: "🍿 Movie Hub", callback_data: "movie_hub" },
            { text: "🏠 Main Hub", callback_data: "hub" }
        ]
    ];

    await safeEditOrSendMessage(env, chatId, messageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

export async function sendWatchlistMenu(env, chatId, userId, filter = "all", page = 1, messageId = null) {
    await ensureTables(env.DB);

    const { results: allItems } = await env.DB.prepare(
        `SELECT id, title, year, genre, rating, runtime, platforms, synopsis, status, created_at, watched_at
         FROM watchlist
         WHERE user_id = ? AND status IN ('plan_to_watch', 'watched')
         ORDER BY (CASE WHEN status = 'plan_to_watch' THEN 0 ELSE 1 END), id DESC`
    ).bind(userId).all();

    const items = allItems || [];
    const planCount = items.filter(i => i.status === "plan_to_watch").length;
    const watchedCount = items.filter(i => i.status === "watched").length;

    let filtered = items;
    if (filter === "plan_to_watch") {
        filtered = items.filter(i => i.status === "plan_to_watch");
    } else if (filter === "watched") {
        filtered = items.filter(i => i.status === "watched");
    }

    if (items.length === 0) {
        const emptyText = [
            `🍿 *Your Movie & Series Watchlist*`,
            `────────────────────`,
            `Your watchlist is currently empty!`,
            ``,
            `💡 *How to add titles:*`,
            `• Type \`/watch add Inception\` or \`/watch add Severance\``,
            `• Or browse recommendations with \`/watch\` and tap **Save to Watchlist**!`,
            `────────────────────`
        ].join("\n");

        await safeEditOrSendMessage(env, chatId, messageId, emptyText, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "➕ Get Recommendations", callback_data: "movie_hub" }],
                    [{ text: "🏠 Main Hub", callback_data: "hub" }]
                ]
            }
        });
        return;
    }

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const curPage = Math.min(Math.max(1, page), totalPages);
    const startIdx = (curPage - 1) * pageSize;
    const pageItems = filtered.slice(startIdx, startIdx + pageSize);

    const filterLabel = filter === "plan_to_watch" ? "⭐ Plan to Watch" : filter === "watched" ? "✅ Finished" : "All Titles";

    const textLines = [
        `🍿 *My Watchlist (${filterLabel})*`,
        `────────────────────`,
        `● *To Watch:* \`${planCount}\`  •  ● *Watched:* \`${watchedCount}\``,
        `────────────────────`
    ];

    if (pageItems.length === 0) {
        textLines.push(`_No titles found under this filter._`);
    } else {
        pageItems.forEach((m, idx) => {
            const num = startIdx + idx + 1;
            const statusIcon = m.status === "watched" ? "✅" : "⭐";
            const yearStr = m.year ? `(${m.year})` : "";
            const ratingStr = m.rating ? `• ${m.rating}` : "";
            textLines.push(`${num}. ${statusIcon} *${sanitizeMd(m.title)}* ${sanitizeMd(yearStr)} ${sanitizeMd(ratingStr)}`);
            if (m.genre) textLines.push(`   _🎭 ${sanitizeMd(m.genre)}_`);
        });
    }

    textLines.push(`────────────────────`);
    textLines.push(`_Page ${curPage} of ${totalPages}_`);

    const keyboard = [];

    // Filter bar
    keyboard.push([
        { text: filter === "all" ? "• All •" : "All", callback_data: "wl_filter:all" },
        { text: filter === "plan_to_watch" ? "• ⭐ To Watch •" : `⭐ To Watch (${planCount})`, callback_data: "wl_filter:plan_to_watch" },
        { text: filter === "watched" ? "• ✅ Watched •" : `✅ Watched (${watchedCount})`, callback_data: "wl_filter:watched" }
    ]);

    // Item Action row for visible items
    if (pageItems.length > 0) {
        const itemButtons = pageItems.slice(0, 3).map(m => {
            const actionText = m.status === "watched" ? `↩️ #${m.id}` : `✅ #${m.id}`;
            return { text: actionText, callback_data: `wl_toggle:${m.id}` };
        });
        const delButtons = pageItems.slice(0, 3).map(m => {
            return { text: `🗑️ #${m.id}`, callback_data: `wl_del:${m.id}` };
        });
        keyboard.push(itemButtons);
        keyboard.push(delButtons);
    }

    // Pagination row
    const navRow = [];
    if (curPage > 1) {
        navRow.push({ text: "‹ Prev", callback_data: `wl_page:${curPage - 1}:${filter}` });
    }
    navRow.push({ text: "🎲 Pick for Tonight", callback_data: "wl_pick" });
    if (curPage < totalPages) {
        navRow.push({ text: "Next ›", callback_data: `wl_page:${curPage + 1}:${filter}` });
    }
    keyboard.push(navRow);

    // Hub links
    keyboard.push([
        { text: "🍿 Recommender", callback_data: "movie_hub" },
        { text: "🏠 Main Hub", callback_data: "hub" }
    ]);

    await safeEditOrSendMessage(env, chatId, messageId, textLines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}
