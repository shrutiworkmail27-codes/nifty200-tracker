# Nifty 200 Earnings & Concall Tracker

Free, automated, no paid APIs, no AI. Watches NSE filings for the Nifty 200. **Your team only gets a
read-only web page, a shared calendar and two emails a day. They never see your Google Sheet.**

```
GitHub Actions (hourly)  -->  Cloudflare relay  -->  NSE archives (RSS + XBRL files)
        |
        +- parses filings, keeps Nifty 200 only
              |
              v
        Google Apps Script (inside your private Sheet)
              +- Tracker tab: one row per company-quarter (only you can see it)
              +- Web app (the link you share): schedule by day, companies, what's new, join buttons
              +- Google Calendar: result dates and concall times with dial-in links
              +- Email: 8:30 AM digest (today + next 7 days), 6:30 PM "new today" digest
```

## What it reads

| Filing | Gives | Status |
|---|---|---|
| Schedule of Analysts / Institutional Investors Meet (XBRL) | Earnings call date, time, mode, dial-in link, quarter | Tested on a real Rallis file |
| Board Meeting Intimation (XBRL) | Result date | **Parser is generic, real file not seen yet** (see step 7) |
| Con. call updates / transcript / audio | Link to the filing, matched by company name | Best effort, unverified |

## Setup (about 40 minutes, once)

### 1. Cloudflare relay (new Worker, leave your old one alone)

1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Hello World** template.
2. Name it `nse-relay-tracker` > **Deploy** > **Edit code**.
3. Delete everything, paste the contents of `worker/relay.js` > **Deploy**.
4. Worker > **Settings** > **Variables and Secrets** > **Add** > type **Secret**, name `RELAY_KEY`,
   value = a long random string (make one up, 30+ characters). Save, then deploy again if asked.
5. Note the Worker URL, e.g. `https://nse-relay-tracker.<yourname>.workers.dev`.

Test without the key (should say `forbidden`): open the URL in a browser.
Test with the key (should print the first lines of the feed):

```
curl -H "X-Relay-Key: YOUR_KEY" "https://nse-relay-tracker.<yourname>.workers.dev/?url=https%3A%2F%2Fnsearchives.nseindia.com%2Fcontent%2FRSS%2FOnline_announcements.xml" | head -20
```

### 2. Google Sheet, Calendar and email (Apps Script)

1. New Google Sheet in your account, name it `Nifty 200 Earnings Tracker`.
2. **Extensions > Apps Script**. Delete the sample code, paste all of `apps_script/Code.gs`, save.
   Then **+ (Files) > HTML**, name it exactly `Index` and paste all of `apps_script/Index.html`, save.
3. Left side **Project Settings** (gear) > tick **Show "appsscript.json" manifest file in editor**.
   Back in **Editor**, open `appsscript.json`, replace its content with `apps_script/appsscript.json`, save.
4. Pick function **setup** in the toolbar > **Run**. Approve the permissions
   ("Google hasn't verified this app" > **Advanced** > **Go to ... (unsafe)**, it is your own script).
5. Open **Execution log**. Copy the line `SECRET (put in GitHub as APPS_SCRIPT_SECRET): ...`.
   (Lost it? Run `showConfig`.)
6. In the Sheet, tab **Settings**: type your team's emails in column A from A2 down. They get the digests as BCC.
7. **Deploy > New deployment** > gear > **Web app** > Execute as **Me**, Who has access **Anyone** > Deploy.
   Copy the **Web app URL** (ends in `/exec`). Open it in a browser: that page is what you send your team.
   (Google shows a small grey "created by an Apps Script user" bar on top. That is normal.)
8. Run **selfTest**, refresh the web page: a fake `TESTCO` call appears. Then run **removeTestRows**.
9. **Do not share the Sheet.** The team only needs the web app link.
10. Make the calendar public so the "Subscribe" button works for everyone: Google Calendar > left side,
    hover `Nifty 200 Earnings & Concalls` > **Settings and sharing** > **Access permissions** >
    tick **Make available to public** (leave it on "See all event details"). It only holds public
    exchange information. Without this, the Subscribe button will not work for your team, but the
    "+ My calendar" button on every event still does.
11. **Test on one work PC before announcing:** open the web app link. If it loads, you are done.

> **After every later change to Code.gs or Index.html:** Deploy > Manage deployments > pencil > Version:
> **New version** > Deploy. Without this the `/exec` link keeps serving the old version.

### 3. GitHub

1. New **public** repo, e.g. `nifty200-tracker`.
2. Upload everything from this folder. The hidden `.github/workflows/collect.yml` must be included:
   if drag-and-drop skips it, use **Add file > Create new file**, type the name
   `.github/workflows/collect.yml` and paste the content.
3. **Settings > Secrets and variables > Actions > New repository secret**, add four:

   | Name | Value |
   |---|---|
   | `RELAY_URL` | your Worker URL, no trailing slash |
   | `RELAY_KEY` | the same random string as in step 1 |
   | `APPS_SCRIPT_URL` | the Web app URL ending `/exec` |
   | `APPS_SCRIPT_SECRET` | the SECRET from step 2.5 |

4. **Settings > Actions > General > Workflow permissions** > **Read and write permissions** > Save.
5. **Actions** tab > **collect** > **Run workflow**.

### 4. Check it worked

The run should end green and print a line like `{"items": 800, "relevant": 14, ...}`. Within a minute
the Tracker tab fills with any Nifty 200 company that has filed an earnings-call schedule today.
Then it runs by itself every hour.

If the run fails on the first fetch with HTTP 403 or 5xx, the relay or NSE is blocking. Send me the log.

### 5. Daily life

- **Team**: opens the web app link (Schedule, Companies, What's new), subscribes to the calendar once, and
  gets two emails: 8:30 AM on weekdays (today's concalls and results first, then the next 7 days, plus
  anything announced since the last mail) and 6:30 PM only when something new was announced (with tomorrow's schedule).
- **Nifty 200 changes**: nothing to do, the list is re-downloaded from NSE every run.
- **Add or remove an email**: edit the Settings tab.
- **Collector stuck**: you get an email after 3 hours of silence on weekdays 9:00 to 21:00.

### 6. Maintenance notes (written down because it all lives under your personal login)

- Everything is under your Google account, your Cloudflare account and one public GitHub repo.
  Keep a copy of the four secrets somewhere safe.
- The workflow commits `state/seen.json` when something new is processed. That commit also keeps GitHub
  from auto-disabling the schedule after 60 days of inactivity.
- To change the digest times, edit the trigger lines in `setup()` and run `setup()` again (it rebuilds
  triggers, keeps your data and secret).
- Already ran the first version of this tracker (it had Owner/Status/Notes columns)? Delete the `Tracker`
  tab, set `state/seen.json` in GitHub to `[]`, then run `setup()` again so the sheet refills.

### 7. Helping me finish the board-meeting parser

After the first few days of real runs, open **Actions > a run > Artifacts > samples**. It holds up to five
raw Board Meeting Intimation files. Send me one (or a screenshot of it like you did for Rallis) and I
will make the result-date reading exact.

---

## Known limits

- Column "Stage" is derived: Result date set > Concall scheduled > Call held, awaiting transcript > Post-call filed.
- The quarter is inferred from the meeting month (Oct to Dec = Q2 of next FY, and so on). A call held in an
  unusual month could be labelled with a neighbouring quarter.
- A change of call date or time updates the same row and the calendar event, and emails "Concall UPDATED".
  A cancellation filing is not detected yet.
- Free Gmail sends to about 100 recipients a day. Two digests a day keeps a team of up to ~40 safely inside
  that. Hourly "instant" emails would not (set `INSTANT_EMAIL = true` in Code.gs only if the team is tiny).
- Anyone with the web app link can view it. It only shows public exchange filings.
- The team cannot add notes or status: the page is read-only by design.
- Tests: `python3 -I tests/test_parse.py` (filing parser) and `node tests/test_appsscript.js` (Apps Script
  logic against fake Google services; not the real Google runtime).
