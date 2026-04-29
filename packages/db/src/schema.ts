import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  index,
  primaryKey,
  pgEnum,
  customType,
} from 'drizzle-orm/pg-core';

// pgvector custom type. Drizzle has experimental support; this is the safe form.
const vector = (name: string, opts: { dimensions: number }) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${opts.dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      // Postgres returns vectors as e.g. "[0.1,0.2,0.3]"
      return value.replace(/^\[|\]$/g, '').split(',').map(Number);
    },
  })(name);

export const transportModeEnum = pgEnum('transport_mode', [
  'sea',
  'air',
  'rail',
  'road',
  'multimodal',
]);

export const hubTypeEnum = pgEnum('hub_type', ['port', 'airport', 'rail', 'warehouse']);

export const hubs = pgTable(
  'hubs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    country: varchar('country', { length: 2 }).notNull(),
    type: hubTypeEnum('type').notNull(),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryIdx: index('hubs_country_idx').on(t.country),
  }),
);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    country: varchar('country', { length: 2 }).notNull(),
    epaBaselineFactor: doublePrecision('epa_baseline_factor').notNull(),
    transportModes: text('transport_modes').array().notNull(),
    embedding: vector('embedding', { dimensions: 384 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countryIdx: index('suppliers_country_idx').on(t.country),
    activeIdx: index('suppliers_active_idx').on(t.active),
  }),
);

export const routes = pgTable(
  'routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    originHubId: uuid('origin_hub_id')
      .notNull()
      .references(() => hubs.id),
    destinationHubId: uuid('destination_hub_id')
      .notNull()
      .references(() => hubs.id),
    distanceKm: doublePrecision('distance_km').notNull(),
    transportMode: transportModeEnum('transport_mode').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    supplierIdx: index('routes_supplier_idx').on(t.supplierId),
    activeIdx: index('routes_active_idx').on(t.active),
  }),
);

// Hypertable: time-series telemetry from shipments.
// Note: Drizzle declares the regular table; the migration converts it to a hypertable.
export const emissionsTelemetry = pgTable(
  'emissions_telemetry',
  {
    time: timestamp('time', { withTimezone: true }).notNull(),
    routeId: uuid('route_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    co2Kg: doublePrecision('co2_kg').notNull(),
    fuelL: doublePrecision('fuel_l').notNull(),
    distanceKm: doublePrecision('distance_km').notNull(),
    transportMode: transportModeEnum('transport_mode').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.time, t.routeId] }),
    routeIdx: index('emissions_telemetry_route_idx').on(t.routeId, t.time.desc()),
    supplierIdx: index('emissions_telemetry_supplier_idx').on(t.supplierId, t.time.desc()),
  }),
);

// Hypertable: rolling carbon scores per route per moment.
export const carbonScores = pgTable(
  'carbon_scores',
  {
    time: timestamp('time', { withTimezone: true }).notNull(),
    routeId: uuid('route_id').notNull(),
    score: doublePrecision('score').notNull(),
    scoreComponents: jsonb('score_components')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    modelVersion: text('model_version').notNull().default('v1'),
    confidenceLower: doublePrecision('confidence_lower'),
    confidenceUpper: doublePrecision('confidence_upper'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.time, t.routeId] }),
    routeIdx: index('carbon_scores_route_idx').on(t.routeId, t.time.desc()),
  }),
);

export const forecasts = pgTable('forecasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  forecastRunId: uuid('forecast_run_id').notNull(),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.id, { onDelete: 'cascade' }),
  horizonDate: timestamp('horizon_date', { withTimezone: true }).notNull(),
  predictedScore: doublePrecision('predicted_score').notNull(),
  ciLower: doublePrecision('ci_lower').notNull(),
  ciUpper: doublePrecision('ci_upper').notNull(),
  model: text('model').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const optimizationRuns = pgTable('optimization_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  goal: jsonb('goal').$type<Record<string, unknown>>().notNull(),
  paretoSolutions: jsonb('pareto_solutions').$type<Array<Record<string, unknown>>>().notNull(),
  agentTrace: jsonb('agent_trace').$type<Array<Record<string, unknown>>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userGoal: text('user_goal').notNull(),
  messages: jsonb('messages').$type<Array<Record<string, unknown>>>().notNull().default([]),
  finalPlan: jsonb('final_plan').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('running'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Hub = typeof hubs.$inferSelect;
export type Supplier = typeof suppliers.$inferSelect;
export type Route = typeof routes.$inferSelect;
export type EmissionsTelemetry = typeof emissionsTelemetry.$inferSelect;
export type CarbonScore = typeof carbonScores.$inferSelect;
export type Forecast = typeof forecasts.$inferSelect;
