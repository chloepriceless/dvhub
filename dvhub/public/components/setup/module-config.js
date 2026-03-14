/**
 * Build a new config object with the specified module enabled/disabled.
 * Pure function -- no framework dependencies, safe for Node.js testing.
 * Deep-clones to avoid mutation.
 * @param {object} currentConfig - Current configuration object
 * @param {string} moduleName - Module name (e.g. 'dv', 'optimizer')
 * @param {boolean} enabled - Whether the module should be enabled
 * @returns {object} New config with modules.[moduleName].enabled set
 */
export function buildModuleConfig(currentConfig, moduleName, enabled) {
  const cloned = JSON.parse(JSON.stringify(currentConfig || {}));
  if (!cloned.modules || typeof cloned.modules !== 'object') {
    cloned.modules = {};
  }
  if (!cloned.modules[moduleName] || typeof cloned.modules[moduleName] !== 'object') {
    cloned.modules[moduleName] = {};
  }
  cloned.modules[moduleName].enabled = enabled;
  return cloned;
}
