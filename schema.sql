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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reminder_time TEXT NOT NULL, -- HH:mm 24-hour format in Asia/Bangkok
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

