let tablesEnsured = false;

// Auto-create missing tables for effortless self-healing
export async function ensureTables(db) {
    if (tablesEnsured) return;
    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                title TEXT NOT NULL,
                reminder_time TEXT NOT NULL,
                frequency TEXT NOT NULL DEFAULT 'weekdays',
                type TEXT NOT NULL DEFAULT 'lunchbox',
                is_active INTEGER NOT NULL DEFAULT 1,
                last_sent_date TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables reminders error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS work_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'General',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables work_logs error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                date TEXT NOT NULL,
                amount REAL NOT NULL CHECK (amount > 0),
                category TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'expense',
                currency TEXT NOT NULL DEFAULT 'KHR',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables expenses error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id TEXT PRIMARY KEY,
                display_currency TEXT NOT NULL DEFAULT 'KHR',
                monthly_budget REAL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables user_settings error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS processed_updates (
                update_id INTEGER PRIMARY KEY,
                processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables processed_updates error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS pending_scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                amount REAL NOT NULL,
                currency TEXT NOT NULL DEFAULT 'USD',
                category TEXT NOT NULL DEFAULT 'Other',
                type TEXT NOT NULL DEFAULT 'expense',
                merchant TEXT,
                bank TEXT,
                note TEXT,
                date TEXT,
                message_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `).run();
    } catch (e) {
        console.error("ensureTables pending_scans error:", e);
    }

    try {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                title TEXT NOT NULL,
                year TEXT,
                genre TEXT,
                rating TEXT,
                runtime TEXT,
                platforms TEXT,
                synopsis TEXT,
                why_love TEXT,
                status TEXT NOT NULL DEFAULT 'plan_to_watch',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                watched_at TEXT
            );
        `).run();
    } catch (e) {
        console.error("ensureTables watchlist error:", e);
    }
    tablesEnsured = true;
}
