# Klaviyo → Notion Sync

Pulls email stats from Klaviyo and writes them into the **📊 Live Scoreboard** table on a Notion page. Runs automatically every Monday at 8:00 AM CT via GitHub Actions.

## What it syncs

| Notion row | Klaviyo source |
|---|---|
| Email List Size | Profile count for list `KLAVIYO_LIST_ID` |
| Engaged Email Segment | Profile count for segment `KLAVIYO_SEGMENT_ID` |
| Open Rate | 30-day unique-open ÷ delivered across all campaigns |

## Requirements

- Node.js 20+ (uses built-in `fetch` — no dependencies)

## Local setup

```bash
cp .env.example .env
# Fill in real values in .env
node sync.js
```

> The script reads `.env` only when you export variables yourself or use a tool like `dotenv-cli`:
> ```bash
> npx dotenv-cli node sync.js
> ```
> Alternatively, export them manually:
> ```bash
> export $(grep -v '^#' .env | xargs) && node sync.js
> ```

## GitHub Actions setup

1. Push this repo to GitHub.
2. Go to **Settings → Secrets and variables → Actions** and add each secret:

   | Secret name | Value |
   |---|---|
   | `KLAVIYO_PRIVATE_KEY` | Your Klaviyo private API key |
   | `KLAVIYO_LIST_ID` | `U6TK2J` |
   | `KLAVIYO_SEGMENT_ID` | `Req9bA` |
   | `NOTION_TOKEN` | Your Notion integration token |
   | `NOTION_PAGE_ID` | `33061df7-5c71-8127-90c6-d61f7671ff4e` |

3. The workflow (`.github/workflows/sync.yml`) runs every Monday at **14:00 UTC (08:00 CDT)**. During Central Standard Time (Nov–Mar) this is 09:00 CT. To always run at exactly 08:00 CST in winter, change the cron to `0 13 * * 1`.

4. You can also trigger it manually from **Actions → Klaviyo → Notion Sync → Run workflow**.

## Notion page requirements

- The Notion integration must be **connected to the page** (Share → Connections → add your integration).
- The page must contain a heading with the text **Live Scoreboard** (any heading level).
- The table immediately following that heading must have:
  - A **header row** with a cell containing the word `Current`
  - Data rows whose first cell matches exactly: `Email List Size`, `Engaged Email Segment`, `Open Rate`

## Environment variables

See `.env.example` for all required variables. Never commit real secrets to the repository.
