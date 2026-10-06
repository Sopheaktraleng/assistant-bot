# Cashflow Telegram Bot

A 24/7 Telegram expense tracker designed for free hosting on Cloudflare Workers with Cloudflare D1.

Cloudflare Workers do not run as a permanent process. Telegram sends each bot update to `/webhook`, the Worker handles it, stores data in D1, replies to Telegram, then exits. This keeps the bot available without paying for an always-on server.

## Commands

```text
/start or /menu   - Open modern dashboard & quick actions
/lunchbox         - Lunch box departure reminder manager
/lunchbox 17:30   - Set lunch box reminder time
/lunchbox on/off  - Enable or disable lunch box alarm
/remind 17:30 ... - Set custom daily reminder
/reminders        - View & manage all active reminders
/add 5 usd lunch  - Log an expense (or type /a for picker)
/income 500 usd   - Log income (or type /i for picker)
/today or /t      - View today's itemized ledger
/summary          - Today's spending stats & category progress bars
/week             - 7-day spending report with doughnut chart
/month            - Current month summary & budget status
/budget 300 usd   - Set monthly spending limit (0 to disable)
/settings         - Currency switcher & budget settings
/clear            - Reset records (with auto CSV backup)
/help             - View bot documentation
```

## Bot Highlights & Flow

- **🍱 Lunch Box Departure Alarm:** Set a weekday reminder (e.g. at 5:30 PM before heading home) so you never leave your lunch box behind at the office. Comes with `[✅ Got it!]` and `[⏰ Snooze 15m]` buttons.
- **⏰ Habit & Custom Reminders:** Setup custom daily reminders (`/remind <time> <title>`) or enable daily 9:00 PM expense check-ins.
- **🎨 Redesigned Premium UI:** Clean layout, sleek category icons (`🍔 Food`, `☕ Coffee`, `🚗 Transport`, etc.), currency toggle (USD/KHR), visual progress bars (`▰▰▰▰▱▱`), and organized menus without chat clutter.
- **⚡ Instant Interactive Receipts:** Clean receipt cards with quick actions `[➕ Add Another]`, `[📜 Ledger]`, `[🏠 Menu]`.
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
```

Use any random long string for `WEBHOOK_SECRET`.

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
