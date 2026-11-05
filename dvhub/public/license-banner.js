// license-banner.js — Hinweis im Leitstand, wenn die Lizenz nicht (mehr) an
// dieser Box hängt (1.0.10, Vorfall 04./05.11.2026: Prod verlor Pro still,
// nachdem ein Test-Stack mit kopiertem Lizenzzustand die Lizenz an sich band).
// Quelle: /api/status.licenseBinding = licenseService.getBindingNotice():
//   moved      — die Lizenz ist auf eine andere Box umgezogen
//   adopted    — der Lizenzzustand stammt von einer anderen Box (kopiert)
//   slot_taken — eine andere Box hält die Lizenz gerade
// Nur Text und ein Verweis auf Einstellungen → Lizenz; binden geht dort
// („An diese Box binden“, mit Rückfrage).
(function () {
  'use strict';

  const BANNER_ID = 'licenseBindingBanner';
  const HOW = 'Einstellungen → Lizenz → „An diese Box binden“';

  function sinceText(since) {
    const d = new Date(since);
    if (!since || !Number.isFinite(d.getTime())) return '';
    return ` (seit ${d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})`;
  }

  /** Text für den Hinweis oder null (kein Hinweis). */
  function licenseBannerText(notice) {
    if (!notice || typeof notice !== 'object') return null;
    if (notice.kind === 'moved') {
      return `Deine Lizenz ist jetzt auf einer anderen Box${sinceText(notice.since)} – hier sind die Pro-Funktionen `
        + `(EOS-Steuerung, DV-Schnittstelle) aus. Zurückholen: ${HOW}. Warst du das nicht, melde dich beim Support.`;
    }
    if (notice.kind === 'adopted') {
      return 'Lizenz von anderer Box übernommen – an diese Box binden? Bis dahin sind die Pro-Funktionen hier aus, '
        + `die andere Box behält die Lizenz. Binden: ${HOW}.`;
    }
    if (notice.kind === 'slot_taken') {
      return 'Diese Lizenz ist gerade an eine andere Box gebunden – hier sind die Pro-Funktionen aus. '
        + `Übernehmen: ${HOW} (frühestens 24 Stunden nach der letzten Bindung der anderen Box).`;
    }
    return null;
  }

  /** Hinweis im Leitstand zeigen, aktualisieren oder entfernen. */
  function render(notice) {
    if (typeof document === 'undefined' || !document) return;
    const text = licenseBannerText(notice);
    let el = document.getElementById(BANNER_ID);
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = BANNER_ID;
      el.className = 'victron-alarm-banner warn';
      el.setAttribute('role', 'status');
      const span = document.createElement('span');
      span.className = 'license-binding-banner-text';
      const link = document.createElement('a');
      link.href = '/settings.html#license';
      link.textContent = 'Zur Lizenz';
      el.append(span, ' ', link);
      document.body.prepend(el);
    }
    const span = el.querySelector('.license-binding-banner-text');
    if (span && span.textContent !== `🔑 ${text}`) span.textContent = `🔑 ${text}`;
  }

  const api = { licenseBannerText, render };
  if (typeof window !== 'undefined') window.DVhubLicenseBanner = api;
  if (typeof globalThis !== 'undefined') globalThis.DVhubLicenseBanner = api;
})();
