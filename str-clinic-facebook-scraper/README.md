# COM-001: Facebook Competitor Scraper

## Setup

```bash
cd /Users/robotmac/workspace/str-clinic-facebook-scraper
python3.11 -m pip install -r requirements.txt
python3.11 -m playwright install chromium
```

## Run

```bash
python3.11 facebook_scraper.py
```

Opens Chrome browser. If Facebook login is required for groups, log in manually — the agent will continue.

## Output

Google Sheet: "STR Clinic — Competitor Facebook Posts"
Columns: Source Page | Post Text | Likes | Comments | Date | Time | Format

## Model

claude-haiku-4-5-20251001 via Browser Use
