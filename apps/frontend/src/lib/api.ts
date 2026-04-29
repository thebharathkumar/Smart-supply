import { env } from './env';

export interface Hub {
  id: string;
  name: string;
  country: string;
  type: 'port' | 'airport' | 'rail' | 'warehouse';
  lat: number;
  lng: number;
}

export interface Supplier {
  id: string;
  name: string;
  country: string;
  epa_baseline_factor: number;
  transport_modes: string[];
  active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RouteRow {
  id: string;
  supplier_id: string;
  origin_hub_id: string;
  destination_hub_id: string;
  distance_km: number;
  transport_mode: string;
  active: boolean;
  supplier_name: string;
  origin_name: string;
  origin_lat: number;
  origin_lng: number;
  destination_name: string;
  destination_lat: number;
  destination_lng: number;
}

export interface ScorePoint {
  time: string;
  score: number;
  score_components: Record<string, number>;
  model_version: string;
  confidence_lower: number | null;
  confidence_upper: number | null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${env.apiUrl}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${env.apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export const api = {
  hubs: () => get<Hub[]>('/api/hubs'),
  suppliers: (params: { country?: string; active?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.country) q.set('country', params.country);
    if (params.active !== undefined) q.set('active', String(params.active));
    return get<Supplier[]>(`/api/suppliers?${q.toString()}`);
  },
  supplier: (id: string) => get<Supplier>(`/api/suppliers/${id}`),
  routes: () => get<RouteRow[]>('/api/routes?active=true'),
  routeScores: (id: string, hours = 24) =>
    get<ScorePoint[]>(`/api/routes/${id}/scores?hours=${hours}`),
  forecast: (supplierId: string, horizonDays = 30) =>
    post('/api/forecast', { supplierId, horizonDays }),
};
