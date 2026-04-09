// migration-runner.js -- Versioned config migration system.
// Runs sequentially numbered migrations at server startup.
// Each migration is idempotent and transforms the config object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Load all migration modules from migrations/ directory.
 * Files must be named NNN-description.js and export { version, up(config) }.
 */
async function loadMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}-.*\.js$/.test(f))
    .sort();

  const migrations = [];
  for (const file of files) {
    const mod = await import(path.join(MIGRATIONS_DIR, file));
    if (typeof mod.version !== 'number' || typeof mod.up !== 'function') {
      console.warn(`Migration ${file}: skipped (missing version or up function)`);
      continue;
    }
    migrations.push({ file, version: mod.version, up: mod.up, description: mod.description || file });
  }
  return migrations;
}

/**
 * Run pending config migrations.
 * - Backs up config before any changes
 * - Applies migrations sequentially
 * - Updates configSchemaVersion
 * - Writes config atomically (tmp + rename)
 *
 * @param {string} configPath - Path to config.json
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Print changes without writing
 * @param {number} [options.maxBackups=5] - Number of backups to keep
 * @returns {{ applied: string[], fromVersion: number, toVersion: number }}
 */
export async function runMigrations(configPath, options = {}) {
  const { dryRun = false, maxBackups = 5 } = options;

  if (!fs.existsSync(configPath)) {
    return { applied: [], fromVersion: 0, toVersion: 0 };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Migration runner: cannot parse ${configPath}: ${e.message}`);
    return { applied: [], fromVersion: 0, toVersion: 0, error: e.message };
  }

  const currentVersion = config.configSchemaVersion || 0;
  const migrations = await loadMigrations();
  const pending = migrations.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    return { applied: [], fromVersion: currentVersion, toVersion: currentVersion };
  }

  console.log(`Config migrations: ${pending.length} pending (v${currentVersion} → v${pending[pending.length - 1].version})`);

  if (!dryRun) {
    // Backup before any changes
    const backupDir = path.dirname(configPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `config.backup-${timestamp}.json`);
    fs.copyFileSync(configPath, backupPath);
    console.log(`Config backup: ${backupPath}`);

    // Clean old backups (keep maxBackups)
    const backups = fs.readdirSync(backupDir)
      .filter(f => /^config\.backup-.*\.json$/.test(f))
      .sort()
      .reverse();
    for (const old of backups.slice(maxBackups)) {
      fs.unlinkSync(path.join(backupDir, old));
    }
  }

  const applied = [];
  for (const migration of pending) {
    try {
      if (dryRun) {
        console.log(`  [dry-run] Would apply: v${migration.version} — ${migration.description}`);
      } else {
        migration.up(config);
        console.log(`  Applied: v${migration.version} — ${migration.description}`);
      }
      applied.push(migration.description);
    } catch (e) {
      console.error(`  FAILED: v${migration.version} — ${migration.description}: ${e.message}`);
      // Stop on first failure — don't apply further migrations
      break;
    }
  }

  if (!dryRun && applied.length > 0) {
    config.configSchemaVersion = pending[applied.length - 1].version;

    // Atomic write: tmp + rename
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmpPath, configPath);
  }

  const toVersion = applied.length > 0 ? pending[applied.length - 1].version : currentVersion;
  return { applied, fromVersion: currentVersion, toVersion };
}

/**
 * Check system-level requirements and return warnings.
 * These cannot be auto-fixed (require root) but can be shown in the dashboard.
 */
export function checkSystemRequirements() {
  const warnings = [];

  // Check openvpn installed
  try {
    fs.accessSync('/usr/sbin/openvpn', fs.constants.X_OK);
  } catch {
    warnings.push({ id: 'openvpn', message: 'OpenVPN ist nicht installiert. Bitte "sudo apt install openvpn" ausfuehren oder post-update.sh starten.' });
  }

  // Check TUN device (LXC)
  try {
    fs.accessSync('/dev/net/tun');
  } catch {
    warnings.push({ id: 'tun', message: '/dev/net/tun nicht verfuegbar. Bei LXC-Containern muss TUN/TAP auf dem Host aktiviert werden. Empfehlung: VM statt LXC.' });
  }

  // Check TLS cert exists
  const configDir = process.env.DV_APP_CONFIG ? path.dirname(process.env.DV_APP_CONFIG) : '/etc/dvhub';
  const tlsCert = path.join(configDir, 'tls', 'cert.pem');
  try {
    fs.accessSync(tlsCert);
  } catch {
    warnings.push({ id: 'tls', message: 'Kein TLS-Zertifikat gefunden. HTTPS ist deaktiviert. Bitte post-update.sh ausfuehren.' });
  }

  return warnings;
}
