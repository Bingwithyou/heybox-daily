import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { router } from "../server/rpc.ts";

export const client: RouterClient<typeof router> = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}/rpc`,
  }),
);
export async function authRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "请求未完成，请稍后重试");
  return data;
}
