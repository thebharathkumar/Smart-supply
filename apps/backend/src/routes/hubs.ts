import type { FastifyPluginAsync } from 'fastify';

export const hubRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/hubs', async () => {
    return await app.pg`
      SELECT id, name, country, type, lat, lng FROM hubs ORDER BY country, name
    `;
  });
};
