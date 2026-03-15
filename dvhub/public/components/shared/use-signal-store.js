import { signal, computed } from '@preact/signals';
import { computeAutarky, computeSelfConsumption } from './compute.js';

// Re-export pure functions for convenience
export { computeAutarky, computeSelfConsumption };

// Core signals fed by WebSocket
export const telemetry = signal({});
export const config = signal({});
export const wsConnected = signal(false);
export const prices = signal([]);
export const forecast = signal({ pv: [], load: [] });
export const dvStatus = signal({});
export const execStatus = signal({});
export const userEnergyPricing = signal(null);

// --- Computed signals using the pure functions ---

export const autarkyRate = computed(() => {
  const t = telemetry.value;
  return computeAutarky(t.loadPower, t.gridPower);
});

export const selfConsumptionRate = computed(() => {
  const t = telemetry.value;
  return computeSelfConsumption(t.pvPower, t.gridPower);
});
