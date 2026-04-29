# ADR 0008: Schema Registry for Kafka events (Redpanda built-in)

**Status:** Accepted
**Date:** 2026-04-29

## Context

Producer and consumer both speak JSON over Kafka, with Zod schemas in `packages/shared-types`. The Zod schemas are the single source of truth for shape, but nothing currently *enforces* that across the wire boundary - a producer pushing a renamed field would happily emit messages that the consumer silently drops at parse time.

## Decision

Register every event schema with **Redpanda's built-in Schema Registry** (Confluent-compatible REST API on port 8081) at producer startup. Each Kafka message carries the registry's returned schema id in a `smartsupply.schema_id` header. Consumers:

1. Reject messages with no schema-id header.
2. Validate payload shape against the same Zod schema locally (cheap, in-process).

We chose the header-based approach over Confluent's binary envelope (magic byte + 4-byte schema id prefix) because plain-JSON payloads stay readable in `rpk topic consume` and `kcat`, which is operationally important during incident response.

## Consequences

**Pros:**
- Contract drift between producer and consumer fails at the broker boundary, not silently in business logic.
- One source of truth: Zod → JSON Schema → registry. Pairs with ADR-0009 (Pydantic codegen) so Python services share the same source.
- Header-based wire format keeps debugging tooling simple.
- Idempotent registration - rerunning the producer reuses the existing schema id.

**Cons:**
- One more service in the dependency graph (Redpanda's registry on 8081). Mitigated by the fact that it's bundled - no separate deployment.
- We don't currently validate the schema id matches the registry's recorded version; we just check the header exists. A malicious producer could attach a bogus id and pass our header check. Acceptable for now since auth is enforced at network boundary; Phase 3+ will fetch + cache registry schemas on the consumer for true validation.

## Alternatives considered

- **Confluent Schema Registry** as a separate service - works but adds operational footprint that Redpanda's built-in eliminates.
- **Avro instead of JSON** - smaller wire format and stronger schema-evolution rules, but the codegen + tooling cost across TS + Python is not worth it at our message volumes.
- **Protobuf** - same trade-off; JSON wins on debuggability, Protobuf wins on size.
