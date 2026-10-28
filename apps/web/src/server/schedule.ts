import type { Env } from "./env.ts";
import { notifyRunner } from "./notify.ts";
import { Store } from "@heybox/hosting/store";

export async function runScheduled(env: Env, scheduledTime: number) {
  const store = new Store(env.DB);
  const created = await store.schedule();
  if (created > 0) await notifyRunner(env);
  // The hourly trigger includes 16:30 UTC, which is 00:30 in Beijing.
  const date = new Date(scheduledTime);
  if (date.getUTCHours() === 16 && date.getUTCMinutes() === 30) await store.cleanup();
}
