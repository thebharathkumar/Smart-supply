/**
 * Stream consumer: aggregates raw shipment telemetry into rolling carbon scores.
 *
 * Pipeline:
 *   shipment.position + shipment.fuel  --(5s window)-->  derived score
 *     -> writes to emissions_telemetry + carbon_scores
 *     -> publishes shipment.score_updated to Kafka
 *     -> publishes to Redis pubsub for WS fanout
 *
 * Window strategy: per-route tumbling 5s windows, keyed by routeId. We track
 * (samples, sumCo2, sumFuel) and flush on window boundary.
 */
import { Kafka, type Consumer, type Producer, type EachMessagePayload } from 'kafkajs';
import {
  ShipmentPositionEvent,
  ShipmentFuelEvent,
  KafkaTopic,
  type ShipmentScoreUpdatedEvent,
} from '@smart-supply/shared-types';
import { TRANSPORT_MODE_FACTORS } from './lib/factors.js';
import type postgres from 'postgres';
import type { WsHub } from './ws-hub.js';
import type { Logger } from './logger.js';

interface RouteState {
  routeId: string;
  supplierId: string;
  transportMode: keyof typeof TRANSPORT_MODE_FACTORS;
  distanceKm: number;
  windowStart: number;
  samples: number;
  sumCo2Kg: number;
  sumFuelL: number;
}

const WINDOW_MS = 5_000;

export class StreamConsumer {
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;
  private readonly state = new Map<string, RouteState>();
  private flushTimer: NodeJS.Timeout | null = null;
  private routeMeta = new Map<
    string,
    { supplierId: string; transportMode: keyof typeof TRANSPORT_MODE_FACTORS; distanceKm: number }
  >();

  constructor(
    private readonly kafka: Kafka,
    private readonly sql: ReturnType<typeof postgres>,
    private readonly hub: WsHub,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    await this.loadRouteMeta();

    this.consumer = this.kafka.consumer({ groupId: 'backend-stream-consumer' });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
    await Promise.all([this.consumer.connect(), this.producer.connect()]);
    await this.consumer.subscribe({
      topics: [KafkaTopic.ShipmentPosition, KafkaTopic.ShipmentFuel],
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async (payload) => this.onMessage(payload),
    });

    this.flushTimer = setInterval(() => this.flushExpired(), 1000);
    this.log.info('stream consumer started');
  }

  private async loadRouteMeta(): Promise<void> {
    const rows = (await this.sql`
      SELECT id, supplier_id, transport_mode, distance_km
      FROM routes WHERE active = TRUE
    `) as Array<{
      id: string;
      supplier_id: string;
      transport_mode: string;
      distance_km: number;
    }>;
    for (const r of rows) {
      this.routeMeta.set(r.id, {
        supplierId: r.supplier_id,
        transportMode: r.transport_mode as keyof typeof TRANSPORT_MODE_FACTORS,
        distanceKm: r.distance_km,
      });
    }
    this.log.info({ routes: rows.length }, 'route meta loaded');
  }

  private async onMessage({ topic, message }: EachMessagePayload): Promise<void> {
    if (!message.value) return;
    const text = message.value.toString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (topic === KafkaTopic.ShipmentPosition) {
      const ev = ShipmentPositionEvent.safeParse(parsed);
      if (!ev.success) return;
      this.touchWindow(ev.data.routeId);
    } else if (topic === KafkaTopic.ShipmentFuel) {
      const ev = ShipmentFuelEvent.safeParse(parsed);
      if (!ev.success) return;
      this.applyFuel(ev.data);
    }
  }

  private touchWindow(routeId: string): void {
    if (!this.routeMeta.has(routeId)) return;
    if (!this.state.has(routeId)) {
      const meta = this.routeMeta.get(routeId)!;
      this.state.set(routeId, {
        routeId,
        supplierId: meta.supplierId,
        transportMode: meta.transportMode,
        distanceKm: meta.distanceKm,
        windowStart: Date.now(),
        samples: 0,
        sumCo2Kg: 0,
        sumFuelL: 0,
      });
    }
  }

  private applyFuel(ev: ShipmentFuelEvent): void {
    const meta = this.routeMeta.get(ev.routeId);
    if (!meta) return;
    this.touchWindow(ev.routeId);
    const window = this.state.get(ev.routeId)!;
    const factor = TRANSPORT_MODE_FACTORS[meta.transportMode];
    // CO2 per second contribution: fuel L/h * 2.68 kg/L -> kg/h -> kg/s scaled.
    const co2KgPerSec = (ev.fuelLPerHour * 2.68) / 3600;
    // Scale by load factor and emission factor adjustment.
    const adj = co2KgPerSec * (0.6 + 0.8 * ev.load) * (factor / 0.062);
    window.sumCo2Kg += adj;
    window.sumFuelL += ev.fuelLPerHour / 3600;
    window.samples += 1;
  }

  private flushExpired(): void {
    const now = Date.now();
    for (const [routeId, w] of this.state) {
      if (now - w.windowStart >= WINDOW_MS && w.samples > 0) {
        this.flushWindow(w).catch((err) =>
          this.log.error({ err, routeId }, 'window flush failed'),
        );
        this.state.delete(routeId);
      }
    }
  }

  private async flushWindow(w: RouteState): Promise<void> {
    const ts = new Date(w.windowStart + WINDOW_MS / 2);
    // Score: lower intensity per km is better. Map to 0-100.
    const intensity = w.sumCo2Kg / Math.max(w.samples, 1);
    const factor = TRANSPORT_MODE_FACTORS[w.transportMode];
    const score = Math.max(0, Math.min(100, 100 - intensity * 30 - factor * 50));

    // Persist to TimescaleDB.
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO emissions_telemetry (time, route_id, supplier_id, co2_kg, fuel_l, distance_km, transport_mode)
        VALUES (${ts}, ${w.routeId}, ${w.supplierId}, ${w.sumCo2Kg}, ${w.sumFuelL}, ${w.distanceKm}, ${w.transportMode})
        ON CONFLICT (time, route_id) DO UPDATE
          SET co2_kg = EXCLUDED.co2_kg, fuel_l = EXCLUDED.fuel_l
      `;
      await tx`
        INSERT INTO carbon_scores (time, route_id, score, score_components, model_version, confidence_lower, confidence_upper)
        VALUES (${ts}, ${w.routeId}, ${score}, ${tx.json({ factor, intensity, samples: w.samples })}, 'streaming-v1', ${score - 4}, ${score + 4})
        ON CONFLICT (time, route_id) DO UPDATE SET score = EXCLUDED.score
      `;
    });

    const event: ShipmentScoreUpdatedEvent = {
      type: 'shipment.score_updated',
      routeId: w.routeId,
      ts: ts.toISOString(),
      score: Number(score.toFixed(2)),
      windowSec: WINDOW_MS / 1000,
    };

    // Fire-and-forget Kafka emit; don't block fanout on broker latency.
    this.producer
      ?.send({
        topic: KafkaTopic.ShipmentScoreUpdated,
        messages: [{ key: w.routeId, value: JSON.stringify(event) }],
      })
      .catch((err) => this.log.warn({ err }, 'producer send failed'));

    await this.hub.publishScoreUpdate(event);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await Promise.allSettled([this.consumer?.disconnect(), this.producer?.disconnect()]);
  }
}
