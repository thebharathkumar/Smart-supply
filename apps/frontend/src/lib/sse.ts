/**
 * Minimal SSE consumer using fetch + ReadableStream.
 *
 * Browser EventSource doesn't support POST or custom headers; for our agent
 * stream (which is POST with a JSON body) we read the response stream and
 * parse SSE frames manually. Yields an async iterator of typed events.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export async function* sseStream(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): AsyncIterableIterator<SseEvent> {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    throw new Error(`SSE upstream ${res.status}: ${await res.text()}`);
  }
  if (!res.body) throw new Error('SSE response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        yield parseFrame(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseEvent {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return { event, data: dataLines.join('\n') };
}
