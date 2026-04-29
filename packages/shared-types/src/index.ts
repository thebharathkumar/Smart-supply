/**
 * Single source of truth for cross-process schemas.
 * Used by:
 *   - backend (REST input validation, WS message validation)
 *   - frontend (typed API client + WS messages)
 *   - simulator (Kafka event payloads)
 *   - ml-* services indirectly via JSON schema mirrors
 */
import { z } from 'zod';

// ---------- Domain primitives ----------
export const TransportMode = z.enum(['sea', 'air', 'rail', 'road', 'multimodal']);
export type TransportMode = z.infer<typeof TransportMode>;

export const HubType = z.enum(['port', 'airport', 'rail', 'warehouse']);
export type HubType = z.infer<typeof HubType>;

export const Hub = z.object({
  id: z.string().uuid(),
  name: z.string(),
  country: z.string().length(2),
  type: HubType,
  lat: z.number(),
  lng: z.number(),
});
export type Hub = z.infer<typeof Hub>;

export const Supplier = z.object({
  id: z.string().uuid(),
  name: z.string(),
  country: z.string().length(2),
  epaBaselineFactor: z.number(),
  transportModes: z.array(TransportMode),
  active: z.boolean(),
  metadata: z.record(z.unknown()).default({}),
});
export type Supplier = z.infer<typeof Supplier>;

export const Route = z.object({
  id: z.string().uuid(),
  supplierId: z.string().uuid(),
  originHubId: z.string().uuid(),
  destinationHubId: z.string().uuid(),
  distanceKm: z.number(),
  transportMode: TransportMode,
  active: z.boolean(),
});
export type Route = z.infer<typeof Route>;

export const CarbonScore = z.object({
  time: z.string().datetime(),
  routeId: z.string().uuid(),
  score: z.number(),
  scoreComponents: z.record(z.number()).optional(),
  modelVersion: z.string(),
  confidenceLower: z.number().nullable(),
  confidenceUpper: z.number().nullable(),
});
export type CarbonScore = z.infer<typeof CarbonScore>;

// ---------- Kafka events ----------
export const ShipmentPositionEvent = z.object({
  type: z.literal('shipment.position'),
  shipmentId: z.string(),
  routeId: z.string().uuid(),
  ts: z.string().datetime(),
  lat: z.number(),
  lng: z.number(),
  speedKnots: z.number().nonnegative(),
  headingDeg: z.number().min(0).max(360),
});
export type ShipmentPositionEvent = z.infer<typeof ShipmentPositionEvent>;

export const ShipmentFuelEvent = z.object({
  type: z.literal('shipment.fuel'),
  shipmentId: z.string(),
  routeId: z.string().uuid(),
  ts: z.string().datetime(),
  fuelLPerHour: z.number().nonnegative(),
  load: z.number().min(0).max(1),
});
export type ShipmentFuelEvent = z.infer<typeof ShipmentFuelEvent>;

export const PortCongestionEvent = z.object({
  type: z.literal('port.congestion'),
  hubId: z.string().uuid(),
  ts: z.string().datetime(),
  queueDepth: z.number().int().nonnegative(),
  avgWaitHours: z.number().nonnegative(),
});
export type PortCongestionEvent = z.infer<typeof PortCongestionEvent>;

export const WeatherUpdateEvent = z.object({
  type: z.literal('weather.update'),
  region: z.string(),
  ts: z.string().datetime(),
  windKnots: z.number().nonnegative(),
  swellM: z.number().nonnegative(),
  precipMm: z.number().nonnegative(),
});
export type WeatherUpdateEvent = z.infer<typeof WeatherUpdateEvent>;

export const ShipmentScoreUpdatedEvent = z.object({
  type: z.literal('shipment.score_updated'),
  routeId: z.string().uuid(),
  ts: z.string().datetime(),
  score: z.number(),
  windowSec: z.number().int().positive(),
});
export type ShipmentScoreUpdatedEvent = z.infer<typeof ShipmentScoreUpdatedEvent>;

export const KafkaTopic = {
  ShipmentPosition: 'shipment.position',
  ShipmentFuel: 'shipment.fuel',
  PortCongestion: 'port.congestion',
  WeatherUpdate: 'weather.update',
  ShipmentScoreUpdated: 'shipment.score_updated',
} as const;
export type KafkaTopic = (typeof KafkaTopic)[keyof typeof KafkaTopic];

// ---------- WebSocket protocol ----------
export const WsServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    serverTime: z.string().datetime(),
    sessionId: z.string(),
  }),
  z.object({ type: z.literal('score_update'), data: ShipmentScoreUpdatedEvent }),
  z.object({ type: z.literal('position_update'), data: ShipmentPositionEvent }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('pong'), ts: z.string().datetime() }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

export const WsClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), routeIds: z.array(z.string().uuid()).optional() }),
  z.object({ type: z.literal('unsubscribe'), routeIds: z.array(z.string().uuid()).optional() }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

// ---------- ML service request/response ----------
export const ForecastRequest = z.object({
  supplierId: z.string().uuid(),
  horizonDays: z.number().int().min(1).max(365).default(30),
});
export type ForecastRequest = z.infer<typeof ForecastRequest>;

export const ForecastPoint = z.object({
  date: z.string(),
  predicted: z.number(),
  ciLower: z.number(),
  ciUpper: z.number(),
});

export const ForecastResponse = z.object({
  supplierId: z.string().uuid(),
  model: z.string(),
  generatedAt: z.string().datetime(),
  horizonDays: z.number().int(),
  points: z.array(ForecastPoint),
  metrics: z.object({
    mape: z.number().nullable(),
    samples: z.number().int(),
  }),
});
export type ForecastResponse = z.infer<typeof ForecastResponse>;

export const OptimizeRouteRequest = z.object({
  originHubId: z.string().uuid(),
  destinationHubId: z.string().uuid(),
  weightCo2: z.number().min(0).max(1).default(0.5),
  weightCost: z.number().min(0).max(1).default(0.3),
  weightTime: z.number().min(0).max(1).default(0.2),
  topK: z.number().int().min(1).max(10).default(3),
});
export type OptimizeRouteRequest = z.infer<typeof OptimizeRouteRequest>;

export const ParetoSolution = z.object({
  rank: z.number().int(),
  routeIds: z.array(z.string().uuid()),
  totalCo2Kg: z.number(),
  totalCostUsd: z.number(),
  totalTimeHours: z.number(),
  explanation: z.string(),
});

export const OptimizeRouteResponse = z.object({
  runId: z.string().uuid(),
  solutions: z.array(ParetoSolution),
});
export type OptimizeRouteResponse = z.infer<typeof OptimizeRouteResponse>;
