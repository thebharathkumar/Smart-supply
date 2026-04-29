# ADR 0004: Kafka (Redpanda) for ingest, Redis pub/sub for fanout

**Status:** Accepted
**Date:** 2026-04-29

## Context

Two distinct messaging needs:

1. **Ingest pipeline** (simulator → backend stream consumer → ML feedback): high-volume telemetry, needs durability, replayability, and consumer-group semantics so multiple consumers can scale horizontally.
2. **WebSocket fanout** (stream consumer → all backend instances → connected clients): low-volume derived events that just need to reach every backend pod live.

These have different SLAs. One bus serving both means picking a tool that's adequate at neither.

## Decision

- **Kafka (Redpanda in dev)** for ingest. Topics partitioned by route ID for ordering guarantees per shipment.
- **Redis pub/sub** for inter-process WS fanout. Backend publishes derived score events; every backend instance subscribes and fans out only to interested sockets.
- Stream consumer bridges the two: persists to TimescaleDB, emits to Redis pub/sub, and re-emits to a `shipment.score_updated` Kafka topic that downstream ML services consume for the feedback loop.

## Consequences

**Pros:**
- Each channel optimized for its load profile.
- Redis pub/sub is fire-and-forget and ~ms latency — perfect for live UI updates.
- Kafka's partitioning + retention give us replay for ML model retraining without operational complexity in the WS path.

**Cons:**
- Two messaging systems instead of one. Worth it given how different the patterns are.
- The stream consumer is a single point of bridging — covered by replication + Kafka durability so a consumer restart re-reads from the last committed offset.

## Alternatives considered

- **Kafka only** — viable but heavier than needed for short-lived UI fanout. Would also push WS lag onto broker latency.
- **Redis Streams only** — works for ingest at small scale but lacks Kafka's mature consumer-group semantics and partition guarantees.
- **NATS JetStream** — modern, lighter than Kafka, would consolidate to one tool. Reasonable alternative; we picked Kafka for portability and ecosystem (Redpanda speaks the protocol so dev stays light).
