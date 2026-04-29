"""
OpenTelemetry bootstrap for Python ML services.

Imported at the top of `main.py`. Auto-instruments FastAPI, asyncpg, httpx,
and exports OTLP HTTP traces to the configured collector (Jaeger).

Disabled when OTEL_DISABLED=true is set (e.g. in unit tests).
"""
from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


_initialized = False


def init_telemetry(service_name: str, version: str = "0.1.0") -> None:
    """Idempotent. Safe to call from multiple lifespan handlers."""
    global _initialized
    if _initialized or os.environ.get("OTEL_DISABLED") == "true":
        return
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4318")
    resource = Resource.create({SERVICE_NAME: service_name, SERVICE_VERSION: version})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(provider)
    AsyncPGInstrumentor().instrument()
    HTTPXClientInstrumentor().instrument()
    _initialized = True


def instrument_app(app) -> None:  # type: ignore[no-untyped-def]
    """FastAPI instrumentor must be called after app is created."""
    if os.environ.get("OTEL_DISABLED") == "true":
        return
    FastAPIInstrumentor.instrument_app(app)
