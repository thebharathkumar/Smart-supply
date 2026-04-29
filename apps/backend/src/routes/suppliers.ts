import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  country: z.string().length(2).optional(),
  active: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const supplierRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/suppliers', async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const { country, active, limit, offset } = q.data;

    const rows = await app.pg`
      SELECT id, name, country, epa_baseline_factor, transport_modes, active, metadata, created_at
      FROM suppliers
      WHERE TRUE
        ${country ? app.pg`AND country = ${country}` : app.pg``}
        ${active !== undefined ? app.pg`AND active = ${active}` : app.pg``}
      ORDER BY name
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  });

  app.get('/api/suppliers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await app.pg`
      SELECT id, name, country, epa_baseline_factor, transport_modes, active, metadata, created_at
      FROM suppliers WHERE id = ${id}::uuid
    `;
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    return rows[0];
  });

  // Semantic similarity via pgvector. Body: { embedding: number[384], topK: int }
  const SimilarBody = z.object({
    embedding: z.array(z.number()).length(384),
    topK: z.number().int().min(1).max(50).default(10),
  });
  app.post('/api/suppliers/similar', async (req, reply) => {
    const body = SimilarBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const vec = `[${body.data.embedding.join(',')}]`;
    const rows = await app.pg`
      SELECT id, name, country, epa_baseline_factor, transport_modes,
             1 - (embedding <=> ${vec}::vector) AS similarity
      FROM suppliers
      WHERE active = TRUE AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${body.data.topK}
    `;
    return rows;
  });
};
