# Phase 9: HTTP Enhancements & Caching - Research

**Researched:** 2026-03-29
**Domain:** Node.js native HTTP server (no framework), response headers, access logging, browser caching
**Confidence:** HIGH

## Summary

Phase 9 adds four capabilities to the existing vanilla Node.js HTTP server: a public `/health` endpoint for Uptime Kuma, correct `Content-Length` headers for text/JSON responses (critical for German Umlauts), access logging via `res.on('finish')`, and `Cache-Control` headers for static assets.

All four requirements are straightforward Node.js HTTP primitives with no new dependencies. The codebase already has the exact integration points identified: the `json()` and `text()` helper functions in `routes-api.js` (lines 114-122) for Content-Length, the `handleRequest()` function (line 573) for the health route, the `servePage()` and `serveStatic()` functions (lines 540-570) for cache headers, and the `http.createServer()` callback in `server.js` (line 717) for access logging.

**Primary recommendation:** Implement all four requirements by modifying only `routes-api.js` and `server.js`. No new files, no new dependencies. The critical pitfall is HTTP-02: `Buffer.byteLength(body, 'utf8')` must be used instead of `body.length` because German Umlauts (ae, oe, ue, ss) occupy 2 bytes in UTF-8 but are 1 JavaScript string character.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| HTTP-01 | GET /health Endpoint antwortet ohne Auth mit 200 und JSON-Status | Route must be placed BEFORE the auth/rate-limit guard at line 578. Existing `adminHealthPayload()` provides a reference pattern. Response: `{ ok: bool, uptimeSec: N, version: string\|null }`. `process.uptime()` already used in admin health (line 56). `ctx.getAppVersion().versionLabel` provides version string. |
| HTTP-02 | JSON/Text Responses enthalten Content-Length Header via `Buffer.byteLength(body, 'utf8')` | The `json()` (line 114) and `text()` (line 119) helpers currently call `res.end(body)` without Content-Length. Also affects `downloadJson()` (line 124). Buffer.byteLength is a Node.js built-in, no import needed. |
| HTTP-03 | Alle HTTP Requests werden geloggt (Methode, Pfad, Status, Dauer) via `res.on('finish')` | Access logging must be added in `server.js` line ~719, inside the `http.createServer` callback, BEFORE any route handling. `res.on('finish')` fires after response is fully sent. Timestamp at request start, diff on finish. |
| FE-03 | Static Assets (JS, CSS) werden mit Cache-Control Headers ausgeliefert | `serveStatic()` (line 550) and `servePage()` (line 540) currently set no Cache-Control. Per requirement: `no-store` for setup.html, `no-cache` for index.html, `max-age=3600` for JS/CSS. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `http` | Built-in (>=18) | HTTP server | Already in use, no framework |
| Node.js `Buffer` | Built-in | `Buffer.byteLength()` for correct Content-Length | Global, no import needed |
| Node.js `process` | Built-in | `process.uptime()` for health endpoint | Already used in `adminHealthPayload()` |

### Supporting
No new dependencies required. All four requirements use Node.js built-ins already available in the codebase.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual Cache-Control | express static middleware | Overkill for 4 MIME types; project uses vanilla http |
| `res.on('finish')` | morgan/pino-http | Unnecessary dependency; 5 lines of code suffices |

## Architecture Patterns

### Existing Code Structure (no changes to structure)
```
dvhub/
  server.js          # HTTP server creation, CORS, error handling, access logging (NEW)
  routes-api.js      # All routes, json/text helpers, serveStatic, servePage
  server-utils.js    # Shared utilities
  public/            # Static assets (HTML, JS, CSS)
```

### Pattern 1: Route Placement for Public Endpoints
**What:** The `/health` endpoint must NOT require auth or rate limiting.
**When to use:** Any public endpoint that external monitors (Uptime Kuma, Docker HEALTHCHECK) must reach.
**Implementation detail:** In `handleRequest()`, the auth/rate-limit guard is at line 578:
```javascript
if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/dv/')) {
  if (!checkRateLimit(req, res)) return;
  if (!checkAuth(req, res)) return;
}
```
The `/health` route must be placed BEFORE this guard (between line 576 and 578) since it does NOT start with `/api/` or `/dv/`, it is naturally exempt. However, placing it early makes intent explicit.

### Pattern 2: Content-Length in Response Helpers
**What:** Serialize body to string first, then compute byte length, then set header.
**When to use:** Every `json()` and `text()` call.
**Example:**
```javascript
// CORRECT: Buffer.byteLength for UTF-8
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}
```

### Pattern 3: Access Logging via res.on('finish')
**What:** Attach a `finish` event listener at the start of request handling.
**When to use:** Every HTTP request.
**Example:**
```javascript
// In server.js, inside http.createServer callback, before any route handling
const start = Date.now();
res.on('finish', () => {
  const duration = Date.now() - start;
  console.log(`${req.method} ${url.pathname} ${res.statusCode} ${duration}ms`);
});
```
**Important:** `res.on('finish')` fires AFTER the response has been fully written to the OS. `res.statusCode` is available at that point.

### Pattern 4: Cache-Control Per File Type
**What:** Set Cache-Control header based on file extension and filename.
**When to use:** In `serveStatic()` and `servePage()`.
**Rules from requirement FE-03:**
| File/Pattern | Cache-Control Value | Reason |
|-------------|-------------------|--------|
| `setup.html` | `no-store` | Contains config wizard, must never be cached |
| `index.html` | `no-cache` | Dashboard, revalidate on every load |
| `*.js`, `*.css` | `max-age=3600` | Static assets, safe to cache 1 hour |
| Other (images, JSON) | No header (default) | Browser defaults are fine |

### Anti-Patterns to Avoid
- **Using `body.length` for Content-Length:** JavaScript string `.length` counts UTF-16 code units, not UTF-8 bytes. German Umlauts (ae=0xC3A4, oe=0xC3B6, ue=0xC3BC) are 1 JS char but 2 UTF-8 bytes. Using `.length` causes truncated responses.
- **Setting Content-Length on streamed responses:** `servePage()` and `serveStatic()` use `fs.createReadStream().pipe(res)`. Do NOT add Content-Length there -- streams handle their own framing via chunked transfer encoding. Content-Length is only for `res.end(body)` calls.
- **Logging before `finish`:** Don't log in the route handler. `res.statusCode` may not be set yet. Always use `res.on('finish')`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| UTF-8 byte counting | Manual char-by-char counting | `Buffer.byteLength(body, 'utf8')` | Handles all Unicode correctly including 3-4 byte chars |
| Access log formatting | Custom log parser | Simple `console.log` with method/path/status/duration | systemd journal captures stdout; no need for file rotation |
| Cache invalidation | Query-string versioning | `max-age=3600` is sufficient | Assets change only on deployment; 1h TTL is acceptable |

## Common Pitfalls

### Pitfall 1: Content-Length vs String Length (CRITICAL)
**What goes wrong:** `'Content-Length': body.length` sends wrong byte count for non-ASCII.
**Why it happens:** JS string `.length` returns UTF-16 code units. `"Uberschuss"` with Umlaut u (U+00FC) is 1 char but 2 UTF-8 bytes.
**How to avoid:** Always use `Buffer.byteLength(body, 'utf8')`.
**Warning signs:** Truncated JSON responses in browser, garbled last characters, `ERR_CONTENT_LENGTH_MISMATCH` in Chrome DevTools.

### Pitfall 2: Health Endpoint Behind Auth
**What goes wrong:** Uptime Kuma gets 401 instead of 200.
**Why it happens:** Route placed after the auth guard, or using `/api/health` path which triggers auth.
**How to avoid:** Use `/health` path (not `/api/health`). Place route handling BEFORE the `/api/` prefix check.
**Warning signs:** Uptime Kuma shows service as down despite server running.

### Pitfall 3: Access Logging Performance
**What goes wrong:** Logging every request including polling endpoints floods the log.
**Why it happens:** Dashboard polls `/api/status` and `/api/keepalive/*` every few seconds.
**How to avoid:** The requirement says "alle HTTP Requests" so log everything. But use `console.log` (single line) not `pushLog` (which stores in memory array and has a 1000-entry ring buffer). Access logs go to stdout/systemd journal only.
**Warning signs:** Memory growth if accidentally using `pushLog` for high-frequency requests.

### Pitfall 4: Cache-Control on setup.html via servePage
**What goes wrong:** `servePage()` serves both `setup.html` and `index.html` via the same code path. Different cache policies needed.
**Why it happens:** `servePage(res, filename)` currently ignores the filename for header purposes.
**How to avoid:** Add cache-control logic based on the `filename` parameter inside `servePage()`.
**Warning signs:** Setup wizard shows stale config after saving; or dashboard doesn't refresh on new data.

### Pitfall 5: Content-Length on downloadJson
**What goes wrong:** `downloadJson()` (line 124) also calls `res.end()` with a string body but has no Content-Length.
**Why it happens:** It's easy to miss because it uses pretty-printing (`JSON.stringify(payload, null, 2)`).
**How to avoid:** Apply the same `Buffer.byteLength` pattern to `downloadJson()`.
**Warning signs:** Config export files may be truncated if they contain Umlauts.

## Code Examples

### HTTP-01: Public /health Endpoint
```javascript
// In handleRequest(), BEFORE the /api/ auth guard
// Source: requirement HTTP-01 + existing adminHealthPayload() pattern at line 29
if (url.pathname === '/health' && req.method === 'GET') {
  return json(res, 200, {
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    version: ctx.getAppVersion().versionLabel || null
  });
}
```

### HTTP-02: Content-Length in json() Helper
```javascript
// Source: Node.js Buffer.byteLength docs + existing json() at line 114
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}
```

### HTTP-02: Content-Length in text() Helper
```javascript
// Source: existing text() at line 119
function text(res, code, payload) {
  const body = String(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}
```

### HTTP-02: Content-Length in downloadJson() Helper
```javascript
// Source: existing downloadJson() at line 124
function downloadJson(res, filename, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}
```

### HTTP-03: Access Logging in server.js
```javascript
// Source: Node.js http.ServerResponse 'finish' event docs
// Inside http.createServer callback, at line ~719, after URL parsing
const reqStart = Date.now();
res.on('finish', () => {
  const ms = Date.now() - reqStart;
  console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
});
```

### FE-03: Cache-Control in serveStatic()
```javascript
// Source: requirement FE-03 + existing serveStatic() at line 550
// Add cache-control logic before res.writeHead()
let cacheControl;
if (ext === '.html') {
  cacheControl = reqPath.includes('setup') ? 'no-store' : 'no-cache';
} else if (ext === '.js' || ext === '.css') {
  cacheControl = 'max-age=3600';
}

res.writeHead(200, {
  ...SECURITY_HEADERS,
  'content-type': mime,
  ...(cacheControl && { 'cache-control': cacheControl })
});
```

### FE-03: Cache-Control in servePage()
```javascript
// Source: requirement FE-03 + existing servePage() at line 540
// servePage only serves setup.html or index.html
const cacheControl = filename === 'setup.html' ? 'no-store' : 'no-cache';
res.writeHead(200, {
  ...SECURITY_HEADERS,
  'content-type': 'text/html; charset=utf-8',
  'cache-control': cacheControl
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No Content-Length | `Buffer.byteLength()` for correct framing | Always been best practice | Prevents truncated responses |
| No access logging | `res.on('finish')` pattern | Standard since Node.js v0.10 | Reliable status code capture |
| No cache headers | Per-type Cache-Control | HTTP/1.1 standard | Browser caching reduces load |

**No deprecated APIs:** All patterns used (`res.on('finish')`, `Buffer.byteLength`, `Cache-Control` header) are stable Node.js / HTTP features with no deprecation risk.

## Open Questions

None. All four requirements have clear integration points, exact line numbers, and established patterns in the codebase. The implementation is entirely self-contained within two files.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in test runner (node --test), >=18 |
| Config file | None (uses `package.json` script `"test": "node --test"`) |
| Quick run command | `cd dvhub && node --test test/<file>.test.js` |
| Full suite command | `cd dvhub && node --test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HTTP-01 | /health returns 200 with JSON `{ ok, uptimeSec, version }` without auth | unit | `cd dvhub && node --test test/http-health.test.js` | No -- Wave 0 |
| HTTP-02 | json()/text()/downloadJson() set correct Content-Length via Buffer.byteLength | unit | `cd dvhub && node --test test/http-content-length.test.js` | No -- Wave 0 |
| HTTP-03 | Access log line emitted on every request with method/path/status/duration | unit | `cd dvhub && node --test test/http-access-log.test.js` | No -- Wave 0 |
| FE-03 | Cache-Control: no-store for setup.html, no-cache for index.html, max-age=3600 for JS/CSS | unit | `cd dvhub && node --test test/http-cache-control.test.js` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd dvhub && node --test test/http-*.test.js`
- **Per wave merge:** `cd dvhub && node --test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `dvhub/test/http-health.test.js` -- covers HTTP-01 (mock ctx, call handleRequest, assert JSON shape)
- [ ] `dvhub/test/http-content-length.test.js` -- covers HTTP-02 (call json/text with Umlaut strings, assert Content-Length header equals Buffer.byteLength)
- [ ] `dvhub/test/http-access-log.test.js` -- covers HTTP-03 (spy on console.log, trigger finish event, assert log format)
- [ ] `dvhub/test/http-cache-control.test.js` -- covers FE-03 (call serveStatic/servePage for different file types, assert Cache-Control header values)

**Note on testability:** The `json()`, `text()`, and `downloadJson()` functions are internal to `createApiRoutes()` closure. Testing HTTP-02 requires either: (a) calling `handleRequest` with a mock request/response that triggers a route using these helpers, or (b) extracting the helpers. Option (a) is simpler and tests the full path. For HTTP-01, calling `handleRequest` with `url.pathname === '/health'` on a mock is straightforward. For HTTP-03, the access logging is in `server.js`'s `http.createServer` callback -- test by spying on `console.log` with a real or mock server.

## Sources

### Primary (HIGH confidence)
- **Codebase inspection** -- `routes-api.js` lines 114-122, 124-131, 540-570, 573-580, 804-806; `server.js` lines 717-753; `app-version.js` lines 42-54
- **Node.js Buffer.byteLength** -- Built-in API, stable since Node.js v0.1.90. Returns byte length of string in given encoding. No import required.
- **Node.js http.ServerResponse 'finish' event** -- Standard event, fires when response has been handed off to OS. `res.statusCode` is reliable at this point.
- **HTTP/1.1 Cache-Control** -- RFC 7234. `no-store` (never cache), `no-cache` (revalidate every time), `max-age=N` (cache for N seconds).

### Secondary (MEDIUM confidence)
- **Uptime Kuma compatibility** -- Expects HTTP 200 with valid response body. JSON body with `ok` field is a common pattern. No special headers required beyond standard HTTP.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all Node.js built-ins, already used in codebase
- Architecture: HIGH -- exact line numbers identified, integration points are trivial
- Pitfalls: HIGH -- UTF-8 byte length vs string length is well-documented, verified in codebase context (German Umlauts in JSON responses)

**Research date:** 2026-03-29
**Valid until:** Indefinite -- all patterns are stable Node.js/HTTP standards
