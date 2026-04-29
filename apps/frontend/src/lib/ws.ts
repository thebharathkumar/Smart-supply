/**
 * WebSocket client with reconnect, message queue, and typed routing.
 *
 * Messages are pushed into a Zustand store; components subscribe to slices
 * (most recent score per route, etc.) so re-renders stay scoped.
 */
import { create } from 'zustand';
import { env } from './env';

interface ScoreSnapshot {
  routeId: string;
  score: number;
  ts: string;
}

interface WsState {
  status: 'connecting' | 'open' | 'closed' | 'error';
  scores: Record<string, ScoreSnapshot>;
  setStatus: (s: WsState['status']) => void;
  applyScore: (s: ScoreSnapshot) => void;
}

export const useWsStore = create<WsState>((set) => ({
  status: 'connecting',
  scores: {},
  setStatus: (status) => set({ status }),
  applyScore: (s) =>
    set((state) => ({
      scores: { ...state.scores, [s.routeId]: s },
    })),
}));

export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private queue: string[] = [];
  private closed = false;

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
  }

  send(payload: object): void {
    const text = JSON.stringify(payload);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    } else {
      this.queue.push(text);
    }
  }

  private connect(): void {
    if (this.closed) return;
    useWsStore.getState().setStatus('connecting');
    this.socket = new WebSocket(env.wsUrl);
    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      useWsStore.getState().setStatus('open');
      // Drain queue
      while (this.queue.length && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(this.queue.shift()!);
      }
      // Heartbeat
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data?: unknown };
        if (msg.type === 'score_update' && msg.data) {
          const d = msg.data as { routeId: string; score: number; ts: string };
          useWsStore.getState().applyScore({ routeId: d.routeId, score: d.score, ts: d.ts });
        }
      } catch {
        // ignore malformed
      }
    };
    this.socket.onerror = () => useWsStore.getState().setStatus('error');
    this.socket.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      useWsStore.getState().setStatus('closed');
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt++);
      setTimeout(() => this.connect(), delay);
    };
  }
}

export const ws = new WsClient();
