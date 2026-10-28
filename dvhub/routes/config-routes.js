// routes/config-routes.js — Konfiguration lesen, speichern, importieren,
// exportieren (GET/POST /api/config, /api/config/import, /api/config/export).
//
// Aus routes-api.js herausgelöst (2026-10-15, Wartung: Aufteilung der großen
// Routen-Datei). Der Code ist unverändert; was er aus createApiRoutes braucht
// (Antwort-Helfer, Payload-Bauer, Bootstrap-Token), kommt über `deps`. Gibt
// `false` zurück, wenn die Anfrage keine dieser Routen ist.

import { isAllowedRemoteEndpoint } from '../services/optimizer/eos-remote.js';
import { REDACTED_PATHS, REDACTED, redactConfig, isRedactedPath } from '../config-redaction.js';
import { encryptSecrets, decryptSecrets, applySecrets, collectMigrationFiles, restoreMigrationFiles } from '../services/config-secrets-crypto.js';
import { protectOwnRouteKeys, applyCarriedKeys, OWN_ROUTE_KEYS } from '../services/config-protected-keys.js';
import { mergeAgainstBaseWithConflicts } from '../services/config-base-merge.js';
import { validateVpnProfileFile } from '../vpn-manager.js';

// VPN-Profile eines Geräte-Tausch-Pakets (config/vpn/profiles/<name>/<datei>):
// nur gefährliche Inhalte blockieren — siehe validateVpnProfileByProtocol.
export function rejectedMigrationVpnFiles(files) {
  const out = [];
  for (const [key, b64] of Object.entries(files || {})) {
    if (!key.startsWith('config/vpn/profiles/') || typeof b64 !== 'string') continue;
    const name = key.split('/').pop();
    const check = validateVpnProfileFile(name, Buffer.from(b64, 'base64').toString('utf8'), { dangerousOnly: true });
    if (!check.valid) out.push({ file: key, errors: check.errors });
  }
  return out;
}

export function createConfigRoutes(deps) {
  const {
    ctx, getCfg, pushLog, licenseService,
    json, downloadJson, readJsonBody,
    configApiPayload, configMetaPayload, withScheduleRules, migrationDirs,
    requireBootstrapToken, consumeBootstrapToken, isRfc1918OrLoopback,
    actorContext, deriveClientIp, validateApiTokenStrength, configChangeNeedsEosReplan, ALLOWED_CONFIG_ROOTS,
  } = deps;

  return async function handleConfigRoute(req, res, url) {
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, configApiPayload());

    if (url.pathname === '/api/config/export' && req.method === 'GET') {
      // Plan 09-05 Task 1: audit the sensitive config-export download BEFORE the
      // response body is streamed. actorIp via deriveClientIp (09-03) so XFF
      // posture is consistent with auth + rate-limiting. Only the COUNT of
      // redacted keys is logged — never the values themselves (T-9-05-02).
      pushLog('config_exported', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        redactedKeyCount: Array.isArray(REDACTED_PATHS) ? REDACTED_PATHS.length : 0
      }, { ...actorContext(req), severity: 'info' });
      return downloadJson(res, 'dvhub-config.json', withScheduleRules(redactConfig(ctx.getRawCfg())));
    }

    // Password-protected migration export. Same redacted config PLUS an encrypted
    // `_encryptedSecrets` bundle carrying the REDACTED_PATHS values (forecast API
    // keys, DB password, MQTT/notification creds — but NOT apiToken) so a FRESH
    // box can restore them on import. The bundle is AES-256-GCM under a
    // PBKDF2(password) key; without the password it is opaque.
    if (url.pathname === '/api/config/export' && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!password) return json(res, 400, { ok: false, error: 'password_required' });
      if (password.length < 8) return json(res, 400, { ok: false, error: 'password_too_short' });
      let bundle;
      try {
        // Voller Export (Geräte-Tausch): zusätzlich API-Token und die Schlüssel-
        // Dateien (Lizenz, Kennung, Datenspende, Portal, TLS, VPN …) verschlüsselt
        // mitgeben. Übernommen werden sie nur beim Import mit migrate:true.
        bundle = encryptSecrets(ctx.getRawCfg(), password, {
          apiToken: ctx.getRawCfg()?.apiToken || null,
          files: collectMigrationFiles(migrationDirs()),
        });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message || 'encrypt_failed' });
      }
      const out = withScheduleRules(redactConfig(ctx.getRawCfg()));
      if (bundle) out._encryptedSecrets = bundle;
      pushLog('config_exported', {
        actor: req.headers['x-actor'] || 'admin',
        actorIp: deriveClientIp(req, getCfg()),
        redactedKeyCount: Array.isArray(REDACTED_PATHS) ? REDACTED_PATHS.length : 0,
        encryptedSecretCount: bundle ? bundle.paths.length : 0
      }, { ...actorContext(req), severity: 'info' });
      return json(res, 200, out);
    }

    // --- Config POST / Import POST ---
    if ((url.pathname === '/api/config' || url.pathname === '/api/config/import') && req.method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (!body || typeof body !== 'object' || !body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
        return json(res, 400, { ok: false, error: 'config object required' });
      }
      // Zeitplan-Regeln stehen nicht in der Config (schedule-rules.json): Beim
      // Speichern werden mitgeschickte Regeln ignoriert — sie ändern sich nur über
      // /api/schedule/* —, ein Import übernimmt sie nach dem Speichern.
      const importedScheduleRules = url.pathname === '/api/config/import' && Array.isArray(body.config.schedule?.rules)
        ? body.config.schedule.rules : null;
      for (const c of [body.config, body.base]) {
        if (c?.schedule && typeof c.schedule === 'object') delete c.schedule.rules;
      }
      // Einstellungsseite: nur übernehmen, was im Formular geändert wurde —
      // alles andere so, wie die Box es jetzt hat (services/config-base-merge.js).
      // Ohne `base` (andere Aufrufer) und beim Import gilt die geschickte Config.
      if (url.pathname === '/api/config' && body.base && typeof body.base === 'object' && !Array.isArray(body.base)) {
        const merged = mergeAgainstBaseWithConflicts(body.config, body.base, redactConfig(ctx.getRawCfg?.() || {}));
        // Schlüssel mit eigenen Wegen setzt protectOwnRouteKeys ohnehin auf den Stand der Box.
        const conflicts = merged.conflicts.filter((c) => !OWN_ROUTE_KEYS.some((k) => c.path === k || c.path.startsWith(`${k}.`)));
        if (conflicts.length && body.overwriteConflicts !== true) {
          return json(res, 409, {
            ok: false,
            error: 'config_conflict',
            // Geheimnisse ohne Werte — nur der Pfad.
            conflicts: conflicts.map((c) => (isRedactedPath(c.path) ? { path: c.path, secret: true } : c)),
          });
        }
        body.config = merged.config;
      }
      // Fernzugang, Datenspende und Ortsnetz haben eigene Wege — siehe
      // services/config-protected-keys.js. Ein Geräte-Tausch (unten) bringt
      // sie aus der Datei mit, alles andere lässt sie, wie die Box sie hat.
      const carriedKeys = protectOwnRouteKeys(body.config, ctx.getRawCfg?.(), { isImport: url.pathname === '/api/config/import' });
      // Encrypted secrets bundle (config-secrets-crypto): a password-protected
      // migration export carries the REDACTED_PATHS values sealed under the
      // operator's password. Decrypt + restore them into body.config BEFORE the
      // strict-root check (otherwise `_encryptedSecrets` reads as an unknown root)
      // and before the apiToken strength gate.
      let migrationFiles = null;
      if (Object.prototype.hasOwnProperty.call(body.config, '_encryptedSecrets')) {
        const blob = body.config._encryptedSecrets;
        delete body.config._encryptedSecrets;
        if (blob && typeof blob === 'object') {
          const secretsPw = typeof body.password === 'string' ? body.password : '';
          if (!secretsPw) return json(res, 400, { ok: false, error: 'secrets_password_required' });
          let secrets;
          try {
            secrets = decryptSecrets(blob, secretsPw);
          } catch (e) {
            const code = e.message === 'invalid_password' ? 'secrets_password_invalid'
              : e.message === 'unsupported_secrets_format' ? 'secrets_format_unsupported'
              : 'secrets_decrypt_failed';
            pushLog('config_import_secrets_failed', { reason: code }, actorContext(req));
            return json(res, 400, { ok: false, error: code });
          }
          body.config = applySecrets(body.config, secrets);
          // Geräte-Tausch: Token + Schlüssel-Dateien nur auf ausdrücklichen Wunsch
          // (GUI-Frage „Geräte-Tausch?“) — wer nur Einstellungen kopiert, behält
          // Token, Lizenz und Kopplungen der Zielbox.
          if (body.migrate === true) {
            if (typeof secrets.__apiToken === 'string' && secrets.__apiToken) body.config.apiToken = secrets.__apiToken;
            migrationFiles = secrets.__files && typeof secrets.__files === 'object' ? secrets.__files : null;
            // VPN-Profile im Paket durch dieselbe Inhaltsprüfung wie Upload und
            // Start, BEVOR irgendetwas gespeichert wird — sonst käme ein Profil
            // mit Hook (Root-Code beim Start) am Upload vorbei (Codex-Review S2).
            // Das Passwort belegt nur, wer das Paket gepackt hat, nicht wer es gebaut hat.
            const rejected = rejectedMigrationVpnFiles(migrationFiles);
            if (rejected.length) {
              pushLog('config_import_vpn_rejected', { files: rejected.map((r) => r.file) }, actorContext(req));
              return json(res, 400, { ok: false, error: 'migration_vpn_profile_rejected', files: rejected });
            }
            const carried = applyCarriedKeys(body.config, carriedKeys);
            if (carried.length) pushLog('config_import_switches_carried', { keys: carried }, actorContext(req));
          }
          pushLog('config_import_secrets_restored', {
            count: Object.keys(secrets).filter((k) => !k.startsWith('__')).length,
            migrate: body.migrate === true,
            files: migrationFiles ? Object.keys(migrationFiles).length : 0,
          }, actorContext(req));
        }
      }
      // Plan 09-01 (D-05, supersedes Plan 08-01 rejection): apiToken stays
      // OPTIONAL. Empty / null / undefined apiToken is a VALID config state
      // (LAN-trust appliance model — LAN-bypass continues to gate local traffic;
      // remote callers fall through to checkAuth's 503 api_token_not_configured).
      // Mandatory-token semantics arrive with the user/account phase, not here.
      //
      // Plan 09-01 (D-03 + D-05): token strength gate fires ONLY when a
      // non-empty apiToken string is supplied. Skip validation entirely when
      // missing / empty / null — empty is a valid "no external auth" config.
      //
      // ALSO skip when the value is the redaction placeholder REDACTED ('***'):
      // the settings UI GETs the config redacted and POSTs the whole object
      // back, so an unchanged apiToken arrives as '***'. restoreRedacted()
      // (inside ctx.saveAndApplyConfig) swaps the real token back in — but it
      // runs AFTER this gate, so validating '***' here would wrongly reject a
      // normal settings save with token_too_short.
      if (typeof body.config.apiToken === 'string'
          && body.config.apiToken.length > 0
          && body.config.apiToken !== REDACTED) {
        const tokenCheck = validateApiTokenStrength(body.config.apiToken);
        if (!tokenCheck.ok) {
          return json(res, 400, { ok: false, error: tokenCheck.error });
        }
      }
      // Plan 08-04 Task 1 Step 3: strict root-level schema. Reject any top-level
      // key that is not in ALLOWED_CONFIG_ROOTS so an attacker cannot pass
      // arbitrary paths that future handlers might read without validation.
      // (Deep-path validation — e.g. schema of `victron.*` — stays in Plan 08-06.)
      const unknownRoots = Object.keys(body.config).filter((k) => !ALLOWED_CONFIG_ROOTS.has(k));
      if (unknownRoots.length > 0) {
        return json(res, 400, { ok: false, error: 'unknown_config_paths', paths: unknownRoots });
      }
      // H-3 (Plan 16-02): SSRF guard on epex.priceApiUrl. The /api/epex/*
      // handlers issue a server-side `fetch` to this config-controlled URL —
      // the CSP does not constrain outbound fetch. A config writer could
      // otherwise point it at an internal host (RFC1918/loopback) and proxy
      // that host's response back to the caller, or downgrade to plain http.
      // Reject at save time: scheme must be https, host must not be private.
      // Reuse the existing isRfc1918OrLoopback matcher — no new private-IP code.
      const candidatePriceApiUrl = body.config?.epex?.priceApiUrl;
      if (candidatePriceApiUrl) {
        let u;
        try { u = new URL(candidatePriceApiUrl); } catch { /* u stays undefined → reject below */ }
        if (!u || u.protocol !== 'https:' || isRfc1918OrLoopback(u.hostname)) {
          return json(res, 400, { ok: false, error: 'invalid_epex_price_api_url' });
        }
      }
      // Review 2026-06-10 (B2): same SSRF surface as epex.priceApiUrl — the EOS
      // probe (/api/forecast/providers/eos-akkudoktor/probe) and sync
      // (/api/eos/sync-from-dvhub) handlers fetch optimizer.eosProxy.url
      // server-side and relay the response. EOS deploys next to the appliance,
      // so: http only to RFC1918/loopback hosts; https to any host (TLS deploys
      // behind a public reverse proxy stay possible). Everything else rejected.
      const candidateEosUrl = body.config?.optimizer?.eosProxy?.url;
      if (candidateEosUrl) {
        let eu;
        try { eu = new URL(candidateEosUrl); } catch { /* eu stays undefined → reject below */ }
        const eosUrlOk = eu && (
          eu.protocol === 'https:'
          || (eu.protocol === 'http:' && (isRfc1918OrLoopback(eu.hostname) || eu.hostname === 'localhost'))
        );
        if (!eosUrlOk) {
          return json(res, 400, { ok: false, error: 'invalid_eos_proxy_url' });
        }
      }
      // EOS-Rechendienst (Fernbetrieb): DVhub schickt dorthin Lizenzschlüssel
      // und Prognosen — https zu jedem Host, http nur im eigenen Netz, keine
      // Zugangsdaten in der URL (eos-remote.js isAllowedRemoteEndpoint).
      const candidateRemoteEndpoint = body.config?.optimizer?.eosProxy?.remote?.endpoint;
      if (candidateRemoteEndpoint && !isAllowedRemoteEndpoint(candidateRemoteEndpoint)) {
        return json(res, 400, { ok: false, error: 'invalid_eos_remote_endpoint' });
      }
      // Plan 08-06 Task 1 Step 3: legal-gate flip detection.
      // allowGridCharge / allowGridDischarge are EEG/§14a-relevant. ENABLING
      // either (turning it ON) requires an explicit `x-confirm-legal-gate: true`
      // header AND emits a distinct audit event so the actor IP is recorded
      // separately from generic config_saved.
      //
      // 2026-06-28: gate ONLY the enable transition. The earlier rule (any
      // before !== after) made a fresh install unusable — on a new device these
      // keys are undefined, so the first config save of ANYTHING that round-trips
      // them as an explicit `false` read as a flip (undefined → false) and was
      // 403-rejected, even though grid-charge was never touched (observed on a
      // fresh Pi: "Speichern fehlgeschlagen: legal_gate_flip_requires_confirmation").
      // Materialising an unset field to false — and any DISABLE (→ false) — is
      // never a legal risk, so those pass without the header (a disable still
      // shows up in the generic config_saved changedPaths audit). Only turning a
      // gate ON, the sole §14a-relevant direction, needs the confirmation.
      const getByPath = (obj, dotPath) => dotPath.split('.').reduce(
        (a, k) => (a != null && Object.prototype.hasOwnProperty.call(a, k)) ? a[k] : undefined,
        obj
      );
      const LEGAL_GATE_PATHS = ['optimizer.allowGridCharge', 'optimizer.allowGridDischarge', 'optimizer.gridChargeWithoutMispel', 'optimizer.mispel.mode'];
      // „An“ heißt bei den Schaltern true, bei der MiSpeL-Option eine gewählte
      // Option (gibt Netzladen mit PV-Anlage frei, grid-storage.js isMispelReleased).
      const legalGateOn = (p, v) => (p === 'optimizer.mispel.mode' ? (v === 'pauschal' || v === 'abgrenzung') : v === true);
      const currentCfgForGate = getCfg();
      // Plan 08-06 Task 2 Step 2: setup wizard one-shot bootstrap.
      // If apiToken is currently empty AND this request is trying to set it, the
      // caller MUST present a valid x-bootstrap-token header (matched against
      // ${DV_DATA_DIR}/bootstrap.token, written at startup, mode 0600). This blocks
      // the first-caller-wins race on a fresh device — even LAN attackers cannot
      // take over the box without filesystem access.
      const currentApiToken = currentCfgForGate.apiToken;
      // Plan 16-04: the redaction placeholder REDACTED ('***') is NOT a real
      // token — the settings UI GETs the config redacted and POSTs the whole
      // object back, so an UNCHANGED apiToken arrives as '***'. Treating that
      // as "setting a new token" would wrongly force a routine settings save
      // through the bootstrap-token gate during setup phase (apiToken empty).
      // restoreRedacted() inside ctx.saveAndApplyConfig swaps the real value
      // back in. Exclude REDACTED here, mirroring the strength gate above.
      const settingApiToken = Object.prototype.hasOwnProperty.call(body.config, 'apiToken')
        && typeof body.config.apiToken === 'string'
        && body.config.apiToken.length > 0
        && body.config.apiToken !== REDACTED;
      const setupPhase = (!currentApiToken || currentApiToken === '') && settingApiToken;
      if (setupPhase) {
        if (!requireBootstrapToken(req, res)) return;
      }
      const flippedLegalGates = LEGAL_GATE_PATHS.filter((p) => {
        const before = getByPath(currentCfgForGate, p);
        const after = getByPath(body.config, p);
        // Gate strictly on the ENABLE transition: the new value turns the gate
        // ON and it wasn't ON before. undefined/false → false (fresh-install
        // materialisation) and true → false (disable) are safe → not gated.
        return legalGateOn(p, after) && !legalGateOn(p, before);
      });
      if (flippedLegalGates.length > 0 && req.headers['x-confirm-legal-gate'] !== 'true') {
        // Plan 08-09 Task 2 Step 6: actor context (ip + ua + session) so we
        // can attribute attempted illegal-gate flips, not just see the IP.
        pushLog('legal_gate_flip_rejected', {
          paths: flippedLegalGates,
        }, actorContext(req));
        return json(res, 403, {
          ok: false,
          error: 'legal_gate_flip_requires_confirmation',
          paths: flippedLegalGates,
          hint: 'Add header x-confirm-legal-gate: true after reading EEG/§14a compliance documentation'
        });
      }
      // Plan 08-09 Task 2 Step 6: legal-gate flip events get the same actor
      // context as every other audited mutation (replaces the legacy ip-only
      // shorthand from plan 08-06).
      const cfgActor = actorContext(req);
      if (flippedLegalGates.length > 0) {
        pushLog('legal_gate_flipped', {
          paths: flippedLegalGates,
        }, cfgActor);
      }
      const result = ctx.saveAndApplyConfig(body.config);
      if (importedScheduleRules && typeof ctx.replaceManualScheduleRules === 'function') {
        const count = ctx.replaceManualScheduleRules(importedScheduleRules);
        pushLog('config_import_schedule_rules', { count }, cfgActor);
      }
      // Geräte-Tausch: Schlüssel-Dateien erst NACH erfolgreichem Speichern
      // zurückschreiben (nur erlaubte Pfade, atomar). Lizenz, Kennung, Portal
      // & Co. lesen sie beim Start — deshalb Neustart nötig.
      let migration = null;
      if (migrationFiles) {
        try {
          const written = restoreMigrationFiles(migrationFiles, migrationDirs());
          migration = { files: written, apiToken: typeof body.config.apiToken === 'string' && body.config.apiToken.length > 0 };
          pushLog('config_import_migration_files', { files: written }, cfgActor);
        } catch (e) {
          migration = { error: e.message };
          pushLog('config_import_migration_error', { error: e.message }, cfgActor);
        }
      }
      // Plan 08-06 Task 2 Step 2: consume the one-shot bootstrap token after
      // a successful setup-phase save. From here on, only Bearer-authenticated
      // requests can rewrite config — the takeover window is closed.
      if (setupPhase) {
        consumeBootstrapToken();
        pushLog('setup_bootstrap_consumed', {}, cfgActor);
      }
      // Plan 08-09 Task 2 Step 5: config_saved emits the FULL changedPaths
      // array (regulator-readable diff) plus the legacy count. Path entries
      // are dot-paths (e.g. 'optimizer.minSoc') — the actual VALUES are NOT
      // included to keep secrets out of the audit log (apiToken, mqtt
      // credentials etc. are in REDACTED_PATHS but the policy is "paths
      // only" anyway). This in-handler log is in addition to the generic
      // config_saved emitted by persistConfig (which sees only fs-level
      // context, not the path delta).
      pushLog('config_saved', {
        changedPaths: Array.isArray(result.changedPaths) ? result.changedPaths : [],
        pathCount: Array.isArray(result.changedPaths) ? result.changedPaths.length : 0,
        restartRequired: result.restartRequired,
        source: url.pathname.endsWith('/import') ? 'import' : 'settings',
      }, cfgActor);
      // If any small-market-automation setting changed (e.g. forecastAware,
      // searchWindow, minSoc, …), force a replan so the user immediately sees
      // the new plan instead of waiting for the next ambient regeneration tick
      // — which only fires on price/SOC/day changes, not on config edits.
      const smaChanged = Array.isArray(result.changedPaths)
        && result.changedPaths.some((p) => typeof p === 'string'
          && p.startsWith('schedule.smallMarketAutomation'));
      if (smaChanged && typeof ctx.regenerateSmallMarketAutomationRules === 'function') {
        ctx.regenerateSmallMarketAutomationRules({ force: true })
          .catch((e) => pushLog('sma_regen_after_config_save_error', { error: e.message }));
      }
      // Ändert eine Einstellung die Grundlage des EOS-Plans (Akku, Preise,
      // Netzladen/-entladen, Wallbox, PV-Größe), rechnet EOS sofort neu statt
      // erst zum nächsten Takt — wie beim An- und Abstecken des Autos.
      if (configChangeNeedsEosReplan(result.changedPaths)) {
        ctx.optimizerService?.requestEosReplan?.('config');
      }
      const freshCfg = getCfg();
      // T-LICENSE-KWP-GATING Increment 4: nicht-blockierende Lizenz-kWp-Warnung
      // in der Save-Antwort, wenn die (nun angewandte) PV-Summe den Tarif-Deckel
      // übersteigt. Reines Signal für UI/API-Consumer — der Save wird NIE
      // blockiert (der Betreiber darf seine reale Anlage eintragen); Anzeige/
      // Prognose/EOS gaten bereits über getCapKwp(), Pro-Features über
      // capacityOk(). Community/Legacy (max_kwp==null) → keine Warnung.
      let licenseCapWarning = null;
      try {
        const lic = licenseService?.getState?.();
        const maxKwp = Number(lic?.max_kwp);
        const sysKwp = Number(lic?.system_kwp);
        if (Number.isFinite(maxKwp) && maxKwp > 0 && Number.isFinite(sysKwp) && sysKwp > maxKwp) {
          licenseCapWarning = {
            maxKwp,
            systemKwp: sysKwp,
            message: `Konfigurierte PV-Leistung (${sysKwp} kWp) übersteigt den Lizenz-Tarif `
              + `(${maxKwp} kWp). Anzeige, Prognose und EOS-Planung werden auf ${maxKwp} kWp gekappt.`
          };
        }
      } catch { /* Lizenz-Read best-effort — darf einen Save nie blockieren */ }
      return json(res, 200, {
        ok: true,
        meta: configMetaPayload(),
        config: redactConfig(ctx.getRawCfg()),
        effectiveConfig: redactConfig(freshCfg),
        changedPaths: result.changedPaths,
        restartRequired: result.restartRequired || !!(migration && migration.files && migration.files.length),
        restartRequiredPaths: result.restartRequiredPaths,
        licenseCapWarning,
        migration
      });
    }

    return false;
  };
}
