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

function injectBase(buf) {
  const html = buf.toString('utf8');
  // Insert <base> as the FIRST child of <head> so subsequent relative URLs
  // are resolved against /eosdash/. If <head> is missing (shouldn't happen
  // for EOSdash), fall through unchanged.
  const headIdx = html.search(/<head\b[^>]*>/i);
  if (headIdx === -1) return buf;
  const headEnd = html.indexOf('>', headIdx) + 1;
  const inject = '<base href="/eosdash/">';
  return Buffer.from(html.slice(0, headEnd) + inject + html.slice(headEnd), 'utf8');
}

export function isEosdashRequest(pathname) {
  return pathname === PROXY_PREFIX || pathname.startsWith(PROXY_PREFIX + '/');
}

export function createEosdashProxy(ctx) {
  const { pushLog } = ctx;

  return function handleEosdashRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Strip /eosdash prefix; preserve query string and trailing slash.
    let upstreamPath = url.pathname.slice(PROXY_PREFIX.length) || '/';
    if (upstreamPath === '') upstreamPath = '/';
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
      const contentType = String(upstreamRes.headers['content-type'] || '');
      const isHtml = contentType.includes('text/html');
      const responseHeaders = { ...upstreamRes.headers };
      // Allow iframe embedding from the DVhub origin.
      delete responseHeaders['x-frame-options'];
      // Drop hop-by-hop on response side too.
      delete responseHeaders.connection;
      delete responseHeaders['transfer-encoding'];

      if (!isHtml) {
        // Stream verbatim — fast path for assets/JSON.
        res.writeHead(status, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }

      // Buffer HTML, inject <base>, send.
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const original = Buffer.concat(chunks);
        const modified = injectBase(original);
        // Content-Length must reflect modified body length.
        responseHeaders['content-length'] = String(modified.length);
        res.writeHead(status, responseHeaders);
        res.end(modified);
      });
      upstreamRes.on('error', (e) => {
        pushLog('eosdash_proxy_error', { phase: 'upstream_response', error: e.message });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        try { res.end('EOSdash proxy: upstream response error'); } catch { /* ignore */ }
      });
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
