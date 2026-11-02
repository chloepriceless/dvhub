// services/eosdash-proxy.js — Phase 21 (operator request 2026-05-23).
//
// Reverse-proxy DVhub-host:/eosdash/* → 127.0.0.1:8504/* so EOSdash (which
// only binds to localhost by default) is reachable through the DVhub HTTP
// listener. Lets the operator configure EOS auto-optimization without an
// SSH tunnel and embeds the EOSdash UI as a Settings tab iframe.
//
// Behaviour:
//   - Strips the /eosdash prefix before forwarding.
//   - For HTML responses, injects <base href="/eosdash/"> into <head> so
//     htmx + relative URLs inside EOSdash route back through the proxy.
//   - Streams all other content types verbatim (no body modification).
//   - Preserves request method, query string, headers (sans Host), body.
//   - Forwards response status, headers and body; framing only from DVhub
//     itself (SAMEORIGIN / frame-ancestors 'self', Strix W2).
//   - Logs failures via pushLog('eosdash_proxy_error') — never throws to
//     the dispatcher.

import http from 'node:http';

const EOSDASH_HOST = '127.0.0.1';
const EOSDASH_PORT = 8504;
const PROXY_PREFIX = '/eosdash';
const TIMEOUT_MS = 30_000;

// injectBase removed 2026-05-23: with the corrected path mapping (no prefix
// strip on /eosdash/<sub>), EOSdash's absolute /eosdash/* paths already
// resolve correctly through the proxy. A <base> tag would only affect
// RELATIVE URLs, and adding one risks breaking edge-case relative paths
// inside EOSdash's HTML.

export function isEosdashRequest(pathname) {
  return pathname === PROXY_PREFIX || pathname.startsWith(PROXY_PREFIX + '/');
}

// Strix W2 (30.10.2026): der Proxy läuft vor handleRequest, SECURITY_HEADERS
// greifen hier nicht — vorher ging jede EOSdash-Antwort ohne Framing-Schutz
// hinaus (Clickjacking unter lanTrust „Offen“). Einbetten nur von DVhub selbst
// (der iframe unter Einstellungen → EOS ist same-origin), nosniff, kein
// Referrer. Bewusst NICHT die volle DVhub-CSP: EOSdash bettet Bokeh-JavaScript
// inline ein, script-src 'self' bräche die Diagramme. Eine CSP von EOSdash
// bleibt, nur frame-ancestors setzt DVhub.
const FRAME_ANCESTORS = "frame-ancestors 'self'";
export function withEosdashSecurityHeaders(headers = {}) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (['x-frame-options', 'x-content-type-options', 'referrer-policy'].includes(k.toLowerCase())) delete out[k];
  }
  const cspKey = Object.keys(out).find((k) => k.toLowerCase() === 'content-security-policy');
  // Mehrere Richtlinien kommen komma-getrennt (Node fasst doppelte Kopfzeilen
  // so zusammen): frame-ancestors aus JEDER entfernen, sonst gälte in einer
  // zweiten Richtlinie z. B. `frame-ancestors *` (Gegenprüfung 68ea4b79).
  const upstreamCsp = cspKey ? [].concat(out[cspKey]).join(', ') : '';
  if (cspKey) delete out[cspKey];
  const policies = upstreamCsp.split(',')
    .map((pol) => pol.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d)).join('; '))
    .filter(Boolean);
  if (policies.length) policies[policies.length - 1] += `; ${FRAME_ANCESTORS}`;
  else policies.push(FRAME_ANCESTORS);
  out['content-security-policy'] = policies.join(', ');
  out['x-frame-options'] = 'SAMEORIGIN';
  out['x-content-type-options'] = 'nosniff';
  // same-origin statt no-referrer: bei no-referrer schicken Browser auf
  // Formular-POSTs Origin: null — das Schreibtor lehnte dann EOSdash-eigene
  // Formulare ab (Gegenprüfung 68ea4b79). Nach außen geht weiter kein Referrer.
  out['referrer-policy'] = 'same-origin';
  return out;
}

export function createEosdashProxy(ctx, { port = EOSDASH_PORT } = {}) {
  const { pushLog } = ctx;

  return function handleEosdashRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // EOSdash path mapping is asymmetric:
    //   `/`                     → root page (200)
    //   `/eosdash/<sub>`        → htmx subpages (200) — already prefixed!
    //   `/eosdash` or `/eosdash/` → 404 (no upstream route)
    // So: the iframe's entry-point request (`/eosdash/`) must be rewritten
    // to `/`, while every other `/eosdash/...` is forwarded VERBATIM (no
    // prefix strip) because upstream's htmx handlers already expect the
    // /eosdash prefix.
    let upstreamPath;
    if (url.pathname === PROXY_PREFIX || url.pathname === PROXY_PREFIX + '/') {
      upstreamPath = '/';
    } else {
      upstreamPath = url.pathname || '/';
    }
    if (url.search) upstreamPath += url.search;

    // Build upstream headers — drop Host (will be set by http.request) and
    // drop hop-by-hop headers per RFC 7230.
    const upstreamHeaders = { ...req.headers };
    delete upstreamHeaders.host;
    delete upstreamHeaders.connection;
    delete upstreamHeaders['proxy-connection'];
    delete upstreamHeaders['keep-alive'];
    delete upstreamHeaders.upgrade;
    upstreamHeaders.host = `${EOSDASH_HOST}:${port}`;

    const upstreamReq = http.request({
      host: EOSDASH_HOST,
      port,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders,
      timeout: TIMEOUT_MS,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      // Einbetten nur von DVhub selbst (W2) — der iframe ist same-origin.
      const responseHeaders = withEosdashSecurityHeaders(upstreamRes.headers);
      // Drop hop-by-hop on response side too.
      delete responseHeaders.connection;
      delete responseHeaders['transfer-encoding'];

      // Stream all responses verbatim — no body modification needed since
      // EOSdash's internal paths are already absolute /eosdash/* URLs and
      // we forward them 1:1 (see path-mapping comment above).
      res.writeHead(status, responseHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (e) => {
      pushLog('eosdash_proxy_error', { phase: 'upstream_request', error: e.message, path: upstreamPath });
      if (!res.headersSent) {
        res.writeHead(502, withEosdashSecurityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      }
      try { res.end(`EOSdash proxy: cannot reach EOSdash at ${EOSDASH_HOST}:${port} — is the service running?`); } catch { /* ignore */ }
    });

    upstreamReq.on('timeout', () => {
      pushLog('eosdash_proxy_error', { phase: 'timeout', path: upstreamPath });
      upstreamReq.destroy(new Error('eosdash_timeout'));
    });

    // Pipe the inbound body to upstream.
    req.pipe(upstreamReq);
  };
}
