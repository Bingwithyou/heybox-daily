import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizePhone } from 'heybox-daily/login';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function deviceId(value: unknown) { return record(record(record(value)?.config)?.session)?.device_id; }

// A separate domain for each reference prevents matching a phone against a device.
// No unkeyed fallback: a plain phone hash can be enumerated from the number space.
export function createLoginLog(input: unknown, env: NodeJS.ProcessEnv = process.env) {
  const data = record(input);
  if (!data || !['begin', 'send', 'verify'].includes(String(data.action))) return undefined;
  const key = env.RUNNER_SERVICE_TOKEN;
  const reference = (kind: 'phone' | 'device', value: unknown) => {
    if (!key || key.length < 32 || typeof value !== 'string' || !value || value.length > 256) return undefined;
    const digest = createHmac('sha256', key).update(`heybox-login-log:v1:${kind}:`).update(value).digest('hex').slice(0, 24);
    return `${kind === 'phone' ? 'p1' : 'd1'}_${digest}`;
  };
  let phone: string | undefined;
  try { if (typeof data.phone === 'string') phone = normalizePhone(data.phone); } catch { /* invalid input has no identity */ }
  const configuredIp = env.RUNNER_EGRESS_IP?.trim() || '';
  const relayed = !!env.LOGIN_RELAY_URL;
  const family = configuredIp.includes('%') ? 0 : isIP(configuredIp);
  const egressIp = relayed ? undefined : family === 6 ? new URL(`http://[${configuredIp}]`).hostname.slice(1, -1) : family === 4 ? configuredIp : undefined;
  const started = performance.now();
  const base = { operationId: randomUUID(), startedAt: new Date().toISOString(), phoneRef: reference('phone', phone),
    transport: relayed ? 'cloudflare_worker' : 'direct',
    egressIp, egressSource: relayed ? 'cloudflare_worker' : egressIp ? 'configured' : 'unknown', hasCaptchaProof: !!record(data.proof) };
  return (result?: unknown) => {
    const status = record(result)?.status;
    return { ...base, durationMs: Math.max(0, Math.round(performance.now() - started)),
      deviceRef: reference('device', deviceId(result) ?? deviceId(input)),
      outcome: typeof status === 'string' && ['sent', 'captcha', 'authenticated'].includes(status) ? status : undefined };
  };
}
