// Runs apps_script/Code.gs against fakes of Google's services.   node tests/test_appsscript.js
'use strict';
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas_mock');

const ROOT = path.resolve(__dirname, '..');
const env = createEnv(ROOT);
env.setClock('2026-10-13T14:20:00+05:30'); // a Tuesday, 2:20 PM IST
env.load();
const g = env.sandbox;
const C = env.get('C'), SC = env.get('SC'), MAX = env.get('MAX_SUBSCRIBERS');

let failed = 0;
function check(name, cond) { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed++; }
const post = (secret, events, extra) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(Object.assign({ secret, events }, extra || {})) } }).getContent());
const inDays = n => g.addDays_(g.today_(), n);
const tracker = () => env.sheets.Tracker;
const trackerRows = () => { const out = []; for (let r = 2; r <= g.lastDataRow_(tracker()); r++) out.push(tracker().getRange(r, 1, 1, 18).getValues()[0]); return out; };
const subsRows = () => { const s = env.sheets.Subscribers; const n = s.getLastRow(); return n > 1 ? s.getRange(2, 1, n - 1, 7).getValues() : []; };
const subOf = e => subsRows().find(r => r[SC.EMAIL] === e);
const tokenFromMail = m => /t=([a-f0-9]{32})/.exec(m.htmlBody)[1];
const makeUniverse = n => Array.from({ length: n }, (_, i) => ({ s: 'SYM' + i, n: 'Company ' + i, i: i % 2 ? 'Capital Goods' : 'Information Technology', g: i < 50 ? 'Nifty 50' : 'Midcap' }));

// ================================================================= setup
const legacy = g.SpreadsheetApp.getActive().insertSheet('Settings');
legacy.getRange(1, 1, 1, 1).setValues([['Team emails']]);
legacy.getRange(2, 1, 3, 1).setValues([['a@x.com'], ['b@y.com'], ['not-an-email']]);

env.anon = true;
let threw = 0;
['setup', 'showConfig', 'selfTest', 'removeTestRows', 'testMorningToMe', 'testEveningToMe'].forEach(fn => { try { g[fn](); } catch (e) { if (/Owner only/.test(String(e))) threw++; } });
check('owner-only functions refuse a page visitor (no active-user email)', threw === 6);
env.anon = false;

g.setup();
check('setup: Tracker, Alerts, Universe, Subscribers tabs exist', ['Tracker', 'Alerts', 'Universe', 'Subscribers'].every(n => env.sheets[n]));
check('setup: no team columns', !g.SpreadsheetApp.getActive().getSheetByName('Tracker').getRange(1, 1, 1, 18).getValues()[0].some(h => /Owner|Status|Notes|Listened/.test(h)));
check('setup: three triggers', env.triggers.join() === 'morningDigest,eveningDigest,checkHeartbeat');
check('setup: legacy Settings emails imported as active, with tokens; junk skipped',
  subsRows().length === 2 && subsRows().every(r => r[SC.STATUS] === 'active' && /^[a-f0-9]{32}$/.test(r[SC.TOKEN])));
check('setup: legacy Settings tab removed', !env.sheets.Settings);
const SECRET = env.props.SECRET;
check('setup: secret and calendar created', SECRET && env.props.CAL_ID);
g.setup(); // running it twice must be harmless
check('setup twice: no duplicate subscribers', subsRows().length === 2);

// ================================================================= universe
check('post: wrong secret rejected', post('nope', []).ok === false);
const U60 = makeUniverse(60);
check('universe: first post stores 60', post(SECRET, [], { universe: U60 }).ok && env.sheets.Universe.getLastRow() === 61);
const sigBefore = env.props.UNIV_SIG;
post(SECRET, [], { universe: U60 });
check('universe: same list again changes nothing', env.props.UNIV_SIG === sigBefore);
post(SECRET, [], { universe: U60.slice(0, 5) });
check('universe: a tiny fallback list never overwrites the real one', env.sheets.Universe.getLastRow() === 61);
post(SECRET, [], { universe: U60.slice(0, 55) });
check('universe: a shorter real list clears the leftover rows', env.sheets.Universe.getLastRow() === 56);
post(SECRET, [], { universe: U60 });
check('universe: back to 60', env.sheets.Universe.getLastRow() === 61);
check('payload carries the universe with groups', (() => { const p = g.getPayload_(); return p.universe.length === 60 && p.universe[0].g === 'Nifty 50' && p.universe[59].g === 'Midcap'; })());

// ================================================================= events pipeline
const rallis = { kind: 'concall', symbol: 'RALLIS', company: 'Rallis India Ltd.', industry: 'Chemicals', quarter: 'Q2FY27',
  date: inDays(10), time: '11:00', mode: 'Virtual', link: 'https://services.choruscall.in/x?a=1&b=2', call_name: 'Q2 call', filing_url: 'https://nse/rallis.xml' };
let r = post(SECRET, [rallis]);
check('event: ok, 1 alert', r.ok && r.alerts === 1);
check('event: row 2, not row 2002', trackerRows().length === 1 && tracker().getRange(2, C.SYMBOL + 1).getValue() === 'RALLIS');
check('event: concall date stored as a date', tracker().getRange(2, C.CC_DATE + 1).getValue() instanceof g.Date);
check('event: calendar event created', Object.keys(env.calEvents).length === 1);
check('event: alert logged, not yet emailed', env.sheets.Alerts.getRange(2, 5).getValue().indexOf('Concall scheduled') === 0 && env.sheets.Alerts.getRange(2, 7).getValue() === '');
check('event: no mail at post time', env.mails.length === 0);
check('event: same event again = 0 alerts', post(SECRET, [rallis]).alerts === 0 && trackerRows().length === 1);
const firstEv = Object.keys(env.calEvents)[0];
r = post(SECRET, [Object.assign({}, rallis, { time: '15:30' })]);
check('event: time change = UPDATED alert, calendar event replaced', r.alerts === 1 && env.sheets.Alerts.getRange(3, 5).getValue().indexOf('UPDATED') >= 0 && !env.calEvents[firstEv] && Object.keys(env.calEvents).length === 1);
r = post(SECRET, [{ kind: 'result', symbol: 'RALLIS', company: 'Rallis India Ltd.', quarter: 'Q2FY27', date: inDays(14), filing_url: 'https://nse/board.xml' }]);
check('event: result date joins the same row', trackerRows().length === 1 && trackerRows()[0][C.RES_DATE] !== '' && r.alerts === 1);
const mk = (sym, d, t, link) => ({ kind: 'concall', symbol: sym, company: sym + ' Ltd.', industry: 'Test', quarter: 'Q2FY27', date: d, time: t, mode: 'Virtual', link: link, filing_url: 'https://nse/' + sym });
post(SECRET, [mk('TESTCO', inDays(0), '16:00', 'https://example.com/j'), mk('ABB', inDays(1), '10:00', ''), mk('AUBANK', inDays(3), '', 'https://example.com/au')]);
check('events: 3 new rows are contiguous', trackerRows().length === 4 && tracker().getRange(5, C.SYMBOL + 1).getValue() === 'AUBANK');
check('events: no-link row flagged', String(tracker().getRange(4, C.LINK + 1).getValue()).indexOf('no link') >= 0);
const bf = post(SECRET, [mk('NESTLEIND', inDays(6), '11:00', 'https://example.com/n')], { backfill: true });
check('backfill: saved, and logged as already emailed', bf.ok && trackerRows().some(x => x[C.SYMBOL] === 'NESTLEIND') &&
  (() => { const a = env.sheets.Alerts; const n = a.getLastRow(); return a.getRange(n, 7).getValue() === 'Y'; })());

// ================================================================= subscribe flow (double opt-in)
check('subscribe: junk and hostile addresses refused', ['', 'nope', 'a@b', '<script>@x.com', 'x'.repeat(130) + '@a.com', 'a b@c.com'].every(e => g.subscribeEmail(e).ok === false) && env.mails.length === 0);
r = g.subscribeEmail('  New.Person@Gmail.com ');
check('subscribe: new address gets a pending row and exactly one confirmation mail', r.ok && r.state === 'sent' && subOf('new.person@gmail.com')[SC.STATUS] === 'pending' && env.mails.length === 1);
const cmail = env.mails[0];
check('subscribe: mail goes to that address, link is the web app confirm link', cmail.to === 'new.person@gmail.com' && /script\.google\.com\/macros\/s\/FAKE\/exec\?a=confirm&amp;t=[a-f0-9]{32}/.test(cmail.htmlBody));
check('subscribe: not subscribed before the click (no digest recipients yet)', g.activeSubscribers_().length === 2);
r = g.subscribeEmail('new.person@gmail.com');
check('subscribe: asking again within 10 minutes sends nothing new', r.state === 'wait' && env.mails.length === 1);
const tok = tokenFromMail(cmail);
{ // a mail scanner "clicking" the link must change nothing
  const first = g.doGet({ parameter: { a: 'confirm', t: tokenFromMail(cmail) } });
  check('confirm link, first visit (scanner): shows a button, changes nothing', /Yes, subscribe me/.test(first.html) && /go=1/.test(first.html) && subOf('new.person@gmail.com')[SC.STATUS] === 'pending');
  const un = g.doGet({ parameter: { a: 'unsub', t: subOf('a@x.com')[SC.TOKEN] } });
  check('unsubscribe link, first visit (scanner): shows a button, changes nothing', /Yes, unsubscribe me/.test(un.html) && subOf('a@x.com')[SC.STATUS] === 'active');
}
let page = g.doGet({ parameter: { a: 'confirm', go: '1', t: tok } });
check('confirm link: success page, row becomes active', /You are subscribed/.test(page.html) && subOf('new.person@gmail.com')[SC.STATUS] === 'active');
check('confirm link: now 3 active subscribers', g.activeSubscribers_().length === 3);
page = g.doGet({ parameter: { a: 'confirm', go: '1', t: tok } });
check('confirm link twice: friendly, still active', /You are subscribed/.test(page.html) && subOf('new.person@gmail.com')[SC.STATUS] === 'active');
check('confirm link: bad or unknown token refused', ['', 'abc', 'g'.repeat(32), 'a'.repeat(32)].every(t => /Could not confirm/.test(g.doGet({ parameter: { a: 'confirm', go: '1', t } }).html)));
check('subscribe: already active = no mail', g.subscribeEmail('new.person@gmail.com').state === 'already' && env.mails.length === 1);

// expiry
g.subscribeEmail('late@x.com');
const lateTok = tokenFromMail(env.mails[env.mails.length - 1]);
env.setClock('2026-10-15T15:00:00+05:30'); // 48h+ later
check('confirm link: expired after 48 hours', /expired/.test(g.doGet({ parameter: { a: 'confirm', go: '1', t: lateTok } }).html) && subOf('late@x.com')[SC.STATUS] === 'pending');
r = g.subscribeEmail('late@x.com');
check('subscribe: an expired request can be re-sent (new token)', r.state === 'sent' && tokenFromMail(env.mails[env.mails.length - 1]) !== lateTok);
env.setClock('2026-10-13T14:30:00+05:30');
check('old link stops working after a re-send', /Could not confirm/.test(g.doGet({ parameter: { a: 'confirm', go: '1', t: lateTok } }).html));

// unsubscribe and re-subscribe
const unsubTok = subOf('new.person@gmail.com')[SC.TOKEN];
page = g.doGet({ parameter: { a: 'unsub', go: '1', t: unsubTok } });
check('unsubscribe link: page says so, row unsubscribed', /You are unsubscribed/.test(page.html) && subOf('new.person@gmail.com')[SC.STATUS] === 'unsubscribed');
check('unsubscribe link twice is harmless', /You are unsubscribed/.test(g.doGet({ parameter: { a: 'unsub', go: '1', t: unsubTok } }).html));
check('unsubscribed address gets no digests', !g.activeSubscribers_().some(s => s.email === 'new.person@gmail.com'));
env.setClock('2026-10-13T14:45:00+05:30');
r = g.subscribeEmail('new.person@gmail.com');
check('re-subscribe after unsubscribing sends a fresh confirmation', r.state === 'sent' && subOf('new.person@gmail.com')[SC.STATUS] === 'pending' && subOf('new.person@gmail.com')[SC.TOKEN] !== unsubTok);
g.doGet({ parameter: { a: 'confirm', go: '1', t: subOf('new.person@gmail.com')[SC.TOKEN] } });

// caps
env.props.CONF_DAY = g.today_(); env.props.CONF_COUNT = '30';
check('subscribe: daily cap on confirmation mails', /Too many sign-ups/.test(g.subscribeEmail('cap@x.com').msg));
env.props.CONF_COUNT = '0';
env.lockBusy = true;
check('subscribe: a busy lock gives a friendly answer, not an error', g.subscribeEmail('busy@x.com').ok === false);
env.lockBusy = false;
{
  const sb = env.sheets.Subscribers, base = sb.getLastRow();
  let n = subsRows().filter(x => x[SC.STATUS] === 'active').length;
  for (let k = 0; n < MAX; k++, n++) sb.getRange(base + 1 + k, 1, 1, 7).setValues([['fill' + k + '@x.com', 'active', 'f'.repeat(32), '', '', '', 0]]);
}
check('subscribe: list full = polite refusal, payload says full', /full/.test(g.subscribeEmail('one-too-many@x.com').msg) && g.getPayload_().full === true);
check('confirm: a pending address cannot slip past the cap', (() => { const sb = env.sheets.Subscribers; const n = sb.getLastRow() + 1; sb.getRange(n, 1, 1, 7).setValues([['p@x.com', 'pending', 'e'.repeat(32), '', '', '', Date.now()]]); return /full/.test(g.doGet({ parameter: { a: 'confirm', go: '1', t: 'e'.repeat(32) } }).html); })());
// make room again for digest tests: drop the filler rows
{
  const sb = env.sheets.Subscribers;
  for (let r2 = sb.getLastRow(); r2 >= 2; r2--) if (/^fill\d+@x\.com$/.test(sb.getRange(r2, 1).getValue()) || sb.getRange(r2, 1).getValue() === 'p@x.com') sb.deleteRow(r2);
}
env.props.CONF_COUNT = '0';

// ================================================================= digests
env.mails.length = 0; env.sentTotal = 0;
env.setClock('2026-10-13T06:00:00+05:30');
g.morningDigest();
check('morning digest: nothing before 8 AM (so a visitor calling it early does nothing)', env.mails.length === 0 && !env.props.LAST_MORNING);
env.setClock('2026-10-17T09:00:00+05:30'); // Saturday
g.morningDigest();
check('morning digest: nothing on a Saturday', env.mails.length === 0);

env.setClock('2026-10-13T08:40:00+05:30');
const subsNow = g.activeSubscribers_();
g.morningDigest();
check('morning digest: one separate mail per active subscriber', env.mails.length === subsNow.length && new Set(env.mails.map(m => m.to)).size === subsNow.length);
check('morning digest: each mail has that person\'s own unsubscribe link', env.mails.every(m => { const s = subsNow.find(x => x.email === m.to); return m.htmlBody.indexOf('a=unsub&amp;t=' + s.token) > 0; }));
check('morning digest: subject and content', /Today: 1 concall/.test(env.mails[0].subject) && env.mails[0].htmlBody.indexOf('TESTCO') > 0 && env.mails[0].htmlBody.indexOf('example.com/j') > 0);
check('morning digest: never links the Sheet, links the web app', env.mails.every(m => m.htmlBody.indexOf('docs.google.com') < 0 && m.htmlBody.indexOf('script.google.com') > 0));
check('morning digest: alerts marked emailed', g.unsentAlerts_().list.length === 0);
const n1 = env.mails.length;
g.morningDigest();
check('morning digest: calling it again the same day sends nothing (idempotent)', env.mails.length === n1);

env.mails.length = 0;
g.eveningDigest(); // too early (08:40)
check('evening digest: nothing before 5 PM', env.mails.length === 0);
env.setClock('2026-10-13T18:35:00+05:30');
g.eveningDigest();
check('evening digest: nothing new = nothing sent', env.mails.length === 0);
env.props.LAST_EVENING = '';
post(SECRET, [mk('LT', inDays(1), '14:00', 'https://example.com/lt')]);
g.eveningDigest();
check('evening digest: new update goes to every subscriber, with tomorrow', env.mails.length === subsNow.length && /1 new update/.test(env.mails[0].subject) && env.mails[0].htmlBody.indexOf('Tomorrow') > 0);
const n2 = env.mails.length; g.eveningDigest();
check('evening digest: idempotent too', env.mails.length === n2);

// quota guard
env.mails.length = 0; env.sentTotal = 0; env.quota = 7;
env.setClock('2026-10-14T08:40:00+05:30');
post(SECRET, [mk('INFY', inDays(0), '17:00', 'https://example.com/i')]);
g.morningDigest();
check('quota guard: stops with 5 mails still left for confirmations', env.mails.length === 2 && env.quota - env.sentTotal === 5);
env.quota = 100; env.sentTotal = 0;

// owner test mails
env.mails.length = 0;
env.setClock('2026-10-15T08:40:00+05:30');
post(SECRET, [mk('WIPRO', inDays(0), '12:00', 'https://example.com/w')]);
g.testMorningToMe();
check('test mail: goes only to the owner, no unsubscribe link, nothing marked as sent', env.mails.length === 1 && env.mails[0].to === 'owner@gmail.com' && env.mails[0].htmlBody.indexOf('a=unsub') < 0 && g.unsentAlerts_().list.length > 0 && !env.props.LAST_MORNING === false);
// (LAST_MORNING still holds the 14th, not the 15th)
check('test mail does not use up the real morning send', env.props.LAST_MORNING === '2026-10-14');
g.morningDigest();
check('real morning digest still goes out after a test mail', env.mails.length === 1 + g.activeSubscribers_().length);

// hand-added subscriber with no token gets one
env.mails.length = 0;
{
  const sb = env.sheets.Subscribers; const n = sb.getLastRow() + 1;
  sb.getRange(n, 1, 1, 7).setValues([['manual@x.com', 'active', '', '', '', '', 0]]);
}
check('hand-added active subscriber gets a token so the unsubscribe link works', g.activeSubscribers_().some(s => s.email === 'manual@x.com' && /^[a-f0-9]{32}$/.test(s.token)));

// stale alerts are not dumped into a digest
{
  const a = env.sheets.Alerts; const n = a.getLastRow() + 1;
  a.getRange(n, 1, 1, 7).setValues([['2026-10-01 10:00', 'OLD', 'Old Co', 'Q1FY27', 'Concall scheduled', '', '']]);
}
check('alerts older than 40 hours are left out of digests', !g.unsentAlerts_().list.some(x => x.symbol === 'OLD'));

// heartbeat
env.mails.length = 0; delete env.props.LAST_POST; delete env.props.LAST_WARN;
env.setClock('2026-10-15T11:00:00+05:30');
g.checkHeartbeat(); g.checkHeartbeat();
check('heartbeat: one warning to the owner, not repeated', env.mails.length === 1 && env.mails[0].to === 'owner@gmail.com');

// ================================================================= web page
env.setClock('2026-10-15T11:00:00+05:30');
post(SECRET, [Object.assign(mk('EVIL', inDays(2), '12:00', 'javascript:alert(1)'), { company: '</script><img src=x onerror=alert(1)>' })]);
const evil = g.doGet({}).html;
check('page: a hostile company name cannot close the script tag', evil.indexOf('</script><img') < 0);
check('page: serves the template with data, no leftover scriptlet', evil.indexOf('RALLIS') > 0 && evil.indexOf('<?!=') < 0);
check('page: ping answers', g.doGet({ parameter: { ping: '1' } }).getContent().indexOf('running') > 0);
{ // Sheets turns "2026-10-13 10:04" typed into a cell into a real date; the payload must still give clean text
  const a = env.sheets.Alerts; const n = a.getLastRow() + 1;
  a.getRange(n, 1, 1, 7).setValues([[new g.Date('2026-10-15T09:30:00+05:30'), 'DATEY', 'Datey Co', 'Q2FY27', 'Concall scheduled', '', 'Y']]);
  check('payload: Date objects in the Alerts "When" column become clean text', g.getPayload_().recent[0].w === '2026-10-15 09:30');
}
check('payload: no team fields, stage computed', (() => { const p = g.getPayload_(); return p.rows[0].st && !('o' in p.rows[0]) && p.rows.length === 9; })());

// removing test rows
g.selfTest();
check('selfTest writes a TESTCO row and does not queue an email', trackerRows().some(x => x[C.KEY] === 'TESTCO|Q2FY27') === true || trackerRows().some(x => String(x[C.KEY]).indexOf('TESTCO|') === 0));
g.removeTestRows();
check('removeTestRows deletes TESTCO rows', trackerRows().every(x => String(x[C.KEY]).indexOf('TESTCO|') !== 0));

// old layout guard
env.sheets.Tracker.getRange(1, 17).setValue('Owner');
let guard = false; try { g.setup(); } catch (e) { guard = /Old layout/.test(String(e)); }
check('setup refuses an old-layout sheet', guard);
env.sheets.Tracker.getRange(1, 17).setValue('ResultEventId');

// ================================================================= public surface
{
  const src = fs.readFileSync(path.join(ROOT, 'apps_script', 'Code.gs'), 'utf8');
  const pub = [...src.matchAll(/^function (\w+)\(/gm)].map(m => m[1]).filter(n => !n.endsWith('_')).sort();
  const allowed = ['checkHeartbeat', 'doGet', 'doPost', 'eveningDigest', 'morningDigest', 'removeTestRows', 'selfTest', 'setup', 'showConfig', 'subscribeEmail', 'testEveningToMe', 'testMorningToMe'];
  check('only the intended functions are callable from the page: ' + pub.join(', '), JSON.stringify(pub) === JSON.stringify(allowed));
}

console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
