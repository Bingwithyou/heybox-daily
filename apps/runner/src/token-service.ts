import { createServer, type IncomingMessage } from 'node:http';
import { authorized } from './server.ts';
import { LoginTiming, loginTimingHeader } from '@heybox/contracts';

type Waiting = { signal: AbortSignal; resolve(value: string): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>;
  cancel(): void; queuedAt: number; timing?: LoginTiming };
export class TokenQueue {
  private readonly execute: (signal: AbortSignal) => Promise<string>;
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly waitMs: number;
  private readonly waiting: Waiting[] = [];
  private running = 0;
  private stopping = false;
  get active() { return this.running; }
  get pending() { return this.waiting.length; }
  constructor(execute: (signal: AbortSignal) => Promise<string>, options: { concurrency?: number; maxPending?: number; waitMs?: number } = {}) {
    this.execute = execute; this.concurrency = options.concurrency ?? 4;
    this.maxPending = options.maxPending ?? 16; this.waitMs = options.waitMs ?? 15_000;
  }
  run(signal = new AbortController().signal, timing?: LoginTiming): Promise<string> {
    if (this.stopping || this.waiting.length >= this.maxPending) return Promise.reject(new Error('设备令牌服务繁忙'));
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const remove = (error: unknown) => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) this.waiting.splice(index, 1);
        timing?.add('token_queue', performance.now() - item.queuedAt);
        clearTimeout(item.timer); signal.removeEventListener('abort', item.cancel); reject(error);
      };
      const item: Waiting = { signal, resolve, reject, timing, queuedAt: performance.now(), cancel: () => remove(signal.reason),
        timer: setTimeout(() => remove(new Error('设备令牌等待超时')), this.waitMs) };
      signal.addEventListener('abort', item.cancel, { once: true });
      this.waiting.push(item); this.pump();
    });
  }
  private pump() {
    while (!this.stopping && this.running < this.concurrency && this.waiting.length) {
      const item = this.waiting.shift()!;
      clearTimeout(item.timer); item.signal.removeEventListener('abort', item.cancel);
      if (item.signal.aborted) { item.reject(item.signal.reason); continue; }
      this.running++;
      item.timing?.add('token_queue', performance.now() - item.queuedAt);
      const operation = item.timing ? item.timing.measure('token_generate', () => this.execute(item.signal)) : this.execute(item.signal);
      operation.then(item.resolve, item.reject).finally(() => { this.running--; this.pump(); });
    }
  }
  stop() {
    this.stopping = true;
    for (const item of this.waiting.splice(0)) {
      clearTimeout(item.timer); item.signal.removeEventListener('abort', item.cancel);
      item.timing?.add('token_queue', performance.now() - item.queuedAt);
      item.reject(new Error('设备令牌服务正在停止'));
    }
  }
}
async function emptyBody(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 64) throw new Error('Invalid body'); }
  const value: unknown = JSON.parse(text || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) throw new Error('Invalid body');
}
export function createTokenServer(queue: TokenQueue, token: string, poolState?: () => object) {
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
    if (!authorized(request.headers.authorization, token)) { response.writeHead(401).end('{}'); return; }
    if (request.method !== 'POST') { response.writeHead(405).end('{}'); return; }
    if (request.url === '/health') { response.end(JSON.stringify({ service: 'device-token', active: queue.active, pending: queue.pending,
      ...(poolState ? { pool: poolState() } : {}) })); return; }
    if (request.url !== '/token') { response.writeHead(404).end('{}'); return; }
    try { await emptyBody(request); } catch { response.writeHead(400).end('{}'); return; }
    const controller = new AbortController();
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    const started = performance.now();
    const id = request.headers[loginTimingHeader];
    const timing = new LoginTiming(typeof id === 'string' ? id : undefined);
    const finishTiming = () => {
      timing.add('token_service', performance.now() - started);
      if (!response.destroyed) {
        response.setHeader(loginTimingHeader, timing.id);
        response.setHeader('server-timing', timing.header());
      }
      return { requestId: timing.id, durationMs: Math.round(performance.now() - started), stages: timing.values };
    };
    try {
      const value = await queue.run(controller.signal, timing);
      const metrics = finishTiming();
      response.end(JSON.stringify({ token: value }));
      console.log(JSON.stringify({ event: 'device_token_finished', ...metrics }));
    } catch {
      const metrics = finishTiming();
      if (!response.destroyed) response.writeHead(503).end('{"error":"设备令牌服务暂时繁忙，请稍后再试"}');
      console.warn(JSON.stringify({ event: 'device_token_failed', ...metrics }));
    }
  });
  server.requestTimeout = 50_000; server.headersTimeout = 10_000;
  return server;
}
