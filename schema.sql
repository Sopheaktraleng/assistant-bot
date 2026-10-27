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

CREATE INDEX IF NOT EXISTS idx_expenses_user_date
ON expenses (user_id, date);

CREATE INDEX IF NOT EXISTS idx_expenses_user_created
ON expenses (user_id, created_at);

CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    display_currency TEXT NOT NULL DEFAULT 'KHR',
    monthly_budget REAL DEFAULT 0,
    voice_mode TEXT DEFAULT 'off',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reminder_time TEXT NOT NULL, -- HH:mm 24-hour format in Asia/Phnom_Penh
    frequency TEXT NOT NULL DEFAULT 'weekdays', -- 'weekdays', 'daily', 'once'
    type TEXT NOT NULL DEFAULT 'lunchbox', -- 'lunchbox', 'expense_log', 'custom'
    is_active INTEGER NOT NULL DEFAULT 1,
    last_sent_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminders_user
ON reminders (user_id);

CREATE INDEX IF NOT EXISTS idx_reminders_active
ON reminders (is_active, reminder_time);

CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_work_logs_user_date
ON work_logs (user_id, date);

CREATE INDEX IF NOT EXISTS idx_work_logs_user_created
ON work_logs (user_id, created_at);

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

CREATE INDEX IF NOT EXISTS idx_pending_scans_user
ON pending_scans (user_id);

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
    status TEXT NOT NULL DEFAULT 'plan_to_watch', -- 'plan_to_watch', 'watched'
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    watched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user
ON watchlist (user_id, status);

CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user' or 'model'
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user
ON chat_history (user_id, created_at);

CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'preference', -- 'identity', 'work', 'preference', 'goal', 'rule'
    fact TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user
ON user_memories (user_id);

CREATE TABLE IF NOT EXISTS daily_broadcast_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- 'wakeup', 'briefing', 'weekly_report'
    date TEXT NOT NULL, -- YYYY-MM-DD
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, type, date)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_logs_user_date
ON daily_broadcast_logs (user_id, type, date);

CREATE TABLE IF NOT EXISTS authorized_users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    role TEXT NOT NULL DEFAULT 'guest', -- 'owner' | 'guest'
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'pending' | 'revoked'
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_authorized_users_status
ON authorized_users (status);

INSERT OR IGNORE INTO authorized_users (user_id, first_name, role, status, approved_by)
VALUES ('849550186', 'Boss', 'owner', 'active', 'system');

-- Pending Multi-Transaction PDF Statements
CREATE TABLE IF NOT EXISTS pending_statements (
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
);

CREATE INDEX IF NOT EXISTS idx_pending_statements_user
ON pending_statements (user_id);

-- FTS5 Full-Text Search Virtual Tables for Semantic RAG
CREATE VIRTUAL TABLE IF NOT EXISTS work_logs_fts USING fts5(
    user_id UNINDEXED,
    content,
    category,
    date UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS expenses_fts USING fts5(
    user_id UNINDEXED,
    category,
    type,
    currency UNINDEXED,
    date UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(
    user_id UNINDEXED,
    fact,
    category
);

-- Triggers for FTS5 Synchronization
CREATE TRIGGER IF NOT EXISTS trg_work_logs_ai AFTER INSERT ON work_logs BEGIN
    INSERT INTO work_logs_fts(rowid, user_id, content, category, date)
    VALUES (new.id, new.user_id, new.content, new.category, new.date);
END;

CREATE TRIGGER IF NOT EXISTS trg_work_logs_ad AFTER DELETE ON work_logs BEGIN
    DELETE FROM work_logs_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_work_logs_au AFTER UPDATE ON work_logs BEGIN
    UPDATE work_logs_fts SET content = new.content, category = new.category, date = new.date WHERE rowid = new.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_user_memories_ai AFTER INSERT ON user_memories BEGIN
    INSERT INTO user_memories_fts(rowid, user_id, fact, category)
    VALUES (new.id, new.user_id, new.fact, new.category);
END;

CREATE TRIGGER IF NOT EXISTS trg_user_memories_ad AFTER DELETE ON user_memories BEGIN
    DELETE FROM user_memories_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_ai AFTER INSERT ON expenses BEGIN
    INSERT INTO expenses_fts(rowid, user_id, category, type, currency, date)
    VALUES (new.id, new.user_id, new.category, new.type, new.currency, new.date);
END;

CREATE TRIGGER IF NOT EXISTS trg_expenses_ad AFTER DELETE ON expenses BEGIN
    DELETE FROM expenses_fts WHERE rowid = old.id;
END;



