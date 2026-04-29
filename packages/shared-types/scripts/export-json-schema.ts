/**
 * Export every Zod schema in this package to a JSON Schema file under
 *   packages/shared-types/schemas/<name>.json
 *
 * Run via:  pnpm --filter @smart-supply/shared-types export-schema
 *
 * Python services pick up the same definitions via datamodel-codegen
 * (see services/<svc>/scripts/generate_types.py).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as schemas from '../src/index.js';

const OUT_DIR = path.resolve(__dirname, '..', 'schemas');
mkdirSync(OUT_DIR, { recursive: true });

const exports: [string, unknown][] = [
  ['Hub', schemas.Hub],
  ['Supplier', schemas.Supplier],
  ['Route', schemas.Route],
  ['CarbonScore', schemas.CarbonScore],
  ['ShipmentPositionEvent', schemas.ShipmentPositionEvent],
  ['ShipmentFuelEvent', schemas.ShipmentFuelEvent],
  ['PortCongestionEvent', schemas.PortCongestionEvent],
  ['WeatherUpdateEvent', schemas.WeatherUpdateEvent],
  ['ShipmentScoreUpdatedEvent', schemas.ShipmentScoreUpdatedEvent],
  ['ForecastRequest', schemas.ForecastRequest],
  ['ForecastResponse', schemas.ForecastResponse],
  ['OptimizeRouteRequest', schemas.OptimizeRouteRequest],
  ['OptimizeRouteResponse', schemas.OptimizeRouteResponse],
];

let count = 0;
for (const [name, schema] of exports) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = zodToJsonSchema(schema as any, {
    name,
    $refStrategy: 'none',
  });
  const file = path.join(OUT_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  count++;
  console.log(`wrote ${file}`);
}
console.log(`\nexported ${count} schemas to ${OUT_DIR}`);
