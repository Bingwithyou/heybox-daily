import { ORPCError } from "@orpc/server";
import {
  ActivityFailure,
  activityResultSchema,
  type ActivityRequest,
  type ActivityResult,
} from "@heybox/contracts";
import type { Env } from "./env.ts";
import type { Store } from "./store.ts";
import { runnerRequest } from "./security.ts";

type Input = { expectedAccount: string } & (
  | { mode: "list" }
  | { mode: "participate"; activityId: string; approvedFollowIds: string[] }
);
export async function activityRequest(
  env: Env,
  store: Pick<Store, "activityCredential">,
  userId: string,
  input: Input,
  signal?: AbortSignal,
): Promise<ActivityResult> {
  if (userId !== `heybox:${input.expectedAccount}`)
    throw new ORPCError("CONFLICT", { message: "当前账号已变化，请刷新页面后重试" });
  const credential = await store.activityCredential(userId);
  if (!credential || credential.account !== input.expectedAccount)
    throw new ORPCError("BAD_REQUEST", { message: "请重新登录小黑盒后查看活动" });
  const request: ActivityRequest =
    input.mode === "list"
      ? { mode: "list", credential }
      : {
          mode: "participate",
          credential,
          activityId: input.activityId,
          approvedFollowIds: input.approvedFollowIds,
        };
  try {
    const result = activityResultSchema.parse(
      await runnerRequest(env, "/activities", request, undefined, undefined, signal),
    );
    if (
      result.mode !== input.mode ||
      (result.mode === "participate" &&
        input.mode === "participate" &&
        result.activity.id !== input.activityId)
    )
      throw new Error("Activity response mismatch");
    return result;
  } catch (error) {
    if (error instanceof ActivityFailure)
      throw new ORPCError(error.code === "activity_busy" ? "CONFLICT" : "BAD_REQUEST", {
        message: error.message,
      });
    throw new ORPCError("BAD_GATEWAY", { message: "活动服务暂时不可用，请稍后刷新状态" });
  }
}
