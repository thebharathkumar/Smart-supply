import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  app.get('/ready', async (_req, reply) => {
    try {
      const sql = app.pg;
      await sql`SELECT 1`;
      return { status: 'ready' };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
};
