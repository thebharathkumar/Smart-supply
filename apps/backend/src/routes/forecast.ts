/**
 * Thin proxy to the ml-forecast service. Backend owns auth + caching;
 * the Python service owns model logic. Cached in Redis for short TTL.
 */
import type { FastifyPluginAsync } from 'fastify';
import { ForecastRequest, ForecastResponse } from '@smart-supply/shared-types';
import { request } from 'undici';

const CACHE_TTL_SEC = 60;

export const forecastRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/forecast', async (req, reply) => {
    const parsed = ForecastRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { supplierId, horizonDays } = parsed.data;

    const cacheKey = `forecast:${supplierId}:${horizonDays}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return JSON.parse(cached);
    }

    try {
      const url = `${app.config.ML_FORECAST_URL}/forecast/supplier/${supplierId}?horizon_days=${horizonDays}`;
      const res = await request(url, { method: 'POST' });
      if (res.statusCode !== 200) {
        const body = await res.body.text();
        return reply.code(502).send({ error: 'forecast_service_error', detail: body });
      }
      const json = (await res.body.json()) as unknown;
      const validated = ForecastResponse.safeParse(json);
      if (!validated.success) {
        return reply.code(502).send({ error: 'forecast_invalid_response' });
      }
      await app.redis.set(cacheKey, JSON.stringify(validated.data), 'EX', CACHE_TTL_SEC);
      reply.header('X-Cache', 'MISS');
      return validated.data;
    } catch (err) {
      app.log.error({ err }, 'forecast proxy failed');
      return reply.code(503).send({ error: 'forecast_unavailable' });
    }
  });
};
