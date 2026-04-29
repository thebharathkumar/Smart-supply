/**
 * Schema Registry client (Confluent-compatible API).
 *
 * Redpanda exposes the same REST endpoints as Confluent Schema Registry
 * on port 8081. We register a JSON schema per topic on producer startup
 * and embed the returned schema id as a Kafka message header so consumers
 * can fetch the matching schema and validate.
 *
 * Confluent's wire format reserves the first 5 bytes of the value
 * (magic + 4-byte schema id). We instead use a header named
 * `smartsupply.schema_id` which keeps message bodies as plain JSON -
 * easier to debug with kcat / rpk than the binary envelope.
 */
import { z } from 'zod';
import { TOPICS, TOPIC_VALIDATORS } from './index.js';

export interface SchemaRegistryConfig {
  url: string;
  fetchImpl?: typeof fetch;
}

export interface RegisteredSchema {
  topic: string;
  subject: string;
  schemaId: number;
}

export const SCHEMA_ID_HEADER = 'smartsupply.schema_id';

/**
 * Strip Zod 'default' wrappers and other complexity that confuses
 * registries. We keep just the validator's high-level structure.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Lazy import so consumers without zod-to-json-schema can still build.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { zodToJsonSchema: convert } = require('zod-to-json-schema') as {
    zodToJsonSchema: (s: unknown, name?: string) => Record<string, unknown>;
  };
  return convert(schema);
}

async function postSchema(
  cfg: SchemaRegistryConfig,
  subject: string,
  jsonSchema: Record<string, unknown>,
): Promise<number> {
  const fetchFn = cfg.fetchImpl ?? fetch;
  const url = `${cfg.url.replace(/\/$/, '')}/subjects/${encodeURIComponent(subject)}/versions`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
    body: JSON.stringify({
      schema: JSON.stringify(jsonSchema),
      schemaType: 'JSON',
    }),
  });
  if (!res.ok) {
    throw new Error(`schema-registry POST failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function getLatestSchemaId(
  cfg: SchemaRegistryConfig,
  subject: string,
): Promise<number | null> {
  const fetchFn = cfg.fetchImpl ?? fetch;
  const url = `${cfg.url.replace(/\/$/, '')}/subjects/${encodeURIComponent(subject)}/versions/latest`;
  const res = await fetchFn(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`schema-registry GET failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: number };
  return body.id;
}

/**
 * Register every topic-value schema defined in TOPIC_VALIDATORS.
 * Idempotent: returns existing schema id when subject already exists.
 *
 * Subject naming: `<topic>-value` per Confluent convention.
 */
export async function registerAllSchemas(
  cfg: SchemaRegistryConfig,
): Promise<RegisteredSchema[]> {
  const out: RegisteredSchema[] = [];
  for (const [topic, validator] of Object.entries(TOPIC_VALIDATORS)) {
    const subject = `${topic}-value`;
    const jsonSchema = zodToJsonSchema(validator);
    const existing = await getLatestSchemaId(cfg, subject);
    const id = existing ?? (await postSchema(cfg, subject, jsonSchema));
    out.push({ topic, subject, schemaId: id });
  }
  return out;
}

/**
 * Cache built up at startup: topic -> schemaId.
 */
export type SchemaIdMap = Map<string, number>;

export function indexById(registered: RegisteredSchema[]): SchemaIdMap {
  return new Map(registered.map((r) => [r.topic, r.schemaId]));
}

/**
 * Validate a parsed payload against the registered Zod schema for a topic.
 * Returns null on success, error string on failure.
 */
export function validateForTopic(topic: string, payload: unknown): string | null {
  const validator = (TOPIC_VALIDATORS as Record<string, z.ZodTypeAny>)[topic];
  if (!validator) return `unknown topic: ${topic}`;
  const r = validator.safeParse(payload);
  if (r.success) return null;
  return r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

// Surface topic config for callers that want partition counts, etc.
export { TOPICS };
