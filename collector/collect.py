"""Nifty 500 earnings-date and concall tracker: collector.

Reads NSE's announcements RSS (via your Cloudflare relay), picks out
  - Schedule of Analysts / Institutional Investors Meet  (earnings call schedule, XBRL)
  - Board Meeting Intimation                              (result date, XBRL, best effort)
  - Con. call updates / audio / transcript                (post-call filings, best effort)
keeps only Nifty 500 symbols, and POSTs the events to the Google Apps Script web app.

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
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parent.parent
NIFTY_FILE = ROOT / "data" / "nifty500.csv"
STATE_FILE = ROOT / "state" / "seen.json"
SAMPLES_DIR = ROOT / "samples"

FEED_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml"
NIFTY_URL = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
INDEX_BASE = "https://archives.nseindia.com/content/indices/"
# index-group lists used for the "Nifty 50 / Next 50 / Midcap" filter on the web page
GROUP_LISTS = {"Nifty 50": "ind_nifty50list.csv", "Next 50": "ind_niftynext50list.csv",
               "Midcap": "ind_niftymidcap150list.csv", "Smallcap": "ind_niftysmallcap250list.csv"}

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


PUB_FORMATS = ("%d-%b-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d-%m-%Y %H:%M:%S")


def parse_pub(pub):
    for fmt in PUB_FORMATS:
        try:
            return datetime.strptime((pub or "").strip()[:19], fmt)
        except ValueError:
            continue
    return None


def feed_date(pub):
    d = parse_pub(pub)
    return d.strftime("%Y-%m-%d") if d else date.today().isoformat()


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


MONTHS = {m: i + 1 for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}
_DATE_PATS = (
    re.compile(r"\bon\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})"),   # on October 23, 2026
    re.compile(r"\bon\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})"),   # on 23rd October 2026
)


def announced_result_date(text):
    """Date from a press-release style notice such as 'Infosys to Announce Second Quarter Results on October 23, 2026'.
    Returns ISO date or ''. Needs both 'announce' and 'result' in the text, so unrelated notices are ignored."""
    t = text or ""
    low = t.lower()
    if "announce" not in low or "result" not in low:
        return ""
    for k, pat in enumerate(_DATE_PATS):
        for m in pat.finditer(t):
            mon, day, yr = (m.group(1), m.group(2), m.group(3)) if k == 0 else (m.group(2), m.group(1), m.group(3))
            mi = MONTHS.get(mon[:3].lower())
            if mi:
                try:
                    return date(int(yr), mi, int(day)).isoformat()
                except ValueError:
                    pass
    return ""


def classify(item):
    d = item["desc"].lower()
    if "outcome" in d and ("financial result" in d or "results for the quarter" in d or "results for the half" in d):
        return "outcome"
    if announced_result_date(item["desc"]):
        return "announce"
    if item["link"].lower().endswith(".xml") and ("investor meet" in d or "investors meet" in d):
        return "meet"
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
def read_symbols(text):
    """Set of NSE symbols in an index-constituents CSV."""
    return {(r.get("Symbol") or "").strip().upper() for r in csv.DictReader(io.StringIO(text)) if r.get("Symbol")}


def assign_groups(by_symbol, n50, next50, mid=frozenset(), small=frozenset()):
    """Tag each company: Nifty 50, Next 50, Midcap (150) or Smallcap (250). Anything not in a list stays
    untagged. Midcap/Smallcap are only used when their list was downloaded."""
    for sym, info in by_symbol.items():
        if sym in n50:
            info["group"] = "Nifty 50"
        elif sym in next50:
            info["group"] = "Next 50"
        elif sym in mid:
            info["group"] = "Midcap"
        elif sym in small:
            info["group"] = "Smallcap"
        else:
            info["group"] = ""


def refresh_list(url, path):
    """Download a CSV into data/; on any failure keep the copy already in the repo. Returns its text or ''."""
    try:
        text = fetch(url)
        if "Symbol" in text:
            path.parent.mkdir(exist_ok=True)
            path.write_text(text, encoding="utf-8")
    except Exception as e:
        print(f"WARN: could not refresh {path.name} ({e}); using repo copy if there is one")
    return path.read_text(encoding="utf-8") if path.exists() else ""


def load_nifty():
    text = refresh_list(NIFTY_URL, NIFTY_FILE)
    rows = list(csv.DictReader(io.StringIO(text)))
    by_symbol, by_name = {}, {}
    for r in rows:
        sym = r["Symbol"].strip().upper()
        info = {"symbol": sym, "company": r["Company Name"].strip(), "industry": r.get("Industry", "").strip(), "group": ""}
        by_symbol[sym] = info
        by_name[norm_name(info["company"])] = info
    groups = {g: read_symbols(refresh_list(INDEX_BASE + f, NIFTY_FILE.parent / f.replace("ind_", "").replace("list", ""))) for g, f in GROUP_LISTS.items()}
    assign_groups(by_symbol, groups["Nifty 50"], groups["Next 50"], groups["Midcap"], groups["Smallcap"])
    return by_symbol, by_name


def universe_payload(by_symbol):
    """The whole tracked universe, sent to the Sheet so the web page can show companies with no schedule yet."""
    return [
        {"s": i["symbol"], "n": i["company"], "i": i["industry"], "g": i.get("group", "")}
        for i in sorted(by_symbol.values(), key=lambda x: x["symbol"])
    ]


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
        if it.get("symbol") and it["symbol"] not in by_symbol:
            continue  # backfill items carry a symbol: skip non-Nifty-200 before fetching anything
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
            elif kind in ("outcome", "announce"):
                # no structured file: the date comes from the announcement text (announce) or is the filing day (outcome)
                info = by_symbol.get(it.get("symbol", "")) or by_name.get(norm_name(it["title"]))
                if info:
                    when = announced_result_date(it["desc"]) if kind == "announce" else filed_on
                    events.append({
                        "kind": "result", "symbol": info["symbol"], "company": info["company"], "industry": info["industry"],
                        "date": when, "filing_url": link, "filed_on": filed_on, "quarter": quarter_label(when),
                    })
            else:
                # PDF or post-call filing: no symbol inside, match on company name
                info = by_symbol.get(it.get("symbol", "")) or by_name.get(norm_name(it["title"]))
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


def api_item(a):
    """Map one NSE corporate-announcements API row to the same shape as an RSS item.
    Field names are from memory, so several spellings are tried; backfill_sample.json shows the real ones."""
    def g(*keys):
        for k in keys:
            v = a.get(k)
            if v not in (None, ""):
                return str(v).strip()
        return ""

    name = g("sm_name", "companyName", "comp_name", "name")
    cat = g("desc", "subject", "category")
    text = g("attchmntText", "attchmnttext", "body", "text")
    pub = parse_pub(g("an_dt", "sort_date", "dt", "exchdisstime"))
    return {
        "title": name,
        "link": g("attchmntFile", "attchmntfile", "attachment", "file"),
        "desc": f"{name} has informed the Exchange about {cat} |SUBJECT: {text}",
        "pub": pub.strftime("%d-%b-%Y %H:%M:%S") if pub else "",
        "symbol": g("symbol").upper(),
    }


def fetch_backfill(days):
    """Announcements of the last `days` days (plus today), oldest first, via NSE's date-range API."""
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    out = []
    for n in range(days, -1, -1):
        ds = (today - timedelta(days=n)).strftime("%d-%m-%Y")
        text = fetch(f"https://www.nseindia.com/api/corporate-announcements?index=equities&from_date={ds}&to_date={ds}")
        try:
            data = json.loads(text)
        except ValueError:
            raise RuntimeError(f"NSE did not return JSON for {ds} (blocked or cookie step failed): {text[:150]!r}")
        rows = data if isinstance(data, list) else data.get("data", [])
        print(f"backfill {ds}: {len(rows)} announcements")
        if rows and not (SAMPLES_DIR / "backfill_sample.json").exists():
            SAMPLES_DIR.mkdir(exist_ok=True)
            (SAMPLES_DIR / "backfill_sample.json").write_text(json.dumps(rows[:3], indent=1))
        for a in rows:
            it = api_item(a)
            if it["link"]:
                out.append(it)
        time.sleep(1)
    out.sort(key=lambda it: parse_pub(it["pub"]) or datetime.min)
    return out


def post_to_sheet(events, stats, backfill=False, universe=None):
    url, secret = os.environ["APPS_SCRIPT_URL"], os.environ["APPS_SCRIPT_SECRET"]
    body = {"secret": secret, "events": events, "stats": stats, "backfill": backfill}
    if universe:
        body["universe"] = universe
    r = requests.post(url, json=body, timeout=180)
    r.raise_for_status()
    body = r.json()
    if not body.get("ok"):
        raise RuntimeError(f"Apps Script rejected the post: {body}")
    return body


def main():
    dry = "--dry-run" in sys.argv
    days = int(os.environ.get("BACKFILL_DAYS") or 0)
    if "--backfill" in sys.argv:
        days = int(sys.argv[sys.argv.index("--backfill") + 1])
    by_symbol, by_name = load_nifty()
    seen = load_seen()
    items = fetch_backfill(days) if days else parse_feed(fetch(FEED_URL))
    events, new_seen, stats = collect(items, by_symbol, by_name, seen)
    stats["events"] = len(events)
    stats["backfill_days"] = days
    uni = universe_payload(by_symbol)
    stats["universe"] = len(uni)
    print(json.dumps(stats))
    for e in events:
        print(" ", e["kind"], e["symbol"], e.get("quarter"), e.get("date"), e.get("time", ""))
    if dry:
        return
    if days:
        # small batches: each event may create a calendar entry, and one request has a time limit
        for i in range(0, max(len(events), 1), 25):
            print("sheet:", post_to_sheet(events[i:i + 25], stats, backfill=True, universe=uni if i == 0 else None))
    else:
        print("sheet:", post_to_sheet(events, stats, universe=uni))
    save_seen(seen | new_seen)


if __name__ == "__main__":
    main()
