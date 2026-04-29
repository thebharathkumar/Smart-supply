/**
 * OpenTelemetry bootstrap for the Node backend.
 *
 * Loaded at the very top of server.ts before any other import that should be
 * instrumented (HTTP, postgres, redis, kafkajs all auto-instrument when the
 * SDK starts before they're imported).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;

export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'smart-supply-backend';

  if (process.env.OTEL_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    // OTel ships two copies of MetricReader through the auto-instrumentation
    // dep tree; tsc sees them as separate types. Cast through unknown to
    // sidestep the false-positive nominal mismatch.
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }) as unknown as ConstructorParameters<typeof NodeSDK>[0]['metricReader'],
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs noise drowns out app spans; turn it off.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-redis-4': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-kafkajs': { enabled: true },
      }),
    ],
  });
  sdk.start();

  process.on('SIGTERM', () => {
    sdk
      ?.shutdown()
      .catch((err) => console.error('OTel shutdown error', err))
      .finally(() => process.exit(0));
  });
}

export const tracer = trace.getTracer('smart-supply-backend');

/**
 * Wrap an async block in a span. Errors mark the span and rethrow.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    return await fn(span);
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}
