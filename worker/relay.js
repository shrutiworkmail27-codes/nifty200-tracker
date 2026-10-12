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

    const upstream = await fetch(t.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.nseindia.com/',
      },
    });

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
  },
};
