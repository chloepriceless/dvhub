/* DVhub Family Dashboard — screensaver time-window logic (extracted for testability).
   Decisions: D-16 (in-dashboard dimming), D-17 (time-window configurable timeout),
              D-19 (presence-hook wake — see family.js for poller).

   This file is intentionally pure (no DOM, no fetch) so it can be imported by
   node:test directly. Browser integration is via `<script type="module">` in
   family.html which executes the side-effect assignment to window.FamilyScreensaverLogic,
   letting the classic-script family.js reach the helpers after DOMContentLoaded. */

function isInWindow(hhmm, start, end) {
  // Handles cross-midnight windows like 22:00-06:00 as well as same-day windows.
  // End is exclusive — `end === hhmm` counts as OUTSIDE the window.
  if (start <= end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end;
}

function getActiveTimeout(cfg, hhmm) {
  if (!cfg || cfg.enabled === false) return 0;
  var windows = cfg.windows || [];
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    if (isInWindow(hhmm, w.start, w.end)) return w.timeoutSec;
  }
  return cfg.defaultTimeoutSec || 120;
}

export { isInWindow, getActiveTimeout };

// Browser side-effect: expose helpers on the global so classic-script family.js
// (loaded AFTER this deferred module script via DOMContentLoaded bootstrap) can use them.
if (typeof window !== 'undefined') {
  window.FamilyScreensaverLogic = { isInWindow: isInWindow, getActiveTimeout: getActiveTimeout };
}
