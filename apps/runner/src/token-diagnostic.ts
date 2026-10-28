import { z } from 'zod';
import { errorDiagnostic } from 'heybox-daily/diagnostics';

// Drop free text and unknown fields at both sides of the child-process boundary.
const schema = z.object({
  stage: z.enum(['download_sdk', 'sdk_integrity', 'initialize', 'execute_sdk', 'wait_token', 'request_token',
    'sdk_error', 'process', 'deadline']),
  networkCode: z.enum(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
    'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError']).optional(),
  networkPhase: z.enum(['dns', 'tcp', 'tls', 'response']).optional(),
  sdkCode: z.number().int().min(-4).max(-1).optional(),
  httpStatus: z.number().int().min(0).max(599).optional(),
  upstreamCode: z.number().int().min(0).max(999_999).optional(),
  requestDurationMs: z.number().int().min(0).max(120_000).optional(),
});
export type TokenDiagnostic = z.infer<typeof schema>;
export function parseTokenDiagnostic(value: unknown): TokenDiagnostic {
  return schema.safeParse(value).data ?? { stage: 'process' };
}
export function tokenDiagnostic(error: unknown): TokenDiagnostic {
  const value = errorDiagnostic(error);
  return parseTokenDiagnostic({ ...value, stage: value.stage ?? 'initialize',
    networkCode: value.networkCode ?? value.cause?.cause?.code ?? value.cause?.code
      ?? (value.cause?.name === 'TimeoutError' ? 'TimeoutError' : undefined) });
}
export class TokenGenerationError extends Error {
  readonly diagnostic: TokenDiagnostic;
  constructor(diagnostic: TokenDiagnostic) { super('设备令牌生成失败'); this.diagnostic = diagnostic; }
}
export function canRetryToken(diagnostic: TokenDiagnostic) {
  if (diagnostic.stage === 'wait_token') return diagnostic.networkCode === 'ETIMEDOUT';
  if (diagnostic.stage === 'download_sdk') return Boolean(diagnostic.networkCode) || (diagnostic.httpStatus ?? 0) >= 500;
  return diagnostic.stage === 'request_token' && (diagnostic.sdkCode === -1
    || (diagnostic.sdkCode === -2 && (diagnostic.httpStatus ?? 0) >= 500));
}
export interface TokenAttempt { attempt: number; diagnostic: TokenDiagnostic; retry: boolean }
