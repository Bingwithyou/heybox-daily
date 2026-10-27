export function loginRelayConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = env.LOGIN_RELAY_URL || ''; const token = env.LOGIN_RELAY_TOKEN || '';
  if (!value && !token) return undefined;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('请完整配置 LOGIN_RELAY_URL 和 LOGIN_RELAY_TOKEN'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || token.length < 32 || /[^\x21-\x7e]/.test(token))
    throw new Error('LOGIN_RELAY_URL 必须为 HTTPS origin，LOGIN_RELAY_TOKEN 至少 32 位');
  return { url: url.origin, token };
}

export function createLoginFetch(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): typeof fetch {
  const relay = loginRelayConfig(env);
  if (!relay) return fetchImpl;
  return async (input, options) => {
    try {
      return await fetchImpl(`${relay.url}/relay`, {
        method: 'POST', headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: String(input), method: options?.method || 'GET',
          headers: Object.fromEntries(new Headers(options?.headers)), body: options?.body == null ? null : String(options.body) }),
        redirect: 'error', signal: options?.signal || AbortSignal.timeout(20_000),
      });
    } catch {
      // Never retry a possibly accepted SMS request or expose transport credentials in diagnostics.
      throw new Error('登录转发请求失败或超时');
    }
  };
}

export function dailyTransport(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.DAILY_TRANSPORT || 'direct';
  if (mode !== 'direct' && mode !== 'worker') throw new Error('DAILY_TRANSPORT 必须为 direct 或 worker');
  if (mode === 'worker' && !loginRelayConfig(env))
    throw new Error('DAILY_TRANSPORT=worker 需要配置 LOGIN_RELAY_URL 和 LOGIN_RELAY_TOKEN');
  return mode;
}

export function createDailyFetch(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): typeof fetch {
  return dailyTransport(env) === 'worker' ? createLoginFetch(env, fetchImpl) : fetchImpl;
}

export function activityTransport(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.ACTIVITY_TRANSPORT || 'direct';
  if (mode !== 'direct' && mode !== 'worker') throw new Error('ACTIVITY_TRANSPORT 必须为 direct 或 worker');
  if (mode === 'worker' && !loginRelayConfig(env))
    throw new Error('ACTIVITY_TRANSPORT=worker 需要配置 LOGIN_RELAY_URL 和 LOGIN_RELAY_TOKEN');
  return mode;
}

export function createActivityFetch(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): typeof fetch {
  return activityTransport(env) === 'worker' ? createLoginFetch(env, fetchImpl) : fetchImpl;
}
