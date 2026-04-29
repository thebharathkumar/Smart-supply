/**
 * Schema validation tests - pure logic, no infra needed.
 */
import { describe, it, expect } from 'vitest';
import {
  WsClientMessage,
  WsServerMessage,
  OptimizeRouteRequest,
  ForecastRequest,
} from '@smart-supply/shared-types';

describe('WsClientMessage', () => {
  it('accepts subscribe with no routeIds (subscribe all)', () => {
    expect(WsClientMessage.safeParse({ type: 'subscribe' }).success).toBe(true);
  });

  it('accepts subscribe with routeIds', () => {
    const r = WsClientMessage.safeParse({
      type: 'subscribe',
      routeIds: ['00000000-0000-0000-0000-000000000001'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown message type', () => {
    expect(WsClientMessage.safeParse({ type: 'foo' }).success).toBe(false);
  });

  it('rejects non-uuid routeIds', () => {
    const r = WsClientMessage.safeParse({ type: 'subscribe', routeIds: ['not-a-uuid'] });
    expect(r.success).toBe(false);
  });
});

describe('WsServerMessage', () => {
  it('round-trips a score_update', () => {
    const msg = {
      type: 'score_update' as const,
      data: {
        type: 'shipment.score_updated' as const,
        routeId: '00000000-0000-0000-0000-000000000001',
        ts: new Date().toISOString(),
        score: 55,
        windowSec: 5,
      },
    };
    const r = WsServerMessage.safeParse(msg);
    expect(r.success).toBe(true);
  });
});

describe('OptimizeRouteRequest', () => {
  it('clamps weights to [0,1]', () => {
    const bad = OptimizeRouteRequest.safeParse({
      originHubId: '00000000-0000-0000-0000-000000000001',
      destinationHubId: '00000000-0000-0000-0000-000000000002',
      weightCo2: 2,
      weightCost: 0.3,
      weightTime: 0.2,
    });
    expect(bad.success).toBe(false);
  });

  it('uses defaults when optional fields missing', () => {
    const r = OptimizeRouteRequest.safeParse({
      originHubId: '00000000-0000-0000-0000-000000000001',
      destinationHubId: '00000000-0000-0000-0000-000000000002',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.weightCo2).toBe(0.5);
      expect(r.data.topK).toBe(3);
    }
  });
});

describe('ForecastRequest', () => {
  it('rejects horizon out of range', () => {
    const r = ForecastRequest.safeParse({
      supplierId: '00000000-0000-0000-0000-000000000001',
      horizonDays: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects horizon too large', () => {
    const r = ForecastRequest.safeParse({
      supplierId: '00000000-0000-0000-0000-000000000001',
      horizonDays: 1000,
    });
    expect(r.success).toBe(false);
  });
});
