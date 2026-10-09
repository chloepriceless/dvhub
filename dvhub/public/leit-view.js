// leit-view.js — Leitstand: Ansicht „Einfach" oder „Erweitert" (2026-10-09).
//
// Der Leitstand zeigt alles, was DVhub weiß und stellen kann — für Einsteiger
// zu viel auf einmal. „Einfach" lässt Energiefluss, PV, Akku, Kosten, Preis,
// E-Auto und den Not-Halt stehen und blendet Sollwerte, Direktvermarkter-
// Signale, Zeitplan, Prognose-Details und Protokoll aus. Es wird nur
// ausgeblendet (CSS, html.leit-simple) — alle Elemente bleiben im Dokument,
// die Aktualisierung läuft unverändert weiter.
//
// Die Wahl gilt je Browser (localStorage). Ohne eigene Wahl: ein Browser, der
// DVhub schon kennt, behält die erweiterte Ansicht; ein neuer startet einfach.
// Die Klasse wird sofort gesetzt (dieses Skript steht im <head>), damit die
// erweiterten Karten nicht erst aufblitzen.
(function () {
  'use strict';
  const KEY = 'dvhub.leitstand.view.v1';

  function stored() {
    try {
      const v = window.localStorage.getItem(KEY);
      return v === 'simple' || v === 'advanced' ? v : null;
    } catch { return null; }
  }
  function knownBrowser() {
    try { return window.localStorage.length > 0; } catch { return true; }
  }
  function current() {
    return stored() || (knownBrowser() ? 'advanced' : 'simple');
  }
  function apply(view) {
    document.documentElement.classList.toggle('leit-simple', view === 'simple');
    const buttons = document.querySelectorAll('#leitViewToggle [data-leit-view]');
    for (let i = 0; i < buttons.length; i++) {
      const on = buttons[i].getAttribute('data-leit-view') === view;
      buttons[i].classList.toggle('is-active', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function choose(view) {
    try { window.localStorage.setItem(KEY, view); } catch { /* privater Modus */ }
    apply(view);
    // Diagramme messen ihre Breite neu, sobald sie wieder sichtbar sind.
    try { window.dispatchEvent(new Event('resize')); } catch { /* alt */ }
  }

  const first = current();
  // Die erste Wahl festhalten: sonst kippte ein neuer Browser nach dem ersten
  // gespeicherten Wert irgendeiner anderen Funktion ungefragt auf „Erweitert".
  if (!stored()) { try { window.localStorage.setItem(KEY, first); } catch { /* privater Modus */ } }
  apply(first);

  document.addEventListener('DOMContentLoaded', function () {
    apply(current());
    const toggle = document.getElementById('leitViewToggle');
    if (!toggle) return;
    toggle.addEventListener('click', function (event) {
      const button = event.target.closest('[data-leit-view]');
      if (button) choose(button.getAttribute('data-leit-view'));
    });
  });
})();
