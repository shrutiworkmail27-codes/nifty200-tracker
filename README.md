# Nifty 200 Earnings & Concall Tracker

Free, automated, no paid APIs, no AI. Watches NSE filings for the Nifty 200. **Your team only gets a
read-only web page, a shared calendar and an optional daily email they sign up for themselves. They never see your Google Sheet.**

```
GitHub Actions (hourly)  -->  Cloudflare relay  -->  NSE archives (RSS + XBRL files)
        |
        +- parses filings, keeps Nifty 200 only
              |
              v
        Google Apps Script (inside your private Sheet)
              +- Tracker tab: one row per company-quarter (only you can see it)
              +- Web app (the link you share): tabs: Overview, Concalls, Results, Calendar, Companies, What's new
              +- Google Calendar: result dates and concall times with dial-in links
              +- Email: opt-in subscribers get an 8:30 AM digest and a 6:30 PM "new today" note
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
6. Nothing to type for email: teammates subscribe themselves on the web page (see "Daily email" below).
   Anyone already listed in an old `Settings` tab is moved to the `Subscribers` tab by `setup()`.
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

- **Team**: opens the web app link, uses the tabs and the left filters (index, sector, "My companies" stars
  saved in their own browser), presses **Subscribe to calendar** once, and optionally types an email into the
  **Daily email** box.
- **Daily email (double opt-in)**: they type their address, get a confirmation mail, open it and press
  **Yes, subscribe me**. Only then do they get mail: 8:30 AM on weekdays (today's concalls and results, then the
  next 7 days) and a 6:30 PM note only when something new was announced. Every mail has its own unsubscribe link
  (also a two-step button, so mail scanners cannot unsubscribe anyone by accident). Limits: 40 subscribers,
  30 confirmation mails a day, one resend per 10 minutes per address, unconfirmed requests expire after 48 hours.
- **Nifty 200 changes**: nothing to do, the list is re-downloaded from NSE every run.
- **Add or remove an email**: people do it themselves. You can also edit the `Subscribers` tab (status `active` or `unsubscribed`).
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

### 8. One-time catch-up (backfill)

After the relay, Apps Script and repo files are updated: **Actions > collect > Run workflow**, set
`backfill_days` to `5`, run. It loads the last 5 days from NSE's date-range API, saves past events without
emailing anyone, and marks them as seen. Hourly runs stay "today only". The run also saves
`samples/backfill_sample.json` (first 3 raw rows) so the real field names can be checked. If the log says
`NSE did not return JSON`, NSE blocked the date-range endpoint: nothing is lost, the page just fills from
the hourly runs. Running the backfill twice is harmless.

---

## Known limits

- Column "Stage" is derived: Result date set > Concall scheduled > Call held, awaiting transcript > Post-call filed.
- The quarter is inferred from the meeting month (Oct to Dec = Q2 of next FY, and so on). A call held in an
  unusual month could be labelled with a neighbouring quarter.
- A change of call date or time updates the same row and the calendar event, and emails "Concall UPDATED".
  A cancellation filing is not detected yet.
- Free Gmail sends about 100 mails a day. Two digests a day to at most 40 subscribers, plus confirmation mails (capped at 30 a day), stays inside that.
- Anyone with the web app link can view it. It only shows public exchange filings.
- The team cannot add notes or status: the page is read-only by design. "My companies" stars live only in each person's browser.
- The Google Fonts files load from the internet; if a work network blocks them the page falls back to system fonts.
- Admin functions (`setup`, `showConfig`, `selfTest`, `removeTestRows`) refuse anyone but you, even though the page is public.
- Tests: `python3 -I tests/test_parse.py` (filing parser) and `node tests/test_appsscript.js` (Apps Script
  logic against fake Google services; not the real Google runtime). `node tests/render_preview.js <folder>`
  builds the page with made-up sample data so you can open `page.html` in a browser and look at it.
