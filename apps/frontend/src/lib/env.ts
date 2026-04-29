interface Env {
  apiUrl: string;
  wsUrl: string;
  mapboxToken: string;
}

export const env: Env = {
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  wsUrl: import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/ws',
  mapboxToken: (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? '',
};
