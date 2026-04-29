"""
ml-forecast: time-series forecasting service.

Endpoints:
  GET  /health          - liveness
  POST /forecast/supplier/{id}?horizon_days=30 - returns forecast + backtest metric
  GET  /metrics         - prometheus
"""
from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

import structlog
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import PlainTextResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .config import load_settings
from .db import Db
from .forecaster import fit_prophet


structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger("ml-forecast")

REQ_COUNTER = Counter(
    "forecast_requests_total", "Forecast requests", ["status"]
)
REQ_LATENCY = Histogram(
    "forecast_request_seconds", "Forecast request latency", buckets=[0.1, 0.5, 1, 2, 5, 10, 30]
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = load_settings()
    db = Db(settings.database_url)
    await db.connect()
    app.state.db = db
    app.state.settings = settings
    log.info("ml-forecast started", port=settings.port)
    try:
        yield
    finally:
        await db.close()


app = FastAPI(title="ml-forecast", version="0.1.0", lifespan=lifespan)


class ForecastPointDTO(BaseModel):
    date: str
    predicted: float
    ciLower: float
    ciUpper: float


class ForecastMetrics(BaseModel):
    mape: float | None
    samples: int


class ForecastResponse(BaseModel):
    supplierId: str
    model: str
    generatedAt: str
    horizonDays: int = Field(..., ge=1, le=365)
    points: list[ForecastPointDTO]
    metrics: ForecastMetrics


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ml-forecast"}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/forecast/supplier/{supplier_id}", response_model=ForecastResponse)
async def forecast_supplier(
    supplier_id: str,
    horizon_days: int = Query(30, ge=1, le=365),
) -> ForecastResponse:
    start = time.perf_counter()
    try:
        # Validate UUID early.
        try:
            uuid.UUID(supplier_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail="invalid supplier_id") from e

        settings = app.state.settings
        db: Db = app.state.db

        history = await db.supplier_history(supplier_id, days=90)
        if not history:
            REQ_COUNTER.labels("not_found").inc()
            raise HTTPException(status_code=404, detail="no history for supplier")

        # Run CPU-heavy fit off the event loop.
        result = await asyncio.to_thread(
            fit_prophet,
            history,
            horizon_days,
            changepoint_prior_scale=settings.prophet_changepoint_prior_scale,
            seasonality_prior_scale=settings.prophet_seasonality_prior_scale,
        )

        run_id = str(uuid.uuid4())
        await db.write_forecast(
            run_id=run_id,
            supplier_id=supplier_id,
            model=result.model,
            points=[
                {
                    "date": datetime.fromisoformat(p.date).replace(tzinfo=timezone.utc),
                    "predicted": p.predicted,
                    "ciLower": p.ci_lower,
                    "ciUpper": p.ci_upper,
                }
                for p in result.points
            ],
        )

        REQ_COUNTER.labels("ok").inc()
        return ForecastResponse(
            supplierId=supplier_id,
            model=result.model,
            generatedAt=datetime.now(timezone.utc).isoformat(),
            horizonDays=horizon_days,
            points=[
                ForecastPointDTO(
                    date=p.date,
                    predicted=round(p.predicted, 3),
                    ciLower=round(p.ci_lower, 3),
                    ciUpper=round(p.ci_upper, 3),
                )
                for p in result.points
            ],
            metrics=ForecastMetrics(mape=result.mape, samples=result.samples),
        )
    finally:
        REQ_LATENCY.observe(time.perf_counter() - start)
