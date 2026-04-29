from __future__ import annotations

from typing import Any

import asyncpg


class Db:
    """Thin asyncpg wrapper. Pool is initialized at app startup."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=8)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("DB pool not connected")
        return self._pool

    async def supplier_history(self, supplier_id: str, days: int = 90) -> list[dict[str, Any]]:
        """Hourly avg score for a supplier over the last N days."""
        rows = await self.pool.fetch(
            """
            SELECT time_bucket(INTERVAL '1 hour', cs.time) AS bucket,
                   AVG(cs.score) AS score
            FROM carbon_scores cs
            JOIN routes r ON r.id = cs.route_id
            WHERE r.supplier_id = $1::uuid
              AND cs.time >= NOW() - $2::interval
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            supplier_id,
            f"{days} days",
        )
        return [dict(r) for r in rows]

    async def write_forecast(
        self,
        run_id: str,
        supplier_id: str,
        model: str,
        points: list[dict[str, Any]],
    ) -> None:
        if not points:
            return
        await self.pool.executemany(
            """
            INSERT INTO forecasts (forecast_run_id, supplier_id, horizon_date, predicted_score,
                                   ci_lower, ci_upper, model)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
            """,
            [
                (run_id, supplier_id, p["date"], p["predicted"], p["ciLower"], p["ciUpper"], model)
                for p in points
            ],
        )
