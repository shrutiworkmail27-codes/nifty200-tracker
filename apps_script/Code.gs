/**
 * Nifty 200 Earnings & Concall Tracker: Google Apps Script (bound to the Sheet).
 *
 * The GitHub collector POSTs events here. This script:
 *   - keeps one row per company-quarter on the "Tracker" tab (nobody else edits it)
 *   - keeps the Nifty 200 list on the "Universe" tab (sent by the collector)
 *   - creates/updates events on a Google Calendar
 *   - logs every change on the "Alerts" tab
 *   - lets team members subscribe to the daily mail from the web page (double opt-in: they must click
 *     a confirmation link) and sends the digests: weekday 8:30 AM and 6:30 PM "new today"
 *   - serves the read-only team web app (Index.html) from the same /exec URL
 *   - warns the owner if the collector goes quiet
 *
 * First time: run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). See README.
 *
 * SECURITY NOTE: in an Apps Script web app, every function whose name does NOT end in "_" can be called
 * by anyone who has the page open (google.script.run). So the only public functions are:
 *   - subscribeEmail            (meant to be public, rate limited)
 *   - morningDigest/eveningDigest/checkHeartbeat   (triggers; guarded so repeat calls do nothing)
 *   - setup/showConfig/selfTest/removeTestRows/testMorningToMe/testEveningToMe   (owner-only guard)
 * Everything else ends in "_".
 */

const TZ = 'Asia/Kolkata';
const SHEET = 'Tracker';
const ALERTS = 'Alerts';
const SETTINGS = 'Settings'; // legacy: old team-email list, imported into Subscribers by setup()
const SUBS = 'Subscribers';
const UNIVERSE = 'Universe';

// Free Gmail can send about 100 mails a day. Each subscriber gets their own mail (so each has their own
// unsubscribe link): 40 people x 2 digests = 80, leaving room for confirmation mails.
const MAX_SUBSCRIBERS = 40;
const CONFIRM_TTL_MS = 48 * 3600000; // confirmation link valid for 48 hours
const RESEND_MS = 10 * 60000;        // same address can ask for a new confirmation mail every 10 minutes
const CONFIRM_MAILS_PER_DAY = 30;    // cap on confirmation mails, so the form cannot be used to spam
const ALERT_MAX_AGE_H = 40;          // digests only list changes from the last 40 hours
const MAIL_RESERVE = 5;              // digests stop when this many mails are left, so confirmation mails still work

const NCOL = 18;
// 0-based column positions on the Tracker tab
const C = {
  KEY: 0, SYMBOL: 1, COMPANY: 2, INDUSTRY: 3, QUARTER: 4,
  RES_DATE: 5, RES_FILING: 6, CC_DATE: 7, CC_TIME: 8, MODE: 9, LINK: 10,
  CALLNAME: 11, CC_FILING: 12, POST: 13, STAGE: 14, UPDATED: 15,
  RES_EID: 16, CC_EID: 17, // hidden calendar event ids
};
const HEADERS = [
  'Key', 'Symbol', 'Company', 'Industry', 'Quarter',
  'Result Date', 'Result Filing', 'Concall Date', 'Concall Time (IST)', 'Mode', 'Dial-in / Registration',
  'Call Name', 'Concall Filing', 'Post-call Filing', 'Stage', 'Last Updated',
  'ResultEventId', 'ConcallEventId',
];
const ALERT_HEADERS = ['When', 'Symbol', 'Company', 'Quarter', 'What changed', 'Link', 'Emailed'];
const SUB_HEADERS = ['Email', 'Status', 'Token', 'Requested', 'Confirmed', 'Unsubscribed', 'RequestedMs'];
const SC = { EMAIL: 0, STATUS: 1, TOKEN: 2, REQ: 3, CONF: 4, UNSUB: 5, REQMS: 6 };
const NSUB = 7;

// ------------------------------------------------------------------ web app
function doGet(e) {
  saveWebAppUrl_();
  const p = (e && e.parameter) || {};
  if (p.ping) return ContentService.createTextOutput('Nifty 200 tracker receiver is running.');
  // Mail scanners (Outlook Safe Links and similar) open every link in a mail. So the link in the mail only
  // shows a button; nothing changes until the person clicks it (go=1).
  if (p.a === 'confirm' || p.a === 'unsub') {
    const confirming = p.a === 'confirm';
    if (!/^[a-f0-9]{32}$/.test(String(p.t || ''))) {
      return resultPage_(confirming ? 'Could not confirm' : 'Could not unsubscribe', 'This link is not valid.', false);
    }
    if (p.go !== '1') {
      return resultPage_(confirming ? 'Confirm your subscription' : 'Unsubscribe from the daily mail?',
        confirming ? 'One click and the Nifty 200 daily mail starts.' : 'You will stop getting the daily mail.',
        true, { label: confirming ? 'Yes, subscribe me' : 'Yes, unsubscribe me', href: webAppUrl_() + '?a=' + p.a + '&t=' + p.t + '&go=1' });
    }
    const r = withLock_(function () { return confirming ? confirmToken_(p.t) : unsubscribeToken_(p.t); });
    if (confirming) return resultPage_(r.ok ? 'You are subscribed' : 'Could not confirm', r.msg, r.ok);
    return resultPage_(r.ok ? 'You are unsubscribed' : 'Could not unsubscribe', r.msg, r.ok);
  }
  try {
    const t = HtmlService.createTemplateFromFile('Index');
    // "<" is escaped so no filing text can close the script tag
    t.payload = JSON.stringify(getPayload_()).replace(/</g, '\\u003c');
    return t.evaluate()
      .setTitle('Nifty 200 Earnings & Concalls')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput('<p>Tracker is not ready yet: ' + esc_(String(err)) + '</p>');
  }
}

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad json' });
  }
  if (!body.secret || body.secret !== props.getProperty('SECRET')) {
    return json_({ ok: false, error: 'bad secret' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    props.setProperty('LAST_POST', String(Date.now()));
    saveWebAppUrl_();
    if (body.universe) saveUniverse_(body.universe);
    const events = body.events || [];
    const alerts = processEvents_(events);
    logAlerts_(alerts, body.backfill === true); // backfill: logged as already emailed, no flood of mails
    return json_({ ok: true, received: events.length, alerts: alerts.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, msg: 'The tracker is busy. Please try again in a minute.' };
  try {
    return fn();
  } catch (err) {
    console.error(err);
    return { ok: false, msg: 'Something went wrong. Please try again later.' };
  } finally {
    lock.releaseLock();
  }
}

function saveWebAppUrl_() {
  try {
    const u = ScriptApp.getService().getUrl();
    if (u) PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', u);
  } catch (err) { /* not deployed yet */ }
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
}

/** Owner-only guard for admin functions: a page visitor has no active-user email, the owner in the editor does. */
function assertOwner_() {
  const a = Session.getActiveUser().getEmail();
  if (!a || a !== Session.getEffectiveUser().getEmail()) throw new Error('Owner only.');
}

/** Everything the web page needs, as plain JSON. */
function getPayload_() {
  const props = PropertiesService.getScriptProperties();
  const today = today_();
  const ss = SpreadsheetApp.getActive();
  const rows = [];
  const sh = ss.getSheetByName(SHEET);
  const n = sh ? lastDataRow_(sh) : 1;
  if (n > 1) {
    sh.getRange(2, 1, n - 1, NCOL).getValues().forEach(function (r) {
      if (!r[C.KEY]) return;
      r[C.RES_DATE] = iso_(r[C.RES_DATE]);
      r[C.CC_DATE] = iso_(r[C.CC_DATE]);
      r[C.CC_TIME] = time_(r[C.CC_TIME]);
      rows.push({
        s: r[C.SYMBOL], n: r[C.COMPANY], i: r[C.INDUSTRY], q: r[C.QUARTER],
        rd: r[C.RES_DATE], rf: r[C.RES_FILING], cd: r[C.CC_DATE], ct: r[C.CC_TIME],
        m: r[C.MODE], l: r[C.LINK], cn: r[C.CALLNAME], cf: r[C.CC_FILING], p: r[C.POST],
        st: stage_(r, today),
      });
    });
  }
  const recent = [];
  const al = ss.getSheetByName(ALERTS);
  if (al && al.getLastRow() > 1) {
    const from = Math.max(2, al.getLastRow() - 59);
    al.getRange(from, 1, al.getLastRow() - from + 1, 7).getValues().reverse().forEach(function (r) {
      recent.push({ w: whenStr_(r[0]), s: r[1], n: r[2], q: r[3], t: r[4], l: r[5] });
    });
  }
  const lastPost = Number(props.getProperty('LAST_POST') || 0);
  const subs = ss.getSheetByName(SUBS) ? readSubs_().rows : [];
  return {
    rows: rows,
    recent: recent,
    universe: readUniverse_(),
    calId: props.getProperty('CAL_ID') || '',
    checked: lastPost ? Utilities.formatDate(new Date(lastPost), TZ, 'dd MMM, HH:mm') : '',
    full: subs.filter(function (r) { return r[SC.STATUS] === 'active'; }).length >= MAX_SUBSCRIBERS,
  };
}

// ------------------------------------------------------------------ helpers
function iso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '');
}
function time_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  return String(v || '');
}
/** "2026-10-13 10:04" whether Sheets kept it as text or turned it into a date. */
function whenStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
  return String(v || '');
}
function whenMs_(v) {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v || '').replace(' ', 'T') + ':00+05:30').getTime();
  return isNaN(t) ? 0 : t;
}
function toDate_(isoStr) {
  if (!isoStr) return '';
  const p = isoStr.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function pretty_(isoStr) {
  return isoStr ? Utilities.formatDate(new Date(isoStr + 'T00:00:00+05:30'), TZ, 'EEE d MMM yyyy') : '';
}
function today_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}
function addDays_(isoStr, n) {
  const d = toDate_(isoStr);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeUrl_(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
}
function hash_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return String(h);
}

/** Last row that really holds data (column A, the hidden key). getLastRow() is not used for this. */
function lastDataRow_(sh) {
  const v = sh.getRange(1, 1, sh.getMaxRows(), 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (v[i][0] !== '') return i + 1;
  return 1;
}
function ensureRows_(sh, upto) {
  if (sh.getMaxRows() < upto) sh.insertRowsAfter(sh.getMaxRows(), upto - sh.getMaxRows() + 200);
}

function stage_(r, today) {
  if (r[C.POST]) return 'Post-call filed';
  if (r[C.CC_DATE]) return r[C.CC_DATE] < today ? 'Call held, awaiting transcript' : 'Concall scheduled';
  if (r[C.RES_DATE]) return r[C.RES_DATE] < today ? 'Results out' : 'Result date set';
  return 'Filing seen, check it';
}

function rowOut_(r) {
  const o = r.slice(0, NCOL);
  o[C.RES_DATE] = toDate_(o[C.RES_DATE]);
  o[C.CC_DATE] = toDate_(o[C.CC_DATE]);
  return o;
}

// ------------------------------------------------------------------ universe (the Nifty 200 list)
function saveUniverse_(list) {
  if (!Array.isArray(list)) return false;
  const clean = list.map(function (u) {
    return [String(u.s || '').toUpperCase(), String(u.n || ''), String(u.i || ''), String(u.g || '')];
  }).filter(function (r) { return /^[A-Z0-9&\-]{1,20}$/.test(r[0]); });
  if (clean.length < 50) return false; // a failed download falls back to a tiny sample: never overwrite with that
  const sig = hash_(JSON.stringify(clean));
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('UNIV_SIG') === sig) return false;
  const sh = sheetOrThrow_(UNIVERSE);
  ensureRows_(sh, clean.length + 1);
  sh.getRange(2, 1, sh.getMaxRows() - 1, 4).clearContent();
  sh.getRange(2, 1, clean.length, 4).setValues(clean);
  props.setProperty('UNIV_SIG', sig);
  return true;
}

function readUniverse_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(UNIVERSE);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) { return { s: String(r[0]), n: String(r[1]), i: String(r[2]), g: String(r[3]) }; });
}

// ------------------------------------------------------------------ core upsert
function processEvents_(events) {
  if (!events.length) return [];
  const sh = sheetOrThrow_(SHEET);
  const last = lastDataRow_(sh);
  const rows = (last > 1 ? sh.getRange(2, 1, last - 1, NCOL).getValues() : []).map(function (r) {
    r[C.RES_DATE] = iso_(r[C.RES_DATE]);
    r[C.CC_DATE] = iso_(r[C.CC_DATE]);
    r[C.CC_TIME] = time_(r[C.CC_TIME]);
    return r;
  });
  const existing = rows.length;
  const idx = {};
  rows.forEach(function (r, i) { if (r[C.KEY]) idx[r[C.KEY]] = i; });

  const today = today_();
  const touched = {};
  const alerts = [];

  events.forEach(function (ev) {
    if (!ev.symbol || !ev.quarter) return;
    const key = ev.symbol + '|' + ev.quarter;
    let i = idx[key];
    let isNew = false;
    if (i === undefined) {
      const blank = new Array(NCOL).fill('');
      blank[C.KEY] = key;
      blank[C.SYMBOL] = ev.symbol;
      blank[C.COMPANY] = ev.company || ev.symbol;
      blank[C.INDUSTRY] = ev.industry || '';
      blank[C.QUARTER] = ev.quarter;
      rows.push(blank);
      i = rows.length - 1;
      idx[key] = i;
      isNew = true;
    }
    const r = rows[i];
    const before = r.slice();
    let msg = '';

    if (ev.kind === 'concall') {
      if (ev.date) {
        r[C.CC_DATE] = ev.date;
        r[C.CC_TIME] = ev.time || r[C.CC_TIME] || '';
        r[C.MODE] = ev.mode || r[C.MODE] || '';
        r[C.CALLNAME] = ev.call_name || r[C.CALLNAME] || '';
        if (ev.link) r[C.LINK] = ev.link;
        else if (!r[C.LINK]) r[C.LINK] = ev.link_note ? '(no link) ' + ev.link_note : '(no link given, check filing)';
        r[C.CC_FILING] = ev.filing_url || r[C.CC_FILING];
        if (isNew || before[C.CC_DATE] !== r[C.CC_DATE] || before[C.CC_TIME] !== r[C.CC_TIME] || before[C.LINK] !== r[C.LINK]) {
          msg = (!before[C.CC_DATE] ? 'Concall scheduled: ' : 'Concall UPDATED: ') +
            pretty_(r[C.CC_DATE]) + (r[C.CC_TIME] ? ' ' + r[C.CC_TIME] + ' IST' : '');
        }
      } else {
        r[C.CC_FILING] = ev.filing_url || r[C.CC_FILING];
        if (before[C.CC_FILING] !== r[C.CC_FILING]) msg = 'Concall schedule filed (PDF, open the filing for date/time)';
      }
    } else if (ev.kind === 'result') {
      r[C.RES_FILING] = ev.filing_url || r[C.RES_FILING];
      if (ev.date) {
        r[C.RES_DATE] = ev.date;
        if (isNew || before[C.RES_DATE] !== r[C.RES_DATE]) {
          msg = (!before[C.RES_DATE] ? 'Result date: ' : 'Result date CHANGED: ') + pretty_(r[C.RES_DATE]);
        }
      } else if (before[C.RES_FILING] !== r[C.RES_FILING]) {
        msg = 'Board meeting filed (open the filing for the result date)';
      }
    } else if (ev.kind === 'post') {
      r[C.POST] = ev.filing_url || r[C.POST];
      if (before[C.POST] !== r[C.POST]) msg = (ev.post_label || 'Post-call') + ' filing available';
    }

    r[C.STAGE] = stage_(r, today);
    if (isNew || msg) {
      r[C.UPDATED] = Utilities.formatDate(new Date(), TZ, 'dd-MMM HH:mm');
      touched[i] = true;
    }
    if (msg) {
      alerts.push({
        symbol: r[C.SYMBOL], company: r[C.COMPANY], quarter: r[C.QUARTER], text: msg,
        link: ev.kind === 'concall' && String(r[C.LINK]).indexOf('http') === 0 ? r[C.LINK] : (ev.filing_url || ''),
      });
      try {
        syncCalendar_(r);
      } catch (err) {
        console.error('calendar sync failed for ' + key + ': ' + err); // sheet row is still written
      }
    }
  });

  Object.keys(touched).map(Number).sort(function (a, b) { return a - b; }).forEach(function (i) {
    if (i < existing) sh.getRange(i + 2, 1, 1, NCOL).setValues([rowOut_(rows[i])]);
  });
  if (rows.length > existing) {
    const block = rows.slice(existing).map(rowOut_);
    ensureRows_(sh, last + block.length);
    sh.getRange(last + 1, 1, block.length, NCOL).setValues(block);
  }
  return alerts;
}

function logAlerts_(alerts, alreadySent) {
  if (!alerts.length) return;
  const sh = sheetOrThrow_(ALERTS);
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const out = alerts.map(function (a) { return [now, a.symbol, a.company, a.quarter, a.text, a.link, alreadySent ? 'Y' : '']; });
  const start = sh.getLastRow() + 1;
  ensureRows_(sh, start + out.length);
  sh.getRange(start, 1, out.length, 7).setValues(out);
}

// ------------------------------------------------------------------ calendar
function calendar_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CAL_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar('Nifty 200 Earnings & Concalls', { timeZone: TZ });
    props.setProperty('CAL_ID', cal.getId());
  }
  return cal;
}

function syncCalendar_(r) {
  const cal = calendar_();
  const today = today_();
  const title = r[C.SYMBOL] + ' ' + r[C.QUARTER];

  if (r[C.RES_DATE] && r[C.RES_DATE] >= today) {
    deleteEvent_(cal, r[C.RES_EID]);
    const ev = cal.createAllDayEvent('Results: ' + title + ' (' + r[C.COMPANY] + ')', toDate_(r[C.RES_DATE]), {
      description: 'Board meeting for results.\n' + (r[C.RES_FILING] || ''),
    });
    r[C.RES_EID] = ev.getId();
  }
  if (r[C.CC_DATE] && r[C.CC_DATE] >= today) {
    deleteEvent_(cal, r[C.CC_EID]);
    const desc = 'Dial-in / registration:\n' + (r[C.LINK] || 'not given') + '\n\nFiling:\n' + (r[C.CC_FILING] || '') + '\n\n' + (r[C.CALLNAME] || '');
    const name = 'Concall: ' + title + ' (' + r[C.COMPANY] + ')';
    let ev;
    if (r[C.CC_TIME]) {
      const start = new Date(r[C.CC_DATE] + 'T' + r[C.CC_TIME] + ':00+05:30');
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      ev = cal.createEvent(name, start, end, { description: desc, location: safeUrl_(r[C.LINK]) });
    } else {
      ev = cal.createAllDayEvent(name, toDate_(r[C.CC_DATE]), { description: desc });
    }
    r[C.CC_EID] = ev.getId();
  }
}

function deleteEvent_(cal, id) {
  if (!id) return;
  try {
    const e = cal.getEventById(id);
    if (e) e.deleteEvent();
  } catch (err) { /* already gone */ }
}

// ------------------------------------------------------------------ email subscriptions (double opt-in)
function readSubs_() {
  const sh = sheetOrThrow_(SUBS);
  const last = sh.getLastRow();
  return { sh: sh, rows: last > 1 ? sh.getRange(2, 1, last - 1, NSUB).getValues() : [] };
}
function writeSubRow_(sh, i, row) {
  sh.getRange(i + 2, 1, 1, NSUB).setValues([row]);
}
function appendSubRow_(sh, row) {
  const at = sh.getLastRow() + 1;
  ensureRows_(sh, at);
  sh.getRange(at, 1, 1, NSUB).setValues([row]);
}
function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
}
function nowStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
}

/**
 * Called from the web page. Public on purpose; it only ever (a) records a "pending" address and
 * (b) mails a confirmation link to that address. Nothing is subscribed until the link is clicked.
 */
function subscribeEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]{2,}$/.test(email)) {
    return { ok: false, msg: 'Please enter a valid email address.' };
  }
  return withLock_(function () { return subscribe_(email); });
}

function subscribe_(email) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const d = readSubs_();
  let idx = -1;
  d.rows.forEach(function (r, i) { if (String(r[SC.EMAIL]).trim().toLowerCase() === email) idx = i; });

  if (idx >= 0) {
    const r = d.rows[idx];
    if (r[SC.STATUS] === 'active') {
      return { ok: true, state: 'already', msg: 'You are already subscribed. Look for the mail at 8:30 AM on weekdays.' };
    }
    if (r[SC.STATUS] === 'pending' && now - Number(r[SC.REQMS] || 0) < RESEND_MS) {
      return { ok: true, state: 'wait', msg: 'We just sent you a confirmation mail. Check your inbox and spam folder.' };
    }
  }
  const active = d.rows.filter(function (r) { return r[SC.STATUS] === 'active'; }).length;
  if (active >= MAX_SUBSCRIBERS) {
    return { ok: false, msg: 'The subscriber list is full right now. Please ask the tracker owner.' };
  }
  const day = today_();
  const sent = props.getProperty('CONF_DAY') === day ? Number(props.getProperty('CONF_COUNT') || 0) : 0;
  if (sent >= CONFIRM_MAILS_PER_DAY || MailApp.getRemainingDailyQuota() < 2) {
    return { ok: false, msg: 'Too many sign-ups today. Please try again tomorrow.' };
  }
  const base = webAppUrl_() || ScriptApp.getService().getUrl();
  if (!base) return { ok: false, msg: 'The tracker is not deployed yet.' };

  const token = newToken_();
  const row = [email, 'pending', token, nowStr_(), '', '', now];
  if (idx >= 0) writeSubRow_(d.sh, idx, row); else appendSubRow_(d.sh, row);

  const link = base + '?a=confirm&t=' + token;
  MailApp.sendEmail({
    to: email,
    subject: 'Confirm your Nifty 200 tracker daily mail',
    name: 'Nifty 200 Tracker',
    htmlBody:
      '<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f1b3d;max-width:480px">' +
      '<h2 style="margin:0 0 8px">One click to confirm</h2>' +
      '<p style="color:#4a5675;line-height:1.5">Someone (hopefully you) asked for the Nifty 200 earnings and concall mail. ' +
      'You will get today\'s schedule on weekdays at 8:30 AM, and a 6:30 PM mail when something new is announced.</p>' +
      '<p><a href="' + esc_(link) + '" style="display:inline-block;background:#3b4cff;color:#fff;text-decoration:none;' +
      'font-weight:600;padding:11px 20px;border-radius:10px">Confirm subscription</a></p>' +
      '<p style="color:#7d88a3;font-size:12px">The link works for 48 hours. If this was not you, just ignore this mail and nothing will happen.</p></div>',
  });
  props.setProperty('CONF_DAY', day);
  props.setProperty('CONF_COUNT', String(sent + 1));
  return { ok: true, state: 'sent', msg: 'Almost done. We sent a confirmation mail to ' + email + '. Click the link in it to start the daily mail (check spam if you do not see it).' };
}

function confirmToken_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, msg: 'This link is not valid.' };
  const d = readSubs_();
  let idx = -1;
  d.rows.forEach(function (r, i) { if (r[SC.TOKEN] === token) idx = i; });
  if (idx < 0) return { ok: false, msg: 'This link is not valid. Subscribe again from the tracker page.' };
  const r = d.rows[idx];
  if (r[SC.STATUS] === 'active') return { ok: true, msg: 'You were already subscribed. Nothing more to do.' };
  if (r[SC.STATUS] !== 'pending') return { ok: false, msg: 'This link is no longer valid. Subscribe again from the tracker page.' };
  if (Date.now() - Number(r[SC.REQMS] || 0) > CONFIRM_TTL_MS) {
    return { ok: false, msg: 'This link has expired. Subscribe again from the tracker page to get a new one.' };
  }
  const active = d.rows.filter(function (x) { return x[SC.STATUS] === 'active'; }).length;
  if (active >= MAX_SUBSCRIBERS) return { ok: false, msg: 'The subscriber list is full right now. Please ask the tracker owner.' };
  r[SC.STATUS] = 'active';
  r[SC.CONF] = nowStr_();
  writeSubRow_(d.sh, idx, r);
  return { ok: true, msg: 'You will get the schedule on weekdays at 8:30 AM, plus a 6:30 PM mail when something new is announced. Every mail has an unsubscribe link.' };
}

function unsubscribeToken_(token) {
  token = String(token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, msg: 'This link is not valid.' };
  const d = readSubs_();
  let idx = -1;
  d.rows.forEach(function (r, i) { if (r[SC.TOKEN] === token) idx = i; });
  if (idx < 0) return { ok: false, msg: 'This link is not valid.' };
  const r = d.rows[idx];
  if (r[SC.STATUS] !== 'unsubscribed') {
    r[SC.STATUS] = 'unsubscribed';
    r[SC.UNSUB] = nowStr_();
    writeSubRow_(d.sh, idx, r);
  }
  return { ok: true, msg: 'You will not get any more mails. You can subscribe again any time from the tracker page.' };
}

function resultPage_(title, msg, ok, action) {
  const u = webAppUrl_();
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<base target="_top"><title>' + esc_(title) + '</title></head>' +
    '<body style="margin:0;background:#f5f7fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f1b3d">' +
    '<div style="max-width:460px;margin:12vh auto;padding:0 20px"><div style="background:#fff;border:1px solid #e3e8f2;border-radius:16px;padding:32px;text-align:center;box-shadow:0 8px 30px rgba(15,27,61,.08)">' +
    '<div style="width:56px;height:56px;border-radius:50%;margin:0 auto 14px;line-height:56px;font-size:28px;background:' + (ok ? '#e2f6ea' : '#fde8e8') + ';color:' + (ok ? '#0b6b38' : '#b42318') + '">' + (ok ? '&#10003;' : '!') + '</div>' +
    '<h1 style="font-size:22px;margin:0 0 8px">' + esc_(title) + '</h1>' +
    '<p style="margin:0 0 22px;color:#4a5675;line-height:1.5">' + esc_(msg) + '</p>' +
    (action ? '<a href="' + esc_(action.href) + '" style="display:inline-block;background:#3b4cff;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">' + esc_(action.label) + '</a>'
      : (u ? '<a href="' + esc_(u) + '" style="display:inline-block;background:#3b4cff;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">Open the tracker</a>' : '')) +
    '</div></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Active subscribers; rows added by hand (no token yet) get one here. */
function activeSubscribers_() {
  const d = readSubs_();
  const out = [];
  d.rows.forEach(function (r, i) {
    if (r[SC.STATUS] !== 'active') return;
    const email = String(r[SC.EMAIL]).trim();
    if (email.indexOf('@') < 1) return;
    if (!/^[a-f0-9]{32}$/.test(String(r[SC.TOKEN]))) {
      r[SC.TOKEN] = newToken_();
      writeSubRow_(d.sh, i, r);
    }
    out.push({ email: email, token: r[SC.TOKEN] });
  });
  return out;
}

function unsubFooter_(sub) {
  const u = webAppUrl_();
  return '<p style="color:#7d88a3;font-size:12px;margin-top:18px">You get this because you subscribed on the tracker page.' +
    (u && sub.token ? ' <a href="' + esc_(u + '?a=unsub&t=' + sub.token) + '">Unsubscribe</a>' : '') + '</p>';
}

/** One mail per subscriber so each has a personal unsubscribe link. Returns how many were sent. */
function sendToSubscribers_(subject, html, onlyOwner) {
  const subs = onlyOwner ? [{ email: Session.getEffectiveUser().getEmail(), token: '' }] : activeSubscribers_();
  let sent = 0;
  subs.forEach(function (s) {
    if (MailApp.getRemainingDailyQuota() <= MAIL_RESERVE) return; // keep a few for confirmation mails
    try {
      MailApp.sendEmail({ to: s.email, subject: subject, htmlBody: html + unsubFooter_(s), name: 'Nifty 200 Tracker' });
      sent++;
    } catch (err) {
      console.error('mail to subscriber failed: ' + err);
    }
  });
  return sent;
}

function itemsHtml_(items, withDate) {
  let h = '<table cellpadding="5" style="border-collapse:collapse;font-size:14px">';
  items.forEach(function (x) {
    h += '<tr style="border-top:1px solid #ddd">' +
      (withDate ? '<td>' + esc_(pretty_(x.d)) + '</td>' : '') +
      '<td>' + esc_(x.t ? x.t + ' IST' : (x.kind === 'Results' ? 'all day' : 'time n/a')) + '</td>' +
      '<td><b>' + esc_(x.symbol) + '</b> <span style="color:#666">' + esc_(x.company) + '</span></td>' +
      '<td>' + esc_(x.kind) + (x.link ? ' &middot; <a href="' + esc_(x.link) + '">join</a>' : '') + '</td></tr>';
  });
  return h + '</table>';
}

function alertsHtml_(list) {
  let h = '<p><b>Announced since the last mail</b></p><table cellpadding="5" style="border-collapse:collapse;font-size:14px">';
  list.forEach(function (a) {
    const l = safeUrl_(a.link);
    h += '<tr style="border-top:1px solid #ddd"><td><b>' + esc_(a.symbol) + '</b><br><span style="color:#666;font-size:12px">' +
      esc_(a.company) + ' ' + esc_(a.quarter) + '</span></td><td>' + esc_(a.text) +
      (l ? '<br><a href="' + esc_(l) + '">open</a>' : '') + '</td></tr>';
  });
  return h + '</table>';
}

function footerHtml_() {
  const u = webAppUrl_(); // never the Sheet link: the team has no access to the Sheet
  return u ? '<p><a href="' + esc_(u) + '">Open the tracker</a></p>' : '';
}

/** Rows of the Tracker tab that happen between two ISO dates (inclusive), as a flat sorted list. */
function scheduleItems_(from, to) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  const items = [];
  const n = sh ? lastDataRow_(sh) : 1;
  if (n < 2) return items;
  sh.getRange(2, 1, n - 1, NCOL).getValues().forEach(function (r) {
    if (!r[C.KEY]) return;
    const rd = iso_(r[C.RES_DATE]), cd = iso_(r[C.CC_DATE]);
    if (rd && rd >= from && rd <= to) {
      items.push({ d: rd, t: '', kind: 'Results', symbol: r[C.SYMBOL], company: r[C.COMPANY], link: '' });
    }
    if (cd && cd >= from && cd <= to) {
      items.push({ d: cd, t: time_(r[C.CC_TIME]), kind: 'Concall', symbol: r[C.SYMBOL], company: r[C.COMPANY], link: safeUrl_(r[C.LINK]) });
    }
  });
  items.sort(function (a, b) { return (a.d + a.t + a.symbol) < (b.d + b.t + b.symbol) ? -1 : 1; });
  return items;
}

/** Alerts not yet emailed (and recent). mark() flags ALL unsent ones as emailed. */
function unsentAlerts_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ALERTS);
  if (!sh || sh.getLastRow() < 2) return { list: [], mark: function () {} };
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const cutoff = Date.now() - ALERT_MAX_AGE_H * 3600000;
  const list = [];
  vals.forEach(function (r) {
    if (r[6]) return;
    const t = whenMs_(r[0]);
    if (t && t < cutoff) return;
    list.push({ symbol: r[1], company: r[2], quarter: r[3], text: r[4], link: r[5] });
  });
  return {
    list: list,
    mark: function () {
      sh.getRange(2, 7, vals.length, 1).setValues(vals.map(function (r) { return [r[6] || 'Y']; }));
    },
  };
}

function istParts_() {
  const now = new Date();
  return {
    dow: Number(Utilities.formatDate(now, TZ, 'u')), // 1=Mon .. 7=Sun
    hour: Number(Utilities.formatDate(now, TZ, 'H')),
  };
}

/** Trigger, weekdays ~8:30. Guarded: does nothing before 8 AM, on weekends, or if it already ran today. */
function morningDigest() {
  const props = PropertiesService.getScriptProperties();
  const t = istParts_();
  const today = today_();
  if (t.dow > 5 || t.hour < 8 || props.getProperty('LAST_MORNING') === today) return;
  props.setProperty('LAST_MORNING', today); // set first, so a second call can never send twice
  sendMorning_(false);
}

/** Trigger, every day ~18:30. Same guards. */
function eveningDigest() {
  const props = PropertiesService.getScriptProperties();
  const t = istParts_();
  const today = today_();
  if (t.hour < 17 || props.getProperty('LAST_EVENING') === today) return;
  props.setProperty('LAST_EVENING', today);
  sendEvening_(false);
}

/** Run from the editor to see the morning mail (sent only to you; nothing is marked as sent). */
function testMorningToMe() {
  assertOwner_();
  sendMorning_(true);
}
function testEveningToMe() {
  assertOwner_();
  sendEvening_(true);
}

function sendMorning_(onlyOwner) {
  refreshStages_();
  const dow = istParts_().dow;
  const today = today_();
  const items = scheduleItems_(today, addDays_(today, 7));
  const todays = items.filter(function (x) { return x.d === today; });
  const later = items.filter(function (x) { return x.d !== today; });
  const un = unsentAlerts_();
  if (!todays.length && !un.list.length && !(dow === 1 && later.length)) {
    if (onlyOwner) Logger.log('Nothing to send right now (no events today, nothing new).');
    return;
  }
  const calls = todays.filter(function (x) { return x.kind === 'Concall'; }).length;
  const results = todays.length - calls;
  const parts = [];
  if (calls) parts.push(calls + ' concall' + (calls > 1 ? 's' : ''));
  if (results) parts.push(results + ' result' + (results > 1 ? 's' : ''));
  const subject = todays.length ? '[Nifty200] Today: ' + parts.join(', ') : '[Nifty200] Week ahead';

  let html = '<p><b>Today, ' + esc_(pretty_(today)) + '</b></p>' +
    (todays.length ? itemsHtml_(todays, false) : '<p>Nothing scheduled today.</p>');
  if (un.list.length) html += alertsHtml_(un.list);
  if (later.length) html += '<p><b>Next 7 days</b></p>' + itemsHtml_(later, true);
  html += footerHtml_();
  const sent = sendToSubscribers_(subject, html, onlyOwner);
  if (!onlyOwner) un.mark();
  Logger.log('Morning mail sent to ' + sent + ' address(es).');
}

function sendEvening_(onlyOwner) {
  const un = unsentAlerts_();
  if (!un.list.length) {
    if (onlyOwner) Logger.log('Nothing new to send.');
    return;
  }
  const tomorrow = addDays_(today_(), 1);
  const items = scheduleItems_(tomorrow, tomorrow);
  let html = alertsHtml_(un.list);
  if (items.length) html += '<p><b>Tomorrow</b></p>' + itemsHtml_(items, false);
  html += footerHtml_();
  const sent = sendToSubscribers_('[Nifty200] ' + un.list.length + ' new update' + (un.list.length > 1 ? 's' : ''), html, onlyOwner);
  if (!onlyOwner) un.mark();
  Logger.log('Evening mail sent to ' + sent + ' address(es).');
}

function refreshStages_() {
  const sh = sheetOrThrow_(SHEET);
  const last = lastDataRow_(sh);
  if (last < 2) return;
  const today = today_();
  const n = last - 1;
  const vals = sh.getRange(2, 1, n, C.UPDATED + 1).getValues();
  const out = vals.map(function (r) {
    r[C.RES_DATE] = iso_(r[C.RES_DATE]);
    r[C.CC_DATE] = iso_(r[C.CC_DATE]);
    return [r[C.KEY] ? stage_(r, today) : ''];
  });
  sh.getRange(2, C.STAGE + 1, n, 1).setValues(out);
}

/** Trigger. Warns the owner if the collector has gone quiet during working hours (at most every 6 hours). */
function checkHeartbeat() {
  const props = PropertiesService.getScriptProperties();
  const t = istParts_();
  if (t.dow > 5 || t.hour < 9 || t.hour > 21) return;
  const lastPost = Number(props.getProperty('LAST_POST') || 0);
  const lastWarn = Number(props.getProperty('LAST_WARN') || 0);
  const now = Date.now();
  if (now - lastPost > 3 * 3600000 && now - lastWarn > 6 * 3600000) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Nifty200] Collector looks stuck',
      'No data received from the GitHub collector for more than 3 hours. Check the Actions tab of the repo.');
    props.setProperty('LAST_WARN', String(now));
  }
}

// ------------------------------------------------------------------ setup (owner only)
function sheetOrThrow_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Run setup() first: missing tab ' + name);
  return sh;
}

function setup() {
  assertOwner_();
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  let sh = ss.getSheetByName(SHEET);
  if (sh && String(sh.getRange(1, 17).getValue()) === 'Owner') {
    throw new Error('Old layout found (it had team columns). Delete the Tracker tab, set state/seen.json in GitHub to [] and run setup() again.');
  }
  if (!sh) sh = ss.insertSheet(SHEET);
  ensureRows_(sh, 3000);
  sh.getRange(1, 1, 1, NCOL).setValues([HEADERS]).setFontWeight('bold').setBackground('#e8eaf6');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  sh.getRange(2, C.RES_DATE + 1, sh.getMaxRows() - 1, 1).setNumberFormat('ddd dd-mmm-yyyy');
  sh.getRange(2, C.CC_DATE + 1, sh.getMaxRows() - 1, 1).setNumberFormat('ddd dd-mmm-yyyy');
  sh.getRange(2, C.CC_TIME + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  sh.hideColumns(1);
  sh.hideColumns(C.RES_EID + 1, 2);
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), NCOL).createFilter();

  const al = ss.getSheetByName(ALERTS) || ss.insertSheet(ALERTS);
  al.getRange(1, 1, 1, 7).setValues([ALERT_HEADERS]).setFontWeight('bold').setBackground('#e8eaf6');
  al.setFrozenRows(1);
  al.getRange(2, 1, al.getMaxRows() - 1, 1).setNumberFormat('@'); // keep "2026-10-13 10:04" as text

  const un = ss.getSheetByName(UNIVERSE) || ss.insertSheet(UNIVERSE);
  un.getRange(1, 1, 1, 4).setValues([['Symbol', 'Company', 'Industry', 'Index group']]).setFontWeight('bold').setBackground('#e8eaf6');
  un.setFrozenRows(1);
  un.getRange(2, 1, un.getMaxRows() - 1, 4).setNumberFormat('@');

  const sb = ss.getSheetByName(SUBS) || ss.insertSheet(SUBS);
  sb.getRange(1, 1, 1, NSUB).setValues([SUB_HEADERS]).setFontWeight('bold').setBackground('#e8eaf6');
  sb.setFrozenRows(1);
  sb.getRange(2, 1, sb.getMaxRows() - 1, 6).setNumberFormat('@');
  sb.hideColumns(SC.REQMS + 1);
  migrateSettings_();

  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 2 && first.getLastRow() === 0) ss.deleteSheet(first);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid().replace(/-/g, ''));
  calendar_();

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('morningDigest').timeBased().atHour(8).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('eveningDigest').timeBased().atHour(18).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('checkHeartbeat').timeBased().everyHours(1).create();

  Logger.log('SECRET (put in GitHub as APPS_SCRIPT_SECRET): ' + props.getProperty('SECRET'));
  Logger.log('Calendar id: ' + props.getProperty('CAL_ID'));
  Logger.log('Setup done. Now deploy a NEW VERSION of the web app.');
}

/** The old version kept team emails on a "Settings" tab. Move them to Subscribers once, then drop that tab. */
function migrateSettings_() {
  const ss = SpreadsheetApp.getActive();
  const st = ss.getSheetByName(SETTINGS);
  if (!st) return;
  const d = readSubs_();
  const have = {};
  d.rows.forEach(function (r) { have[String(r[SC.EMAIL]).trim().toLowerCase()] = true; });
  if (st.getLastRow() > 1) {
    st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().forEach(function (x) {
      const e = String(x[0]).trim().toLowerCase();
      if (e.indexOf('@') < 1 || have[e]) return;
      have[e] = true;
      appendSubRow_(d.sh, [e, 'active', newToken_(), nowStr_(), nowStr_(), '', Date.now()]);
    });
  }
  if (ss.getSheets().length > 1) ss.deleteSheet(st);
}

/** Run this to see the secret, calendar id and web app url again (Execution log). */
function showConfig() {
  assertOwner_();
  const p = PropertiesService.getScriptProperties();
  Logger.log('SECRET: ' + p.getProperty('SECRET'));
  Logger.log('Calendar id: ' + p.getProperty('CAL_ID'));
  Logger.log('Web app url: ' + (p.getProperty('WEBAPP_URL') || '(open the web app once to record it)'));
}

/** Run once after deploying: pushes a fake call through the whole pipeline. Then run removeTestRows. */
function selfTest() {
  assertOwner_();
  const alerts = processEvents_([{
    kind: 'concall', symbol: 'TESTCO', company: 'Test Company Ltd', industry: 'Test',
    quarter: 'Q2FY27', date: Utilities.formatDate(new Date(Date.now() + 5 * 86400000), TZ, 'yyyy-MM-dd'),
    time: '16:00', mode: 'Virtual', link: 'https://example.com/join', call_name: 'Self test call',
    filing_url: 'https://example.com/filing.xml',
  }]);
  logAlerts_(alerts, true); // already "emailed": the test must never reach subscribers
  Logger.log('Wrote a TESTCO row, a calendar event and an Alerts line. Check them, then run removeTestRows.');
}

function removeTestRows() {
  assertOwner_();
  const sh = sheetOrThrow_(SHEET);
  const cal = calendar_();
  for (let r = lastDataRow_(sh); r >= 2; r--) {
    if (String(sh.getRange(r, 1).getValue()).indexOf('TESTCO|') === 0) {
      deleteEvent_(cal, sh.getRange(r, C.RES_EID + 1).getValue());
      deleteEvent_(cal, sh.getRange(r, C.CC_EID + 1).getValue());
      sh.deleteRow(r);
    }
  }
  const al = SpreadsheetApp.getActive().getSheetByName(ALERTS);
  if (al) for (let r = al.getLastRow(); r >= 2; r--) if (String(al.getRange(r, 2).getValue()) === 'TESTCO') al.deleteRow(r);
  Logger.log('Test rows removed.');
}
