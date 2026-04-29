/**
 * Side-effect-only entrypoint that starts OTel before anything else loads.
 * Imported as the very first line of server.ts.
 */
import { startTelemetry } from './telemetry.js';

if (process.env.OTEL_DISABLED !== 'true') {
  startTelemetry();
}
