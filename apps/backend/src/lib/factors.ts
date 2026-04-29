/**
 * Transport-mode emission factors (kg CO2e per ton-km).
 * Intentionally duplicated from packages/db/src/seed-data so the backend
 * doesn't pull in the Drizzle schema graph at runtime.
 */
export const TRANSPORT_MODE_FACTORS = {
  sea: 0.011,
  rail: 0.022,
  road: 0.062,
  air: 0.602,
  multimodal: 0.045,
} as const;

export type TransportMode = keyof typeof TRANSPORT_MODE_FACTORS;
