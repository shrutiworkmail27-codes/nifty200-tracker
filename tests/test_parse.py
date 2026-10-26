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

# --- real board-meeting files (from the first live run)
for fname, sym, d in (("board_infollion.xml", "INFOLLION", "2026-10-15"), ("board_monolith.xml", "MONOLITH", "2026-10-24")):
    _, _, bev = c.parse_board((FIX / fname).read_text(encoding="utf-8"), "u", "2026-10-12")
    check("real board file " + sym, bev and bev[0]["symbol"] == sym and bev[0]["date"] == d and bev[0]["quarter"] == "Q2FY27")

# --- backfill mapping (API field names are a GUESS: made-up row shaped like NSE's JSON)
api_rows = [
    {"symbol": "RALLIS", "sm_name": "Rallis India Limited", "desc": "Analysts/Institutional Investor Meet/Con. Call Updates",
     "attchmntText": "Rallis India Limited has informed the Exchange about Schedule of Analysts or Institutional Investors Meet",
     "attchmntFile": "https://nsearchives.nseindia.com/corporate/xbrl/SAIIM_1186.xml", "an_dt": "2026-10-09 14:50:47"},
    {"symbol": "SMALLCO", "sm_name": "Small Co", "desc": "Board Meeting Intimation", "attchmntText": "x",
     "attchmntFile": "https://nsearchives.nseindia.com/corporate/xbrl/PIBM_1.xml", "an_dt": "2026-10-08 10:00:00"},
    {"symbol": "RALLIS", "sm_name": "Rallis India Limited", "desc": "Analysts/Institutional Investor Meet/Con. Call Updates",
     "attchmntText": "Transcript of earnings call", "attchmntFile": "https://nsearchives.nseindia.com/corporate/RALLIS_tr.pdf", "an_dt": "2026-10-11 09:00:00"},
]
its = sorted([c.api_item(a) for a in api_rows], key=lambda x: c.parse_pub(x["pub"]))
check("api_item: oldest first, symbol kept", its[0]["symbol"] == "SMALLCO" and its[1]["pub"].startswith("09-Oct-2026"))
check("api: xml investor-meet is classified meet", c.classify(its[1]) == "meet")
calls2 = []
def fake2(url):
    calls2.append(url)
    return RALLIS
ev5, ns5, st5 = c.collect(its, by_symbol, by_name, set(), fetcher=fake2)
check("backfill: Nifty symbol only, SMALLCO skipped w/o fetching", len(calls2) == 1 and "PIBM_1" not in calls2[0])
check("backfill: concall event + post-call event for RALLIS", sorted(e["kind"] for e in ev5) == ["concall", "post"])
check("feed_date handles both formats", c.feed_date("2026-10-09 14:50:47") == "2026-10-09" == c.feed_date("09-Oct-2026 14:50:47"))

# --- index groups and universe payload
n50 = c.read_symbols("Company Name,Industry,Symbol\nA,x,AAA\nB,x,BBB\n")
nn50 = c.read_symbols("Company Name,Industry,Symbol\nC,x,CCC\n")
check("read_symbols", n50 == {"AAA", "BBB"} and nn50 == {"CCC"})
bs = {s: {"symbol": s, "company": s + " Ltd", "industry": "Ind"} for s in ("AAA", "CCC", "DDD")}
c.assign_groups(bs, n50, nn50)
check("groups: Nifty 50 / Next 50 / Midcap", [bs[x]["group"] for x in ("AAA", "CCC", "DDD")] == ["Nifty 50", "Next 50", "Midcap"])
bs2 = {s: {"symbol": s, "company": s, "industry": ""} for s in ("AAA", "DDD")}
c.assign_groups(bs2, n50, set())
check("groups: no Midcap label if Next 50 list is missing", bs2["AAA"]["group"] == "Nifty 50" and bs2["DDD"]["group"] == "")
up = c.universe_payload(bs)
check("universe payload is sorted and short-keyed", [u["s"] for u in up] == ["AAA", "CCC", "DDD"] and set(up[0]) == {"s", "n", "i", "g"})

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
