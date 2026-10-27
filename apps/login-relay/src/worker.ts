interface Env { LOGIN_RELAY_TOKEN: string }
const endpoints = new Map([
  ['https://api.xiaoheihe.cn/account/get_login_code/', 'POST'],
  ['https://api.xiaoheihe.cn/account/login_code/', 'POST'],
  ['https://api.xiaoheihe.cn/task/list_v2/', 'GET'],
  ['https://api.xiaoheihe.cn/task/sign_v4/get_sign_state', 'GET'],
  ['https://api.xiaoheihe.cn/task/sign_v3/sign', 'GET'],
  ['https://api.xiaoheihe.cn/bbs/app/feeds', 'GET'],
  ['https://api.xiaoheihe.cn/game/all_recommend/v2', 'GET'],
  ['https://api.xiaoheihe.cn/bbs/app/link/game/comments', 'GET'],
  ['https://api.xiaoheihe.cn/game/comment/share_data/', 'GET'],
  ['https://data.xiaoheihe.cn/account/data_report/', 'POST'],
  ['https://api.xiaoheihe.cn/store/roll_room_v2/room_list', 'GET'],
  ['https://api.xiaoheihe.cn/store/roll_room_v2/get_home_info', 'GET'],
  ['https://api.xiaoheihe.cn/bbs/app/profile/user/profile', 'GET'],
  ['https://api.xiaoheihe.cn/store/roll_room_v2/data_report', 'POST'],
  ['https://api.xiaoheihe.cn/bbs/app/profile/follow/user', 'POST'],
  ['https://api.xiaoheihe.cn/store/roll_room_v2/join', 'POST'],
]);
const headerNames = ['accept', 'content-type', 'cookie', 'user-agent', 'origin', 'referer', 'x-requested-with'];
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });

async function authorized(request: Request, token: string) {
  const encoder = new TextEncoder();
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  const [actual, expected] = await Promise.all([digest(request.headers.get('authorization') || ''), digest(`Bearer ${token}`)]);
  let different = 0;
  for (let i = 0; i < actual.length; i++) different |= actual[i] ^ expected[i];
  return different === 0;
}
async function boundedBody(request: Request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 32_768) { await reader.cancel(); throw new RangeError('body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function handle(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (typeof env.LOGIN_RELAY_TOKEN !== 'string' || env.LOGIN_RELAY_TOKEN.length < 32) return json('unconfigured', 503);
  if (!(await authorized(request, env.LOGIN_RELAY_TOKEN))) return json('unauthorized', 401);
  if (new URL(request.url).pathname !== '/relay') return json('not_found', 404);
  if (request.method !== 'POST') return json('method_not_allowed', 405);
  let url: URL; let method: string; let body: string | undefined;
  const headers = new Headers();
  try {
    const input = JSON.parse(await boundedBody(request));
    if (!input || typeof input.url !== 'string') return json('invalid_request', 400);
    url = new URL(input.url); method = input.method;
    if (url.username || url.password || url.hash
      || !endpoints.has(url.origin + url.pathname) || endpoints.get(url.origin + url.pathname) !== method
      || !input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers)
      || (method === 'POST' && typeof input.body !== 'string')
      || (method === 'GET' && input.body != null)) return json('invalid_request', 400);
    const supplied = new Headers(input.headers);
    for (const key of headerNames) if (supplied.has(key)) headers.set(key, supplied.get(key)!);
    body = method === 'POST' ? input.body : undefined;
  } catch (error) { return json(error instanceof RangeError ? 'body_too_large' : 'invalid_request', error instanceof RangeError ? 413 : 400); }
  try {
    const response = await fetchImpl(url.href, { method, headers, body, redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); return json('upstream_redirect_refused', 502);
    }
    return new Response(response.body, { status: response.status, headers: {
      'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store',
    } });
  } catch { return json('upstream_unavailable', 502); }
}

export default { fetch(request: Request, env: Env) { return handle(request, env); } };
