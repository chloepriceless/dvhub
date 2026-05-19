/* Aurora topbar shell mount helper (AURORA-02).
   Exposes window.DVhub_mountShell({active, status}). Theme logic lives in
   theme.js (single writer of localStorage['dvhub.theme']). Tweaks panel
   deferred to v1.1 per RESEARCH §2. */
(function(){
  'use strict';

  /* ─── HTML-escape for status.text interpolation (T-09.1-01-04 mitigation) ───
     Sweep package 6: delegate to the canonical common.js escapeHtml so no copy
     can drift. Falls back to a minimal stringifier if common.js is unavailable. */
  const escapeHtml = (window.DVhubCommon || {}).escapeHtml || ((s) => String(s ?? ''));

  /* ─── TOPBAR INJECTION ─────────────────────────────────────────────
     PAGES list and shell-build helpers ported from
     .planning/DESIGN-2026-05-10-aurora/assets/dvhub-app.js (lines 43-94).
     The original theme cycler block (lines 1-40) is intentionally OMITTED
     — theme.js is the single writer of localStorage['dvhub.theme']. The
     theme-toggle button still renders here, but its click handler is
     attached by theme.js's mount() when it discovers the button. */
  const PAGES = [
    { href:'index.html',        label:'Leitstand',     key:'leitstand' },
    { href:'family.html',       label:'Family',        key:'family' },
    { href:'history.html',      label:'History',       key:'history' },
    { href:'explorer.html',     label:'Explorer',      key:'explorer' },
    { href:'settings.html',     label:'Settings',      key:'settings' },
    { href:'integrations.html', label:'Integrations',  key:'integrations' },
    { href:'setup.html',        label:'Setup',         key:'setup' },
    { href:'tools.html',        label:'Tools',         key:'tools' },
    { href:'api-docs.html',     label:'API',           key:'api-docs' },
  ];

  function buildTopbar(active, status){
    const links = PAGES.map(p =>
      `<a href="${p.href}"${p.key===active ? ' class="is-active" aria-current="page"' : ''}>${p.label}</a>`
    ).join('');
    const sd = (status && status.dot) || 'ok';
    const st = (status && status.text) || 'Live · alle Systeme';
    const sdClass = sd === 'warn' ? 'warn' : sd === 'danger' ? 'danger' : '';
    return `
<header class="topbar">
  <a class="topbar-brand" href="index.html" aria-label="DVhub">
    <img src="assets/dvhub-wordmark.png" alt="DVhub">
    <span class="product">App</span>
  </a>
  <nav class="topbar-nav" aria-label="Hauptnavigation">${links}</nav>
  <div class="topbar-right">
    <span class="status-pill ${sdClass}"><span class="dot"></span>${escapeHtml(st)}</span>
    <button class="theme-toggle" type="button" aria-label="Theme wechseln"></button>
  </div>
</header>`;
  }

  function buildFooter(){
    return `
<footer class="app-footer">
  <span>DVhub · Direktvermarktung Self-Hosted · v1.4.2</span>
  <div class="links">
    <a href="api-docs.html">API</a>
    <a href="https://github.com/chloepriceless/dvhub" target="_blank">GitHub</a>
    <a href="https://dvhub.de" target="_blank">dvhub.de</a>
  </div>
</footer>`;
  }

  window.DVhub_mountShell = function(opts){
    opts = opts || {};
    const slot = document.getElementById('app-shell-top');
    if(slot) slot.outerHTML = buildTopbar(opts.active, opts.status);
    const fslot = document.getElementById('app-shell-foot');
    if(fslot) fslot.outerHTML = buildFooter();
    // theme.js owns .theme-toggle paint + click handler; it observes the
    // DOMContentLoaded / direct mount() and binds clicks at that time.
    // No theme bindings are attached here — single-writer policy (AURORA-02).
  };

  /* ─── TWEAKS PANEL ─────────────────────────────────────────────────
     OMITTED per RESEARCH §2 — defer to v1.1. The Aurora CSS still ships
     the tokens (--accent, --glass-blur, --density) so a future tweaks
     surface can mount without re-shipping the design system. */
})();
