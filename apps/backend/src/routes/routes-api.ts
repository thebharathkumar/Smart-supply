import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  active: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const routeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/routes', async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const rows = await app.pg`
      SELECT
        r.id, r.supplier_id, r.origin_hub_id, r.destination_hub_id,
        r.distance_km, r.transport_mode, r.active,
        s.name AS supplier_name,
        oh.name AS origin_name, oh.lat AS origin_lat, oh.lng AS origin_lng,
        dh.name AS destination_name, dh.lat AS destination_lat, dh.lng AS destination_lng
      FROM routes r
      JOIN suppliers s ON s.id = r.supplier_id
      JOIN hubs oh ON oh.id = r.origin_hub_id
      JOIN hubs dh ON dh.id = r.destination_hub_id
      WHERE TRUE ${q.data.active !== undefined ? app.pg`AND r.active = ${q.data.active}` : app.pg``}
      ORDER BY r.created_at DESC
      LIMIT ${q.data.limit}
    `;
    return rows;
  });

  app.get('/api/routes/:id/scores', async (req, reply) => {
    const { id } = req.params as { id: string };
    const Query = z.object({
      hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
    });
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const since = new Date(Date.now() - q.data.hours * 3600 * 1000);
    const rows = await app.pg`
      SELECT time, score, score_components, model_version, confidence_lower, confidence_upper
      FROM carbon_scores
      WHERE route_id = ${id}::uuid AND time >= ${since}
      ORDER BY time ASC
    `;
    return rows;
  });

  app.get('/api/routes/:id/telemetry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const Query = z.object({
      hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
    });
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const since = new Date(Date.now() - q.data.hours * 3600 * 1000);
    const rows = await app.pg`
      SELECT time, co2_kg, fuel_l, distance_km, transport_mode
      FROM emissions_telemetry
      WHERE route_id = ${id}::uuid AND time >= ${since}
      ORDER BY time ASC
    `;
    return rows;
  });
};
