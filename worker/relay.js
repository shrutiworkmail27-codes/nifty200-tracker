// Locked NSE relay for the Nifty 200 tracker.
// Deploy as a NEW Worker (do not edit your old one).
// Add a secret named RELAY_KEY in Worker -> Settings -> Variables and Secrets.
//
// Usage: GET https://<worker>/?url=<nseindia.com url>   with header  X-Relay-Key: <RELAY_KEY>

export default {
  async fetch(request, env) {
    if (!env.RELAY_KEY || request.headers.get('X-Relay-Key') !== env.RELAY_KEY) {
      return new Response('forbidden', { status: 403 });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing url', { status: 400 });

    let t;
    try {
      t = new URL(target);
    } catch (e) {
      return new Response('bad url', { status: 400 });
    }

    // Only NSE hosts over https. Blocks use as an open proxy.
    const host = t.hostname.toLowerCase();
    const okHost = host === 'nseindia.com' || host.endsWith('.nseindia.com');
    if (t.protocol !== 'https:' || !okHost) {
      return new Response('host not allowed', { status: 403 });
    }

    const browser = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.nseindia.com/',
    };
    const headers = Object.assign({}, browser);

    // NSE's /api/ endpoints need cookies from a normal page visit first (used by the one-time backfill).
    if (host === 'www.nseindia.com' && t.pathname.startsWith('/api/')) {
      const home = await fetch('https://www.nseindia.com/companies-listing/corporate-filings-announcements', {
        headers: Object.assign({}, browser, { Accept: 'text/html,application/xhtml+xml' }),
      });
      const jar = (home.headers.getSetCookie ? home.headers.getSetCookie() : [])
        .map((c) => c.split(';')[0])
        .join('; ');
      headers.Cookie = jar;
      headers.Accept = 'application/json, text/plain, */*';
      headers.Referer = 'https://www.nseindia.com/companies-listing/corporate-filings-announcements';
    }

    const upstream = await fetch(t.toString(), { headers });

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
  },
};
