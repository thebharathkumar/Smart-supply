/**
 * SSE proxy for the ml-agent service.
 *
 * The browser hits `/api/agent/run` on the backend (same-origin / proper CORS),
 * we open an upstream connection to ml-agent and pipe each event through.
 * No buffering, no JSON re-parsing - we forward raw SSE frames.
 */
import type { FastifyPluginAsync } from 'fastify';
import { request } from 'undici';
import { z } from 'zod';

const RunBody = z.object({
  goal: z.string().min(10).max(2000),
  constraints: z.record(z.unknown()).optional(),
  maxSteps: z.number().int().min(1).max(30).optional(),
});

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/agent/tools', async (_req, reply) => {
    try {
      const r = await request(`${app.config.ML_AGENT_URL}/tools`);
      reply.code(r.statusCode);
      return await r.body.json();
    } catch (err) {
      app.log.error({ err }, 'agent tools fetch failed');
      return reply.code(503).send({ error: 'agent_unavailable' });
    }
  });

  app.post('/api/agent/dry-run', async (req, reply) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const r = await request(`${app.config.ML_AGENT_URL}/agent/dry-run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: body.data.goal,
          constraints: body.data.constraints,
          max_steps: body.data.maxSteps ?? 12,
        }),
      });
      reply.code(r.statusCode);
      return await r.body.json();
    } catch (err) {
      app.log.error({ err }, 'agent dry-run proxy failed');
      return reply.code(503).send({ error: 'agent_unavailable' });
    }
  });

  app.post('/api/agent/run', async (req, reply) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    let upstream: Awaited<ReturnType<typeof request>>;
    try {
      upstream = await request(`${app.config.ML_AGENT_URL}/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: body.data.goal,
          constraints: body.data.constraints,
          max_steps: body.data.maxSteps ?? 12,
        }),
      });
    } catch (err) {
      app.log.error({ err }, 'agent run upstream connection failed');
      return reply.code(503).send({ error: 'agent_unavailable' });
    }

    if (upstream.statusCode >= 400) {
      const errBody = await upstream.body.text();
      return reply.code(upstream.statusCode).send({ error: errBody });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Pipe upstream SSE bytes straight through.
    upstream.body.on('data', (chunk: Buffer) => {
      reply.raw.write(chunk);
    });
    upstream.body.on('end', () => reply.raw.end());
    upstream.body.on('error', (err) => {
      app.log.warn({ err }, 'agent stream upstream error');
      reply.raw.end();
    });

    req.raw.on('close', () => {
      // Client disconnected; cancel upstream.
      upstream.body.destroy();
    });
  });
};
