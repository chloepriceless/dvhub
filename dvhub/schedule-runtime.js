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

export function sanitizePersistedScheduleRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule) => rule && typeof rule === 'object' && !Array.isArray(rule))
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
