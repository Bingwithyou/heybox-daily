import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useCallback, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Modal } from "./dialog";
import { AccountAvatar } from "./account-avatar";
import { authRequest } from "../lib/client";
import { readAccounts, type Account } from "../lib/accounts";
export type { Account } from "../lib/accounts";
import { readableError } from "../lib/utils";

const AccountContext = createContext<{
  account: Account | null;
  setAccount: (account: Account | null) => void;
  refreshAccounts: () => Promise<void>;
}>({ account: null, setAccount: () => {}, refreshAccounts: async () => {} });
export const useAccount = () => useContext(AccountContext);

export function Layout({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [info, setInfo] = useState<"error" | "delete" | "logout" | null>(null);
  const [actionAccount, setActionAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const refreshAccounts = useCallback(async () => {
    const value = await readAccounts();
    setAccounts(value.accounts);
    setAccount(value.accounts.find((item) => item.account === value.activeAccount) || null);
  }, []);
  useEffect(() => {
    void refreshAccounts().catch(() => {});
    const refresh = () => {
      void refreshAccounts().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshAccounts]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/stats", { cache: "reload" });
        if (!response.ok) return;
        const value = (await response.json()) as { accounts: number };
        if (!disposed) setCount(value.accounts);
      } catch {
        /* Keep the last known count during a network interruption. */
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 300_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [account?.account]);
  async function switchAccount(target: Account) {
    setBusy(true);
    try {
      await authRequest("heybox/switch", { account: target.account });
      window.location.assign("/tasks");
    } catch (e) {
      setError(readableError(e));
      setInfo("error");
      setBusy(false);
    }
  }
  async function leave(remove: boolean) {
    if (!actionAccount) return;
    setBusy(true);
    setError("");
    try {
      const result = await authRequest<{ account: string | null }>(
        remove ? "heybox/delete" : "heybox/logout",
        {
          expectedAccount: actionAccount.account,
          ...(remove ? { confirm: true } : {}),
        },
      );
      window.location.assign(result.account ? "/tasks" : "/login");
    } catch (e) {
      setError(readableError(e));
      setBusy(false);
    }
  }
  function confirmAction(action: "logout" | "delete") {
    setActionAccount(account);
    setError("");
    setInfo(action);
  }
  return (
    <AccountContext.Provider value={{ account, setAccount, refreshAccounts }}>
      <div className="flex min-h-dvh flex-col">
        <header className="border-b">
          <div className="mx-auto flex h-20 max-w-6xl items-center justify-between gap-4 px-6 sm:px-8">
            <Link
              to="/"
              className="shrink-0 whitespace-nowrap text-xl font-semibold tracking-tight sm:text-2xl"
            >
              Heybox Daily
            </Link>
            <nav
              aria-label="主导航"
              className="flex min-w-0 items-center justify-end gap-3 text-base sm:gap-8"
            >
              {account && (
                <Link
                  to="/tasks"
                  className="hidden text-muted-foreground hover:text-foreground sm:block"
                  activeProps={{ className: "text-foreground" }}
                >
                  我的任务
                </Link>
              )}
              <Link
                to="/sponsor"
                className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
              >
                赞助
              </Link>
              {account || accounts.length ? (
                <Menu.Root>
                  <Menu.Trigger
                    aria-label="账号菜单"
                    render={
                      <Button
                        variant="ghost"
                        className="h-11 min-w-0 max-w-44 shrink gap-2.5 px-2 text-base"
                      />
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
                        {accounts.map((item) => (
                          <Menu.Item
                            key={item.account}
                            disabled={busy}
                            className="flex items-center gap-3 rounded px-3 py-3 outline-none data-highlighted:bg-muted"
                            onClick={() => {
                              if (item.account !== account?.account) void switchAccount(item);
                            }}
                          >
                            <AccountAvatar account={item} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{item.nickname || "盒友"}</span>
                              <span className="block text-sm text-muted-foreground">
                                盒友 {item.account}
                              </span>
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
                              onClick={() =>
                                navigate({ to: "/login", search: { account: account.account } })
                              }
                            >
                              重新登录
                            </Menu.Item>
                            <Menu.Item
                              className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted"
                              disabled={busy}
                              onClick={() => confirmAction("logout")}
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
                              onClick={() => confirmAction("delete")}
                            >
                              删除托管数据
                            </Menu.Item>
                          </>
                        )}
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              ) : (
                <Link
                  to="/login"
                  className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground"
                  activeOptions={{ exact: true, includeSearch: false }}
                  activeProps={{ className: "hidden" }}
                >
                  登录
                </Link>
              )}
              <a
                href="https://github.com/Cansiny0320/heybox-daily"
                target="_blank"
                rel="noreferrer"
                aria-label="GitHub 仓库"
                title="GitHub 仓库"
                className="inline-flex shrink-0 text-muted-foreground hover:text-foreground"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-5">
                  <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.105.77-.244.77-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.509-3.79-1.509-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.077-.685.077-.685 1.13.08 1.725 1.16 1.725 1.16 1.005 1.723 2.636 1.225 3.278.937.103-.728.393-1.225.715-1.507-2.499-.284-5.126-1.25-5.126-5.563 0-1.229.44-2.233 1.16-3.02-.116-.284-.503-1.429.11-2.978 0 0 .945-.302 3.094 1.154A10.79 10.79 0 0 1 12 6.191a10.8 10.8 0 0 1 2.818.379c2.148-1.456 3.091-1.154 3.091-1.154.615 1.549.228 2.694.112 2.978.722.787 1.159 1.791 1.159 3.02 0 4.324-2.631 5.276-5.138 5.555.404.349.765 1.039.765 2.094 0 1.512-.014 2.732-.014 3.103 0 .301.203.653.774.542A11.25 11.25 0 0 0 12 .75Z" />
                </svg>
              </a>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-6 pb-8 text-sm text-muted-foreground sm:px-8">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-6">
            <Link to="/about">关于</Link>
            <Link to="/help">使用说明</Link>
            <Link to="/privacy">隐私说明</Link>
            {count !== null && (
              <span className="ml-auto">已接入 {count.toLocaleString("zh-CN")} 个账号</span>
            )}
          </div>
        </footer>
      </div>
      <Modal
        open={info !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setInfo(null);
        }}
        title={
          info === "delete" ? "删除托管数据？" : info === "logout" ? "退出当前账号？" : "操作失败"
        }
      >
        {info === "delete" || info === "logout" ? (
          <>
            <p className="text-base leading-7 text-muted-foreground">
              {info === "logout"
                ? `退出后将暂停「${actionAccount?.nickname || actionAccount?.account}」的自动任务，保留登录态和历史记录。其他账号不受影响。`
                : `这会删除「${actionAccount?.nickname || actionAccount?.account}」的登录态和任务记录，并退出该账号。其他账号不受影响，已发送的小黑盒请求无法撤回。`}
            </p>
            {error && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" disabled={busy} onClick={() => setInfo(null)}>
                取消
              </Button>
              <Button
                variant={info === "delete" ? "destructive" : "default"}
                disabled={busy}
                onClick={() => leave(info === "delete")}
              >
                {busy ? "正在处理…" : info === "delete" ? "删除数据" : "退出登录"}
              </Button>
            </div>
          </>
        ) : (
          <p role="alert" className="text-base leading-7 text-destructive">
            {error}
          </p>
        )}
      </Modal>
    </AccountContext.Provider>
  );
}
