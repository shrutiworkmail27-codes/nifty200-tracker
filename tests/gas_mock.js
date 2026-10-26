// Hand-made fakes of Google's Apps Script services, so Code.gs can be run and tested in plain Node.
// This is NOT the real Google runtime. It catches logic errors, wrong row maths and API-shape mistakes.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function createEnv(root) {
  const RealDate = Date;
  const env = {
    offset: 0, mails: [], calEvents: {}, props: {}, triggers: [], sheets: {},
    quota: 100, sentTotal: 0, anon: false, lockBusy: false, lastPage: null,
  };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + env.offset); else super(...a); }
    static now() { return RealDate.now() + env.offset; }
  }
  /** Pin "now" to an IST wall-clock time, e.g. env.setClock('2026-10-13T08:40:00+05:30'). */
  env.setClock = iso => { env.offset = new RealDate(iso).getTime() - RealDate.now(); };

  // ---------- Utilities.formatDate in IST (the only zone Code.gs uses)
  function fmt(date, tz, pattern) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(date).forEach(x => { p[x.type] = x.value; });
    const mon = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'short' }).format(date);
    const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
    const map = { yyyy: p.year, MMM: mon, MM: p.month, dd: p.day, d: String(Number(p.day)), HH: p.hour, H: String(Number(p.hour)), mm: p.minute, EEE: p.weekday, u: String(iso) };
    return pattern.replace(/yyyy|MMM|MM|dd|d|HH|H|mm|EEE|u/g, t => map[t]);
  }

  // ---------- fake sheets
  function chain(target) {
    const prox = new Proxy(target, { get: (t, k) => (k in t ? t[k] : (k === 'then' || typeof k === 'symbol' ? undefined : () => prox)) });
    return prox;
  }
  const COLS = 30;
  function makeSheet(name, rows) {
    const sh = { name, data: Array.from({ length: rows }, () => Array(COLS).fill('')) };
    sh.getMaxRows = () => sh.data.length;
    sh.getLastRow = () => { for (let i = sh.data.length - 1; i >= 0; i--) if (sh.data[i].some(v => v !== '')) return i + 1; return 0; };
    sh.insertRowsAfter = (n, k) => { for (let i = 0; i < k; i++) sh.data.splice(n, 0, Array(COLS).fill('')); };
    sh.deleteRow = r => { sh.data.splice(r - 1, 1); };
    sh.getFilter = () => null;
    sh.getRange = (r, c, nr, nc) => {
      if (typeof r === 'string') { r = 1; c = 1; }
      nr = nr || 1; nc = nc || 1;
      if (r + nr - 1 > sh.data.length) throw new Error('Range out of bounds: row ' + (r + nr - 1) + ' > ' + sh.data.length);
      if (c + nc - 1 > COLS) throw new Error('Range out of bounds: col ' + (c + nc - 1));
      const rng = {
        getValues: () => sh.data.slice(r - 1, r - 1 + nr).map(row => row.slice(c - 1, c - 1 + nc)),
        setValues: v => {
          if (v.length !== nr || v[0].length !== nc) throw new Error('setValues shape ' + v.length + 'x' + v[0].length + ' vs range ' + nr + 'x' + nc);
          v.forEach((row, i) => row.forEach((x, j) => { sh.data[r - 1 + i][c - 1 + j] = x; }));
          return prox;
        },
        getValue: () => sh.data[r - 1][c - 1],
        setValue: x => { sh.data[r - 1][c - 1] = x; return prox; },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.data[r - 1 + i][c - 1 + j] = ''; return prox; },
      };
      const prox = chain(rng);
      return prox;
    };
    return chain(sh);
  }
  const ssObj = {
    getSheetByName: n => env.sheets[n] || null,
    insertSheet: n => (env.sheets[n] = makeSheet(n, 1000)),
    getSheets: () => Object.values(env.sheets),
    deleteSheet: s => { delete env.sheets[s.name]; },
    getUrl: () => 'https://docs.google.com/spreadsheets/d/SECRET-SHEET-ID/edit',
    setSpreadsheetTimeZone: () => {},
  };

  function calApi() {
    const mk = (name, extra) => { const id = 'ev' + (Object.keys(env.calEvents).length + 1 + Math.floor(Math.random() * 1e6)); env.calEvents[id] = Object.assign({ name }, extra); return { getId: () => id }; };
    return {
      createAllDayEvent: (name, d, o) => mk(name, { allDay: true, d, o }),
      createEvent: (name, s, e, o) => mk(name, { allDay: false, s, e, o }),
      getEventById: id => (env.calEvents[id] ? { deleteEvent: () => { delete env.calEvents[id]; } } : null),
    };
  }

  const sandbox = {
    console, JSON, Math, Intl, Object, Number, String, Array, Promise, RegExp, Error, isNaN, parseInt, parseFloat,
    Date: FakeDate,
    SpreadsheetApp: { getActive: () => ssObj },
    Utilities: { formatDate: fmt, getUuid: () => crypto.randomUUID() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in env.props ? env.props[k] : null), setProperty: (k, v) => { env.props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => !env.lockBusy, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: t => ({ text: t, setMimeType() { return this; }, getContent() { return t; } }),
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: n => {
        const t = {
          evaluate() {
            const html = fs.readFileSync(path.join(root, 'apps_script', n + '.html'), 'utf8').replace('<?!= payload ?>', () => t.payload);
            env.lastPage = html;
            return { html, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } };
          },
        };
        return t;
      },
      createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }),
    },
    MailApp: {
      sendEmail: (o, subject, body) => {
        if (typeof o === 'string') o = { to: o, subject, htmlBody: body };
        env.mails.push(o);
        env.sentTotal++;
      },
      getRemainingDailyQuota: () => env.quota - env.sentTotal,
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'owner@gmail.com' }),
      getActiveUser: () => ({ getEmail: () => (env.anon ? '' : 'owner@gmail.com') }),
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }),
      getProjectTriggers: () => [], deleteTrigger: () => {},
      newTrigger: fn => { const b = new Proxy({}, { get: (t, k) => (k === 'create' ? () => env.triggers.push(fn) : () => b) }); return b; },
    },
    CalendarApp: {
      createCalendar: () => ({ getId: () => 'cal123@group.calendar.google.com', ...calApi() }),
      getCalendarById: () => ({ getId: () => 'cal123@group.calendar.google.com', ...calApi() }),
    },
    Logger: { log: () => {} },
  };
  vm.createContext(sandbox);
  env.sandbox = sandbox;
  env.codePath = path.join(root, 'apps_script', 'Code.gs');
  env.load = () => vm.runInContext(fs.readFileSync(env.codePath, 'utf8'), sandbox, { filename: 'Code.gs' });
  /** Read a top-level const/let of Code.gs (those are not properties of the sandbox). */
  env.get = expr => vm.runInContext(expr, sandbox);
  return env;
}

module.exports = { createEnv };
