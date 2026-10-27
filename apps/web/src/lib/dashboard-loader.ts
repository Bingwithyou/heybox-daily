import { beijingDate } from "@heybox/contracts";
import type { client } from "./client.ts";

export type DashboardData = Awaited<ReturnType<typeof client.dashboard>>;
const active = (data: DashboardData) => ["queued", "running"].includes(data.today?.status || "");

export function createDashboardLoader(
  read: (includeHistory: boolean) => Promise<DashboardData>,
  day = () => beijingDate(),
) {
  let current: DashboardData | undefined;
  let loadedDay: string | undefined;
  let pending: Promise<DashboardData> | undefined;
  async function refresh(full: boolean) {
    const date = day();
    const previous = current;
    full ||= !previous || loadedDay !== date;
    let value = await read(full);
    if (
      !full &&
      previous &&
      (value.account !== previous.account ||
        value.today?.date !== previous.today?.date ||
        (active(previous) && !active(value)))
    ) {
      value = await read(true);
      full = true;
    }
    current = full
      ? value
      : {
          ...value,
          history: previous!.history.map((row) =>
            value.today && row.id === value.today.id ? value.today : row,
          ),
        };
    loadedDay = date;
    return current;
  }
  function load(full = false): Promise<DashboardData> {
    if (pending && !full) return pending;
    // Queue mutation refreshes after older reads; later polls join the newest read.
    const work = pending ? pending.catch(() => {}).then(() => refresh(true)) : refresh(full);
    const tracked = work.finally(() => {
      if (pending === tracked) pending = undefined;
    });
    pending = tracked;
    return tracked;
  }
  return { load };
}
