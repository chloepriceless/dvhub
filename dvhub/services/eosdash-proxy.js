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
//   - Forwards response status, headers (sans X-Frame-Options so iframe
//     works), and body.
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

export function createEosdashProxy(ctx) {
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
    upstreamHeaders.host = `${EOSDASH_HOST}:${EOSDASH_PORT}`;

    const upstreamReq = http.request({
      host: EOSDASH_HOST,
      port: EOSDASH_PORT,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders,
      timeout: TIMEOUT_MS,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const responseHeaders = { ...upstreamRes.headers };
      // Allow iframe embedding from the DVhub origin.
      delete responseHeaders['x-frame-options'];
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
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      try { res.end('EOSdash proxy: cannot reach EOSdash at 127.0.0.1:8504 — is the service running?'); } catch { /* ignore */ }
    });

    upstreamReq.on('timeout', () => {
      pushLog('eosdash_proxy_error', { phase: 'timeout', path: upstreamPath });
      upstreamReq.destroy(new Error('eosdash_timeout'));
    });

    // Pipe the inbound body to upstream.
    req.pipe(upstreamReq);
  };
}
