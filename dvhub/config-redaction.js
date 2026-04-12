// SEC-01: Single source of truth for redacted config field paths.
// Imported by routes-api.js (redactConfig) and server.js (restoreRedacted)

export const REDACTED_PATHS = Object.freeze([
  'apiToken',
  'telemetry.historyImport.vrmToken',
  'telemetry.database.password',
  'forecast.solcast.apiKey',
  'mqtt.username',
  'mqtt.password',
  'notifications.providers.telegram.botToken',
  'notifications.providers.telegram.chatId',
  'notifications.providers.pushover.appToken',
  'notifications.providers.pushover.userKey'
]);

const REDACTED = '***';

export function isRedactedPath(path) {
  return REDACTED_PATHS.includes(path);
}

export function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj?.[parts[i]];
      if (!obj) break;
    }
    if (obj && parts[parts.length - 1] in obj) {
      obj[parts[parts.length - 1]] = REDACTED;
    }
  }
  return copy;
}

export function restoreRedacted(incoming, current) {
  const copy = JSON.parse(JSON.stringify(incoming));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let target = copy;
    let source = current;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target?.[parts[i]];
      source = source?.[parts[i]];
      if (!target || !source) break;
    }
    const key = parts[parts.length - 1];
    if (target && source && target[key] === REDACTED && key in source) {
      target[key] = source[key];
    }
  }
  return copy;
}
