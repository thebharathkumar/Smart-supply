import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_PORT: z.coerce.number().default(4000),
  BACKEND_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  KAFKA_BROKERS: z.string().default('localhost:19092'),
  KAFKA_CLIENT_ID: z.string().default('smart-supply-backend'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ML_FORECAST_URL: z.string().url().default('http://localhost:8001'),
  ML_OPTIMIZE_URL: z.string().url().default('http://localhost:8002'),
  ML_AGENT_URL: z.string().url().default('http://localhost:8003'),
  // Set false to skip Kafka consumer (useful for tests / local without Redpanda).
  ENABLE_STREAM_CONSUMER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
