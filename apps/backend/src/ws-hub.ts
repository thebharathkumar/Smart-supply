/**
 * In-process WebSocket hub backed by Redis pub/sub for multi-instance fanout.
 *
 * Clients subscribe to specific routeIds (or '*' for everything). When a
 * score_update arrives via Redis, the hub fans it out only to interested
 * sockets, keeping per-socket bandwidth proportional to interest.
 */
import type { WebSocket } from '@fastify/websocket';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  WsClientMessage,
  type WsServerMessage,
  type ShipmentScoreUpdatedEvent,
} from '@smart-supply/shared-types';
import type { Logger } from './logger.js';

const SCORE_CHANNEL = 'ws:score_update';

interface Subscriber {
  id: string;
  socket: WebSocket;
  routeIds: Set<string> | 'all';
}

export class WsHub {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly subClient: Redis;
  private readonly pubClient: Redis;

  constructor(
    redisUrl: string,
    private readonly log: Logger,
  ) {
    this.subClient = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    this.pubClient = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

    this.subClient.subscribe(SCORE_CHANNEL).catch((err) => {
      this.log.error({ err }, 'failed to subscribe to redis channel');
    });

    this.subClient.on('message', (channel, raw) => {
      if (channel !== SCORE_CHANNEL) return;
      try {
        const event = JSON.parse(raw) as ShipmentScoreUpdatedEvent;
        this.fanout(event);
      } catch (err) {
        this.log.warn({ err, raw }, 'failed to parse pubsub message');
      }
    });
  }

  attach(socket: WebSocket): string {
    const id = randomUUID();
    const sub: Subscriber = { id, socket, routeIds: 'all' };
    this.subscribers.set(id, sub);

    this.send(socket, {
      type: 'hello',
      serverTime: new Date().toISOString(),
      sessionId: id,
    });

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.send(socket, { type: 'error', message: 'invalid JSON' });
        return;
      }
      const msg = WsClientMessage.safeParse(parsed);
      if (!msg.success) {
        this.send(socket, { type: 'error', message: 'invalid message shape' });
        return;
      }
      switch (msg.data.type) {
        case 'subscribe':
          if (!msg.data.routeIds || msg.data.routeIds.length === 0) {
            sub.routeIds = 'all';
          } else {
            const set = sub.routeIds === 'all' ? new Set<string>() : sub.routeIds;
            for (const r of msg.data.routeIds) set.add(r);
            sub.routeIds = set;
          }
          break;
        case 'unsubscribe':
          if (sub.routeIds !== 'all' && msg.data.routeIds) {
            for (const r of msg.data.routeIds) sub.routeIds.delete(r);
          }
          break;
        case 'ping':
          this.send(socket, { type: 'pong', ts: new Date().toISOString() });
          break;
      }
    });

    socket.on('close', () => this.subscribers.delete(id));
    socket.on('error', (err) => {
      this.log.warn({ err, sessionId: id }, 'ws error');
      this.subscribers.delete(id);
    });
    return id;
  }

  /**
   * Publish a score update to all backend instances; each fans out locally.
   */
  async publishScoreUpdate(event: ShipmentScoreUpdatedEvent): Promise<void> {
    await this.pubClient.publish(SCORE_CHANNEL, JSON.stringify(event));
  }

  private fanout(event: ShipmentScoreUpdatedEvent): void {
    const message: WsServerMessage = { type: 'score_update', data: event };
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const sub of this.subscribers.values()) {
      if (sub.routeIds !== 'all' && !sub.routeIds.has(event.routeId)) continue;
      try {
        sub.socket.send(payload);
        delivered++;
      } catch (err) {
        this.log.warn({ err, sessionId: sub.id }, 'ws send failed');
      }
    }
    if (delivered > 0) {
      this.log.debug({ delivered, routeId: event.routeId }, 'fanout');
    }
  }

  private send(socket: WebSocket, msg: WsServerMessage): void {
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn({ err }, 'ws send failed');
    }
  }

  async close(): Promise<void> {
    for (const sub of this.subscribers.values()) {
      try {
        sub.socket.close();
      } catch {
        // best effort
      }
    }
    this.subscribers.clear();
    await Promise.all([this.subClient.quit(), this.pubClient.quit()]);
  }
}
