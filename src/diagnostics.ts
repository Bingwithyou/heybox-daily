import { HeyboxApiError } from './client.js';
import { DeviceTokenError } from './device-token.js';

export interface ErrorDiagnostic {
  name: string;
  message: string;
  code?: string;
  stage?: string;
  endpoint?: string;
  status?: string;
  upstreamMessage?: string;
  cause?: ErrorDiagnostic;
}

function safeText(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secrets.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[redacted]');
    // Login query values can also appear percent-encoded in network exceptions.
    try { text = text.replaceAll(encodeURIComponent(secret), '[redacted]'); } catch { /* invalid Unicode has no URI encoding */ }
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[url]'; }
    })
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[credentials redacted]')
    .replace(/\b(?:phone(?:_num)?|pkey|x_pkey|x_xhh_tokenid|token|device_id|imei|code|ticket|randstr|password|secret)["']?\s*[:=]\s*["']?[^\s"',;}]+/gi, '[redacted]')
    .replace(/验证码\s*[:：=]?\s*\d{4,8}/g, '验证码 [redacted]')
    .replace(/(?<!\d)\+?\d{8,15}(?!\d)/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 512);
}

// Only this bounded, redacted projection may cross the worker boundary into logs.
// Never serialize the error object, request, response body, config, or stack.
export function errorDiagnostic(error: unknown, secrets: string[] = [], depth = 0): ErrorDiagnostic {
  if (!(error instanceof Error)) return { name: 'Error', message: 'Unknown failure' };
  const diagnostic: ErrorDiagnostic = {
    name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error',
    message: safeText(error.message, secrets),
  };
  if ('code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) diagnostic.code = error.code;
  if (error instanceof DeviceTokenError) diagnostic.stage = error.stage;
  if (error instanceof HeyboxApiError) {
    diagnostic.endpoint = safeText(error.endpoint.split('?')[0], secrets);
    diagnostic.status = error.status;
    diagnostic.upstreamMessage = safeText(error.upstreamMessage, secrets);
  }
  if (error.cause !== undefined && depth < 3) diagnostic.cause = errorDiagnostic(error.cause, secrets, depth + 1);
  return diagnostic;
}
