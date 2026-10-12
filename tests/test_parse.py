"""Run:  python3 -I tests/test_parse.py   (from the repo root)"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))
import collect as c  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
RALLIS = (FIX / "rallis_saiim.xml").read_text(encoding="utf-8")
FEED = (FIX / "feed_sample.xml").read_text(encoding="utf-8")

# a made-up board-meeting file (real schema not seen yet): checks the generic parser only
BOARD = """<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-capmkt="x">
<in-capmkt:NSESymbol contextRef="MainI">ABB</in-capmkt:NSESymbol>
<in-capmkt:NameOfTheCompany contextRef="MainI">ABB India Limited</in-capmkt:NameOfTheCompany>
<in-capmkt:DateOfReport contextRef="MainI">2026-10-09</in-capmkt:DateOfReport>
<in-capmkt:DateOfMeetingOfBoardOfDirectors contextRef="MainI">2026-11-04</in-capmkt:DateOfMeetingOfBoardOfDirectors>
<in-capmkt:PurposeOfMeeting contextRef="MainI">To consider unaudited financial results for the quarter ended September 30, 2026</in-capmkt:PurposeOfMeeting>
</xbrli:xbrl>"""
BOARD_FUND = BOARD.replace("unaudited financial results for the quarter", "fund raising for the period")

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# --- quarter labels (Indian FY)
check("Oct 2026 -> Q2FY27", c.quarter_label("2026-10-23") == "Q2FY27")
check("Jul 2026 -> Q1FY27", c.quarter_label("2026-07-30") == "Q1FY27")
check("Jan 2027 -> Q3FY27", c.quarter_label("2027-01-20") == "Q3FY27")
check("May 2026 -> Q4FY26", c.quarter_label("2026-05-15") == "Q4FY26")

# --- real Rallis concall file
evs = c.parse_meet(RALLIS, "http://x/rallis.xml", "2026-10-09")
check("rallis: one event", len(evs) == 1)
e = evs[0]
check("rallis: symbol RALLIS", e["symbol"] == "RALLIS")
check("rallis: date 2026-10-23", e["date"] == "2026-10-23")
check("rallis: time 11:00", e["time"] == "11:00")
check("rallis: quarter Q2FY27", e["quarter"] == "Q2FY27")
check("rallis: dial-in link kept", e["link"].startswith("https://services.choruscall.in/"))
check("rallis: mode Virtual", e["mode"] == "Virtual")

# --- a non-earnings investor meet must be ignored
NONEARN = (
    RALLIS.replace("Earning/Quarterly Calls", "Group meeting")
    .replace("Earnings Conference Call for second quarter and half year ended September 30, 2026", "Meeting with fund")
    .replace("Q2 Results", "NA")
)
check("non-earnings meet ignored", c.parse_meet(NONEARN, "u", "2026-10-09") == [])

# --- no link given
NOLINK = RALLIS.replace(
    "https://services.choruscall.in/DiamondPassRegistration/register?confirmationNumber=0006133&amp;linkSecurityString=dbb51ec", "Dial 022-1234"
).replace(
    "https://services.choruscall.in/DiamondPassRegistration/register?confirmationNumber=0006133&linkSecurityString=dbb51ec", "Dial 022-1234"
)
ev2 = c.parse_meet(NOLINK, "u", "2026-10-09")
check("no-link: link empty, note kept", ev2 and ev2[0]["link"] == "" and "Dial" in ev2[0]["link_note"])

# --- board parser (synthetic)
sym, comp, bev = c.parse_board(BOARD, "u", "2026-10-09")
check("board: ABB result date 2026-11-04", bev and bev[0]["date"] == "2026-11-04" and bev[0]["quarter"] == "Q2FY27")
check("board: non-results meeting ignored", c.parse_board(BOARD_FUND, "u", "2026-10-09")[2] == [])

# --- real feed: classification and full collect() with fake fetcher
items = c.parse_feed(FEED)
check("feed: 11 items parsed", len(items) == 11)
kinds = [c.classify(i) for i in items]
check("feed: only Rallis classified as meet", kinds.count("meet") == 1 and kinds.count(None) == 10)

by_symbol = {"RALLIS": {"symbol": "RALLIS", "company": "Rallis India Ltd.", "industry": "Chemicals"}}
by_name = {c.norm_name("Rallis India Ltd."): by_symbol["RALLIS"]}
calls = []


def fake(url):
    calls.append(url)
    return RALLIS


events, new_seen, stats = c.collect(items, by_symbol, by_name, set(), fetcher=fake)
check("collect: one event for Rallis", len(events) == 1 and events[0]["symbol"] == "RALLIS")
check("collect: industry attached from Nifty list", events[0]["industry"] == "Chemicals")
check("collect: only the relevant XBRL fetched", len(calls) == 1)

# seen links are skipped on the next run
events2, _, _ = c.collect(items, by_symbol, by_name, new_seen, fetcher=fake)
check("collect: second run skips seen", events2 == [] and len(calls) == 1)

# a symbol outside Nifty 200 is dropped
ev3, _, _ = c.collect(items, {}, {}, set(), fetcher=fake)
check("collect: non-Nifty symbol dropped", ev3 == [])

# fetch failure is not marked seen, so it retries next run
def boom(url):
    raise RuntimeError("down")


ev4, ns4, st4 = c.collect(items, by_symbol, by_name, set(), fetcher=boom)
check("collect: failure retried (not seen)", st4["errors"] == 1 and not ns4)

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
