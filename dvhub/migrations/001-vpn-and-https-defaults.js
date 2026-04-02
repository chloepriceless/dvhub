// 001-vpn-and-https-defaults.js
// Adds VPN config section and HTTPS defaults for v1.0 upgrade.

export const version = 1;
export const description = 'VPN-Sektion und HTTPS-Defaults hinzufuegen';

export function up(config) {
  // Add vpn section if missing
  if (!config.vpn) {
    config.vpn = {
      enabled: false,
      protocol: 'openvpn',
      autoConnect: true,
      profileName: 'direktvermarkter',
      watchdog: {
        enabled: true,
        intervalMs: 10000,
        failThreshold: 3,
        maxBackoffMs: 120000
      }
    };
  }

  // Ensure vpn.watchdog exists
  if (config.vpn && !config.vpn.watchdog) {
    config.vpn.watchdog = {
      enabled: true,
      intervalMs: 10000,
      failThreshold: 3,
      maxBackoffMs: 120000
    };
  }

  // Ensure profileName has a value (was sometimes empty string)
  if (config.vpn && !config.vpn.profileName) {
    config.vpn.profileName = 'direktvermarkter';
  }

  // Add httpsPort if missing (0 = disabled by default for upgrades)
  if (config.httpsPort === undefined) {
    config.httpsPort = 0;
  }

  // Migrate httpPort from 8080 to 80 for fresh installs only
  // (don't change existing installs — they chose 8080 deliberately)
}
