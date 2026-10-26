import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { beginSchema, verifySchema, completeCaptchaSchema, LoginFailure } from '@heybox/contracts';
import { ChallengeStore } from './challenges.ts';
import { encryptCredential } from './crypto.ts';

export function authorized(header: string | undefined, token: string) {
  const actual = Buffer.from(header || ''); const expected = Buffer.from(`Bearer ${token}`);
  return token.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(request: IncomingMessage) {
  let input = '';
  for await (const chunk of request) { input += chunk; if (Buffer.byteLength(input) > 4096) throw new Error('请求过大'); }
  return JSON.parse(input) as unknown;
}
export function createRunnerServer(store: ChallengeStore, token: string, key: string) {
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
    if (!authorized(request.headers.authorization, token)) { response.writeHead(401).end('{"error":"服务认证失败"}'); return; }
    if (request.method !== 'POST') { response.writeHead(405).end('{}'); return; }
    try {
      if (request.url === '/login/begin') {
        const input = beginSchema.parse(await body(request));
        response.end(JSON.stringify(await store.begin(input.phone, input.binding)));
      } else if (request.url === '/login/verify') {
        const input = verifySchema.parse(await body(request));
        const result = await store.verify(input.challenge, input.code, input.binding);
        response.end(JSON.stringify(result.status === 'authenticated'
          ? { status: 'authenticated', credential: encryptCredential(result.config, key) } : result));
      } else if (request.url === '/login/captcha') {
        const input = completeCaptchaSchema.parse(await body(request));
        const result = await store.completeCaptcha(input.challenge, input, input.binding);
        response.end(JSON.stringify(result.status === 'authenticated'
          ? { status: 'authenticated', credential: encryptCredential(result.config, key) } : result));
      } else response.writeHead(404).end('{}');
    } catch (error) {
      if (error instanceof LoginFailure) {
        response.writeHead(400).end(JSON.stringify({ code: error.code, error: error.message }));
        return;
      }
      const message = error instanceof Error ? error.message : '';
      const safe = /挑战|处理中|繁忙|人机验证/.test(message) ? message : '验证码错误、已过期或小黑盒暂时不可用，请稍后重试';
      response.writeHead(400).end(JSON.stringify({ error: safe }));
    }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 10_000;
  return server;
}
