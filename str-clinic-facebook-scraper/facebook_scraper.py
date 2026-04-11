#!/usr/bin/env python3.11
"""
COM-001: Facebook Competitor Scraper
Scrapes last 30 posts from 6 Facebook pages/groups.
Outputs to Google Sheet in brandon@strclinic.com Drive.
Model: claude-haiku-4-5-20251001
"""

import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Load ANTHROPIC_API_KEY from zshrc if not in env
if not os.environ.get('ANTHROPIC_API_KEY'):
    zshrc = Path.home() / '.zshrc'
    if zshrc.exists():
        for line in zshrc.read_text().splitlines():
            if line.startswith('export ANTHROPIC_API_KEY='):
                os.environ['ANTHROPIC_API_KEY'] = line.split('=', 1)[1].strip()
                break

# Fallback import handling for langchain_anthropic
try:
    from langchain_anthropic import ChatAnthropic
except Exception:
    ChatAnthropic = None

from browser_use import Agent, Browser, BrowserConfig
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# ── Config ────────────────────────────────────────────────────
TARGETS = [
    {"name": "Airbnb Superhost Community UK", "url": "https://www.facebook.com/groups/airbnbsuperhostcommunityuk/", "type": "group"},
    {"name": "Pass the Keys", "url": "https://www.facebook.com/passthekeys/", "type": "page"},
    {"name": "Sykes Cottages", "url": "https://www.facebook.com/sykescottages/", "type": "page"},
    {"name": "Your Space property management", "url": "https://www.facebook.com/yourspacepropertymanagement/", "type": "page"},
    {"name": "STR Superhosts UK", "url": "https://www.facebook.com/groups/strsuperhostsuk/", "type": "group"},
    {"name": "Canopy & Stars", "url": "https://www.facebook.com/canopyandstars/", "type": "page"},
]

SHEET_NAME = "STR Clinic — Competitor Facebook Posts"
HEADERS = ["Source Page", "Post Text", "Likes", "Comments", "Date", "Time", "Format"]
POSTS_PER_TARGET = 30
MODEL_NAME = "claude-haiku-4-5-20251001"

# ── Google Sheets auth ────────────────────────────────────────
def get_sheets_service():
    oauth = json.load(open('/tmp/gog-oauth-config.json'))
    creds = Credentials(
        token=None,
        refresh_token=oauth['refresh_token'],
        client_id=oauth['client_id'],
        client_secret=oauth['client_secret'],
        token_uri='https://oauth2.googleapis.com/token',
        scopes=['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    )
    creds.refresh(Request())
    sheets_svc = build('sheets', 'v4', credentials=creds)
    drive_svc = build('drive', 'v3', credentials=creds)
    return sheets_svc, drive_svc


def create_or_get_sheet(sheets_svc, drive_svc):
    """Create the Google Sheet if it doesn't exist, return spreadsheet_id."""
    # Search for existing sheet
    results = drive_svc.files().list(
        q=f"name='{SHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        fields='files(id, name)'
    ).execute()
    files = results.get('files', [])
    if files:
        sid = files[0]['id']
        print(f"Using existing sheet: https://docs.google.com/spreadsheets/d/{sid}")
        return sid

    # Create new
    spreadsheet = sheets_svc.spreadsheets().create(body={
        'properties': {'title': SHEET_NAME},
        'sheets': [{'properties': {'title': 'Posts'}}]
    }).execute()
    sid = spreadsheet['spreadsheetId']
    # Write headers
    sheets_svc.spreadsheets().values().update(
        spreadsheetId=sid,
        range='Posts!A1:G1',
        valueInputOption='RAW',
        body={'values': [HEADERS]}
    ).execute()
    print(f"Created sheet: https://docs.google.com/spreadsheets/d/{sid}")
    return sid


def append_rows(sheets_svc, sid, rows):
    if not rows:
        return
    sheets_svc.spreadsheets().values().append(
        spreadsheetId=sid,
        range='Posts!A:G',
        valueInputOption='RAW',
        insertDataOption='INSERT_ROWS',
        body={'values': rows}
    ).execute()
    print(f"  Appended {len(rows)} rows")

# ── Browser Use scraper ───────────────────────────────────────
async def scrape_target(target: dict, browser: Browser) -> list[list]:
    """Use Browser Use agent to scrape posts from a Facebook page/group."""
    if ChatAnthropic is None:
        # try dynamic import
        try:
            from langchain_anthropic import ChatAnthropic as ChatAnthropicImpl
            ChatAnthropic = ChatAnthropicImpl
        except Exception:
            raise RuntimeError('langchain_anthropic is required but not available')

    llm = ChatAnthropic(model=MODEL_NAME, timeout=120, stop=None)
    
    task = f"""
Navigate to this Facebook {target['type']}: {target['url']}

Your job is to extract data from the last {POSTS_PER_TARGET} posts visible on this page.

For each post, extract:
1. Post text (full text content, truncate at 2000 chars if very long)
2. Likes/reactions count (number only, 0 if not visible)
3. Comments count (number only, 0 if not visible)
4. Date posted (format: YYYY-MM-DD if possible, or the relative date shown like "2 days ago")
5. Time posted (format: HH:MM if available, else empty string)
6. Format: one of "text", "image", "video", "link" based on post content type

Scroll down to load more posts if needed to get {POSTS_PER_TARGET} posts.

Return your findings as a JSON array of objects with these exact keys:
[
  {{
    "text": "post text here",
    "likes": 42,
    "comments": 7,
    "date": "2024-01-15",
    "time": "14:30",
    "format": "image"
  }}
]

Return ONLY the JSON array, nothing else. If you cannot access the page (login required for groups), return an empty array [].
"""

    agent = Agent(
        task=task,
        llm=llm,
        browser=browser,
    )
    
    try:
        result = await agent.run(max_steps=25)
        # Extract the final result text
        final_text = result.final_result() if hasattr(result, 'final_result') else str(result)
        
        # Parse JSON from result
        import re
        json_match = re.search(r'\[.*\]', final_text, re.DOTALL)
        if json_match:
            posts = json.loads(json_match.group())
        else:
            print(f"  No JSON array found in result for {target['name']}")
            posts = []
    except Exception as e:
        print(f"  Error scraping {target['name']}: {e}")
        posts = []
    
    # Convert to sheet rows
    rows = []
    for post in posts[:POSTS_PER_TARGET]:
        rows.append([
            target['name'],
            str(post.get('text', '')),
            str(post.get('likes', 0)),
            str(post.get('comments', 0)),
            str(post.get('date', '')),
            str(post.get('time', '')),
            str(post.get('format', 'text')),
        ])
    return rows

# ── Main ──────────────────────────────────────────────────────
async def main():
    print(f"COM-001: Facebook Competitor Scraper — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    
    # Set up Google Sheets
    print("\nConnecting to Google Sheets...")
    sheets_svc, drive_svc = get_sheets_service()
    sid = create_or_get_sheet(sheets_svc, drive_svc)
    sheet_url = f"https://docs.google.com/spreadsheets/d/{sid}"
    
    # Set up browser — use Chrome user data dir to leverage existing Facebook login session
    browser_config = BrowserConfig(
        headless=False,  # Non-headless to handle Facebook login if needed
        chrome_instance_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
    
    all_rows = []
    
    async with Browser(config=browser_config) as browser:
        for target in TARGETS:
            print(f"\nScraping: {target['name']} ({target['url']})")
            rows = await scrape_target(target, browser)
            print(f"  Extracted {len(rows)} posts")
            if rows:
                append_rows(sheets_svc, sid, rows)
                all_rows.extend(rows)
    
    print(f"\n✓ Complete. Total posts scraped: {len(all_rows)}")
    print(f"✓ Sheet URL: {sheet_url}")
    return sheet_url

if __name__ == '__main__':
    sheet_url = asyncio.run(main())
    print(f"\nSHEET_URL={sheet_url}")
