import './instrument.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import websocket from '@fastify/websocket';
import postgres from 'postgres';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { WsHub } from './ws-hub.js';
import { StreamConsumer } from './stream-consumer.js';
import { healthRoutes } from './routes/health.js';
import { supplierRoutes } from './routes/suppliers.js';
import { routeRoutes } from './routes/routes-api.js';
import { hubRoutes } from './routes/hubs.js';
import { forecastRoutes } from './routes/forecast.js';
import { agentRoutes } from './routes/agent.js';
import { optimizeRoutes } from './routes/optimize.js';

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyInstance {
    pg: ReturnType<typeof postgres>;
    redis: Redis;
    config: AppConfig;
    wsHub: WsHub;
  }
}

async function buildApp(cfg: AppConfig, log: Logger) {
  const app = Fastify({ loggerInstance: log, disableRequestLogging: false });
  await app.register(cors, { origin: cfg.CORS_ORIGIN.split(',').map((s) => s.trim()) });
  await app.register(sensible);
  await app.register(websocket, { options: { maxPayload: 1024 * 64 } });

  const sql = postgres(cfg.DATABASE_URL, { max: 10, idle_timeout: 30, prepare: false });
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const wsHub = new WsHub(cfg.REDIS_URL, log);

  app.decorate('pg', sql);
  app.decorate('redis', redis);
  app.decorate('config', cfg);
  app.decorate('wsHub', wsHub);

  app.register(healthRoutes);
  app.register(supplierRoutes);
  app.register(routeRoutes);
  app.register(hubRoutes);
  app.register(forecastRoutes);
  app.register(agentRoutes);
  app.register(optimizeRoutes);

  // WebSocket endpoint
  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (connection) => {
      wsHub.attach(connection);
    });
  });

  app.addHook('onClose', async () => {
    await Promise.allSettled([sql.end({ timeout: 5 }), redis.quit(), wsHub.close()]);
  });

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);

  const app = await buildApp(cfg, log);

  let consumer: StreamConsumer | null = null;
  if (cfg.ENABLE_STREAM_CONSUMER) {
    const kafka = new Kafka({
      clientId: cfg.KAFKA_CLIENT_ID,
      brokers: cfg.KAFKA_BROKERS.split(',').map((s) => s.trim()),
      retry: { retries: 5, initialRetryTime: 300 },
    });
    consumer = new StreamConsumer(kafka, app.pg, app.wsHub, log, cfg.SCHEMA_REGISTRY_URL);
    consumer.start().catch((err) => log.error({ err }, 'stream consumer crashed'));
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await consumer?.stop();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.BACKEND_HOST, port: cfg.BACKEND_PORT });
  log.info({ port: cfg.BACKEND_PORT }, 'backend listening');
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
