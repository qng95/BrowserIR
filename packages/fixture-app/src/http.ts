import type { IncomingMessage, ServerResponse } from 'node:http';

/** Small HTTP helpers. Kept dependency-free so the fixture is trivial to run. */

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * Post/Redirect/Get. Real apps redirect after a successful mutation, which
 * means the agent must follow a 303 and re-read a *different* URL to confirm
 * the outcome — a step that simply does not exist on a static page.
 */
export function redirect(res: ServerResponse, location: string, status = 303): void {
  res.writeHead(status, { location, 'cache-control': 'no-store' });
  res.end();
}

export function setCookie(res: ServerResponse, name: string, value: string, maxAgeSec = 3600): void {
  const prior = res.getHeader('set-cookie');
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  const all = Array.isArray(prior) ? [...prior, cookie] : prior ? [String(prior), cookie] : [cookie];
  res.setHeader('set-cookie', all);
}

export function clearCookie(res: ServerResponse, name: string): void {
  res.setHeader('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Artificial server latency.
 *
 * The default is deliberately non-zero: an app that answers instantly lets a
 * reader that never waits score identically to one that waits correctly, and
 * the whole question of "when is the page ready" disappears.
 */
export function latencyFor(url: URL, fallback: number): number {
  const raw = url.searchParams.get('latency');
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(20_000, n)) : fallback;
}
