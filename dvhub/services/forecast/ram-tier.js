// ram-tier.js -- RAM tier detection utility for forecast feature gating.
// Tier 1 (< 2GB): API+SQL only. Tier 2 (2-4GB): +pvlib batch. Tier 3 (4GB+): +persistent Python.
// Pure JavaScript, no native addons -- compatible with ARM64 + x64.

import os from 'node:os';

/**
 * Compute RAM tier from total memory in MB.
 * @param {number} totalMB - Total system memory in megabytes
 * @returns {number} tier - 1, 2, or 3
 */
export function computeTier(totalMB) {
  return totalMB < 2048 ? 1 : totalMB < 4096 ? 2 : 3;
}

/**
 * Detect RAM tier based on total system memory.
 * Tier 1 (< 2GB): API+SQL only. Tier 2 (2-4GB): +pvlib batch. Tier 3 (4GB+): +persistent Python.
 * @returns {{ tier: number, totalMB: number }}
 */
export function detectRamTier() {
  const totalMB = Math.floor(os.totalmem() / (1024 * 1024));
  const tier = computeTier(totalMB);
  return { tier, totalMB };
}
