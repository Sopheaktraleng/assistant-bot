// Production D1 tables are pre-migrated via schema.sql; default to true to eliminate DDL schema locks on hot requests
let tablesEnsured = true;

const TABLE_SCHEMAS = [
    `CREATE TABLE IF NOT EXISTS reminders (
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
    );`,
    `CREATE TABLE IF NOT EXISTS work_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'General',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        amount REAL NOT NULL CHECK (amount > 0),
        category TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'expense',
        currency TEXT NOT NULL DEFAULT 'KHR',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        display_currency TEXT NOT NULL DEFAULT 'KHR',
        monthly_budget REAL DEFAULT 0,
        voice_mode TEXT DEFAULT 'off',
        briefing_mode TEXT DEFAULT 'on',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS processed_updates (
        update_id INTEGER PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS pending_scans (
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
    );`,
    `CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS user_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'preference',
        fact TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, type, date)
    );`,
    `CREATE TABLE IF NOT EXISTS authorized_users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        role TEXT NOT NULL DEFAULT 'guest',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_by TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS pending_statements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        bank TEXT,
        period TEXT,
        currency TEXT DEFAULT 'USD',
        total_inflow REAL DEFAULT 0,
        total_outflow REAL DEFAULT 0,
        transaction_count INTEGER DEFAULT 0,
        transactions_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`
];

// Auto-create missing tables for effortless self-healing with single-roundtrip batching
export async function ensureTables(db) {
    if (tablesEnsured || !db) return;
    try {
        if (typeof db.batch === "function") {
            await db.batch(TABLE_SCHEMAS.map(sql => db.prepare(sql)));
        } else {
            for (const sql of TABLE_SCHEMAS) {
                try {
                    await db.prepare(sql).run();
                } catch (e) {
                    console.error("ensureTables sequential error:", e);
                }
            }
        }
        try {
            await db.prepare("ALTER TABLE user_settings ADD COLUMN briefing_mode TEXT DEFAULT 'on'").run();
        } catch (e) {}
        try {
            await db.prepare(`CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL,
                date TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, type, date)
            )`).run();
        } catch (e) {}
        try {
            await db.prepare(`CREATE TABLE IF NOT EXISTS authorized_users (
                user_id TEXT PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                role TEXT NOT NULL DEFAULT 'guest',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                approved_by TEXT
            )`).run();
            await db.prepare(`
                INSERT OR IGNORE INTO authorized_users (user_id, first_name, role, status, approved_by)
                VALUES ('849550186', 'Boss', 'owner', 'active', 'system')
            `).run();
        } catch (e) {}
        try {
            await db.prepare(`CREATE TABLE IF NOT EXISTS pending_statements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                bank TEXT,
                period TEXT,
                currency TEXT DEFAULT 'USD',
                total_inflow REAL DEFAULT 0,
                total_outflow REAL DEFAULT 0,
                transaction_count INTEGER DEFAULT 0,
                transactions_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`).run();
        } catch (e) {}
        try {
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS work_logs_fts USING fts5(user_id UNINDEXED, content, category, date UNINDEXED)`).run();
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS expenses_fts USING fts5(user_id UNINDEXED, category, type, currency UNINDEXED, date UNINDEXED)`).run();
            await db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(user_id UNINDEXED, fact, category)`).run();
        } catch (e) {}
        tablesEnsured = true;
    } catch (e) {
        console.error("ensureTables batch error:", e);
    }
}

export function resetTablesEnsuredForTest() {
    tablesEnsured = false;
}
