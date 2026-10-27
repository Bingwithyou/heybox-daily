import { LoginTiming, loginTimingHeader } from '@heybox/contracts';
import { requestDeviceToken } from './operations.ts';
import type { Env } from './env.ts';

type Begin = { challenge: string; phone: string; binding: string };
export async function beginPreparedLogin(stub: Pick<DurableObjectStub, 'fetch'>, data: Begin,
  env: Pick<Env, 'TOKEN_SERVICE_URL' | 'TOKEN_SERVICE_TOKEN'>, timing: LoginTiming,
  signal?: AbortSignal, fetchImpl: typeof fetch = fetch, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('execution_timeout')), timeoutMs);
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener('abort', abort, { once: true });
  });
  const call = (action: string, body: object) => stub.fetch(`https://challenge/${action}`, {
    method: 'POST', body: JSON.stringify(body), signal: combined,
    headers: { 'content-type': 'application/json', [loginTimingHeader]: timing.id },
  });
  try {
    combined.throwIfAborted();
    const prepare = timing.measure('challenge_prepare', async () => {
      const response = await call('prepare', { challenge: data.challenge });
      if (!response.ok) throw new Error('登录挑战初始化失败');
      timing.merge(response.headers.get('server-timing'));
      await response.body?.cancel();
    });
    const tokenRequest: typeof fetch = (input, init) => fetchImpl(input, { ...init, signal: combined });
    const [, token] = await Promise.race([cancelled,
      timing.measure('login_prepare', () => Promise.all([prepare, requestDeviceToken(env, timing, tokenRequest)])),
    ]);
    combined.throwIfAborted();
    const response = await Promise.race([cancelled,
      timing.measure('challenge_begin', () => call('begin', { ...data, token })),
    ]);
    timing.merge(response.headers.get('server-timing'));
    // Fully consume the small DO response before aborting remaining preparation I/O.
    const body = await Promise.race([cancelled, response.arrayBuffer()]);
    const result = new Response(body, response);
    result.headers.set('server-timing', timing.header());
    result.headers.set(loginTimingHeader, timing.id);
    console.log(JSON.stringify({ event: 'executor_login_preparation', requestId: timing.id,
      status: result.status, stages: timing.values }));
    return result;
  } finally {
    combined.removeEventListener('abort', abort);
    clearTimeout(timer);
    controller.abort();
  }
}
