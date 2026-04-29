/**
 * Seed the database with realistic demo data:
 *   - 30 hubs across global trade corridors
 *   - 80 suppliers across 25 countries
 *   - 50 active routes
 *   - 6 months of synthetic emissions telemetry (~1 sample/hour/route)
 *   - Initial carbon scores derived from telemetry
 *
 * Deterministic via a seeded RNG so re-running produces the same data.
 * Idempotent: skips if suppliers already exist.
 */
import postgres from 'postgres';
import {
  COUNTRIES,
  HUBS,
  SUPPLIER_NAME_PARTS,
  TRANSPORT_MODE_FACTORS,
  type TransportMode,
} from './seed-data.js';

// ---------- Seeded RNG (mulberry32) ----------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ---------- Geo ----------
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Embedding generator ----------
// In production we'd use a real text embedding model. For seed determinism
// we synthesize a 384-dim unit-norm vector from supplier attributes so
// pgvector similarity search behaves sensibly in the demo.
function syntheticEmbedding(seedStr: string): number[] {
  const dim = 384;
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
  const r = mulberry32(h >>> 0);
  const v = Array.from({ length: dim }, () => r() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// ---------- Main ----------
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = postgres(url, { max: 4, prepare: false });

  try {
    const countRows = (await sql`
      SELECT COUNT(*)::int AS count FROM suppliers
    `) as Array<{ count: number }>;
    const existing = countRows[0]?.count ?? 0;

    if (existing > 0) {
      console.log(`[seed] suppliers already present (${existing}); skipping`);
      return;
    }

    console.log('[seed] inserting hubs');
    const hubRows = (await sql`
      INSERT INTO hubs ${sql(HUBS.map((h) => ({ ...h })))}
      RETURNING id, name, country, type, lat, lng
    `) as unknown as Array<{
      id: string;
      name: string;
      country: string;
      type: 'port' | 'airport' | 'rail' | 'warehouse';
      lat: number;
      lng: number;
    }>;
    type HubRow = (typeof hubRows)[number];
    const hubsByCountry = new Map<string, HubRow[]>();
    for (const h of hubRows) {
      const list = hubsByCountry.get(h.country) ?? [];
      list.push(h);
      hubsByCountry.set(h.country, list);
    }

    console.log('[seed] inserting suppliers');
    const SUPPLIER_COUNT = 80;
    const suppliersToInsert = range(SUPPLIER_COUNT).map((i) => {
      const country = pick(COUNTRIES);
      // Baseline factor mostly tracks grid intensity but with supplier-specific noise.
      const baseline =
        country.gridIntensity / 1000 + (rng() * 0.4 - 0.2) * (country.gridIntensity / 1000);
      const modes: TransportMode[] = (() => {
        const all: TransportMode[] = ['sea', 'air', 'rail', 'road', 'multimodal'];
        const n = 1 + Math.floor(rng() * 3);
        const shuffled = [...all].sort(() => rng() - 0.5);
        return shuffled.slice(0, n);
      })();
      const name = `${pick(SUPPLIER_NAME_PARTS.prefixes)} ${pick(
        SUPPLIER_NAME_PARTS.suffixes,
      )} ${i.toString().padStart(3, '0')}`;
      return {
        name,
        country: country.code,
        epa_baseline_factor: Number(baseline.toFixed(4)),
        transport_modes: modes,
        embedding: `[${syntheticEmbedding(name).join(',')}]`,
        metadata: sql.json({
          gridIntensity: country.gridIntensity,
          tier: rng() > 0.7 ? 'tier1' : 'tier2',
        }),
        active: true,
      };
    });

    const suppliers = (await sql`
      INSERT INTO suppliers ${sql(suppliersToInsert)}
      RETURNING id, country, transport_modes
    `) as unknown as Array<{
      id: string;
      country: string;
      transport_modes: string[];
    }>;

    console.log('[seed] inserting routes');
    const ROUTE_COUNT = 50;
    const routesToInsert = range(ROUTE_COUNT).map(() => {
      const supplier = pick(suppliers);
      const supplierMode = pick(supplier.transport_modes as TransportMode[]) as TransportMode;
      // Origin near supplier country if possible, else random hub.
      const originCandidates = hubsByCountry.get(supplier.country) ?? hubRows;
      const origin = pick(originCandidates);
      let destination = pick(hubRows);
      // Avoid origin == destination.
      let guard = 0;
      while (destination.id === origin.id && guard++ < 5) destination = pick(hubRows);
      const distance = haversineKm(
        { lat: origin.lat, lng: origin.lng },
        { lat: destination.lat, lng: destination.lng },
      );
      return {
        supplier_id: supplier.id,
        origin_hub_id: origin.id,
        destination_hub_id: destination.id,
        distance_km: Number(distance.toFixed(2)),
        transport_mode: supplierMode,
        active: true,
      };
    });

    const routes = (await sql`
      INSERT INTO routes ${sql(routesToInsert)}
      RETURNING id, supplier_id, distance_km, transport_mode
    `) as unknown as Array<{
      id: string;
      supplier_id: string;
      distance_km: number;
      transport_mode: TransportMode;
    }>;

    console.log('[seed] generating 6 months of telemetry');
    // 6 months, 1 sample per hour per route. ~50 routes * 24 * 180 = 216k rows.
    // Insert in batches to keep memory bounded.
    const NOW = new Date();
    NOW.setMinutes(0, 0, 0);
    const HORIZON_DAYS = 180;
    const HOURS = HORIZON_DAYS * 24;

    let inserted = 0;
    const BATCH = 5000;
    let buffer: Array<Record<string, unknown>> = [];
    let scoreBuffer: Array<Record<string, unknown>> = [];

    for (const route of routes) {
      const factor = TRANSPORT_MODE_FACTORS[route.transport_mode as TransportMode];
      // Each route has its own slow-varying emission baseline + diurnal + noise.
      const baseload = 0.8 + rng() * 0.6;
      const phase = rng() * Math.PI * 2;
      for (let h = 0; h < HOURS; h++) {
        const t = new Date(NOW.getTime() - (HOURS - h) * 3600 * 1000);
        const diurnal = 0.15 * Math.sin((h / 24) * 2 * Math.PI + phase);
        const seasonal = 0.1 * Math.sin((h / (24 * 30)) * 2 * Math.PI);
        const noise = (rng() - 0.5) * 0.2;
        const intensity = baseload * (1 + diurnal + seasonal + noise);
        const co2 = factor * (route.distance_km as number) * intensity;
        const fuel = co2 / 2.68; // ~kg diesel CO2 per liter; rough but consistent.
        buffer.push({
          time: t,
          route_id: route.id,
          supplier_id: route.supplier_id,
          co2_kg: Number(co2.toFixed(3)),
          fuel_l: Number(fuel.toFixed(3)),
          distance_km: route.distance_km,
          transport_mode: route.transport_mode,
        });

        // One score per 6h to keep the carbon_scores table compact.
        if (h % 6 === 0) {
          // Score is normalized: lower is better. Rough 0-100 scale.
          const score = Math.max(0, Math.min(100, 100 - intensity * 40 - factor * 50));
          scoreBuffer.push({
            time: t,
            route_id: route.id,
            score: Number(score.toFixed(2)),
            score_components: sql.json({
              factor,
              intensity: Number(intensity.toFixed(3)),
              distance_km: route.distance_km,
            }),
            model_version: 'seed-v1',
            confidence_lower: Number((score - 5).toFixed(2)),
            confidence_upper: Number((score + 5).toFixed(2)),
          });
        }

        if (buffer.length >= BATCH) {
          await sql`INSERT INTO emissions_telemetry ${sql(buffer)}`;
          inserted += buffer.length;
          buffer = [];
        }
        if (scoreBuffer.length >= BATCH) {
          await sql`INSERT INTO carbon_scores ${sql(scoreBuffer)}`;
          scoreBuffer = [];
        }
      }
    }
    if (buffer.length) {
      await sql`INSERT INTO emissions_telemetry ${sql(buffer)}`;
      inserted += buffer.length;
    }
    if (scoreBuffer.length) {
      await sql`INSERT INTO carbon_scores ${sql(scoreBuffer)}`;
    }

    console.log(`[seed] done: ${suppliers.length} suppliers, ${routes.length} routes, ${inserted} telemetry rows`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
