/**
 * Proxy to the ml-optimize service. Same caching strategy as forecast:
 * short Redis TTL keyed by request body hash so repeated identical
 * optimizations don't re-run the NSGA-II loop.
 */
import type { FastifyPluginAsync } from 'fastify';
import { request } from 'undici';
import { createHash } from 'node:crypto';
import { OptimizeRouteRequest, OptimizeRouteResponse } from '@smart-supply/shared-types';

const CACHE_TTL_SEC = 60;

export const optimizeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/optimize/route', async (req, reply) => {
    const parsed = OptimizeRouteRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const cacheKey = `optimize:${createHash('sha1').update(JSON.stringify(parsed.data)).digest('hex')}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return JSON.parse(cached);
    }

    try {
      const r = await request(`${app.config.ML_OPTIMIZE_URL}/optimize/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      if (r.statusCode !== 200) {
        const body = await r.body.text();
        return reply.code(r.statusCode).send({ error: body });
      }
      const json = (await r.body.json()) as unknown;
      const validated = OptimizeRouteResponse.safeParse(json);
      if (!validated.success) {
        return reply.code(502).send({ error: 'optimize_invalid_response' });
      }
      await app.redis.set(cacheKey, JSON.stringify(validated.data), 'EX', CACHE_TTL_SEC);
      reply.header('X-Cache', 'MISS');
      return validated.data;
    } catch (err) {
      app.log.error({ err }, 'optimize proxy failed');
      return reply.code(503).send({ error: 'optimize_unavailable' });
    }
  });
};
