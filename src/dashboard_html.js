export default `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Personal Assistant</title>
    <!-- Fonts -->
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <!-- ChartJS -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <!-- Telegram WebApp SDK -->
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --bg-color: #07090e;
            --card-bg: rgba(18, 22, 33, 0.65);
            --card-border: rgba(255, 255, 255, 0.06);
            --primary: #6366f1;
            --primary-glow: rgba(99, 102, 241, 0.2);
            --success: #10b981;
            --success-bg: rgba(16, 185, 129, 0.1);
            --danger: #ef4444;
            --danger-bg: rgba(239, 68, 68, 0.1);
            --warning: #f59e0b;
            --warning-bg: rgba(245, 158, 11, 0.1);
            --text-color: #f3f4f6;
            --text-muted: #9ca3af;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            min-height: 100vh;
            padding: 16px;
            padding-bottom: 40px;
            overflow-y: auto;
            background-image: 
                radial-gradient(circle at 0% 0%, rgba(99, 102, 241, 0.12) 0%, transparent 50%),
                radial-gradient(circle at 100% 100%, rgba(239, 68, 68, 0.06) 0%, transparent 50%);
        }

        .container {
            max-width: 700px;
            margin: 0 auto;
        }

        /* Header Style */
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding: 4px 0;
        }

        h1 {
            font-weight: 800;
            font-size: 1.45rem;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, #ffffff 40%, #a5b4fc 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .user-profile {
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            padding: 5px 12px;
            border-radius: 20px;
            backdrop-filter: blur(20px);
        }

        .user-avatar {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: var(--primary);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 0.72rem;
            color: #fff;
        }

        .user-name {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-color);
        }

        /* Modern Segmented Navigation Tabs */
        .nav-tabs {
            display: flex;
            background: rgba(18, 22, 33, 0.85);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 4px;
            margin-bottom: 18px;
            gap: 4px;
            backdrop-filter: blur(20px);
        }

        .nav-tab {
            flex: 1;
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 8px 4px;
            border-radius: 12px;
            font-size: 0.76rem;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            white-space: nowrap;
        }

        .nav-tab:hover {
            color: var(--text-color);
            background: rgba(255, 255, 255, 0.03);
        }

        .nav-tab.active {
            background: var(--primary);
            color: #ffffff;
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.35);
        }

        /* Hero Card */
        .hero-card {
            background: linear-gradient(135deg, rgba(20, 24, 39, 0.95) 0%, rgba(12, 14, 24, 0.95) 100%);
            border: 1px solid var(--card-border);
            border-radius: 24px;
            padding: 24px;
            text-align: center;
            backdrop-filter: blur(20px);
            margin-bottom: 14px;
            box-shadow: 0 10px 30px -10px var(--primary-glow);
            position: relative;
        }

        .hero-label {
            font-size: 0.75rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: var(--text-muted);
            margin-bottom: 6px;
        }

        .hero-value {
            font-size: 2.2rem;
            font-weight: 800;
            letter-spacing: -1px;
            margin-bottom: 4px;
            color: #ffffff;
        }

        .hero-subvalue {
            font-size: 0.95rem;
            color: var(--text-muted);
            font-weight: 500;
        }

        /* Mini Stats Grid */
        .mini-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
        }

        .mini-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 18px;
            padding: 16px;
            backdrop-filter: blur(20px);
            display: flex;
            flex-direction: column;
        }

        .mini-label {
            font-size: 0.7rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-muted);
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .mini-indicator {
            width: 6px;
            height: 6px;
            border-radius: 50%;
        }

        .mini-indicator.income { background: var(--success); }
        .mini-indicator.expense { background: var(--danger); }
        .mini-indicator.work { background: #38bdf8; }

        .mini-value {
            font-size: 1.15rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 2px;
        }

        .mini-subvalue {
            font-size: 0.75rem;
            color: var(--text-muted);
        }

        /* Section Cards */
        .section-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 20px;
            padding: 18px;
            backdrop-filter: blur(20px);
            margin-bottom: 16px;
        }

        .section-title {
            font-size: 0.95rem;
            font-weight: 700;
            color: #ffffff;
            margin-bottom: 16px;
            letter-spacing: -0.2px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .chart-wrapper {
            position: relative;
            width: 100%;
            height: 200px;
        }

        .charts-row {
            display: grid;
            grid-template-columns: 1fr;
            gap: 16px;
            margin-bottom: 16px;
        }

        @media (min-width: 600px) {
            .charts-row {
                grid-template-columns: 1.1fr 0.9fr;
            }
        }

        /* List Items */
        .tx-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .tx-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.015);
            border: 1px solid rgba(255, 255, 255, 0.03);
            transition: background-color 0.2s ease;
        }

        .tx-row:hover {
            background: rgba(255, 255, 255, 0.03);
        }

        .tx-left {
            display: flex;
            align-items: center;
            gap: 12px;
            overflow: hidden;
        }

        .tx-badge {
            width: 34px;
            height: 34px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.1rem;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.06);
            flex-shrink: 0;
        }

        .tx-meta {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .tx-name {
            font-weight: 600;
            font-size: 0.85rem;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .tx-date {
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-top: 1px;
        }

        .tx-right {
            text-align: right;
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }

        .tx-amt {
            font-weight: 700;
            font-size: 0.9rem;
        }

        .tx-amt.income { color: var(--success); }
        .tx-amt.expense { color: var(--text-color); }

        /* Form Inputs & Buttons */
        .input-row {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }

        .text-input {
            flex: 1;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--card-border);
            color: var(--text-color);
            padding: 10px 14px;
            border-radius: 12px;
            font-size: 0.85rem;
            font-family: inherit;
            outline: none;
            transition: border-color 0.2s;
        }

        .text-input:focus {
            border-color: var(--primary);
        }

        .btn-action {
            background: var(--primary);
            color: #ffffff;
            border: none;
            padding: 10px 18px;
            border-radius: 12px;
            font-size: 0.85rem;
            font-weight: 700;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .btn-action:hover {
            opacity: 0.9;
            transform: translateY(-1px);
        }

        .btn-action:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none;
        }

        /* Pill Group for Category Selectors */
        .pill-group {
            display: flex;
            gap: 6px;
            overflow-x: auto;
            padding-bottom: 6px;
            margin-bottom: 12px;
            scrollbar-width: none;
        }
        .pill-group::-webkit-scrollbar { display: none; }

        .pill-btn {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--card-border);
            color: var(--text-muted);
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.2s;
        }

        .pill-btn.active {
            background: var(--primary);
            color: #ffffff;
            border-color: var(--primary);
        }

        /* Standup Copy Box */
        .standup-box {
            background: rgba(99, 102, 241, 0.06);
            border: 1px solid rgba(99, 102, 241, 0.2);
            border-radius: 16px;
            padding: 14px;
            margin-bottom: 16px;
        }

        .standup-preview-txt {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.75rem;
            line-height: 1.45;
            color: #c7d2fe;
            white-space: pre-wrap;
            max-height: 140px;
            overflow-y: auto;
            background: rgba(0, 0, 0, 0.25);
            padding: 10px;
            border-radius: 10px;
            margin-bottom: 10px;
        }

        /* Toggle Switch */
        .switch {
            position: relative;
            display: inline-block;
            width: 44px;
            height: 24px;
            flex-shrink: 0;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background-color: rgba(255, 255, 255, 0.1);
            transition: .3s;
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 4px;
            bottom: 3px;
            background-color: white;
            transition: .3s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: var(--primary);
            box-shadow: 0 0 10px var(--primary-glow);
        }

        input:checked + .slider:before {
            transform: translateX(19px);
        }

        /* Loading & Error */
        .loader-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 60vh;
            gap: 12px;
        }

        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid rgba(255, 255, 255, 0.05);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 0.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .error-card {
            background: var(--card-bg);
            border: 1px solid var(--danger);
            border-radius: 20px;
            padding: 30px 20px;
            text-align: center;
            backdrop-filter: blur(20px);
        }

        /* Toast Message */
        .toast {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%) translateY(100px);
            background: rgba(18, 22, 33, 0.95);
            border: 1px solid var(--primary);
            color: #ffffff;
            padding: 10px 20px;
            border-radius: 24px;
            font-size: 0.82rem;
            font-weight: 600;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 999;
            pointer-events: none;
            backdrop-filter: blur(20px);
        }

        .toast.show {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }

        /* History View Styles */
        .history-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
        }

        .btn-back {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            color: var(--text-color);
            padding: 6px 14px;
            border-radius: 14px;
            font-size: 0.8rem;
            font-weight: 600;
            cursor: pointer;
            backdrop-filter: blur(20px);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .filter-section {
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .search-input {
            width: 100%;
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            color: var(--text-color);
            padding: 10px 16px;
            border-radius: 14px;
            font-size: 0.85rem;
            font-family: inherit;
            outline: none;
            backdrop-filter: blur(20px);
        }

        .pagination-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 16px;
            padding-top: 14px;
            border-top: 1px solid var(--card-border);
        }

        .pagination-info {
            font-size: 0.75rem;
            color: var(--text-muted);
            font-weight: 600;
        }

        .pagination-btn {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            color: var(--text-color);
            padding: 6px 14px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .pagination-btn:hover:not(:disabled) {
            border-color: var(--primary);
            background: rgba(99, 102, 241, 0.1);
        }

        .pagination-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div class="container" id="app">
        <!-- Loader Screen -->
        <div class="loader-container" id="loader">
            <div class="spinner"></div>
            <p style="color: var(--text-muted); font-size: 0.85rem; font-weight: 500;">Connecting to Assistant Hub...</p>
        </div>

        <!-- Dashboard Content -->
        <div id="content" style="display: none;">
            <header>
                <h1>Assistant Hub</h1>
                <div class="user-profile">
                    <div class="user-avatar" id="avatar-letter">U</div>
                    <span class="user-name" id="username-display">User</span>
                </div>
            </header>

            <!-- Top Segmented Navigation Tabs -->
            <nav class="nav-tabs">
                <button class="nav-tab active" id="nav-btn-finance" onclick="switchMainTab('finance')">
                    <span>💰</span> Cashflow
                </button>
                <button class="nav-tab" id="nav-btn-work" onclick="switchMainTab('work')">
                    <span>💼</span> Work
                </button>
                <button class="nav-tab" id="nav-btn-reminders" onclick="switchMainTab('reminders')">
                    <span>⏰</span> Reminders
                </button>
                <button class="nav-tab" id="nav-btn-watchlist" onclick="switchMainTab('watchlist')">
                    <span>🍿</span> Movies
                </button>
            </nav>

            <!-- ============================================================== -->
            <!-- TAB 1: CASHFLOW & FINANCE                                      -->
            <!-- ============================================================== -->
            <div id="tab-pane-finance">
                <!-- Hero Balance Display -->
                <div class="hero-card">
                    <div class="hero-label">Net Balance</div>
                    <div class="hero-value" id="balance-val">$0.00</div>
                    <div class="hero-subvalue" id="balance-sub">0 ៛</div>
                </div>

                <!-- Active Reminder Status Card -->
                <div class="section-card" id="reminder-card" style="display: none; margin-bottom: 14px; padding: 12px 16px; border: 1px solid rgba(99, 102, 241, 0.25); background: rgba(99, 102, 241, 0.08); border-radius: 18px;">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span id="reminder-icon" style="font-size: 1.4rem;">⏰</span>
                            <div>
                                <div id="reminder-title-txt" style="font-size: 0.85rem; font-weight: 700; color: #ffffff;">Active Reminder</div>
                                <div id="reminder-status-sub" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">Scheduled</div>
                            </div>
                        </div>
                        <span id="reminder-status-badge" style="font-size: 0.72rem; font-weight: 700; color: var(--success); background: var(--success-bg); padding: 4px 10px; border-radius: 14px; border: 1px solid rgba(16, 185, 129, 0.2);">ACTIVE</span>
                    </div>
                </div>

                <!-- Budget Progress Card -->
                <div class="section-card" id="budget-card" style="display: none; margin-bottom: 20px; box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05); background: rgba(18, 22, 33, 0.7); position: relative; overflow: hidden;">
                    <div class="section-title" style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between;">
                        <span style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-color);">
                            🎯 Budget Limit
                        </span>
                        <span id="budget-percent" style="font-size: 0.85rem; color: var(--primary); font-weight: 800; padding: 2px 8px; background: rgba(99, 102, 241, 0.1); border-radius: 20px; border: 1px solid rgba(99, 102, 241, 0.2);">0%</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 500;">
                            <span style="color: var(--text-color);">Spent: <strong id="budget-spent-txt" style="font-weight: 700;">$0.00</strong></span>
                            <span style="color: var(--text-muted);">Limit: <span id="budget-total-txt">$0.00</span></span>
                        </div>
                        <div style="width: 100%; height: 8px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; overflow: hidden; position: relative;">
                            <div id="budget-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, var(--primary) 0%, #818cf8 100%); border-radius: 4px; transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 0 10px var(--primary-glow);"></div>
                        </div>
                        <div id="budget-status-msg" style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500; text-align: left; display: flex; align-items: center; gap: 4px;">
                            Remaining: $0.00
                        </div>
                    </div>
                </div>

                <!-- Mini Stats Row -->
                <div class="mini-grid">
                    <div class="mini-card">
                        <div class="mini-label">
                            <span class="mini-indicator income"></span> Income
                        </div>
                        <div class="mini-value" id="income-val">$0.00</div>
                        <div class="mini-subvalue" id="income-sub">0 ៛</div>
                    </div>
                    <div class="mini-card">
                        <div class="mini-label">
                            <span class="mini-indicator expense"></span> Expenses
                        </div>
                        <div class="mini-value" id="expense-val">$0.00</div>
                        <div class="mini-subvalue" id="expense-sub">0 ៛</div>
                    </div>
                </div>

                <!-- Charts Section -->
                <div class="charts-row">
                    <div class="section-card">
                        <div class="section-title">Weekly Trend</div>
                        <div class="chart-wrapper">
                            <canvas id="dailyChart"></canvas>
                        </div>
                    </div>
                    <div class="section-card">
                        <div class="section-title">Categories</div>
                        <div class="chart-wrapper">
                            <canvas id="categoryChart"></canvas>
                        </div>
                    </div>
                </div>

                <!-- Recent Transactions -->
                <div class="section-card">
                    <div class="section-title">
                        <span>Recent Transactions</span>
                        <button id="btn-see-all" style="background: none; border: none; color: var(--primary); font-size: 0.8rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; transition: background 0.2s;">
                            See All <span style="font-size: 0.95rem;">→</span>
                        </button>
                    </div>
                    <div class="tx-list" id="transaction-list">
                        <!-- Dynamic transactions render here -->
                    </div>
                </div>
            </div>

            <!-- History View Modal -->
            <div id="history-view" style="display: none;">
                <div class="history-header">
                    <button class="btn-back" id="btn-back-to-dashboard">
                        <span>←</span> Back
                    </button>
                    <h2 style="font-size: 1.15rem; font-weight: 700; background: linear-gradient(135deg, #ffffff 40%, #a5b4fc 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">History Ledger</h2>
                </div>

                <div class="filter-section">
                    <div class="search-container">
                        <input type="text" class="search-input" id="history-search-input" placeholder="Search by category or amount..." />
                    </div>
                    <div class="filter-row">
                        <div class="pill-group" id="type-pill-group">
                            <button class="pill-btn active" data-type="all">All</button>
                            <button class="pill-btn" data-type="income">Income</button>
                            <button class="pill-btn" data-type="expense">Expense</button>
                        </div>
                    </div>
                </div>

                <div class="section-card">
                    <div class="tx-list" id="history-transaction-list">
                        <!-- Dynamic historical transactions render here -->
                    </div>
                    <div class="pagination-container">
                        <button class="pagination-btn" id="btn-prev-page" disabled>
                            <span>←</span> Prev
                        </button>
                        <span class="pagination-info" id="history-page-info">Page 1 of 1</span>
                        <button class="pagination-btn" id="btn-next-page" disabled>
                            Next <span>→</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- ============================================================== -->
            <!-- TAB 2: WORK JOURNAL & STANDUP                                  -->
            <!-- ============================================================== -->
            <div id="tab-pane-work" style="display: none;">
                <!-- Hero Work Card -->
                <div class="hero-card">
                    <div class="hero-label">Accomplishments</div>
                    <div class="hero-value" id="work-month-count">0 Tasks</div>
                    <div class="hero-subvalue" id="work-month-label">This Month</div>
                </div>

                <!-- Mini Work Metrics -->
                <div class="mini-grid">
                    <div class="mini-card">
                        <div class="mini-label">
                            <span class="mini-indicator work"></span> Today
                        </div>
                        <div class="mini-value" id="work-today-count">0 Logged</div>
                        <div class="mini-subvalue" id="work-today-date">Today</div>
                    </div>
                    <div class="mini-card">
                        <div class="mini-label">
                            <span class="mini-indicator income"></span> Velocity
                        </div>
                        <div class="mini-value" id="work-active-days">0 Days</div>
                        <div class="mini-subvalue">Active days this month</div>
                    </div>
                </div>

                <!-- Daily Standup Preview & 1-Tap Copy -->
                <div class="standup-box">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                        <span style="font-size: 0.85rem; font-weight: 700; color: #a5b4fc; display: flex; align-items: center; gap: 6px;">
                            🗣️ Daily Standup Sync
                        </span>
                        <button class="btn-action" id="btn-copy-standup" style="padding: 5px 12px; font-size: 0.75rem;">
                            📋 Copy Block
                        </button>
                    </div>
                    <div class="standup-preview-txt" id="standup-preview-content">Loading standup preview...</div>
                </div>

                <!-- Quick Add Task Card -->
                <div class="section-card">
                    <div class="section-title">
                        <span>＋ Log Accomplishment</span>
                    </div>
                    <div class="pill-group" id="work-cat-pills">
                        <button class="pill-btn active" data-cat="Development">💻 Development</button>
                        <button class="pill-btn" data-cat="Bugfix">🐞 Bugfix</button>
                        <button class="pill-btn" data-cat="Meeting">👥 Meeting</button>
                        <button class="pill-btn" data-cat="Release">🚀 Release</button>
                        <button class="pill-btn" data-cat="Design">🎨 Design</button>
                        <button class="pill-btn" data-cat="Testing">🧪 Testing</button>
                        <button class="pill-btn" data-cat="Documentation">📝 Docs</button>
                    </div>
                    <form id="form-add-task" onsubmit="event.preventDefault(); submitNewTask();">
                        <div class="input-row">
                            <input type="text" class="text-input" id="task-content-input" placeholder="What did you complete? (e.g. Fixed checkout bug #bugfix)" required />
                            <button type="submit" class="btn-action" id="btn-submit-task">
                                <span>＋</span> Log
                            </button>
                        </div>
                    </form>
                </div>

                <!-- Category Breakdown -->
                <div class="section-card" id="work-category-card" style="display: none;">
                    <div class="section-title">Focus Breakdown</div>
                    <div class="pill-group" id="work-category-breakdown" style="padding-bottom: 0;">
                        <!-- Category pills rendered here -->
                    </div>
                </div>

                <!-- Tasks Activity List -->
                <div class="section-card">
                    <div class="section-title">
                        <span>Recent Tasks</span>
                    </div>
                    <input type="text" class="text-input" id="work-search-input" placeholder="Filter tasks..." style="margin-bottom: 12px; width: 100%;" />
                    <div class="tx-list" id="work-tasks-list">
                        <!-- Dynamic work tasks render here -->
                    </div>
                </div>
            </div>

            <!-- ============================================================== -->
            <!-- TAB 3: REMINDERS & ALERTS                                      -->
            <!-- ============================================================== -->
            <div id="tab-pane-reminders" style="display: none;">
                <!-- Hero Reminders Card -->
                <div class="hero-card">
                    <div class="hero-label">Automated Reminders</div>
                    <div class="hero-value" id="reminders-active-count">0 Active</div>
                    <div class="hero-subvalue">Scheduled with minute-precision edge cron</div>
                </div>

                <!-- 1-Tap Quick Presets -->
                <div class="section-card">
                    <div class="section-title">1-Tap Smart Presets</div>
                    <div style="display: grid; grid-template-columns: 1fr; gap: 8px;">
                        <button class="pill-btn" onclick="addPresetReminder('Morning Standup Sync', '09:00', 'weekdays', 'standup')" style="text-align: left; padding: 10px 14px; border-radius: 14px; background: rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.25); color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>🗣️ <strong>Standup Alarm</strong> (09:00 Mon–Fri)</span>
                            <span style="color: #818cf8; font-size: 0.75rem;">＋ Add</span>
                        </button>
                        <button class="pill-btn" onclick="addPresetReminder('Bring lunch box home', '17:30', 'weekdays', 'lunchbox')" style="text-align: left; padding: 10px 14px; border-radius: 14px; background: rgba(16, 185, 129, 0.08); border-color: rgba(16, 185, 129, 0.25); color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>🎒 <strong>Departure / Lunchbox</strong> (17:30 Mon–Fri)</span>
                            <span style="color: #34d399; font-size: 0.75rem;">＋ Add</span>
                        </button>
                        <button class="pill-btn" onclick="addPresetReminder('Review daily expenses', '21:00', 'daily', 'expense_log')" style="text-align: left; padding: 10px 14px; border-radius: 14px; background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.25); color: #ffffff; display: flex; align-items: center; justify-content: space-between;">
                            <span>💳 <strong>Daily Cashflow Check</strong> (21:00 Daily)</span>
                            <span style="color: #fbbf24; font-size: 0.75rem;">＋ Add</span>
                        </button>
                    </div>
                </div>

                <!-- Custom Reminder Creator -->
                <div class="section-card">
                    <div class="section-title">
                        <span>＋ Create Custom Reminder</span>
                    </div>
                    <form id="form-add-reminder" onsubmit="event.preventDefault(); submitNewReminder();">
                        <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px;">
                            <input type="text" class="text-input" id="reminder-title-input" placeholder="Title (e.g. Check oven, Team sync, Water plants)" required />
                            <div style="display: flex; gap: 8px;">
                                <input type="time" class="text-input" id="reminder-time-input" required style="max-width: 130px;" />
                                <select class="text-input" id="reminder-freq-select" style="background: rgba(18, 22, 33, 0.95); cursor: pointer;">
                                    <option value="weekdays">Weekdays (Mon–Fri)</option>
                                    <option value="daily">Daily (Every day)</option>
                                    <option value="once">Once</option>
                                </select>
                            </div>
                        </div>
                        <button type="submit" class="btn-action" style="width: 100%;">
                            <span>⏰</span> Set Reminder
                        </button>
                    </form>
                </div>

                <!-- All Reminders List -->
                <div class="section-card">
                    <div class="section-title">
                        <span>Scheduled Reminders</span>
                    </div>
                    <div class="tx-list" id="reminders-list">
                        <!-- Dynamic reminders render here -->
                    </div>
                </div>
            </div>

            <!-- ============================================================== -->
            <!-- TAB 4: MOVIE & SERIES WATCHLIST                                -->
            <!-- ============================================================== -->
            <div id="tab-pane-watchlist" style="display: none;">
                <!-- Hero Watchlist Card -->
                <div class="hero-card" style="background: radial-gradient(135.5% 80.2% at 50% 0%, rgba(236, 72, 153, 0.22) 0%, rgba(18, 22, 33, 0.75) 100%); border-color: rgba(236, 72, 153, 0.25);">
                    <div class="hero-label">Movie & Series Vault</div>
                    <div class="hero-value" id="wl-hero-count">0 Titles</div>
                    <div class="hero-subvalue" id="wl-hero-sub">0 To Watch • 0 Watched</div>
                </div>

                <!-- Watchlist Quick Stats -->
                <div class="mini-grid">
                    <div class="mini-card">
                        <div class="mini-label"><div class="mini-indicator" style="background: var(--accent);"></div> To Watch</div>
                        <div class="mini-value" id="wl-plan-stat">0</div>
                        <div class="mini-subvalue">Ready for tonight</div>
                    </div>
                    <div class="mini-card">
                        <div class="mini-label"><div class="mini-indicator income"></div> Finished</div>
                        <div class="mini-value" id="wl-watched-stat">0</div>
                        <div class="mini-subvalue">Completed titles</div>
                    </div>
                </div>

                <!-- Add Movie or Series -->
                <div class="section-card">
                    <div class="section-title">
                        <span>➕ Add Title</span>
                        <button type="button" class="btn-sm" onclick="pickRandomMovieTonight()" style="background: rgba(236, 72, 153, 0.15); color: var(--accent); border: 1px solid rgba(236, 72, 153, 0.3);">
                            🎲 Pick for Tonight
                        </button>
                    </div>
                    <form id="form-add-movie" onsubmit="event.preventDefault(); submitNewMovie();">
                        <div class="input-row">
                            <input type="text" class="text-input" id="movie-title-input" placeholder="Title (e.g. Inception, Severance, Arcane...)" required />
                            <button type="submit" class="btn-action" id="btn-submit-movie" style="background: linear-gradient(135deg, var(--accent) 0%, #be185d 100%);">
                                <span>➕</span> Add
                            </button>
                        </div>
                    </form>
                </div>

                <!-- Filter & Search -->
                <div class="section-card">
                    <div class="section-title">
                        <span>Watchlist Catalog</span>
                    </div>

                    <div class="pill-group" id="wl-filter-pills" style="margin-bottom: 12px;">
                        <button class="pill-btn active" data-filter="all">All Titles</button>
                        <button class="pill-btn" data-filter="plan_to_watch">⭐ Plan to Watch</button>
                        <button class="pill-btn" data-filter="watched">✅ Watched</button>
                    </div>

                    <input type="text" class="text-input" id="wl-search-input" placeholder="Filter by title or genre..." style="margin-bottom: 12px; width: 100%;" />

                    <div class="tx-list" id="watchlist-cards-list">
                        <!-- Dynamic movie cards render here -->
                    </div>
                </div>
            </div>
        </div>

        <!-- Toast Notification -->
        <div class="toast" id="toast">Copied to clipboard!</div>
    </div>

    <script>
        const EXCHANGE_RATE = 4000;

        function formatKhr(value) {
            return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " ៛";
        }

        function formatUsd(value) {
            return "$" + Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        function showToast(msg) {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 2500);
        }

        const urlParams = new URLSearchParams(window.location.search);
        let userId = urlParams.get('user_id');
        let username = urlParams.get('username') || 'Member';

        if (window.Telegram && Telegram.WebApp) {
            const tg = Telegram.WebApp;
            tg.ready();
            tg.expand();

            if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
                userId = String(tg.initDataUnsafe.user.id);
                username = tg.initDataUnsafe.user.first_name || tg.initDataUnsafe.user.username || username;
            }
        }

        document.getElementById('username-display').innerText = username;
        document.getElementById('avatar-letter').innerText = username.charAt(0).toUpperCase();

        if (!userId) {
            showError("No User Context. Open via the Telegram Bot.");
        } else {
            loadDashboardData(userId);
        }

        function showError(msg) {
            document.getElementById('loader').style.display = 'none';
            document.getElementById('app').innerHTML = \`
                <div class="error-card">
                    <span style="font-size: 2rem;">⚠️</span>
                    <h3 style="margin-top: 10px; font-weight: 700;">Connection Issue</h3>
                    <p style="margin-top: 8px; font-size: 0.85rem; color: var(--text-muted);">\${msg}</p>
                </div>
            \`;
        }

        // =====================================================================
        // TAB SWITCHER
        // =====================================================================
        let currentTab = 'finance';
        let workDataLoaded = false;
        let remindersDataLoaded = false;
        let watchlistDataLoaded = false;

        function switchMainTab(tab) {
            currentTab = tab;

            // Update Tab Buttons
            document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
            const activeBtn = document.getElementById('nav-btn-' + tab);
            if (activeBtn) activeBtn.classList.add('active');

            // Toggle Panes
            document.getElementById('tab-pane-finance').style.display = tab === 'finance' ? 'block' : 'none';
            document.getElementById('history-view').style.display = 'none';
            document.getElementById('tab-pane-work').style.display = tab === 'work' ? 'block' : 'none';
            document.getElementById('tab-pane-reminders').style.display = tab === 'reminders' ? 'block' : 'none';
            document.getElementById('tab-pane-watchlist').style.display = tab === 'watchlist' ? 'block' : 'none';

            if (tab === 'work' && !workDataLoaded) {
                loadWorkData();
            } else if (tab === 'reminders' && !remindersDataLoaded) {
                loadRemindersData();
            } else if (tab === 'watchlist' && !watchlistDataLoaded) {
                loadWatchlistData();
            }
        }

        // =====================================================================
        // TAB 1: FINANCE & CASHFLOW LOGIC
        // =====================================================================
        async function loadDashboardData(id) {
            try {
                const response = await fetch(\`/api/data?user_id=\${id}\`);
                if (!response.ok) {
                    throw new Error("Could not load database records.");
                }
                const data = await response.json();
                renderDashboard(data);
            } catch (err) {
                showError(err.message || "Failed to load dashboard data.");
            }
        }

        let categoryChartInstance = null;
        let dailyChartInstance = null;

        function renderDashboard(data) {
            document.getElementById('loader').style.display = 'none';
            document.getElementById('content').style.display = 'block';

            const balanceKhr = data.summary.balanceKhr;
            const incomeKhr = data.summary.totalIncomeInKhr;
            const expenseKhr = data.summary.totalExpenseInKhr;

            // Active Reminder Status Render
            const reminderCard = document.getElementById('reminder-card');
            const reminder = data.activeReminder || data.lunchboxReminder;
            if (reminder && reminder.is_active) {
                reminderCard.style.display = 'block';
                const freq = reminder.frequency === 'weekdays' ? 'Weekdays (Mon–Fri)' : reminder.frequency === 'daily' ? 'Everyday' : 'Once';
                const icon = reminder.type === 'lunchbox' ? '🎒' : reminder.type === 'standup' ? '🗣️' : reminder.type === 'expense_log' ? '💰' : '⏰';
                const title = reminder.title || 'Active Reminder';
                const iconEl = document.getElementById('reminder-icon');
                if (iconEl) iconEl.innerText = icon;
                const titleEl = document.getElementById('reminder-title-txt');
                if (titleEl) titleEl.innerText = title;
                document.getElementById('reminder-status-sub').innerText = \`Scheduled at \${reminder.reminder_time} (\${freq})\`;
            } else {
                reminderCard.style.display = 'none';
            }

            // Monthly Budget Progress Render
            const budgetCard = document.getElementById('budget-card');
            const budgetKhr = data.budgetKhr || 0;
            const monthExpenseKhr = data.monthExpenseKhr || 0;

            if (budgetKhr <= 0) {
                budgetCard.style.display = 'none';
            } else {
                budgetCard.style.display = 'block';
                const percent = Math.round((monthExpenseKhr / budgetKhr) * 100);
                const progressWidth = Math.min(100, percent);
                
                const percentBadge = document.getElementById('budget-percent');
                percentBadge.innerText = \`\${percent}%\`;

                document.getElementById('budget-spent-txt').innerText = \`\${formatUsd(monthExpenseKhr / EXCHANGE_RATE)} (\${formatKhr(monthExpenseKhr)})\`;
                document.getElementById('budget-total-txt').innerText = \`\${formatUsd(budgetKhr / EXCHANGE_RATE)} (\${formatKhr(budgetKhr)})\`;

                const progressBar = document.getElementById('budget-progress-bar');
                progressBar.style.width = \`\${progressWidth}%\`;

                const statusMsg = document.getElementById('budget-status-msg');
                if (percent >= 100) {
                    progressBar.style.background = 'linear-gradient(90deg, #ef4444 0%, #f43f5e 100%)';
                    progressBar.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.4)';
                    percentBadge.style.color = 'var(--danger)';
                    percentBadge.style.background = 'rgba(239, 68, 68, 0.1)';
                    percentBadge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
                    
                    const overage = monthExpenseKhr - budgetKhr;
                    statusMsg.innerHTML = \`🚨 <span style="color: #f43f5e; font-weight: 600;">Over budget by \${formatUsd(overage / EXCHANGE_RATE)} (\${formatKhr(overage)})</span>\`;
                } else if (percent >= 90) {
                    progressBar.style.background = 'linear-gradient(90deg, #f97316 0%, #f59e0b 100%)';
                    progressBar.style.boxShadow = '0 0 10px rgba(249, 115, 22, 0.4)';
                    percentBadge.style.color = '#f97316';
                    percentBadge.style.background = 'rgba(249, 115, 22, 0.1)';
                    percentBadge.style.borderColor = 'rgba(249, 115, 22, 0.2)';
                    
                    const remaining = budgetKhr - monthExpenseKhr;
                    statusMsg.innerHTML = \`⚠️ <span style="color: #f97316; font-weight: 600;">Warning: Only \${formatUsd(remaining / EXCHANGE_RATE)} (\${formatKhr(remaining)}) left!</span>\`;
                } else {
                    progressBar.style.background = 'linear-gradient(90deg, var(--primary) 0%, #818cf8 100%)';
                    progressBar.style.boxShadow = '0 0 10px var(--primary-glow)';
                    percentBadge.style.color = 'var(--primary)';
                    percentBadge.style.background = 'rgba(99, 102, 241, 0.1)';
                    percentBadge.style.borderColor = 'rgba(99, 102, 241, 0.2)';
                    
                    const remaining = budgetKhr - monthExpenseKhr;
                    statusMsg.innerHTML = \`💚 <span style="color: var(--success); font-weight: 600;">Remaining: \${formatUsd(remaining / EXCHANGE_RATE)} (\${formatKhr(remaining)})</span>\`;
                }
            }

            document.getElementById('balance-val').innerText = formatUsd(balanceKhr / EXCHANGE_RATE);
            document.getElementById('balance-sub').innerText = formatKhr(balanceKhr);

            document.getElementById('income-val').innerText = formatUsd(incomeKhr / EXCHANGE_RATE);
            document.getElementById('income-sub').innerText = formatKhr(incomeKhr);

            document.getElementById('expense-val').innerText = formatUsd(expenseKhr / EXCHANGE_RATE);
            document.getElementById('expense-sub').innerText = formatKhr(expenseKhr);

            // Category Chart
            if (categoryChartInstance) {
                categoryChartInstance.destroy();
            }
            const catCanvas = document.getElementById('categoryChart').getContext('2d');
            const categoryLabels = data.categories.map(c => c.category);
            const categoryValues = data.categories.map(c => c.total);

            categoryChartInstance = new Chart(catCanvas, {
                type: 'doughnut',
                data: {
                    labels: categoryLabels,
                    datasets: [{
                        data: categoryValues,
                        backgroundColor: ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#eab308'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '70%',
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: '#9ca3af',
                                boxWidth: 8,
                                padding: 12,
                                font: { family: 'Plus Jakarta Sans', size: 10, weight: '500' }
                            }
                        }
                    }
                }
            });

            // Trend Chart
            if (dailyChartInstance) {
                dailyChartInstance.destroy();
            }
            const dailyCanvas = document.getElementById('dailyChart').getContext('2d');
            const dailyLabels = data.daily.map(d => d.date.slice(5)); 
            const dailyValues = data.daily.map(d => d.total);

            const purpleGradient = dailyCanvas.createLinearGradient(0, 0, 0, 180);
            purpleGradient.addColorStop(0, 'rgba(99, 102, 241, 0.2)');
            purpleGradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

            dailyChartInstance = new Chart(dailyCanvas, {
                type: 'line',
                data: {
                    labels: dailyLabels,
                    datasets: [{
                        data: dailyValues,
                        borderColor: '#6366f1',
                        backgroundColor: purpleGradient,
                        fill: true,
                        tension: 0.35,
                        borderWidth: 2,
                        pointRadius: 2,
                        pointHoverRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { 
                            grid: { display: false }, 
                            ticks: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans', size: 9, weight: '500' } } 
                        },
                        y: { 
                            grid: { color: 'rgba(255, 255, 255, 0.03)' }, 
                            ticks: { 
                                color: '#9ca3af', 
                                font: { family: 'Plus Jakarta Sans', size: 9, weight: '500' },
                                callback: val => '$' + Math.round(val / EXCHANGE_RATE)
                            } 
                        }
                    },
                    plugins: { legend: { display: false } }
                }
            });

            // Recent Transactions List
            const txContainer = document.getElementById('transaction-list');
            txContainer.innerHTML = '';

            const emojis = {
                'Food': '🍔', 'Coffee': '☕', 'Transport': '🚌', 'Taxi': '🚕',
                'Rent': '🏠', 'Shopping': '🛒', 'Bills': '📄', 'Salary': '💰',
                'Invest': '📈', 'Other': '🎮'
            };

            if (data.recent.length === 0) {
                txContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 0.85rem;">No recent transactions.</p>';
            } else {
                data.recent.forEach(tx => {
                    const categoryCap = tx.category.charAt(0).toUpperCase() + tx.category.slice(1).toLowerCase();
                    const emoji = emojis[categoryCap] || (tx.type === 'income' ? '💰' : '💸');
                    const sign = tx.type === 'income' ? '+' : '-';
                    const classType = tx.type === 'income' ? 'income' : 'expense';
                    const formattedAmount = tx.currency === 'USD' ? formatUsd(tx.amount) : formatKhr(tx.amount);

                    const row = document.createElement('div');
                    row.className = 'tx-row';
                    row.innerHTML = \`
                        <div class="tx-left">
                            <div class="tx-badge">\${emoji}</div>
                            <div class="tx-meta">
                                <span class="tx-name">\${categoryCap}</span>
                                <span class="tx-date">\${tx.date}</span>
                            </div>
                        </div>
                        <div class="tx-right" style="flex-direction: row; align-items: center; gap: 10px;">
                            <span class="tx-amt \${classType}">\${sign}\${formattedAmount}</span>
                            <button class="btn-delete-tx" data-id="\${tx.id}" style="background: none; border: none; color: var(--danger); opacity: 0.4; cursor: pointer; font-size: 1rem; transition: opacity 0.2s, transform 0.2s; padding: 4px;">🗑️</button>
                        </div>
                    \`;
                    txContainer.appendChild(row);
                });
            }
        }

        // =====================================================================
        // TAB 2: WORK JOURNAL & DAILY STANDUP LOGIC
        // =====================================================================
        let currentWorkCategory = 'Development';
        let cachedWorkData = null;

        document.getElementById('work-cat-pills').addEventListener('click', (e) => {
            const btn = e.target.closest('.pill-btn');
            if (!btn) return;
            document.querySelectorAll('#work-cat-pills .pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentWorkCategory = btn.getAttribute('data-cat') || 'General';
        });

        function getWorkIcon(cat) {
            const c = (cat || '').toLowerCase();
            if (c.includes('bug')) return '🐞';
            if (c.includes('meet') || c.includes('call') || c.includes('sync')) return '👥';
            if (c.includes('release') || c.includes('deploy') || c.includes('ship')) return '🚀';
            if (c.includes('doc') || c.includes('spec') || c.includes('report')) return '📝';
            if (c.includes('test') || c.includes('qa')) return '🧪';
            if (c.includes('design') || c.includes('ui') || c.includes('ux')) return '🎨';
            return '💻';
        }

        async function loadWorkData() {
            const listEl = document.getElementById('work-tasks-list');
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px;"><div class="spinner" style="margin: 0 auto 12px; width:24px; height:24px;"></div>Loading work journal...</div>';

            try {
                const response = await fetch(\`/api/work?user_id=\${userId}\`);
                if (!response.ok) throw new Error("Could not load work data.");
                const data = await response.json();
                cachedWorkData = data;
                workDataLoaded = true;
                renderWorkJournal(data);
            } catch (err) {
                listEl.innerHTML = \`<p style="text-align: center; color: var(--danger); padding: 20px;">Error: \${err.message}</p>\`;
            }
        }

        function renderWorkJournal(data) {
            // Stats
            document.getElementById('work-month-count').innerText = \`\${data.stats.monthCount || 0} Tasks\`;
            document.getElementById('work-month-label').innerText = data.stats.monthLabel || 'This Month';
            document.getElementById('work-today-count').innerText = \`\${data.stats.todayCount || 0} Logged\`;
            document.getElementById('work-today-date').innerText = data.stats.currentDate || 'Today';
            document.getElementById('work-active-days').innerText = \`\${data.stats.activeDays || 0} Days\`;

            // Standup Preview text
            const prevItems = (data.previous || []).map(i => \`  - [\${i.category}] \${i.content}\`).join('\\n') || '  - Continued regular deliverables';
            const todayItems = (data.today || []).map(i => \`  - [\${i.category}] \${i.content}\`).join('\\n') || '  - Continue scheduled tasks & sprint focus';
            const prevDateLabel = data.stats.previousDate || 'Previous';

            const standupTxt = [
                \`Daily Standup - \${data.stats.currentDate}\`,
                \`Engineer: \${username}\`,
                \`\`,
                \`1. Yesterday / Previous (\${prevDateLabel}):\`,
                prevItems,
                \`\`,
                \`2. Today:\`,
                todayItems,
                \`\`,
                \`3. Blockers: None\`
            ].join('\\n');

            document.getElementById('standup-preview-content').innerText = standupTxt;

            // Category breakdown
            const catCard = document.getElementById('work-category-card');
            const catContainer = document.getElementById('work-category-breakdown');
            catContainer.innerHTML = '';
            const cats = Object.entries(data.categories || {});
            if (cats.length > 0) {
                catCard.style.display = 'block';
                cats.forEach(([name, count]) => {
                    const pill = document.createElement('span');
                    pill.className = 'pill-btn';
                    pill.style.background = 'rgba(255, 255, 255, 0.04)';
                    pill.style.cursor = 'default';
                    pill.innerHTML = \`\${getWorkIcon(name)} \${name}: <strong>\${count}</strong>\`;
                    catContainer.appendChild(pill);
                });
            } else {
                catCard.style.display = 'none';
            }

            renderTaskList(data.recent || []);
        }

        function renderTaskList(tasks) {
            const listEl = document.getElementById('work-tasks-list');
            listEl.innerHTML = '';

            const searchVal = (document.getElementById('work-search-input').value || '').toLowerCase().trim();
            const filtered = tasks.filter(t => !searchVal || t.content.toLowerCase().includes(searchVal) || t.category.toLowerCase().includes(searchVal));

            if (filtered.length === 0) {
                listEl.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 0.85rem;">No tasks found.</p>';
                return;
            }

            filtered.forEach(task => {
                const row = document.createElement('div');
                row.className = 'tx-row';
                row.innerHTML = \`
                    <div class="tx-left">
                        <div class="tx-badge">\${getWorkIcon(task.category)}</div>
                        <div class="tx-meta">
                            <span class="tx-name">\${task.content}</span>
                            <span class="tx-date">\${task.date} \${task.time || ''} • [\${task.category}]</span>
                        </div>
                    </div>
                    <div class="tx-right">
                        <button class="btn-delete-task" data-id="\${task.id}" style="background: none; border: none; color: var(--danger); opacity: 0.4; cursor: pointer; font-size: 1rem; padding: 4px;">✕</button>
                    </div>
                \`;
                listEl.appendChild(row);
            });
        }

        document.getElementById('work-search-input').addEventListener('input', () => {
            if (cachedWorkData) {
                renderTaskList(cachedWorkData.recent || []);
            }
        });

        // Copy Standup to clipboard
        document.getElementById('btn-copy-standup').addEventListener('click', () => {
            const txt = document.getElementById('standup-preview-content').innerText;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(txt).then(() => {
                    showToast("✓ Standup copied to clipboard!");
                }).catch(() => {
                    showToast("Could not copy automatically.");
                });
            } else {
                showToast("Clipboard not available in this browser.");
            }
        });

        // Submit New Work Task
        async function submitNewTask() {
            const input = document.getElementById('task-content-input');
            const content = input.value.trim();
            if (!content) return;

            const btn = document.getElementById('btn-submit-task');
            btn.disabled = true;
            btn.innerText = 'Logging...';

            try {
                const response = await fetch(\`/api/work/add?user_id=\${userId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content,
                        category: currentWorkCategory
                    })
                });

                if (!response.ok) throw new Error("Failed to add task.");
                input.value = '';
                showToast("✅ Task logged successfully!");
                await loadWorkData();
            } catch (err) {
                alert("Error: " + err.message);
            } finally {
                btn.disabled = false;
                btn.innerText = '＋ Log';
            }
        }

        // Delete Task
        document.getElementById('work-tasks-list').addEventListener('click', async (e) => {
            const btn = e.target.closest('.btn-delete-task');
            if (!btn) return;
            const taskId = btn.getAttribute('data-id');
            if (!taskId) return;

            if (!confirm("Are you sure you want to remove this task?")) return;

            try {
                const res = await fetch(\`/api/work/delete?user_id=\${userId}&id=\${taskId}\`, {
                    method: 'POST'
                });
                if (!res.ok) throw new Error("Delete failed");
                showToast("🗑️ Task deleted.");
                await loadWorkData();
            } catch (err) {
                alert("Error deleting task: " + err.message);
            }
        });

        // =====================================================================
        // TAB 3: REMINDERS & ALERTS LOGIC
        // =====================================================================
        let cachedReminders = [];

        function getReminderIcon(type, title) {
            const t = (type || '').toLowerCase();
            const tit = (title || '').toLowerCase();
            if (t === 'standup' || tit.includes('standup')) return '🗣️';
            if (t === 'lunchbox' || tit.includes('lunch') || tit.includes('departure')) return '🎒';
            if (t === 'expense_log' || tit.includes('expense') || tit.includes('spending')) return '💳';
            return '⏰';
        }

        async function loadRemindersData() {
            const listEl = document.getElementById('reminders-list');
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px;"><div class="spinner" style="margin: 0 auto 12px; width:24px; height:24px;"></div>Loading reminders...</div>';

            try {
                const response = await fetch(\`/api/reminders?user_id=\${userId}\`);
                if (!response.ok) throw new Error("Could not load reminders.");
                const data = await response.json();
                cachedReminders = data.reminders || [];
                remindersDataLoaded = true;
                renderReminders(cachedReminders);
            } catch (err) {
                listEl.innerHTML = \`<p style="text-align: center; color: var(--danger); padding: 20px;">Error: \${err.message}</p>\`;
            }
        }

        function renderReminders(reminders) {
            const activeCount = reminders.filter(r => r.is_active).length;
            document.getElementById('reminders-active-count').innerText = \`\${activeCount} Active\`;

            const listEl = document.getElementById('reminders-list');
            listEl.innerHTML = '';

            if (reminders.length === 0) {
                listEl.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 0.85rem;">No reminders scheduled. Tap a preset above to create one!</p>';
                return;
            }

            reminders.forEach(r => {
                const icon = getReminderIcon(r.type, r.title);
                const freqLabel = r.frequency === 'weekdays' ? 'Mon–Fri' : r.frequency === 'daily' ? 'Daily' : 'Once';
                const checked = r.is_active ? 'checked' : '';

                const row = document.createElement('div');
                row.className = 'tx-row';
                row.innerHTML = \`
                    <div class="tx-left">
                        <div class="tx-badge">\${icon}</div>
                        <div class="tx-meta">
                            <span class="tx-name">\${r.title}</span>
                            <span class="tx-date">\${r.reminder_time} (\${freqLabel})</span>
                        </div>
                    </div>
                    <div class="tx-right" style="flex-direction: row; align-items: center; gap: 12px;">
                        <label class="switch">
                            <input type="checkbox" class="reminder-toggle" data-id="\${r.id}" \${checked}>
                            <span class="slider"></span>
                        </label>
                        <button class="btn-delete-reminder" data-id="\${r.id}" style="background: none; border: none; color: var(--danger); opacity: 0.4; cursor: pointer; font-size: 1rem; padding: 4px;">✕</button>
                    </div>
                \`;
                listEl.appendChild(row);
            });
        }

        // Toggle Switch handler
        document.getElementById('reminders-list').addEventListener('change', async (e) => {
            const toggle = e.target.closest('.reminder-toggle');
            if (!toggle) return;
            const reminderId = toggle.getAttribute('data-id');
            if (!reminderId) return;

            try {
                const res = await fetch(\`/api/reminders/toggle?user_id=\${userId}&id=\${reminderId}\`, {
                    method: 'POST'
                });
                if (!res.ok) throw new Error("Toggle failed");
                const data = await res.json();
                showToast(data.is_active ? "🟢 Reminder turned ON" : "⚪ Reminder turned OFF");
                await loadRemindersData();
            } catch (err) {
                alert("Error toggling reminder: " + err.message);
                toggle.checked = !toggle.checked;
            }
        });

        // Delete Reminder handler
        document.getElementById('reminders-list').addEventListener('click', async (e) => {
            const btn = e.target.closest('.btn-delete-reminder');
            if (!btn) return;
            const reminderId = btn.getAttribute('data-id');
            if (!reminderId) return;

            if (!confirm("Are you sure you want to remove this reminder?")) return;

            try {
                const res = await fetch(\`/api/reminders/delete?user_id=\${userId}&id=\${reminderId}\`, {
                    method: 'POST'
                });
                if (!res.ok) throw new Error("Delete failed");
                showToast("🗑️ Reminder deleted.");
                await loadRemindersData();
            } catch (err) {
                alert("Error deleting reminder: " + err.message);
            }
        });

        // Add Preset Reminder
        async function addPresetReminder(title, time, frequency, type) {
            try {
                const res = await fetch(\`/api/reminders/add?user_id=\${userId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        reminder_time: time,
                        frequency,
                        type
                    })
                });
                if (!res.ok) throw new Error("Failed to add preset");
                showToast(\`⏰ "\${title}" enabled for \${time}!\`);
                await loadRemindersData();
            } catch (err) {
                alert("Error: " + err.message);
            }
        }

        // Add Custom Reminder
        async function submitNewReminder() {
            const titleInput = document.getElementById('reminder-title-input');
            const timeInput = document.getElementById('reminder-time-input');
            const freqSelect = document.getElementById('reminder-freq-select');

            const title = titleInput.value.trim();
            const time = timeInput.value.trim();
            const frequency = freqSelect.value;

            if (!title || !time) return;

            try {
                const res = await fetch(\`/api/reminders/add?user_id=\${userId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        reminder_time: time,
                        frequency
                    })
                });

                if (!res.ok) throw new Error("Failed to create reminder");
                titleInput.value = '';
                showToast("✅ Reminder scheduled!");
                await loadRemindersData();
            } catch (err) {
                alert("Error: " + err.message);
            }
        }

        // =====================================================================
        // HISTORY VIEW MODAL LOGIC (FINANCE)
        // =====================================================================
        const btnSeeAll = document.getElementById('btn-see-all');
        const btnBackToDashboard = document.getElementById('btn-back-to-dashboard');
        const tabPaneFinance = document.getElementById('tab-pane-finance');
        const historyViewDiv = document.getElementById('history-view');
        const historySearchInput = document.getElementById('history-search-input');
        const typePillGroup = document.getElementById('type-pill-group');
        const historyListContainer = document.getElementById('history-transaction-list');
        const btnPrevPage = document.getElementById('btn-prev-page');
        const btnNextPage = document.getElementById('btn-next-page');
        const historyPageInfo = document.getElementById('history-page-info');

        let historyPage = 1;
        const historyLimit = 20;
        let historyType = 'all';
        let historySearch = '';
        let searchDebounceTimer = null;

        btnSeeAll.addEventListener('click', () => {
            tabPaneFinance.style.display = 'none';
            historyViewDiv.style.display = 'block';
            historyPage = 1;
            loadHistoryData();
        });

        btnBackToDashboard.addEventListener('click', () => {
            historyViewDiv.style.display = 'none';
            tabPaneFinance.style.display = 'block';
            loadDashboardData(userId);
        });

        typePillGroup.addEventListener('click', (e) => {
            const pill = e.target.closest('.pill-btn');
            if (!pill) return;
            document.querySelectorAll('#type-pill-group .pill-btn').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            historyType = pill.getAttribute('data-type') || 'all';
            historyPage = 1;
            loadHistoryData();
        });

        historySearchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                historySearch = e.target.value.trim();
                historyPage = 1;
                loadHistoryData();
            }, 300);
        });

        btnPrevPage.addEventListener('click', () => {
            if (historyPage > 1) {
                historyPage--;
                loadHistoryData();
            }
        });

        btnNextPage.addEventListener('click', () => {
            historyPage++;
            loadHistoryData();
        });

        async function handleDeleteTxClick(e) {
            const btn = e.target.closest('.btn-delete-tx');
            if (!btn) return;
            const txId = btn.getAttribute('data-id');
            if (!txId) return;

            if (!confirm("Are you sure you want to delete this transaction?")) return;

            try {
                const response = await fetch(\`/api/delete?user_id=\${userId}&id=\${txId}\`, {
                    method: 'POST'
                });

                if (!response.ok) throw new Error("Failed to delete transaction.");

                const result = await response.json();
                if (result.ok) {
                    showToast("🗑️ Transaction deleted.");
                    if (historyViewDiv.style.display === 'block') {
                        loadHistoryData();
                    } else {
                        loadDashboardData(userId);
                    }
                } else {
                    alert("Could not delete transaction: " + (result.error || "Unknown error"));
                }
            } catch (err) {
                alert("Error deleting transaction: " + err.message);
            }
        }

        document.getElementById('transaction-list').addEventListener('click', handleDeleteTxClick);
        document.getElementById('history-transaction-list').addEventListener('click', handleDeleteTxClick);

        async function loadHistoryData() {
            historyListContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 30px;"><div class="spinner" style="margin: 0 auto 12px; width:24px; height:24px;"></div>Loading history...</div>';
            
            try {
                let url = \`/api/history?user_id=\${userId}&page=\${historyPage}&limit=\${historyLimit}\`;
                if (historyType !== 'all') {
                    url += \`&type=\${historyType}\`;
                }
                if (historySearch) {
                    url += \`&search=\${encodeURIComponent(historySearch)}\`;
                }

                const response = await fetch(url);
                if (!response.ok) throw new Error("Could not load history records.");
                const data = await response.json();
                renderHistory(data);
            } catch (err) {
                historyListContainer.innerHTML = \`<p style="text-align: center; color: var(--danger); padding: 20px;">Error: \${err.message}</p>\`;
            }
        }

        function renderHistory(data) {
            historyListContainer.innerHTML = '';
            const transactions = data.transactions || [];
            const totalPages = data.totalPages || 1;
            historyPage = data.page || 1;

            if (transactions.length === 0) {
                historyListContainer.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 40px; font-size: 0.85rem; font-weight: 500;">No transactions found matching criteria.</p>';
                btnPrevPage.disabled = true;
                btnNextPage.disabled = true;
                historyPageInfo.innerText = \`Page \${historyPage} of \${totalPages}\`;
                return;
            }

            const emojis = {
                'Food': '🍔', 'Coffee': '☕', 'Transport': '🚌', 'Taxi': '🚕',
                'Rent': '🏠', 'Shopping': '🛒', 'Bills': '📄', 'Salary': '💰',
                'Invest': '📈', 'Other': '🎮'
            };

            transactions.forEach(tx => {
                const categoryCap = tx.category.charAt(0).toUpperCase() + tx.category.slice(1).toLowerCase();
                const emoji = emojis[categoryCap] || (tx.type === 'income' ? '💰' : '💸');
                const sign = tx.type === 'income' ? '+' : '-';
                const classType = tx.type === 'income' ? 'income' : 'expense';
                const formattedAmount = tx.currency === 'USD' ? formatUsd(tx.amount) : formatKhr(tx.amount);

                const row = document.createElement('div');
                row.className = 'tx-row';
                row.innerHTML = \`
                    <div class="tx-left">
                        <div class="tx-badge">\${emoji}</div>
                        <div class="tx-meta">
                            <span class="tx-name">\${categoryCap}</span>
                            <span class="tx-date">\${tx.date}</span>
                        </div>
                    </div>
                    <div class="tx-right" style="flex-direction: row; align-items: center; gap: 10px;">
                        <span class="tx-amt \${classType}">\${sign}\${formattedAmount}</span>
                        <button class="btn-delete-tx" data-id="\${tx.id}" style="background: none; border: none; color: var(--danger); opacity: 0.4; cursor: pointer; font-size: 1rem; transition: opacity 0.2s, transform 0.2s; padding: 4px;">🗑️</button>
                    </div>
                \`;
                historyListContainer.appendChild(row);
            });

            historyPageInfo.innerText = \`Page \${historyPage} of \${totalPages}\`;
            btnPrevPage.disabled = historyPage <= 1;
            btnNextPage.disabled = historyPage >= totalPages;
        }

        // =====================================================================
        // TAB 4: MOVIE & SERIES WATCHLIST LOGIC
        // =====================================================================
        let cachedWatchlist = [];
        let currentWlFilter = 'all';

        async function loadWatchlistData() {
            try {
                const res = await fetch(\`/api/watchlist?user_id=\${userId}\`);
                const data = await res.json();
                if (data.ok) {
                    cachedWatchlist = data.items || [];
                    document.getElementById('wl-hero-count').innerText = \`\${data.total || 0} Titles\`;
                    document.getElementById('wl-hero-sub').innerText = \`\${data.planCount || 0} To Watch • \${data.watchedCount || 0} Watched\`;
                    document.getElementById('wl-plan-stat').innerText = data.planCount || 0;
                    document.getElementById('wl-watched-stat').innerText = data.watchedCount || 0;
                    renderWatchlistCards(cachedWatchlist, currentWlFilter);
                    watchlistDataLoaded = true;
                }
            } catch (err) {
                console.error("Failed to load watchlist:", err);
            }
        }

        function renderWatchlistCards(items, filter = 'all', searchQuery = '') {
            const container = document.getElementById('watchlist-cards-list');
            container.innerHTML = '';

            let filtered = items;
            if (filter === 'plan_to_watch') {
                filtered = items.filter(i => i.status === 'plan_to_watch');
            } else if (filter === 'watched') {
                filtered = items.filter(i => i.status === 'watched');
            }

            if (searchQuery && searchQuery.trim()) {
                const q = searchQuery.toLowerCase().trim();
                filtered = filtered.filter(i => 
                    (i.title && i.title.toLowerCase().includes(q)) || 
                    (i.genre && i.genre.toLowerCase().includes(q)) ||
                    (i.synopsis && i.synopsis.toLowerCase().includes(q))
                );
            }

            if (filtered.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 0.85rem;">No titles found in this list.</p>';
                return;
            }

            filtered.forEach(m => {
                const isWatched = m.status === 'watched';
                const statusBadge = isWatched 
                    ? '<span style="font-size: 0.7rem; font-weight: 700; color: var(--success); background: var(--success-bg); padding: 3px 8px; border-radius: 10px; border: 1px solid rgba(16, 185, 129, 0.2);">✅ Watched</span>'
                    : '<span style="font-size: 0.7rem; font-weight: 700; color: var(--accent); background: rgba(236, 72, 153, 0.15); padding: 3px 8px; border-radius: 10px; border: 1px solid rgba(236, 72, 153, 0.3);">⭐ To Watch</span>';

                const yearStr = m.year ? \`(\${m.year})\` : '';
                const ratingBadge = m.rating ? \`<span style="font-size: 0.75rem; color: #f59e0b; background: rgba(245, 158, 11, 0.1); padding: 2px 6px; border-radius: 6px; font-weight: 600;">⭐ \${m.rating}</span>\` : '';
                const genreBadge = m.genre ? \`<span style="font-size: 0.72rem; color: var(--text-muted); background: rgba(255, 255, 255, 0.05); padding: 2px 6px; border-radius: 6px;">\${m.genre}</span>\` : '';
                const lengthBadge = m.runtime ? \`<span style="font-size: 0.72rem; color: var(--text-muted);">⏱️ \${m.runtime}</span>\` : '';

                const toggleLabel = isWatched ? '↩️ Unwatch' : '🍿 Watched';
                const toggleBg = isWatched ? 'rgba(255, 255, 255, 0.08)' : 'rgba(236, 72, 153, 0.18)';
                const toggleColor = isWatched ? 'var(--text-color)' : 'var(--accent)';

                const card = document.createElement('div');
                card.className = 'tx-row';
                card.style.flexDirection = 'column';
                card.style.alignItems = 'stretch';
                card.style.gap = '8px';
                card.style.padding = '14px';

                card.innerHTML = \`
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                        <div>
                            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                                <strong style="font-size: 0.95rem; color: #ffffff;">\${m.title}</strong>
                                <span style="font-size: 0.8rem; color: var(--text-muted);">\${yearStr}</span>
                                \${statusBadge}
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap;">
                                \${ratingBadge}
                                \${genreBadge}
                                \${lengthBadge}
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <button onclick="toggleMovieStatus(\${m.id})" style="background: \${toggleBg}; color: \${toggleColor}; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 10px; padding: 5px 9px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: opacity 0.2s;">
                                \${toggleLabel}
                            </button>
                            <button onclick="deleteMovieItem(\${m.id})" style="background: none; border: none; color: var(--danger); opacity: 0.5; cursor: pointer; font-size: 1rem; padding: 4px;">
                                🗑️
                            </button>
                        </div>
                    </div>
                    \${m.synopsis ? \`<div style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.4; margin-top: 2px;">\${m.synopsis}</div>\` : ''}
                \`;
                container.appendChild(card);
            });
        }

        async function submitNewMovie() {
            const input = document.getElementById('movie-title-input');
            const title = (input.value || '').trim();
            if (!title) return;

            const btn = document.getElementById('btn-submit-movie');
            btn.disabled = true;
            btn.innerText = '...';

            try {
                const res = await fetch(\`/api/watchlist/add?user_id=\${userId}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title })
                });
                const data = await res.json();
                if (data.ok) {
                    input.value = '';
                    showToast('⭐ Added to Watchlist!');
                    await loadWatchlistData();
                } else {
                    showToast('Failed to add title');
                }
            } catch (err) {
                console.error('Error adding movie:', err);
                showToast('Error adding title');
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span>➕</span> Add';
            }
        }

        async function toggleMovieStatus(id) {
            try {
                const res = await fetch(\`/api/watchlist/toggle?user_id=\${userId}&id=\${id}\`, { method: 'POST' });
                const data = await res.json();
                if (data.ok) {
                    showToast(data.newStatus === 'watched' ? '🍿 Marked as watched!' : '⭐ Moved to Plan to Watch!');
                    await loadWatchlistData();
                }
            } catch (err) {
                console.error('Error toggling movie:', err);
            }
        }

        async function deleteMovieItem(id) {
            if (!confirm('Remove this title from your watchlist?')) return;
            try {
                const res = await fetch(\`/api/watchlist/delete?user_id=\${userId}&id=\${id}\`, { method: 'POST' });
                const data = await res.json();
                if (data.ok) {
                    showToast('🗑️ Removed from Watchlist');
                    await loadWatchlistData();
                }
            } catch (err) {
                console.error('Error deleting movie:', err);
            }
        }

        function pickRandomMovieTonight() {
            const unwatched = cachedWatchlist.filter(i => i.status === 'plan_to_watch');
            if (unwatched.length === 0) {
                showToast('No unwatched titles in your watchlist yet! Add one first.');
                return;
            }
            const pick = unwatched[Math.floor(Math.random() * unwatched.length)];
            alert(\`🎲 Tonight's Movie Pick!\n\n🎬 \${pick.title} \${pick.year ? '(' + pick.year + ')' : ''}\n⭐ \${pick.rating || 'Recommended'}\n🎭 \${pick.genre || ''}\n\n\${pick.synopsis || 'Ready to watch tonight!'}\`);
        }

        // Watchlist filter pills and search listeners
        document.getElementById('wl-filter-pills').addEventListener('click', (e) => {
            const btn = e.target.closest('.pill-btn');
            if (!btn) return;
            document.querySelectorAll('#wl-filter-pills .pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentWlFilter = btn.getAttribute('data-filter') || 'all';
            const searchVal = document.getElementById('wl-search-input').value;
            renderWatchlistCards(cachedWatchlist, currentWlFilter, searchVal);
        });

        document.getElementById('wl-search-input').addEventListener('input', (e) => {
            renderWatchlistCards(cachedWatchlist, currentWlFilter, e.target.value);
        });
    </script>
</body>
</html>
`;
