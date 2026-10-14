export function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function scheduleMatch(rule, nowMin) {
  if (!rule || rule.enabled === false) return false;
  const start = parseHHMM(rule.start);
  const end = parseHHMM(rule.end);
  if (start == null || end == null) return false;
  if (start <= end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;
}

/**
 * Config neu geladen (Speichern, Oberfläche, Import): Regeln von Hand kommen
 * aus der Config, Plan-Regeln (source 'forecast_optimizer') bleiben aus dem
 * laufenden Zustand — sie stehen nie in der Config (2026-10-14).
 *
 * Die Reihenfolge zählt (die erste passende Regel greift): Die Regeln aus der
 * Config stehen dort, wo im laufenden Zustand die erste Nicht-Plan-Regel stand;
 * die Plan-Regeln behalten ihre Lage davor bzw. dahinter. Ohne Regeln von Hand
 * im Zustand kommen die aus der Config ans Ende.
 *
 * Eine Regel von Hand, die beim Neuladen unverändert bleibt, behält ihre
 * Laufzeit-Markierung _wasActive — sonst würde sie nach ihrem Fenster nicht
 * abgeschaltet, wenn das Neuladen zwischen den letzten Durchlauf im Fenster
 * und den ersten danach fällt (Audit 2026-10-14). Eine geänderte Regel gilt
 * als neu.
 */
export function mergeLoadedScheduleRules(liveRules, configRules) {
  const isPlan = (r) => r?.source === 'forecast_optimizer';
  const content = (r) => JSON.stringify(Object.keys(r).filter((k) => !k.startsWith('_') && k !== 'days' && k !== 'oneTime').sort().map((k) => [k, r[k]]));
  const wasActive = (Array.isArray(liveRules) ? liveRules : [])
    .filter((r) => r && typeof r === 'object' && !isPlan(r) && r._wasActive)
    .map(content);
  const fromConfig = (Array.isArray(configRules) ? configRules : []).filter((r) => !isPlan(r)).map((r) => {
    if (!r || typeof r !== 'object' || !wasActive.length) return r;
    const i = wasActive.indexOf(content(r));
    if (i < 0) return r;
    wasActive.splice(i, 1);
    return { ...r, _wasActive: true };
  });
  const out = [];
  let placed = false;
  for (const r of Array.isArray(liveRules) ? liveRules : []) {
    if (isPlan(r)) out.push(r);
    else if (!placed) { out.push(...fromConfig); placed = true; }
  }
  if (!placed) out.push(...fromConfig);
  return out;
}

export function sanitizePersistedScheduleRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => rule && typeof rule === 'object' && !Array.isArray(rule))
    // Plan-Regeln gehören nicht in die Config (eigene Ablage, rule-store.js).
    .filter((rule) => rule.source !== 'forecast_optimizer')
    .map(({ _wasActive, days, oneTime, ...rest }) => ({ ...rest }));
}

export function autoDisableExpiredScheduleRules(rules, nowMin) {
  if (!Array.isArray(rules)) return { changed: false, rules: [] };

  let changed = false;
  const nextRules = rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
    if (!rule._wasActive || rule.enabled === false) return rule;
    if (scheduleMatch(rule, nowMin)) return rule;
    changed = true;
    const { _wasActive, ...rest } = rule;
    return { ...rest, enabled: false };
  });

  return { changed, rules: nextRules };
}

export function autoDisableStopSocScheduleRules({ rules, nowMin, batterySocPct, socStale = false }) {
  if (!Array.isArray(rules)) return { changed: false, disabledRuleIds: [], rules: [] };
  const socUsable = !(batterySocPct == null || batterySocPct === '' || !Number.isFinite(Number(batterySocPct)));
  // Neither a usable SoC reading nor a stale-telemetry signal → nothing to
  // decide; leave rules untouched (cold-start null falls here — the transient
  // chokepoint discharge floor in applyControlTarget covers that case).
  if (!socUsable && !socStale) {
    return { changed: false, disabledRuleIds: [], rules };
  }

  let changed = false;
  const disabledRuleIds = [];
  const nextRules = rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
    if (rule.enabled === false) return rule;
    if (rule.target !== 'gridSetpointW') return rule;
    if (!scheduleMatch(rule, nowMin)) return rule;

    const stopSocPct = Number(rule.stopSocPct);
    if (!Number.isFinite(stopSocPct)) return rule;

    // T-0075 fail-safe: with stale SoC telemetry we can no longer confirm we are
    // above the stop threshold. Latch the active stop-SoC rule off — the same
    // durable action as a real stop-SoC hit — so a frozen reading can never keep
    // an in-window rule discharging. Stale takes precedence over the (possibly
    // frozen) value comparison below.
    if (socStale) {
      changed = true;
      disabledRuleIds.push(rule.id);
      return { ...rule, enabled: false };
    }

    if (Number(batterySocPct) >= stopSocPct) return rule;

    changed = true;
    disabledRuleIds.push(rule.id);
    return { ...rule, enabled: false };
  });

  return { changed, disabledRuleIds, rules: nextRules };
}
