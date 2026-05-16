/* Notification-Provider config editor (Phase 09.4-06; gap-closure).
 *
 * Loads + saves the ntfy.sh provider AND the Uptime Kuma monitoring heartbeat
 * via the dedicated server-side-merge endpoint
 * /api/integrations/notification-providers.
 *
 * Gap-closure: the Uptime Kuma section edits the `monitoring` block
 * (monitoring.pushUrl + monitoring.pushIntervalSec) — the SINGLE Kuma
 * integration — pre-filled from the live config. The old duplicate
 * notifications.providers.uptime-kuma provider was removed. The endpoint still
 * exposes the Kuma fields under the 'uptime-kuma' JSON key for shape stability.
 *
 * CRITICAL — config-save hazard: this MUST NOT POST a partial config to
 * /api/config. saveAndApplyConfig REPLACES config.json verbatim; a partial-root
 * POST wipes apiToken/optimizer/mqtt and crash-loops the appliance. The
 * dedicated endpoint merges ONLY notifications.providers.ntfy + monitoring.*
 * server-side.
 *
 * Secret handling — the GET emits '***' for a stored ntfy token / Kuma pushUrl.
 * The password fields are left EMPTY (with a "leer lassen = unverändert"
 * placeholder) so the redaction placeholder never lands in the input. On save
 * an EMPTY password field sends '***' (the keep-existing sentinel the endpoint
 * understands); a non-empty field sends the typed value.
 *
 * CSP-clean: no inline handlers — the Save button is wired via addEventListener.
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/integrations/notification-providers';

  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var el = $('np-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'np-status' + (kind ? ' is-' + kind : '');
  }

  // Load the provider config and populate the form. Redacted secrets arrive as
  // '***' — leave the password inputs EMPTY so the placeholder never overwrites
  // the real value on a subsequent save.
  async function load() {
    try {
      var res = await apiFetch(ENDPOINT);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var ntfy = data.ntfy || {};
      var kuma = data['uptime-kuma'] || {};

      $('np-ntfy-enabled').checked = !!ntfy.enabled;
      $('np-ntfy-topicUrl').value = ntfy.topicUrl || '';
      // Redacted token arrives as '***' — keep the field empty (placeholder
      // explains "leer lassen = unverändert").
      $('np-ntfy-token').value = (ntfy.token && ntfy.token !== '***') ? ntfy.token : '';

      // Gap-closure: the Uptime Kuma section reflects the `monitoring` block.
      // The GET returns it under the 'uptime-kuma' key for backward shape
      // compatibility, with pushIntervalSec (NOT heartbeatIntervalSec) and an
      // enabled flag derived from whether monitoring.pushUrl is set.
      $('np-kuma-enabled').checked = !!kuma.enabled;
      // Redacted pushUrl arrives as '***' — keep the field empty.
      $('np-kuma-pushUrl').value = (kuma.pushUrl && kuma.pushUrl !== '***') ? kuma.pushUrl : '';
      $('np-kuma-hb').value = kuma.pushIntervalSec || 240;
    } catch (e) {
      setStatus('Konfiguration konnte nicht geladen werden.', 'err');
    }
  }

  // Build the request body. For the two secret fields: an EMPTY input sends
  // '***' — the endpoint reads that as "keep the existing stored value".
  function collect() {
    var token = $('np-ntfy-token').value;
    var pushUrl = $('np-kuma-pushUrl').value;
    var hb = Number($('np-kuma-hb').value) || 240;
    return {
      ntfy: {
        enabled: $('np-ntfy-enabled').checked,
        topicUrl: $('np-ntfy-topicUrl').value.trim(),
        token: token ? token.trim() : '***'   // empty → '***' keep-existing sentinel
      },
      // Gap-closure: the 'uptime-kuma' key maps to the `monitoring` block
      // server-side. pushIntervalSec (not heartbeatIntervalSec) → monitoring.
      'uptime-kuma': {
        enabled: $('np-kuma-enabled').checked,
        pushUrl: pushUrl ? pushUrl.trim() : '***',  // empty → '***' keep-existing sentinel
        pushIntervalSec: hb
      }
    };
  }

  async function save() {
    var btn = $('np-save');
    setStatus('Speichern …', '');
    if (btn) btn.disabled = true;
    try {
      var res = await apiFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect())
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setStatus('Gespeichert ✓', 'ok');
      // Reload so redacted secrets reset to empty + server-clamped values show.
      load();
    } catch (e) {
      setStatus('Fehler beim Speichern: ' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('np-save');
    if (btn) btn.addEventListener('click', save);
    load();
  });
})();
