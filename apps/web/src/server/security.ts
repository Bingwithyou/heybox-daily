import type { Env } from "./env.ts";
import { LoginFailure, loginFailureSchema } from "@heybox/contracts";

export function sameOrigin(request: Request, siteURL: string) {
  return request.headers.get("origin") === new URL(siteURL).origin;
}
export async function boundedBody(request: Request, maxBytes = 4096) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("请求过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function serviceAuthorized(request: Request, token: string) {
  if (token.length < 32) return false;
  const encoder = new TextEncoder();
  const a = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(request.headers.get("authorization") || ""),
    ),
  );
  const b = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  );
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}
export async function privateKey(value: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function runnerRequest(env: Env, path: string, input: unknown) {
  const url = new URL(env.RUNNER_URL);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("执行端必须使用 HTTPS");
  const response = await fetch(new URL(path, url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
    redirect: "manual",
  });
  if (!response.ok) {
    if (response.status === 400) {
      const failure = loginFailureSchema.safeParse(await response.json().catch(() => null));
      if (failure.success) throw new LoginFailure(failure.data.code);
    }
    throw new Error(`执行端响应 HTTP ${response.status}`);
  }
  return response.json();
}
