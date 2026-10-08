# Personal Assistant & Cashflow Telegram Bot

A 24/7 personal assistant and productivity bot hosted on Cloudflare Workers with Cloudflare D1.

Cloudflare Workers do not run as a permanent process. Telegram sends each bot update to `/webhook`, the Worker handles it, stores data in D1, replies to Telegram, then exits. This keeps the bot available without paying for an always-on server.

## Workspaces & Architecture

The bot is structured as an extensible **Personal Assistant Hub**:
- 🌟 **Main Assistant Hub (`/hub` or `/menu`):** Clean top-level portal with quick access to workspaces. Designed to easily scale with future tools.
- 🧾 **Smart Bank Slip & Receipt Scanner (`/scan` or send photo):** Snap or forward any ABA Bank, Bakong, KHQR, or receipt screenshot. AI automatically extracts the amount, currency (USD/KHR), merchant, and category with 1-tap confirmation.
- 💼 **Work Journal & Manager Reports (`/work`, `/done`):** Track daily accomplishments and automatically generate structured, professional monthly accomplishment reports for your manager or 1-on-1s.
- 💰 **Cashflow & Finance Workspace (`/finance`):** Expense & income tracking, daily ledger, monthly budgets, category breakdowns, and paginated transaction history.
- ⏰ **Reminders & Habits Workspace (`/reminders`):** Automated departure alarms (lunch box reminder), custom reminders (`/remind`), and daily check-ins.
- 📱 **Web Mini-App Dashboard:** Interactive visual dashboard with Chart.js, budget gauges, and history search.
- ⚙️ **Settings (`/settings`):** Multi-currency switch (USD / KHR), monthly budget setup, and secure CSV data management.

## Commands

```text
/hub or /menu     - Open Personal Assistant Hub
/scan             - Open Smart Bank Slip & Receipt Scanner guide (or just send an image)
/work             - Open Work Journal & Accomplishment Workspace
/done <task>      - Log a completed work task (e.g. /done Fixed checkout bug)
/report           - Generate this month's manager accomplishment report
/report last      - Generate last month's accomplishment report
/report export    - Export report as a downloadable text document (.txt)
/finance          - Open Cashflow & Finance Workspace
/reminders        - Open Reminders & Habits Workspace
/lunchbox         - Lunch box departure reminder manager
/lunchbox 17:30   - Set lunch box reminder time
/lunchbox on/off  - Enable or disable lunch box alarm
/remind 17:30 ... - Set custom reminder
/add 5 usd lunch  - Log an expense (or type /a for picker)
/income 500 usd   - Log income (or type /i for picker)
/today or /t      - View today's itemized ledger
/summary          - Today's spending stats & category progress bars
/week             - 7-day spending report with chart
/month            - Current month summary & budget status
/budget 300 usd   - Set monthly spending limit (0 to disable)
/settings         - Currency switcher & budget settings
/clear            - Reset records (with auto CSV backup)
/help             - View bot documentation
```

## Bot Highlights & Flow

- **🧾 Smart KHQR & Bank Slip Scanner:** No typing required! Send or forward any ABA Mobile, Bakong KHQR, Acleda, Wing, or restaurant receipt photo. Smart AI OCR parses the amount (USD/KHR), recipient, and category, offering instant `[✅ Confirm]`, `[🏷️ Category]`, and `[🔄 Make Income]` controls.
- **💼 Work Journal & Manager Reports:** Never struggle to recall what you did this month. Type `/done <task>` whenever you finish something. At month-end, type `/report` to get a structured weekly breakdown with active days and categories, ready to copy-paste or download as `.txt`.
- **🌟 Modular Assistant Hub:** An uncluttered, minimalist portal where features are neatly separated into dedicated workspaces.
- **🍱 Lunch Box Departure Alarm:** Set a weekday reminder (e.g. at 5:30 PM before heading home) so you never leave your lunch box behind at the office. Comes with `[✅ Got it!]` and `[⏰ Snooze 15m]` buttons.
- **⏰ Habit & Custom Reminders:** Setup custom reminders (`/remind <time> <title>`) or enable daily 9:00 PM expense check-ins.
- **🎨 Modern UI & Two-Way Navigation:** Clean cards with quick return links `[⬅️ Back to Workspace]` and `[🏠 Main Hub]`.
- **⚡ Instant Interactive Receipts:** Clean receipt cards with quick actions `[➕ Add Another]`, `[📜 Ledger]`, `[💰 Finance Hub]`.
- **📱 Web Mini-App Dashboard:** Full analytics with Chart.js, budget gauges, historical search, and pagination.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Log in to Cloudflare:

```bash
npx wrangler login
```

3. Create a D1 database:

```bash
npx wrangler d1 create cashflow_bot
```

4. Copy the generated `database_id` into `wrangler.toml`.

5. Create the table:

```bash
npm run db:migrate:remote
```

6. Set Cloudflare Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY # (Recommended: free key from https://aistudio.google.com for Khmer/ABA/Bakong slip OCR)
```

Use any random long string for `WEBHOOK_SECRET`. Cloudflare Workers AI is also automatically supported as a built-in fallback.

7. Deploy:

```bash
npm run deploy
```

8. Register the Telegram webhook:

```bash
$env:TELEGRAM_BOT_TOKEN="your-bot-token"
$env:WEBHOOK_SECRET="same-secret-from-step-6"
$env:WORKER_URL="https://cashflow-bot.your-subdomain.workers.dev"
npm run set:webhook
```

On macOS/Linux, use `export TELEGRAM_BOT_TOKEN=...` instead of `$env:...`.

The webhook setup drops pending Telegram updates, so old messages should not replay after deployment.

## Local Development

Create `.dev.vars` from `.dev.vars.example`, then run:

```bash
npm run db:migrate:local
npm run dev
```

For real Telegram testing, deploy first and use the public Worker URL as the webhook.

## Important Security Note

If your Telegram token was ever committed, shared, or printed in logs, rotate it in BotFather before deploying.
