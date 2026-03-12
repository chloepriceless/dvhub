const DEFAULT_DISCOVERY_TIMEOUT_MS = 1500;
const VICTRON_HINTS = ['victron', 'venus', 'cerbo', 'gx'];

export class DiscoveryTimeoutError extends Error {
  constructor(message = 'Discovery timed out') {
    super(message);
    this.name = 'DiscoveryTimeoutError';
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
}

function normalizeIp(value) {
  return String(value || '').trim();
}

function buildDiscoveryKey(system) {
  return [
    String(system.manufacturer || '').trim().toLowerCase(),
    normalizeHost(system.host),
    normalizeIp(system.ip),
    String(system.label || '').trim().toLowerCase()
  ].join('|');
}

function buildDiscoveryId(system) {
  const preferredHost = normalizeIp(system.ip) || normalizeHost(system.host) || 'unknown';
  const preferredLabel = String(system.label || 'system')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'system';
  const manufacturer = String(system.manufacturer || 'system').trim().toLowerCase() || 'system';
  return `${manufacturer}-${preferredLabel}-${preferredHost}`;
}

function hasVictronHint(value) {
  const text = String(value || '').trim().toLowerCase();
  return VICTRON_HINTS.some((hint) => text.includes(hint));
}

function extractServiceLabel(value) {
  const text = String(value || '').trim().replace(/\.$/, '');
  return text.replace(/\._[a-z0-9-]+\._tcp\.local$/i, '') || text;
}

function collectMdnsRecords(packet) {
  const answers = Array.isArray(packet?.answers) ? packet.answers : [];
  const additionals = Array.isArray(packet?.additionals) ? packet.additionals : [];
  return answers.concat(additionals).filter((record) => record && typeof record === 'object');
}

function upsertCandidate(candidates, key, patch) {
  const candidate = candidates.get(key) || {
    manufacturer: 'victron',
    label: '',
    host: '',
    ip: '',
    meta: {}
  };
  if (patch.label) candidate.label = patch.label;
  if (patch.host) candidate.host = normalizeHost(patch.host);
  if (patch.ip) candidate.ip = normalizeIp(patch.ip);
  if (isPlainObject(patch.meta)) {
    candidate.meta = { ...candidate.meta, ...patch.meta };
  }
  candidates.set(key, candidate);
}

function updateVictronCandidates(candidates, records) {
  const ipsByHost = new Map();
  for (const record of records) {
    if (record.type !== 'A' && record.type !== 'AAAA') continue;
    const host = normalizeHost(record.name);
    const ip = normalizeIp(record.data);
    if (host && ip) ipsByHost.set(host, ip);
  }

  for (const record of records) {
    if (record.type !== 'PTR') continue;
    const serviceName = String(record.data || '').trim();
    if (!hasVictronHint(serviceName)) continue;
    upsertCandidate(candidates, serviceName, {
      label: extractServiceLabel(serviceName),
      meta: { serviceName }
    });
  }

  for (const record of records) {
    if (record.type !== 'SRV' || !isPlainObject(record.data)) continue;
    const serviceName = String(record.name || '').trim();
    const target = normalizeHost(record.data.target);
    const label = extractServiceLabel(serviceName);
    if (!hasVictronHint(serviceName) && !hasVictronHint(target) && !hasVictronHint(label)) continue;
    upsertCandidate(candidates, target || serviceName, {
      label: label || target,
      host: target,
      ip: ipsByHost.get(target) || '',
      meta: { serviceName }
    });
  }

  for (const record of records) {
    if (record.type !== 'A' && record.type !== 'AAAA') continue;
    const host = normalizeHost(record.name);
    const ip = normalizeIp(record.data);
    if (!hasVictronHint(host) || !ip) continue;
    upsertCandidate(candidates, host, {
      label: extractServiceLabel(host),
      host,
      ip,
      meta: { serviceName: host }
    });
  }

  for (const candidate of candidates.values()) {
    if (!candidate.ip && candidate.host && ipsByHost.has(candidate.host)) {
      candidate.ip = ipsByHost.get(candidate.host);
    }
  }
}

function normalizeAndDedupe(systems, { manufacturer = '' } = {}) {
  const entries = Array.isArray(systems) ? systems : [];
  const seen = new Set();
  const normalized = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const host = normalizeHost(entry.host);
    const ip = normalizeIp(entry.ip);
    if (!host && !ip) continue;
    const system = {
      id: entry.id || buildDiscoveryId({ ...entry, manufacturer, host, ip }),
      label: String(entry.label || host || ip || 'System').trim(),
      host,
      ip
    };
    if (isPlainObject(entry.meta) && Object.keys(entry.meta).length) {
      system.meta = entry.meta;
    }
    const key = buildDiscoveryKey({ ...system, manufacturer });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(system);
  }

  return normalized;
}

export async function createMdnsBrowser({ mdnsImport = () => import('multicast-dns') } = {}) {
  const module = await mdnsImport();
  const factory = module.default || module;
  return factory();
}

async function browseVictronAnnouncements(browser, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const candidates = new Map();
    let settled = false;
    const removeListener = typeof browser?.off === 'function'
      ? browser.off.bind(browser)
      : browser?.removeListener?.bind(browser);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (removeListener) {
        removeListener('response', onResponse);
        removeListener('error', onError);
      }
      browser?.destroy?.();
      callback();
    };

    const onResponse = (packet) => {
      updateVictronCandidates(candidates, collectMdnsRecords(packet));
    };

    const onError = (error) => {
      finish(() => reject(error));
    };

    const timer = setTimeout(() => {
      const systems = normalizeAndDedupe(Array.from(candidates.values()), { manufacturer: 'victron' });
      if (systems.length === 0) {
        finish(() => reject(new DiscoveryTimeoutError('timed out')));
        return;
      }
      finish(() => resolve(systems));
    }, timeoutMs);

    browser?.on?.('response', onResponse);
    browser?.on?.('error', onError);
    browser?.query?.([{ name: '_http._tcp.local', type: 'PTR' }]);
    browser?.query?.([{ name: 'venus.local', type: 'A' }]);
    browser?.query?.([{ name: 'venus.local', type: 'AAAA' }]);
  });
}

async function discoverVictronSystems({ timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, mdnsFactory = createMdnsBrowser } = {}) {
  const browser = await mdnsFactory();
  return browseVictronAnnouncements(browser, timeoutMs);
}

const DEFAULT_PROVIDERS = {
  victron: discoverVictronSystems
};

export async function discoverSystems({ manufacturer, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, providers = DEFAULT_PROVIDERS } = {}) {
  const provider = providers?.[manufacturer];
  if (!provider) {
    throw new Error(`discovery not supported for manufacturer: ${manufacturer}`);
  }
  try {
    return normalizeAndDedupe(await provider({ timeoutMs }), { manufacturer });
  } catch (error) {
    if (error instanceof DiscoveryTimeoutError) {
      return [];
    }
    throw error;
  }
}
