import { useState } from "react";
import type { Account } from "../lib/accounts";

export function AccountAvatar({ account }: { account: Account | null }) {
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatar = account?.avatar;
  if (avatar && avatar !== failedAvatar)
    return (
      <img
        src={avatar}
        alt=""
        width={32}
        height={32}
        referrerPolicy="no-referrer"
        className="size-8 shrink-0 rounded-full object-cover"
        onError={() => setFailedAvatar(avatar)}
      />
    );
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm"
    >
      {(account?.nickname || "盒友").slice(0, 1)}
    </span>
  );
}
