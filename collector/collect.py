"""Nifty 200 earnings-date and concall tracker: collector.

Reads NSE's announcements RSS (via your Cloudflare relay), picks out
  - Schedule of Analysts / Institutional Investors Meet  (earnings call schedule, XBRL)
  - Board Meeting Intimation                              (result date, XBRL, best effort)
  - Con. call updates / audio / transcript                (post-call filings, best effort)
keeps only Nifty 200 symbols, and POSTs the events to the Google Apps Script web app.

Env vars:
  RELAY_URL, RELAY_KEY        Cloudflare relay (optional; direct fetch if RELAY_URL empty)
  APPS_SCRIPT_URL, APPS_SCRIPT_SECRET   Google Apps Script web app + shared secret
Flags:
  --dry-run   do everything except POST and state save; print events
"""
import csv
import io
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parent.parent
NIFTY_FILE = ROOT / "data" / "nifty200.csv"
STATE_FILE = ROOT / "state" / "seen.json"
SAMPLES_DIR = ROOT / "samples"

FEED_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml"
NIFTY_URL = "https://archives.nseindia.com/content/indices/ind_nifty200list.csv"

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://www.nseindia.com/",
}


# ---------------------------------------------------------------- fetching
def fetch(url, retries=3):
    relay = os.environ.get("RELAY_URL", "").rstrip("/")
    last = None
    for attempt in range(retries):
        try:
            if relay:
                r = requests.get(
                    f"{relay}/?url={quote(url, safe='')}",
                    headers={"X-Relay-Key": os.environ.get("RELAY_KEY", "")},
                    timeout=40,
                )
            else:
                r = requests.get(url, headers=BROWSER_HEADERS, timeout=40)
            if r.status_code == 200:
                return r.content.decode("utf-8", errors="replace")
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"fetch failed for {url}: {last}")


# ---------------------------------------------------------------- helpers
def norm_name(s):
    s = (s or "").lower().replace("&", "and")
    s = re.sub(r"\b(limited|ltd|the)\b", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def local(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def norm_date(s):
    """Return YYYY-MM-DD or ''."""
    s = (s or "").strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d %b %Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(s[:11] if fmt == "%d-%b-%Y" else s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    m = re.search(r"\d{4}-\d{2}-\d{2}", s)
    return m.group(0) if m else ""


def norm_time(s):
    m = re.match(r"\s*(\d{1,2}):(\d{2})", s or "")
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def quarter_label(iso_date):
    """Quarter being reported, given the date results/call happen (Indian FY, Apr-Mar)."""
    y, m = int(iso_date[:4]), int(iso_date[5:7])
    if m <= 3:
        return f"Q3FY{y % 100:02d}"
    if m <= 6:
        return f"Q4FY{y % 100:02d}"
    if m <= 9:
        return f"Q1FY{(y + 1) % 100:02d}"
    return f"Q2FY{(y + 1) % 100:02d}"


def feed_date(pub):
    try:
        return datetime.strptime(pub.strip(), "%d-%b-%Y %H:%M:%S").strftime("%Y-%m-%d")
    except ValueError:
        return date.today().isoformat()


# ---------------------------------------------------------------- parsing
def parse_feed(xml_text):
    root = ET.fromstring(xml_text)
    items = []
    for it in root.iter("item"):
        items.append(
            {
                "title": (it.findtext("title") or "").strip(),
                "link": (it.findtext("link") or "").strip(),
                "desc": (it.findtext("description") or "").strip(),
                "pub": (it.findtext("pubDate") or "").strip(),
            }
        )
    return items


def classify(item):
    d = item["desc"].lower()
    if "schedule of analysts or institutional investors meet" in d or "analyst/investor meet" in d:
        return "meet"
    if "board meeting intimation" in d or ("board meeting" in d and "financial result" in d and "outcome" not in d):
        return "board"
    if "con. call updates" in d or "transcript" in d or ("audio" in d and "recording" in d):
        return "post"
    return None


def xbrl_groups(xml_text):
    """{contextRef: {LocalName: text}} for every fact element."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        # some filers leave bare "&" in links; escape them and retry once
        fixed = re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", "&amp;", xml_text)
        root = ET.fromstring(fixed)
    groups = {}
    for el in root.iter():
        ctx = el.attrib.get("contextRef")
        if ctx and el.text and el.text.strip():
            groups.setdefault(ctx, {}).setdefault(local(el.tag), el.text.strip())
    return groups


EARNINGS_WORDS = ("earning", "quarterly", "result", "q1", "q2", "q3", "q4", "financial")


def parse_meet(xml_text, filing_url, filed_on):
    """Earnings-call schedule events from a SAIIM XBRL file."""
    g = xbrl_groups(xml_text)
    main = g.get("MainI", {})
    symbol = main.get("NSESymbol", "").upper()
    company = main.get("NameOfTheCompany", "")
    events = []
    for ctx, f in g.items():
        if ctx == "MainI" or "DateOfMeetingOrCallOrConferenceOrEventForIntimation" not in f:
            continue
        blob = " ".join(
            f.get(k, "")
            for k in (
                "TypeOfMeetingForWhichIntimationIsGiven",
                "DetailsOfOtherTypeOfMeetingOrCallOrConferenceOrEventForIntimation",
                "AgendaOrReasonForMeetingOrCallOrConferenceOrEventForIntimation",
                "NameOfMeetingOrCallOrConferenceOrEventForIntimation",
                "QuarterForWhichEarningsOrQuarterlyCallIsHeldForIntimation",
            )
        ).lower()
        if not any(w in blob for w in EARNINGS_WORDS):
            continue  # ordinary investor meeting, not an earnings call
        mdate = norm_date(f["DateOfMeetingOrCallOrConferenceOrEventForIntimation"])
        if not mdate:
            continue
        link = f.get("WeblinkOfMeetingOrCallOrConferenceOrEventForIntimation", "")
        note = ""
        if not link.lower().startswith("http"):
            extra = " ".join(
                x for x in (link, f.get("AdditionalDetailsOfMeetingOrCallOrConferenceOrEventForIntimation", "")) if x and x.upper() != "NA"
            )
            note = extra.strip()
            link = ""
        events.append(
            {
                "kind": "concall",
                "symbol": symbol,
                "company": company,
                "date": mdate,
                "time": norm_time(f.get("TimeOfCommencementOfMeetingOrCallOrConferenceOrEventForIntimation", "")),
                "mode": f.get("ModeOfMeetingOrCallOrConferenceOrEventForIntimation", ""),
                "link": link,
                "link_note": note,
                "call_name": f.get("NameOfMeetingOrCallOrConferenceOrEventForIntimation", ""),
                "filing_url": filing_url,
                "filed_on": filed_on,
                "quarter": quarter_label(mdate),
            }
        )
    return events


def parse_board(xml_text, filing_url, filed_on):
    """Result-date event from a Board Meeting Intimation XBRL. Schema not yet seen, so be generic."""
    g = xbrl_groups(xml_text)
    flat = {}
    for ctx in g.values():
        for k, v in ctx.items():
            flat.setdefault(k, v)
    symbol = flat.get("NSESymbol", "").upper()
    company = flat.get("NameOfTheCompany", "")
    blob = " ".join(flat.values()).lower()
    if "result" not in blob:
        return symbol, company, []  # board meeting for something else (fund raise, dividend...)
    mdate = ""
    for k, v in flat.items():
        kl = k.lower()
        if "date" in kl and "meeting" in kl and "report" not in kl:
            mdate = norm_date(v)
            if mdate:
                break
    ev = {
        "kind": "result",
        "symbol": symbol,
        "company": company,
        "date": mdate,
        "filing_url": filing_url,
        "filed_on": filed_on,
        "quarter": quarter_label(mdate or filed_on),
    }
    return symbol, company, [ev]


# ---------------------------------------------------------------- state / universe
def load_nifty():
    try:
        text = fetch(NIFTY_URL)
        if "Symbol" in text:
            NIFTY_FILE.parent.mkdir(exist_ok=True)
            NIFTY_FILE.write_text(text, encoding="utf-8")
    except Exception as e:  # fall back to repo copy
        print(f"WARN: could not refresh Nifty 200 list ({e}); using repo copy")
    rows = list(csv.DictReader(io.StringIO(NIFTY_FILE.read_text(encoding="utf-8"))))
    by_symbol, by_name = {}, {}
    for r in rows:
        sym = r["Symbol"].strip().upper()
        info = {"symbol": sym, "company": r["Company Name"].strip(), "industry": r.get("Industry", "").strip()}
        by_symbol[sym] = info
        by_name[norm_name(info["company"])] = info
    return by_symbol, by_name


def load_seen():
    if STATE_FILE.exists():
        return set(json.loads(STATE_FILE.read_text()))
    return set()


def save_seen(seen):
    STATE_FILE.parent.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(sorted(seen)[-20000:], indent=0))


# ---------------------------------------------------------------- main
def collect(items, by_symbol, by_name, seen, fetcher=fetch):
    events, new_seen, stats = [], set(), {"items": len(items), "relevant": 0, "fetched": 0, "errors": 0}
    SAMPLES_DIR.mkdir(exist_ok=True)
    for it in items:
        kind = classify(it)
        if not kind or it["link"] in seen:
            continue
        stats["relevant"] += 1
        filed_on = feed_date(it["pub"])
        link = it["link"]
        try:
            if kind in ("meet", "board") and link.lower().endswith(".xml"):
                xml_text = fetcher(link)
                stats["fetched"] += 1
                if kind == "meet":
                    evs = parse_meet(xml_text, link, filed_on)
                else:
                    sym, comp, evs = parse_board(xml_text, link, filed_on)
                    if len(list(SAMPLES_DIR.glob("board_*.xml"))) < 5:
                        (SAMPLES_DIR / f"board_{len(list(SAMPLES_DIR.glob('board_*.xml')))+1}.xml").write_text(xml_text, encoding="utf-8")
                for ev in evs:
                    info = by_symbol.get(ev["symbol"])
                    if info:
                        ev["company"], ev["industry"] = info["company"], info["industry"]
                        events.append(ev)
            else:
                # PDF or post-call filing: no symbol inside, match on company name
                info = by_name.get(norm_name(it["title"]))
                if info:
                    d = it["desc"].lower()
                    ev = {
                        "kind": "post" if kind == "post" else ("result" if kind == "board" else "concall"),
                        "symbol": info["symbol"],
                        "company": info["company"],
                        "industry": info["industry"],
                        "date": "",
                        "filing_url": link,
                        "filed_on": filed_on,
                        "quarter": quarter_label(filed_on),
                        "post_label": "Transcript" if "transcript" in d else "Audio/Update",
                        "needs_check": True,
                    }
                    events.append(ev)
            new_seen.add(link)
        except Exception as e:
            stats["errors"] += 1
            print(f"WARN: {link}: {e}")  # not marked seen, retried next run
    return events, new_seen, stats


def post_to_sheet(events, stats):
    url, secret = os.environ["APPS_SCRIPT_URL"], os.environ["APPS_SCRIPT_SECRET"]
    r = requests.post(url, json={"secret": secret, "events": events, "stats": stats}, timeout=120)
    r.raise_for_status()
    body = r.json()
    if not body.get("ok"):
        raise RuntimeError(f"Apps Script rejected the post: {body}")
    return body


def main():
    dry = "--dry-run" in sys.argv
    by_symbol, by_name = load_nifty()
    seen = load_seen()
    items = parse_feed(fetch(FEED_URL))
    events, new_seen, stats = collect(items, by_symbol, by_name, seen)
    stats["events"] = len(events)
    print(json.dumps(stats))
    for e in events:
        print(" ", e["kind"], e["symbol"], e.get("quarter"), e.get("date"), e.get("time", ""))
    if dry:
        return
    resp = post_to_sheet(events, stats)
    print("sheet:", resp)
    save_seen(seen | new_seen)


if __name__ == "__main__":
    main()
