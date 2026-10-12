/**
 * Nifty 200 Earnings & Concall Tracker: Google Apps Script (bound to the Sheet).
 *
 * The GitHub collector POSTs events here. This script:
 *   - keeps one row per company-quarter on the "Tracker" tab (nobody else edits it)
 *   - creates/updates events on a Google Calendar
 *   - logs every change on the "Alerts" tab
 *   - emails the team: weekday 8:30 digest (today + next 7 days) and a 6:30 PM "new today" digest
 *   - serves the read-only team web app (Index.html) from the same /exec URL
 *   - warns the owner if the collector goes quiet
 *
 * First time: run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). See README.
 */

const TZ = 'Asia/Kolkata';
const SHEET = 'Tracker';
const ALERTS = 'Alerts';
const SETTINGS = 'Settings';

// false = changes are collected and sent in the two daily digests (safe for the free Gmail quota).
// true  = also email every hourly batch that has changes (can use up 100 recipients/day quickly).
const INSTANT_EMAIL = false;

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

// ------------------------------------------------------------------ web app
function doGet(e) {
  saveWebAppUrl_();
  if (e && e.parameter && e.parameter.ping) {
    return ContentService.createTextOutput('Nifty 200 tracker receiver is running.');
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
    const events = body.events || [];
    const alerts = processEvents_(events);
    logAlerts_(alerts);
    if (INSTANT_EMAIL && alerts.length) flushAlerts_('[Nifty200] ' + alerts.length + ' earnings update(s)', '');
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

function saveWebAppUrl_() {
  try {
    const u = ScriptApp.getService().getUrl();
    if (u) PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', u);
  } catch (err) { /* not deployed yet */ }
}

function webAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
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
    const from = Math.max(2, al.getLastRow() - 39);
    al.getRange(from, 1, al.getLastRow() - from + 1, 7).getValues().reverse().forEach(function (r) {
      recent.push({ w: String(r[0]), s: r[1], n: r[2], q: r[3], t: r[4], l: r[5] });
    });
  }
  const lastPost = Number(props.getProperty('LAST_POST') || 0);
  return {
    rows: rows,
    recent: recent,
    calId: props.getProperty('CAL_ID') || '',
    checked: lastPost ? Utilities.formatDate(new Date(lastPost), TZ, 'dd MMM, HH:mm') : '',
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

function logAlerts_(alerts) {
  if (!alerts.length) return;
  const sh = sheetOrThrow_(ALERTS);
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const out = alerts.map(function (a) { return [now, a.symbol, a.company, a.quarter, a.text, a.link, '']; });
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

// ------------------------------------------------------------------ email
function teamEmails_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (x) { return String(x[0]).trim(); })
    .filter(function (x) { return x.indexOf('@') > 0; });
}

function sendMail_(subject, html) {
  const team = teamEmails_();
  const owner = Session.getEffectiveUser().getEmail();
  const opts = { to: owner, subject: subject, htmlBody: html, name: 'Nifty 200 Tracker' };
  if (team.length) {
    if (MailApp.getRemainingDailyQuota() >= team.length + 1) opts.bcc = team.join(',');
    else opts.subject += ' [mail quota used up, team not emailed]';
  }
  MailApp.sendEmail(opts);
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

/** Alerts not yet emailed. mark() flags them as emailed (call it only after the mail went out). */
function unsentAlerts_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(ALERTS);
  if (!sh || sh.getLastRow() < 2) return { list: [], mark: function () {} };
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const list = [];
  vals.forEach(function (r) {
    if (!r[6]) list.push({ symbol: r[1], company: r[2], quarter: r[3], text: r[4], link: r[5] });
  });
  return {
    list: list,
    mark: function () {
      sh.getRange(2, 7, vals.length, 1).setValues(vals.map(function (r) { return [r[6] || 'Y']; }));
    },
  };
}

function flushAlerts_(subject, extraHtml) {
  const un = unsentAlerts_();
  if (!un.list.length) return;
  sendMail_(subject, alertsHtml_(un.list) + extraHtml + footerHtml_());
  un.mark();
}

/** Weekdays 8:30. Today's schedule first, then anything announced since the last mail, then the week ahead. */
function morningDigest() {
  const dow = Number(Utilities.formatDate(new Date(), TZ, 'u')); // 1=Mon .. 7=Sun
  if (dow > 5) return;
  refreshStages();
  const today = today_();
  const items = scheduleItems_(today, addDays_(today, 7));
  const todays = items.filter(function (x) { return x.d === today; });
  const later = items.filter(function (x) { return x.d !== today; });
  const un = unsentAlerts_();
  if (!todays.length && !un.list.length && !(dow === 1 && later.length)) return;

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
  sendMail_(subject, html);
  un.mark();
}

/** Every day 6:30 PM, only if something was announced since the last mail. Adds tomorrow's schedule. */
function eveningDigest() {
  const un = unsentAlerts_();
  if (!un.list.length) return;
  const tomorrow = addDays_(today_(), 1);
  const items = scheduleItems_(tomorrow, tomorrow);
  let html = alertsHtml_(un.list);
  if (items.length) html += '<p><b>Tomorrow</b></p>' + itemsHtml_(items, false);
  html += footerHtml_();
  sendMail_('[Nifty200] ' + un.list.length + ' new update' + (un.list.length > 1 ? 's' : ''), html);
  un.mark();
}

function refreshStages() {
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

/** Warn the owner if the collector has gone quiet during working hours. */
function checkHeartbeat() {
  const props = PropertiesService.getScriptProperties();
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  const day = Number(Utilities.formatDate(new Date(), TZ, 'u'));
  if (day > 5 || hour < 9 || hour > 21) return;
  const lastPost = Number(props.getProperty('LAST_POST') || 0);
  const lastWarn = Number(props.getProperty('LAST_WARN') || 0);
  const now = Date.now();
  if (now - lastPost > 3 * 3600000 && now - lastWarn > 6 * 3600000) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '[Nifty200] Collector looks stuck',
      'No data received from the GitHub collector for more than 3 hours. Check the Actions tab of the repo.');
    props.setProperty('LAST_WARN', String(now));
  }
}

// ------------------------------------------------------------------ setup
function sheetOrThrow_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Run setup() first: missing tab ' + name);
  return sh;
}

function setup() {
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

  let al = ss.getSheetByName(ALERTS) || ss.insertSheet(ALERTS);
  al.getRange(1, 1, 1, 7).setValues([ALERT_HEADERS]).setFontWeight('bold').setBackground('#e8eaf6');
  al.setFrozenRows(1);

  let st = ss.getSheetByName(SETTINGS) || ss.insertSheet(SETTINGS);
  if (!st.getRange('A1').getValue()) {
    st.getRange('A1').setValue('Team emails (one per row, starting A2)').setFontWeight('bold');
    st.setColumnWidth(1, 380);
  }
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
  Logger.log('Setup done. Now deploy as a web app.');
}

/** Run this to see the secret, calendar id and web app url again (Execution log). */
function showConfig() {
  const p = PropertiesService.getScriptProperties();
  Logger.log('SECRET: ' + p.getProperty('SECRET'));
  Logger.log('Calendar id: ' + p.getProperty('CAL_ID'));
  Logger.log('Web app url: ' + (p.getProperty('WEBAPP_URL') || '(open the web app once to record it)'));
}

/** Run once after deploying: pushes a fake call through the whole pipeline. Then run removeTestRows. */
function selfTest() {
  const alerts = processEvents_([{
    kind: 'concall', symbol: 'TESTCO', company: 'Test Company Ltd', industry: 'Test',
    quarter: 'Q2FY27', date: Utilities.formatDate(new Date(Date.now() + 5 * 86400000), TZ, 'yyyy-MM-dd'),
    time: '16:00', mode: 'Virtual', link: 'https://example.com/join', call_name: 'Self test call',
    filing_url: 'https://example.com/filing.xml',
  }]);
  logAlerts_(alerts);
  Logger.log('Wrote a TESTCO row, a calendar event and an Alerts line. Check them, then run removeTestRows.');
}

function removeTestRows() {
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
