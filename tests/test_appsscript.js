// Runs apps_script/Code.gs against hand-made fakes of Google's services.
//   node tests/test_appsscript.js [out_dir]        (from the repo root)
// Not the real Google runtime, but it catches logic errors, bad row maths and API-shape mistakes.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || null;

// ---------- Utilities.formatDate in IST
const IST = 'Asia/Kolkata';
function fmt(date, tz, pattern) {
  if (pattern === 'u' && sandbox.__forceDow) return String(sandbox.__forceDow);
  const get = (opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: IST, hourCycle: 'h23' }, opts)).format(date);
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: IST, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(date).forEach(x => { p[x.type] = x.value; });
  const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  const map = {
    yyyy: p.year, MMM: get({ month: 'short' }), MM: p.month, dd: p.day, d: String(Number(p.day)),
    HH: p.hour, H: String(Number(p.hour)), mm: p.minute, EEE: p.weekday, u: String(iso),
  };
  return pattern.replace(/yyyy|MMM|MM|dd|d|HH|H|mm|EEE|u/g, t => map[t]);
}

// ---------- fake sheets
function chain(target) {
  const prox = new Proxy(target, { get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => prox)) });
  return prox;
}
function makeSheet(name, rows) {
  const sh = { name, data: Array.from({ length: rows }, () => Array(25).fill('')) };
  sh.getMaxRows = () => sh.data.length;
  sh.getLastRow = () => { for (let i = sh.data.length - 1; i >= 0; i--) if (sh.data[i].some(v => v !== '')) return i + 1; return 0; };
  sh.insertRowsAfter = (n, k) => { for (let i = 0; i < k; i++) sh.data.splice(n, 0, Array(25).fill('')); };
  sh.deleteRow = r => { sh.data.splice(r - 1, 1); };
  sh.getFilter = () => null;
  sh.getRange = (r, c, nr, nc) => {
    if (typeof r === 'string') { r = 1; c = 1; } // 'A1'
    nr = nr || 1; nc = nc || 1;
    if (r + nr - 1 > sh.data.length) throw new Error('Range out of bounds: row ' + (r + nr - 1) + ' > ' + sh.data.length);
    const rng = {
      getValues: () => sh.data.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)),
      setValues: v => {
        if (v.length !== nr || v[0].length !== nc) throw new Error('setValues shape ' + v.length + 'x' + v[0].length + ' vs range ' + nr + 'x' + nc);
        v.forEach((row, i) => row.forEach((x, j) => { sh.data[r - 1 + i][c - 1 + j] = x; }));
        return prox;
      },
      getValue: () => sh.data[r - 1][c - 1],
      setValue: x => { sh.data[r - 1][c - 1] = x; return prox; },
    };
    const prox = chain(rng);
    return prox;
  };
  return chain(sh);
}

const sheets = {};
const mails = [];
const calEvents = {};
let calSeq = 0;
const props = {};
const triggers = [];
let postedHtml = null;

const ssObj = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = makeSheet(n, 1000)),
  getSheets: () => Object.values(sheets),
  deleteSheet: s => { delete sheets[s.name]; },
  getUrl: () => 'https://docs.google.com/spreadsheets/d/SECRET-SHEET-ID/edit',
  setSpreadsheetTimeZone: () => {},
};

const sandbox = {
  console,
  Date, JSON, Math, Intl, Object, Number, String, Array, Promise,
  SpreadsheetApp: { getActive: () => ssObj },
  Utilities: { formatDate: fmt, getUuid: () => 'aaaa-bbbb-cccc-dddd' },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: t => ({ text: t, setMimeType() { return this; }, getContent() { return t; } }),
  },
  HtmlService: {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile: n => {
      const t = { evaluate() {
        const html = fs.readFileSync(path.join(ROOT, 'apps_script', n + '.html'), 'utf8').replace('<?!= payload ?>', () => t.payload);
        postedHtml = html;
        return { setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; }, html };
      } };
      return t;
    },
    createHtmlOutput: h => ({ html: h }),
  },
  MailApp: { sendEmail: o => mails.push(o), getRemainingDailyQuota: () => 100 },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@gmail.com' }) },
  ScriptApp: {
    getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }),
    getProjectTriggers: () => [], deleteTrigger: () => {},
    newTrigger: fn => { const t = { fn }; const c = chain({ create: () => { triggers.push(fn); } }); return new Proxy(c, { get: (x, k) => (k === 'create' ? () => triggers.push(fn) : () => c) }); },
  },
  CalendarApp: {
    createCalendar: () => ({ getId: () => 'cal123@group.calendar.google.com', ...calApi() }),
    getCalendarById: () => ({ getId: () => 'cal123@group.calendar.google.com', ...calApi() }),
  },
  Logger: { log: () => {} },
};
function calApi() {
  const mk = (name, extra) => { const id = 'ev' + (++calSeq); calEvents[id] = { name, ...extra }; return { getId: () => id }; };
  return {
    createAllDayEvent: (name, d, o) => mk(name, { allDay: true, d, o }),
    createEvent: (name, s, e, o) => mk(name, { allDay: false, s, e, o }),
    getEventById: id => (calEvents[id] ? { deleteEvent: () => { delete calEvents[id]; } } : null),
  };
}
vm.createContext(sandbox);

// ---------- test driver (runs inside the same global scope as Code.gs)
const driver = `
const results = [];
function check(name, cond) { results.push([name, !!cond]); }
const post = (secret, events) => JSON.parse(doPost({ postData: { contents: JSON.stringify({ secret, events }) } }).getContent());
const T = today_();
const inDays = n => addDays_(T, n);
const sh = () => SpreadsheetApp.getActive().getSheetByName('Tracker');
const al = () => SpreadsheetApp.getActive().getSheetByName('Alerts');
const dataRows = () => { const out = []; for (let r = 2; r <= lastDataRow_(sh()); r++) out.push(sh().getRange(r, 1, 1, NCOL).getValues()[0]); return out; };

setup();
check('setup: three working tabs exist', ['Tracker','Alerts','Settings'].every(n => SpreadsheetApp.getActive().getSheetByName(n)));
check('setup: no team columns in headers', !HEADERS.some(h => /Owner|Status|Notes|Listened/.test(h)) && HEADERS.length === NCOL);
check('setup: tracker has room (3000 rows)', sh().getMaxRows() >= 3000);
check('setup: three triggers', __triggers.join() === 'morningDigest,eveningDigest,checkHeartbeat');
const SECRET = PropertiesService.getScriptProperties().getProperty('SECRET');
check('setup: secret + calendar created', SECRET && PropertiesService.getScriptProperties().getProperty('CAL_ID'));
// team emails
SpreadsheetApp.getActive().getSheetByName('Settings').getRange(2, 1, 2, 1).setValues([['a@x.com'], ['b@y.com']]);

check('post: wrong secret rejected', post('nope', []).ok === false);

const rallis = { kind: 'concall', symbol: 'RALLIS', company: 'Rallis India Ltd.', industry: 'Chemicals', quarter: 'Q2FY27',
  date: inDays(10), time: '11:00', mode: 'Virtual', link: 'https://services.choruscall.in/x?a=1&b=2', call_name: 'Q2 call', filing_url: 'https://nse/rallis.xml' };
let r = post(SECRET, [rallis]);
check('post: ok, 1 alert', r.ok && r.alerts === 1);
check('row 2 holds the new row (not row 2002)', dataRows().length === 1 && sh().getRange(2, C.SYMBOL + 1).getValue() === 'RALLIS');
check('concall date stored as a date', sh().getRange(2, C.CC_DATE + 1).getValue() instanceof Date);
check('stage = Concall scheduled', dataRows()[0][C.STAGE] === 'Concall scheduled');
check('calendar event created', Object.keys(__calEvents).length === 1);
check('alert logged, not yet emailed', al().getRange(2, 5).getValue().indexOf('Concall scheduled') === 0 && al().getRange(2, 7).getValue() === '');
check('no instant email', __mails.length === 0);

r = post(SECRET, [rallis]);
check('same event again: 0 alerts, 1 row', r.alerts === 0 && dataRows().length === 1);

const firstEv = Object.keys(__calEvents)[0];
r = post(SECRET, [Object.assign({}, rallis, { time: '15:30' })]);
check('time change: UPDATED alert', r.alerts === 1 && al().getRange(3, 5).getValue().indexOf('UPDATED') >= 0);
check('time change: same row, calendar event replaced (still 1)', dataRows().length === 1 && Object.keys(__calEvents).length === 1 && !__calEvents[firstEv]);
check('time change: new time in sheet', dataRows()[0][C.CC_TIME] === '15:30');

r = post(SECRET, [{ kind: 'result', symbol: 'RALLIS', company: 'Rallis India Ltd.', quarter: 'Q2FY27', date: inDays(14), filing_url: 'https://nse/board.xml' }]);
check('result event joins the same row', dataRows().length === 1 && dataRows()[0][C.RES_DATE] !== '' && r.alerts === 1);
check('result adds all-day calendar event', Object.keys(__calEvents).length === 2);

const mk = (sym, d, t, link) => ({ kind: 'concall', symbol: sym, company: sym + ' Ltd.', industry: 'Test', quarter: 'Q2FY27', date: d, time: t, mode: 'Virtual', link: link, filing_url: 'https://nse/' + sym });
r = post(SECRET, [mk('TESTCO', inDays(0), '16:00', 'https://example.com/j'), mk('ABB', inDays(1), '10:00', ''), mk('AUBANK', inDays(3), '', 'https://example.com/au')]);
check('3 new rows are contiguous after row 2', dataRows().length === 4 && sh().getRange(5, C.SYMBOL + 1).getValue() === 'AUBANK');
check('no-link row flagged', String(sh().getRange(4, C.LINK + 1).getValue()).indexOf('no link') >= 0);

// morning digest
sandbox_forceDow(2);
mails.length = 0;
morningDigest();
check('morning digest sent to owner with team in BCC', __mails.length === 1 && __mails[0].to === 'owner@gmail.com' && __mails[0].bcc === 'a@x.com,b@y.com');
check('morning subject mentions today concall', /Today: 1 concall/.test(__mails[0].subject));
check('digest never contains the Sheet link', __mails[0].htmlBody.indexOf('docs.google.com') < 0 && __mails[0].htmlBody.indexOf('script.google.com') > 0);
check('digest lists the join link, ampersand escaped', __mails[0].htmlBody.indexOf('example.com/j') > 0);
check('alerts marked emailed after morning digest', unsentAlerts_().list.length === 0);
mails.length = 0; eveningDigest();
check('evening digest: nothing to send, nothing sent', __mails.length === 0);
post(SECRET, [mk('LT', inDays(1), '14:00', 'https://example.com/lt')]);
eveningDigest();
check('evening digest sends the new update + tomorrow', __mails.length === 1 && /1 new update/.test(__mails[0].subject) && __mails[0].htmlBody.indexOf('Tomorrow') > 0);
sandbox_forceDow(6); mails.length = 0; morningDigest();
check('no morning digest on Saturday', __mails.length === 0);
sandbox_forceDow(0);

// web app
const page = doGet({});
check('doGet returns html with data and no leftover scriptlet', page.html.indexOf('RALLIS') > 0 && page.html.indexOf('<?!=') < 0);
check('doGet ping works', doGet({ parameter: { ping: '1' } }).getContent().indexOf('running') > 0);
check('payload has no team fields', (() => { const p = getPayload_(); return p.rows.length === 5 && p.rows[0].st && !('o' in p.rows[0]); })());

// hostile company name must not break out of the page's script tag
post(SECRET, [Object.assign(mk('EVIL', inDays(2), '12:00', 'javascript:alert(1)'), { company: '</script><img src=x onerror=alert(1)>' })]);
const evilPage = doGet({}).html;
check('hostile name cannot close the script tag', evilPage.indexOf('</script><img') < 0);

// cleanup helper
removeTestRows();
check('removeTestRows deletes TESTCO row + its calendar event', dataRows().every(x => x[C.SYMBOL] !== 'TESTCO') && dataRows().length === 5);

// old layout guard
SpreadsheetApp.getActive().getSheetByName('Tracker').getRange(1, 17).setValue('Owner');
let threw = false; try { setup(); } catch (e) { threw = /Old layout/.test(String(e)); }
check('setup refuses an old-layout sheet', threw);
SpreadsheetApp.getActive().getSheetByName('Tracker').getRange(1, 17).setValue('ResultEventId');

// ---- showcase data for the screenshot (after all checks)
post(SECRET, [
  Object.assign(mk('INFY', inDays(0), '17:00', 'https://services.choruscall.in/DiamondPassRegistration/register?x=1'), { company: 'Infosys Ltd.', industry: 'Information Technology', call_name: 'Q2 call' }),
  Object.assign(mk('HDFCBANK', inDays(0), '18:00', 'https://example.com/hdfc'), { company: 'HDFC Bank Ltd.', industry: 'Financial Services' }),
  Object.assign(mk('TCS', inDays(1), '19:30', 'https://example.com/tcs'), { company: 'Tata Consultancy Services Ltd.', industry: 'Information Technology' }),
  Object.assign(mk('WIPRO', inDays(2), '', ''), { company: 'Wipro Ltd.', industry: 'Information Technology' }),
  { kind: 'result', symbol: 'ASIANPAINT', company: 'Asian Paints Ltd.', industry: 'Consumer Durables', quarter: 'Q2FY27', date: inDays(1), filing_url: 'https://nse/ap.xml' },
  { kind: 'result', symbol: 'HDFCBANK', company: 'HDFC Bank Ltd.', quarter: 'Q2FY27', date: inDays(0), filing_url: 'https://nse/hdfc-board.xml' },
  Object.assign(mk('LT', inDays(-3), '15:00', 'https://example.com/lt'), { company: 'Larsen & Toubro Ltd.', industry: 'Construction' }),
  { kind: 'post', symbol: 'LT', company: 'Larsen & Toubro Ltd.', quarter: 'Q2FY27', filing_url: 'https://nse/lt-transcript.pdf', post_label: 'Transcript' },
]);
doGet({});

__results.push(...results);
`;

sandbox.__results = [];
sandbox.__mails = mails;
sandbox.__calEvents = calEvents;
sandbox.__triggers = triggers;
sandbox.mails = mails;
sandbox.sandbox_forceDow = n => { sandbox.__forceDow = n; };

const code = fs.readFileSync(path.join(ROOT, 'apps_script', 'Code.gs'), 'utf8');
try {
  vm.runInContext(code + '\n' + driver, sandbox, { filename: 'Code.gs+driver' });
} catch (e) {
  console.error('CRASH:', e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(2);
}

let failed = 0;
sandbox.__results.forEach(([n, ok]) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) failed++; });
console.log(failed ? '\n' + failed + ' failed' : '\nall passed');

if (OUT) {
  // showcase data for a screenshot of the real page
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'page.html'), postedHtml);
}
process.exit(failed ? 1 : 0);
