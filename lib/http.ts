import { NextResponse, type NextRequest } from 'next/server';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });

// The page's API calls carry `x-holo: 1`, which a cross-site form or image cannot send, and a same-origin Origin header.
export function checkSameOrigin(req: NextRequest) {
  if (req.headers.get('x-holo') !== '1') throw new HttpError(403, 'Missing request header', 'forbidden');
  const origin = req.headers.get('origin');
  if (origin && origin !== req.nextUrl.origin) throw new HttpError(403, 'Cross-site request refused', 'forbidden');
}

export async function readJson(req: NextRequest, maxBytes = 2.5 * 1024 * 1024): Promise<any> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'Request is too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request is too large');
  try { return text ? JSON.parse(text) : null; } catch { throw new HttpError(400, 'Body is not valid JSON'); }
}

export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try { return await fn(...args); }
    catch (e: any) {
      const status = typeof e?.status === 'number' ? e.status : 500;
      if (status >= 500) console.error('[api]', e);
      const message = status >= 500 && !e?.expose ? (e?.code === 'unavailable' ? 'The database is not reachable right now.' : 'Something went wrong on the server.') : String(e?.message || e);
      return json({ error: message, code: e?.code }, status);
    }
  };
}
