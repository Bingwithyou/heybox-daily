import { useNavigate } from "@tanstack/react-router";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { AccountAvatar } from "./account-avatar";
import type { Account } from "../lib/accounts";

export default function AccountMenu({
  account,
  accounts,
  busy,
  onSwitch,
  onAction,
}: {
  account: Account | null;
  accounts: Account[];
  busy: boolean;
  onSwitch: (account: Account) => void;
  onAction: (action: "logout" | "delete") => void;
}) {
  const navigate = useNavigate();
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="账号菜单"
        render={
          <Button variant="ghost" className="h-11 min-w-0 max-w-44 shrink gap-2.5 px-2 text-base" />
        }
      >
        <AccountAvatar key={account?.account} account={account} />
        <span className="min-w-0 truncate">
          {account?.nickname || (account ? `盒友 ${account.account}` : "选择账号")}
        </span>
        <ChevronDown className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={8} className="z-40">
          <Menu.Popup className="w-64 max-w-[calc(100vw-2rem)] rounded-lg border bg-white p-1 shadow-lg outline-none">
            <Menu.Item
              className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted sm:hidden"
              onClick={() => navigate({ to: "/tasks" })}
            >
              我的任务
            </Menu.Item>
            <Menu.Item
              className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted sm:hidden"
              onClick={() => navigate({ to: "/history" })}
            >
              历史记录
            </Menu.Item>
            {accounts.map((item) => (
              <Menu.Item
                key={item.account}
                disabled={busy}
                className="flex items-center gap-3 rounded px-3 py-3 outline-none data-highlighted:bg-muted"
                onClick={() => {
                  if (item.account !== account?.account) void onSwitch(item);
                }}
              >
                <AccountAvatar account={item} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.nickname || "盒友"}</span>
                  <span className="block text-sm text-muted-foreground">盒友 {item.account}</span>
                </span>
                {item.account === account?.account && (
                  <Check aria-label="当前账号" className="size-4" />
                )}
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Item
              disabled={busy || accounts.length >= 5}
              className="flex items-center gap-2 rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted data-disabled:text-muted-foreground"
              onClick={() => navigate({ to: "/login", search: {} })}
            >
              <Plus className="size-4" />
              添加账号
            </Menu.Item>
            {accounts.length >= 5 && (
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                已登录 5 个账号，请先退出一个账号
              </p>
            )}
            {account && (
              <>
                <Menu.Item
                  className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted"
                  onClick={() => navigate({ to: "/login", search: { account: account.account } })}
                >
                  重新登录
                </Menu.Item>
                <Menu.Item
                  className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted"
                  disabled={busy}
                  onClick={() => onAction("logout")}
                >
                  退出登录
                  <span className="mt-1 block text-xs text-muted-foreground">
                    暂停当前账号的自动任务
                  </span>
                </Menu.Item>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Item
                  className="rounded px-3 py-2.5 text-base text-destructive outline-none data-highlighted:bg-muted"
                  disabled={busy}
                  onClick={() => onAction("delete")}
                >
                  删除托管数据
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
