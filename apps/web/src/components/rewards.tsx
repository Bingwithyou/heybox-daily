import type { Outcome } from "@heybox/contracts";
import { rewardDelta } from "../lib/utils";

const rewards = [
  { field: "expDelta", name: "EXP", icon: "/rewards/exp.svg" },
  { field: "coinDelta", name: "H 币", icon: "/rewards/coin.svg" },
  { field: "batteryDelta", name: "盒电", icon: "/rewards/battery.svg" },
] as const;

export function Rewards({
  result,
}: {
  result?: Pick<Outcome, "expDelta" | "coinDelta" | "batteryDelta"> | null;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-5 gap-y-2 text-sm tabular-nums">
      {rewards.map(({ field, name, icon }) => (
        <span
          key={field}
          title={name}
          className="relative inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <img
            src={icon}
            alt=""
            aria-hidden="true"
            width={16}
            height={16}
            className="size-4 object-contain"
          />
          <span className="sr-only">{name} </span>
          {result?.[field] === undefined ? "—" : rewardDelta(result[field])}
        </span>
      ))}
    </span>
  );
}
