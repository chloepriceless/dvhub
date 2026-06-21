/* dvhub/public/pro-modal.js — Phase 17 Plan 17-06 (R-7 acceptance #11, #12)
 *
 * Vanilla-DOM Pro-Required-Modal + Family-nav-link lock-badge.
 *
 * PUBLIC API
 *   window.openProRequired(featureName)  — opens the Pro-Required modal
 *   window.closeProModal()               — closes it
 *
 * CONSUMERS
 *   - This file's own DOMContentLoaded scan augments .topbar-nav a[href="/family"]
 *     (5 of 7 HTML pages have a .topbar-nav: index, history, explorer, integrations,
 *     settings). family.html + tools.html have no .topbar-nav — silently skipped.
 *   - settings.js bindProGateCta (Phase 19-01) — delegated click on
 *     .pro-gate-banner-cta with data-pro-feature attr — calls openProRequired
 *     and falls back to /settings#license if undefined. This script makes
 *     openProRequired defined so those 3 Inspector subsections (B3 ML, B4 EOS,
 *     B5 Stage-2) get the proper modal instead of the bare-hash fallback.
 *
 * ARCHITECTURE DEVIATION FROM 17-06 PLAN (2026-05-22 resume audit):
 *   PLAN assumed dvhub-app.js was loaded by all 8 pages and would do the
 *   license-state fetch + lock-badge mount via DVhub_mountShell post-hook.
 *   Actual codebase: dvhub-app.js is NOT loaded by ANY page (it was added in
 *   Phase 09.1 but never wired in); pages render the topbar with hardcoded
 *   inline `<header class="topbar"><nav class="topbar-nav">…` markup.
 *   This file consolidates the lock-badge logic into pro-modal.js itself
 *   (self-mounting on DOMContentLoaded, scanning the static topbar markup)
 *   so 17-06 can ship without first re-architecting the topbar layer.
 *   Phase-20 had already deleted notifications-providers.html, so we're down
 *   to 5 pages with a .topbar-nav (not the PLAN's 8).
 *
 * CSP CONTRACT
 *   No innerHTML for content (only structural for empty containers — CSP-safe).
 *   No style attribute, no setAttribute('style'), no inline onclick, no <style>
 *   injection. All styling lives in pro-modal.css via Aurora tokens.
 *   The single lock-badge glyph 🔒 (U+1F512) is set via textContent.
 *
 * LICENSE-STATE FETCH
 *   Shares the Phase-19 cache `window._licenseStateCache` if present (set by
 *   settings.js initForecastTab). Otherwise self-fetches /api/license/state.
 *   On any failure: degrades to optimistic 'unknown' — renders NO lock-badge,
 *   NO interceptor (fail-open). Server-side 403 from Plan 17-04 still catches
 *   unauthorized requests; UX-only degradation.
 */
(function () {
  'use strict';

  // ─── Feature whitelist + per-feature body text ─────────────────────────
  // Synced with the requirePro() callsites in routes-api.js. History:
  // 1 feature → 4 (Phase 19-01 added the 3 Inspector subsections, 2026-05-22)
  // → 5 (vpn-manager gated, 2026-06-21).

  var ALLOWED_FEATURES = {
    'family-dashboard': true,
    'forecast-inspector-ml': true,
    'forecast-inspector-eos': true,
    'forecast-inspector-stage2': true,
    'vpn-manager': true
  };

  var FEATURE_BODY = {
    'family-dashboard':
      'Family Dashboard ist ein DVhub-Pro-Feature und benötigt eine aktive Lizenz.',
    'forecast-inspector-ml':
      'Der ML-Korrektur-Inspector zeigt das aktive Modell, Tier-Features und die Genauigkeits-Historie — ein DVhub-Pro-Feature.',
    'forecast-inspector-eos':
      'Der EOS-Output-Inspector zeigt push/pull pro Slot — ein DVhub-Pro-Feature.',
    'forecast-inspector-stage2':
      'Der SMA-Stage-2 Plan-Inspector + Backtest zeigt vergangene Pläne inklusive Operator-Overrides — ein DVhub-Pro-Feature.',
    'vpn-manager':
      'Der VPN-Manager (OpenVPN / WireGuard / IPSec) für den sicheren Fernzugriff und den Tunnel zum Direktvermarkter ist ein DVhub-Pro-Feature.'
  };

  var FALLBACK_BODY = 'Diese Funktion erfordert eine aktive DVhub-Pro-Lizenz.';

  // ─── Modal singleton (created lazily on first openProRequired call) ────

  var modalEl = null;       // root .pro-modal-overlay
  var dialogEl = null;      // .pro-modal-dialog
  var bodyTextEl = null;    // .pro-modal-body — updated per call
  var primaryBtn = null;    // 'Lizenz aktivieren'
  var secondaryBtn = null;  // 'Abbrechen'
  var lastTrigger = null;   // element to restore focus to on close
  var keydownHandler = null;

  function buildModalOnce() {
    if (modalEl) return;

    modalEl = document.createElement('div');
    modalEl.className = 'pro-modal-overlay';
    modalEl.setAttribute('hidden', '');

    dialogEl = document.createElement('div');
    dialogEl.className = 'pro-modal-dialog';
    dialogEl.setAttribute('role', 'alertdialog');
    dialogEl.setAttribute('aria-modal', 'true');
    dialogEl.setAttribute('aria-labelledby', 'proModalTitle');
    dialogEl.setAttribute('aria-describedby', 'proModalBody');
    dialogEl.tabIndex = -1;

    var kicker = document.createElement('div');
    kicker.className = 'pro-modal-kicker';
    kicker.textContent = 'DVhub Pro';
    dialogEl.appendChild(kicker);

    var title = document.createElement('h2');
    title.id = 'proModalTitle';
    title.className = 'pro-modal-title';
    title.textContent = 'Pro-Feature';
    dialogEl.appendChild(title);

    bodyTextEl = document.createElement('p');
    bodyTextEl.id = 'proModalBody';
    bodyTextEl.className = 'pro-modal-body';
    bodyTextEl.textContent = FALLBACK_BODY;
    dialogEl.appendChild(bodyTextEl);

    // Empty pitch-card slot — Phase 18+ will populate this. DOM-present per
    // 17-UI-SPEC.md "Pitch-card placeholder (Phase 17, intentionally minimal)".
    var pitch = document.createElement('section');
    pitch.className = 'pro-modal-pitch';
    pitch.setAttribute('aria-hidden', 'true');
    dialogEl.appendChild(pitch);

    var actions = document.createElement('div');
    actions.className = 'pro-modal-actions';

    secondaryBtn = document.createElement('button');
    secondaryBtn.type = 'button';
    secondaryBtn.className = 'pro-modal-btn pro-modal-btn-secondary';
    secondaryBtn.textContent = 'Abbrechen';
    secondaryBtn.addEventListener('click', closeProModal);
    actions.appendChild(secondaryBtn);

    primaryBtn = document.createElement('button');
    primaryBtn.type = 'button';
    primaryBtn.className = 'pro-modal-btn pro-modal-btn-primary';
    primaryBtn.textContent = 'Lizenz aktivieren';
    primaryBtn.addEventListener('click', function () {
      closeProModal();
      window.location.assign('/settings.html#license');
    });
    actions.appendChild(primaryBtn);

    dialogEl.appendChild(actions);
    modalEl.appendChild(dialogEl);

    // Backdrop click (outside dialog) closes — handler on overlay, filtered.
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) closeProModal();
    });

    // Modal lives at body level so its z-index isn't trapped under any
    // .topbar / .card stacking context.
    if (document.body) {
      document.body.appendChild(modalEl);
    } else {
      // DOMContentLoaded hasn't fired yet — wait for body.
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(modalEl);
      });
    }
  }

  // ─── PUBLIC: openProRequired(featureName) ──────────────────────────────

  window.openProRequired = function (featureName) {
    buildModalOnce();

    var feat;
    if (ALLOWED_FEATURES[featureName]) {
      feat = featureName;
    } else {
      feat = 'unknown';
      // Don't throw — Phase 18+ may add new feature names; refusing them
      // would force every new requirePro() callsite to also touch
      // pro-modal.js. Degrade gracefully with a generic body + console hint.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('openProRequired: unknown featureName "' + featureName + '" — falling back to generic body text');
      }
    }

    bodyTextEl.textContent = (FEATURE_BODY[feat] || FALLBACK_BODY);

    lastTrigger = document.activeElement;
    modalEl.removeAttribute('hidden');

    // Focus primary CTA on next tick so screen-readers announce the dialog.
    setTimeout(function () { primaryBtn.focus(); }, 0);

    // ESC + focus-trap
    keydownHandler = function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        closeProModal();
        return;
      }
      if (e.key === 'Tab') {
        // Two focusable buttons in the dialog — trap focus between them.
        var focusables = [secondaryBtn, primaryBtn];
        var idx = focusables.indexOf(document.activeElement);
        if (e.shiftKey) {
          if (idx <= 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
        } else {
          if (idx === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
        }
      }
    };
    document.addEventListener('keydown', keydownHandler);
  };

  // ─── PUBLIC: closeProModal() ───────────────────────────────────────────

  window.closeProModal = function closeProModal() {
    if (!modalEl) return;
    modalEl.setAttribute('hidden', '');
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    if (lastTrigger && typeof lastTrigger.focus === 'function') {
      try { lastTrigger.focus(); } catch (_) { /* element may have been removed */ }
    }
    lastTrigger = null;
  };
  // Local alias so the secondaryBtn click handler bound during buildModalOnce
  // can reference the function before window.closeProModal is fully wired.
  function closeProModal() { return window.closeProModal(); }

  // ─── Lock-badge mount on Family nav-link ───────────────────────────────
  //
  // Scans the static .topbar-nav markup for the Family link (5 of 7 HTML
  // pages have a topbar; family.html + tools.html don't and are skipped
  // silently). When license-state !== 'active', adds .is-locked class,
  // appends a 🔒 lock-badge span, sets aria-label + title attrs, and
  // intercepts clicks to open the modal instead of navigating.

  function findFamilyLink() {
    if (!document.querySelector) return null;
    // Match both '/family' and '/family.html' forms — different pages use
    // different hrefs in their hardcoded topbar markup. The Family page
    // itself (family.html) has no .topbar-nav so it's never matched here.
    var nav = document.querySelector('.topbar-nav');
    if (!nav) return null;
    var links = nav.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (href === '/family' || href === '/family.html' || href === 'family.html') {
        return links[i];
      }
    }
    return null;
  }

  function mountLockBadge(link) {
    if (!link) return;
    if (link.classList.contains('is-locked')) return; // idempotent
    link.classList.add('is-locked');
    link.setAttribute('title', 'Family Dashboard — Pro-Feature');

    var badge = document.createElement('span');
    badge.className = 'lock-badge';
    badge.setAttribute('aria-label', 'Pro-Feature, Klick öffnet Aktivierungs-Hinweis');
    badge.textContent = '🔒';
    link.appendChild(badge);

    link.addEventListener('click', function (e) {
      e.preventDefault();
      window.openProRequired('family-dashboard');
    });
  }

  // ─── License-state read with shared-cache fallback ─────────────────────
  //
  // Phase 19-01 (settings.js initForecastTab) caches the result of
  // /api/license/state at `window._licenseStateCache`. If it's already
  // populated when we run, reuse it (avoids a redundant fetch). Otherwise
  // fetch ourselves and populate the same cache for downstream consumers.

  function resolveLicenseState() {
    var cached = window._licenseStateCache;
    if (cached && typeof cached.status === 'string') {
      return Promise.resolve(cached);
    }
    // Use the same auth pattern as the rest of the app — settings.js
    // uses apiFetch which adds Bearer; here we mirror that minimally so
    // LAN-bypass and Bearer-auth both work.
    var headers = { 'Accept': 'application/json' };
    var token = (window.DVhubCommon && window.DVhubCommon.getApiToken) ? window.DVhubCommon.getApiToken() : null;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('/api/license/state', { headers: headers, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { status: 'unknown' }; })
      .then(function (state) {
        // Don't cache 'unknown' — could be a transient fetch failure.
        if (state && state.status && state.status !== 'unknown') {
          window._licenseStateCache = state;
        }
        return state || { status: 'unknown' };
      })
      .catch(function () { return { status: 'unknown' }; });
  }

  function maybeMountLockBadge() {
    var link = findFamilyLink();
    if (!link) return; // No .topbar-nav on this page (family.html, tools.html)
    resolveLicenseState().then(function (state) {
      var st = (state && state.status) || 'unknown';
      // 'active' → no lock. 'unknown' → no lock (fail-open, server-side 403
      // still enforces). Everything else (none/invalid/expired/suspended) → lock.
      if (st !== 'active' && st !== 'unknown') {
        mountLockBadge(link);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeMountLockBadge);
  } else {
    maybeMountLockBadge();
  }
})();
