import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { Modal } from "./dialog";
import { authRequest, client } from "../lib/client";
import { readableError } from "../lib/utils";

const AccountContext = createContext<{
  account: Account | null;
  setAccount: (account: Account | null) => void;
}>({ account: null, setAccount: () => {} });
export const useAccount = () => useContext(AccountContext);
export type Account = { account: string; nickname?: string; avatar?: string | null };

export function Layout({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const [info, setInfo] = useState<"privacy" | "help" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  async function logout() {
    await authRequest("sign-out", {});
    setAccount(null);
    await navigate({ to: "/login" });
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await client.deleteAccount({ confirm: true });
      setAccount(null);
      setInfo(null);
      await navigate({ to: "/login" });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountContext.Provider value={{ account, setAccount }}>
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
                  to="/"
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
              {account ? (
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
                    {account.avatar && account.avatar !== failedAvatar ? (
                      <img
                        src={account.avatar}
                        alt=""
                        width={32}
                        height={32}
                        referrerPolicy="no-referrer"
                        className="size-8 shrink-0 rounded-full object-cover"
                        onError={() => setFailedAvatar(account.avatar || null)}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm"
                      >
                        {(account.nickname || "盒友").slice(0, 1)}
                      </span>
                    )}
                    <span className="min-w-0 truncate">
                      {account.nickname || `盒友 ${account.account}`}
                    </span>
                    <ChevronDown className="size-4" />
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Positioner align="end" sideOffset={8} className="z-40">
                      <Menu.Popup className="min-w-44 rounded-lg border bg-white p-1 shadow-lg outline-none">
                        <Menu.Item
                          className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted"
                          onClick={() => navigate({ to: "/login" })}
                        >
                          重新验证小黑盒
                        </Menu.Item>
                        <Menu.Item
                          className="rounded px-3 py-2.5 text-base outline-none data-highlighted:bg-muted"
                          onClick={() => {
                            void logout().catch((e) => {
                              setError(readableError(e));
                              setInfo("help");
                            });
                          }}
                        >
                          退出网站
                        </Menu.Item>
                        <Menu.Separator className="my-1 h-px bg-border" />
                        <Menu.Item
                          className="rounded px-3 py-2.5 text-base text-destructive outline-none data-highlighted:bg-muted"
                          onClick={() => {
                            setError("");
                            setInfo("delete");
                          }}
                        >
                          删除托管数据
                        </Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
              ) : (
                <button
                  onClick={() => setInfo("help")}
                  className="text-muted-foreground hover:text-foreground"
                >
                  使用说明
                </button>
              )}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-6 pb-8 text-sm text-muted-foreground sm:px-8">
          <div className="flex gap-6 border-t pt-6">
            <button onClick={() => setInfo("privacy")}>隐私说明</button>
            <a href="https://github.com/Cansiny0320/heybox-daily" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </footer>
      </div>
      <Modal
        open={info !== null}
        onOpenChange={(open) => {
          if (!open) setInfo(null);
        }}
        title={info === "privacy" ? "隐私说明" : info === "delete" ? "删除托管数据？" : "使用说明"}
      >
        {info === "privacy" ? (
          <div className="space-y-4 text-base leading-7 text-muted-foreground">
            <p>
              我们保存你的盒友 ID、昵称、头像、加密后的小黑盒登录态、网站会话和最近 30
              天的任务记录，用于执行你开启的每日任务。
            </p>
            <p>
              手机号和验证码仅在登录时使用，不写入数据库。验证码挑战最多保留 5
              分钟，登录态只在执行端解密。
            </p>
            <p>
              可随时暂停任务或删除托管数据。删除会撤销网站会话并移除登录态和任务记录；已经发送的小黑盒请求无法撤回。
            </p>
          </div>
        ) : info === "delete" ? (
          <>
            <p className="text-base leading-7 text-muted-foreground">
              这会停止后续任务，删除保存的登录态和任务记录，并退出网站。已经发送的小黑盒请求无法撤回。
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
              <Button variant="destructive" disabled={busy} onClick={remove}>
                {busy ? "正在删除…" : "删除数据"}
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4 text-base leading-7 text-muted-foreground">
            <p>
              用小黑盒手机号和验证码登录后，每天北京时间 00:01
              开始执行签到和三项分享任务。首次登录会先补跑今天未完成的任务。
            </p>
            <p>登录可能让手机 APP 退出。登录态失效时任务会暂停，需要你重新验证。</p>
            <p>
              在“我的任务”可暂停、恢复或补跑。退出网站会保留自动任务设置；删除托管数据会停止后续任务。
            </p>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </AccountContext.Provider>
  );
}
