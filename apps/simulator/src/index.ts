/**
 * Synthetic shipment telemetry producer.
 *
 * Loads active routes + hubs on boot, simulates N concurrent shipments, and
 * emits realistic position/fuel events to Kafka at the configured rate.
 *
 * Each shipment moves along its route, varies fuel burn with load + weather,
 * and respects rate limiting so the broker / consumer stay within capacity.
 */
import { Kafka } from 'kafkajs';
import postgres from 'postgres';
import pino from 'pino';
import { z } from 'zod';
import {
  KafkaTopic,
  type ShipmentPositionEvent,
  type ShipmentFuelEvent,
  type WeatherUpdateEvent,
  type PortCongestionEvent,
} from '@smart-supply/shared-types';

const Env = z.object({
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  DATABASE_URL: z.string().url(),
  SIM_EVENTS_PER_SEC: z.coerce.number().int().positive().default(200),
  SIM_SHIPMENTS: z.coerce.number().int().positive().default(50),
  SIM_REGIONS: z.coerce.number().int().positive().default(10),
});

const cfg = Env.parse(process.env);
const log = pino({ name: 'simulator', level: 'info' });

interface RouteRow {
  id: string;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
  origin_hub_id: string;
}

interface Shipment {
  id: string;
  route: RouteRow;
  progress: number; // 0..1 along the route
  speed: number; // progress per second
  baseLoad: number; // 0..1
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function loadRoutes(sql: ReturnType<typeof postgres>): Promise<RouteRow[]> {
  const rows = (await sql`
    SELECT r.id, r.origin_hub_id,
           oh.lat AS origin_lat, oh.lng AS origin_lng,
           dh.lat AS destination_lat, dh.lng AS destination_lng
    FROM routes r
    JOIN hubs oh ON oh.id = r.origin_hub_id
    JOIN hubs dh ON dh.id = r.destination_hub_id
    WHERE r.active = TRUE
  `) as unknown as RouteRow[];
  return rows;
}

async function loadHubIds(sql: ReturnType<typeof postgres>): Promise<string[]> {
  const rows = (await sql`SELECT id FROM hubs`) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const sql = postgres(cfg.DATABASE_URL, { max: 2, prepare: false });
  let routes: RouteRow[] = [];
  let hubIds: string[] = [];
  // Wait for DB readiness with backoff.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      routes = await loadRoutes(sql);
      hubIds = await loadHubIds(sql);
      if (routes.length > 0) break;
    } catch (err) {
      log.warn({ attempt, err: (err as Error).message }, 'db not ready, retrying');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (routes.length === 0) {
    throw new Error('no active routes found - did you run the seed?');
  }
  log.info({ routes: routes.length }, 'routes loaded');

  const kafka = new Kafka({
    clientId: 'smart-supply-simulator',
    brokers: cfg.KAFKA_BROKERS.split(',').map((s) => s.trim()),
    retry: { retries: 5, initialRetryTime: 300 },
  });
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  log.info('producer connected');

  const shipments: Shipment[] = Array.from({ length: cfg.SIM_SHIPMENTS }, (_, i) => {
    const route = routes[i % routes.length]!;
    return {
      id: `ship-${i.toString().padStart(4, '0')}`,
      route,
      progress: Math.random(),
      speed: 0.0001 + Math.random() * 0.0005, // covers route in ~30min - 3h sim time
      baseLoad: 0.4 + Math.random() * 0.5,
    };
  });

  const intervalMs = Math.max(20, Math.floor(1000 / (cfg.SIM_EVENTS_PER_SEC / 2))); // half pos, half fuel

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log.info('shutting down');
    await producer.disconnect().catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  // Position + fuel loop
  setInterval(() => {
    if (stopped) return;
    const ship = shipments[Math.floor(Math.random() * shipments.length)]!;
    const dt = intervalMs / 1000;
    ship.progress = (ship.progress + ship.speed * dt) % 1;
    const lat = lerp(ship.route.origin_lat, ship.route.destination_lat, ship.progress);
    const lng = lerp(ship.route.origin_lng, ship.route.destination_lng, ship.progress);
    const heading =
      (Math.atan2(
        ship.route.destination_lng - ship.route.origin_lng,
        ship.route.destination_lat - ship.route.origin_lat,
      ) *
        180) /
      Math.PI;
    const ts = new Date().toISOString();

    const pos: ShipmentPositionEvent = {
      type: 'shipment.position',
      shipmentId: ship.id,
      routeId: ship.route.id,
      ts,
      lat,
      lng,
      speedKnots: 12 + Math.random() * 8,
      headingDeg: ((heading + 360) % 360),
    };
    const fuel: ShipmentFuelEvent = {
      type: 'shipment.fuel',
      shipmentId: ship.id,
      routeId: ship.route.id,
      ts,
      fuelLPerHour: 800 + ship.baseLoad * 1500 + (Math.random() - 0.5) * 200,
      load: Math.max(0, Math.min(1, ship.baseLoad + (Math.random() - 0.5) * 0.1)),
    };

    producer
      .sendBatch({
        topicMessages: [
          {
            topic: KafkaTopic.ShipmentPosition,
            messages: [{ key: ship.id, value: JSON.stringify(pos) }],
          },
          {
            topic: KafkaTopic.ShipmentFuel,
            messages: [{ key: ship.id, value: JSON.stringify(fuel) }],
          },
        ],
      })
      .catch((err) => log.warn({ err: (err as Error).message }, 'send failed'));
  }, intervalMs);

  // Weather updates: 1 per 5s per region.
  setInterval(() => {
    for (let r = 0; r < cfg.SIM_REGIONS; r++) {
      const ev: WeatherUpdateEvent = {
        type: 'weather.update',
        region: `region-${r}`,
        ts: new Date().toISOString(),
        windKnots: 5 + Math.random() * 25,
        swellM: Math.random() * 4,
        precipMm: Math.random() * 8,
      };
      producer
        .send({
          topic: KafkaTopic.WeatherUpdate,
          messages: [{ key: ev.region, value: JSON.stringify(ev) }],
        })
        .catch(() => undefined);
    }
  }, 5000);

  // Port congestion: 1 per 10s per hub.
  setInterval(() => {
    if (hubIds.length === 0) return;
    const hubId = hubIds[Math.floor(Math.random() * hubIds.length)]!;
    const ev: PortCongestionEvent = {
      type: 'port.congestion',
      hubId,
      ts: new Date().toISOString(),
      queueDepth: Math.floor(Math.random() * 30),
      avgWaitHours: Math.random() * 12,
    };
    producer
      .send({
        topic: KafkaTopic.PortCongestion,
        messages: [{ key: hubId, value: JSON.stringify(ev) }],
      })
      .catch(() => undefined);
  }, 10000);

  log.info(
    { shipments: shipments.length, intervalMs, eventsPerSec: cfg.SIM_EVENTS_PER_SEC },
    'simulator running',
  );
}

main().catch((err) => {
  log.error({ err }, 'simulator crashed');
  process.exit(1);
});
