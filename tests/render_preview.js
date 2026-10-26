// Builds the web page exactly as Code.gs would serve it, filled with SAMPLE data (made-up dates), for screenshots.
//   node tests/render_preview.js <out_dir>          -> page.html (full) and page_empty.html (before any data)
'use strict';
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./gas_mock');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node tests/render_preview.js <out_dir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

function boot() {
  const env = createEnv(ROOT);
  env.load();
  env.sandbox.setup();
  return env;
}
const post = (env, body) => JSON.parse(env.sandbox.doPost({ postData: { contents: JSON.stringify(Object.assign({ secret: env.props.SECRET }, body)) } }).getContent());

// ---------------------------------------------------------------- empty page (fresh install)
{
  const env = boot();
  env.sandbox.doGet({});
  fs.writeFileSync(path.join(OUT, 'page_empty.html'), env.lastPage);
}

// ---------------------------------------------------------------- full page
const IT = 'Information Technology', FIN = 'Financial Services', OIL = 'Oil Gas & Consumable Fuels', FMCG = 'Fast Moving Consumer Goods',
  AUTO = 'Automobile and Auto Components', PHARMA = 'Healthcare', CG = 'Capital Goods', MET = 'Metals & Mining', POW = 'Power',
  CHEM = 'Chemicals', CD = 'Consumer Durables', CS = 'Consumer Services', CON = 'Construction', CM = 'Construction Materials',
  RE = 'Realty', TEL = 'Telecommunication', SERV = 'Services';
const N50 = 'Nifty 50', NX = 'Next 50', MID = 'Midcap';
const U = [
  ['RELIANCE', 'Reliance Industries Ltd.', OIL, N50], ['TCS', 'Tata Consultancy Services Ltd.', IT, N50], ['HDFCBANK', 'HDFC Bank Ltd.', FIN, N50],
  ['ICICIBANK', 'ICICI Bank Ltd.', FIN, N50], ['INFY', 'Infosys Ltd.', IT, N50], ['HINDUNILVR', 'Hindustan Unilever Ltd.', FMCG, N50],
  ['ITC', 'ITC Ltd.', FMCG, N50], ['SBIN', 'State Bank of India', FIN, N50], ['BHARTIARTL', 'Bharti Airtel Ltd.', TEL, N50],
  ['KOTAKBANK', 'Kotak Mahindra Bank Ltd.', FIN, N50], ['LT', 'Larsen & Toubro Ltd.', CON, N50], ['AXISBANK', 'Axis Bank Ltd.', FIN, N50],
  ['ASIANPAINT', 'Asian Paints Ltd.', CD, N50], ['MARUTI', 'Maruti Suzuki India Ltd.', AUTO, N50], ['SUNPHARMA', 'Sun Pharmaceutical Industries Ltd.', PHARMA, N50],
  ['TITAN', 'Titan Company Ltd.', CD, N50], ['ULTRACEMCO', 'UltraTech Cement Ltd.', CM, N50], ['WIPRO', 'Wipro Ltd.', IT, N50],
  ['HCLTECH', 'HCL Technologies Ltd.', IT, N50], ['NESTLEIND', 'Nestle India Ltd.', FMCG, N50], ['M&M', 'Mahindra & Mahindra Ltd.', AUTO, N50],
  ['POWERGRID', 'Power Grid Corporation of India Ltd.', POW, N50], ['NTPC', 'NTPC Ltd.', POW, N50], ['TATASTEEL', 'Tata Steel Ltd.', MET, N50],
  ['JSWSTEEL', 'JSW Steel Ltd.', MET, N50], ['ADANIPORTS', 'Adani Ports and SEZ Ltd.', SERV, N50], ['BAJFINANCE', 'Bajaj Finance Ltd.', FIN, N50],
  ['DMART', 'Avenue Supermarts Ltd.', CS, NX], ['HAL', 'Hindustan Aeronautics Ltd.', CG, NX], ['SIEMENS', 'Siemens Ltd.', CG, NX],
  ['PIDILITIND', 'Pidilite Industries Ltd.', CHEM, NX], ['GODREJCP', 'Godrej Consumer Products Ltd.', FMCG, NX], ['DABUR', 'Dabur India Ltd.', FMCG, NX],
  ['HAVELLS', 'Havells India Ltd.', CD, NX], ['ABB', 'ABB India Ltd.', CG, NX], ['TORNTPHARM', 'Torrent Pharmaceuticals Ltd.', PHARMA, NX],
  ['LODHA', 'Macrotech Developers Ltd.', RE, NX], ['TVSMOTOR', 'TVS Motor Company Ltd.', AUTO, NX], ['INDIGO', 'InterGlobe Aviation Ltd.', SERV, NX],
  ['CHOLAFIN', 'Cholamandalam Investment and Finance Company Ltd.', FIN, NX], ['IRCTC', 'Indian Railway Catering And Tourism Corporation Ltd.', SERV, NX],
  ['PERSISTENT', 'Persistent Systems Ltd.', IT, MID], ['COFORGE', 'Coforge Ltd.', IT, MID], ['MPHASIS', 'Mphasis Ltd.', IT, MID],
  ['AUBANK', 'AU Small Finance Bank Ltd.', FIN, MID], ['FEDERALBNK', 'The Federal Bank Ltd.', FIN, MID], ['POLYCAB', 'Polycab India Ltd.', CG, MID],
  ['ASTRAL', 'Astral Ltd.', CG, MID], ['OBEROIRLTY', 'Oberoi Realty Ltd.', RE, MID], ['ESCORTS', 'Escorts Kubota Ltd.', CG, MID],
  ['LUPIN', 'Lupin Ltd.', PHARMA, MID], ['AUROPHARMA', 'Aurobindo Pharma Ltd.', PHARMA, MID], ['SAIL', 'Steel Authority of India Ltd.', MET, MID],
  ['NMDC', 'NMDC Ltd.', MET, MID], ['TATACOMM', 'Tata Communications Ltd.', TEL, MID], ['VOLTAS', 'Voltas Ltd.', CD, MID],
  ['JUBLFOOD', 'Jubilant Foodworks Ltd.', CS, MID], ['PIIND', 'PI Industries Ltd.', CHEM, MID], ['BALKRISIND', 'Balkrishna Industries Ltd.', AUTO, MID],
];
const universe = U.map(u => ({ s: u[0], n: u[1], i: u[2], g: u[3] }));
const info = Object.fromEntries(U.map(u => [u[0], { company: u[1], industry: u[2] }]));

const env = boot();
const g = env.sandbox;
const day = n => g.addDays_(g.today_(), n);
const link = s => 'https://services.choruscall.in/DiamondPassRegistration/register?id=' + s;
const call = (sym, d, t, l, mode) => Object.assign({ kind: 'concall', symbol: sym, quarter: 'Q2FY27', date: day(d), time: t, mode: mode || 'Virtual', link: l === undefined ? link(sym) : l, call_name: 'Q2 FY27 earnings call', filing_url: 'https://nsearchives.nseindia.com/corporate/xbrl/' + sym + '.xml' }, info[sym]);
const res = (sym, d) => Object.assign({ kind: 'result', symbol: sym, quarter: 'Q2FY27', date: day(d), filing_url: 'https://nsearchives.nseindia.com/corporate/xbrl/PIBM_' + sym + '.xml' }, info[sym]);

const events = [
  call('LT', -3, '15:00'), { kind: 'post', symbol: 'LT', quarter: 'Q2FY27', filing_url: 'https://nsearchives.nseindia.com/corporate/LT_transcript.pdf', post_label: 'Transcript', company: info.LT.company, industry: info.LT.industry },
  call('WIPRO', -1, '17:30'),
  // today: a spread of times so any hour shows past / live / upcoming
  call('PERSISTENT', 0, '09:30'), call('MPHASIS', 0, '11:00'), call('COFORGE', 0, '13:30'), call('HCLTECH', 0, '15:00'), call('INFY', 0, '16:30'),
  call('HDFCBANK', 0, '17:00'), call('KOTAKBANK', 0, '18:00'), call('ICICIBANK', 0, '19:30'),
  res('HDFCBANK', 0), res('ASIANPAINT', 0), res('NESTLEIND', 0),
  // the week ahead
  call('TCS', 1, '19:30'), call('ABB', 1, '10:00', ''), call('AUBANK', 1, '', 'https://example.com/au'), res('MARUTI', 1), res('SUNPHARMA', 1),
  call('HINDUNILVR', 2, '14:00'), call('ITC', 2, '16:00'), call('M&M', 2, '11:30'), res('RELIANCE', 2),
  call('SBIN', 3, '15:30'), call('AXISBANK', 3, '10:30'), res('TITAN', 3), res('LUPIN', 3), res('DABUR', 3),
  call('RELIANCE', 4, '17:30'), call('BHARTIARTL', 4, '12:00'), call('DMART', 4, '16:00', 'Dial 022-5555 1234'),
  call('SIEMENS', 5, '11:00'), call('HAL', 5, '15:00'), res('POLYCAB', 5),
  call('TATASTEEL', 7, '10:00'), call('JSWSTEEL', 7, '15:30'), call('ULTRACEMCO', 8, '16:00'), res('TATASTEEL', 8),
  call('BAJFINANCE', 10, '18:00'), res('ESCORTS', 10), call('NTPC', 12, '15:00'), call('POWERGRID', 14, '11:00'), res('LODHA', 15),
  call('PIDILITIND', 18, '16:00'), call('TVSMOTOR', 20, '11:00'), res('INDIGO', 22), call('INDIGO', 23, '17:00'),
];
const r1 = post(env, { universe, events });
if (!r1.ok) { console.error('post failed', r1); process.exit(1); }
g.doGet({});
fs.writeFileSync(path.join(OUT, 'page.html'), env.lastPage);
console.log('events:', events.length, 'universe:', universe.length, 'page bytes:', env.lastPage.length);
