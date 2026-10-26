import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, CircleAlert, LoaderCircle } from "lucide-react";
import { taskIds, taskNames, publicReasons } from "@heybox/contracts";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useAccount } from "../components/layout";
import { client } from "../lib/client";
import { dateTime, readableError, rewardDelta } from "../lib/utils";

export const Route = createFileRoute("/")({ component: Dashboard });
type DashboardData = Awaited<ReturnType<typeof client.dashboard>>;
const statusNames: Record<string, string> = {
  queued: "等待执行",
  running: "正在执行",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已停止",
  auth_expired: "需要重新验证",
};
function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { setAccount } = useAccount();
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      const value = await client.dashboard();
      setData(value);
      setAccount(value.account);
      setError("");
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "UNAUTHORIZED") {
        setAccount(null);
        await navigate({ to: "/login" });
      } else setError(readableError(e));
    }
  }, [navigate, setAccount]);
  const polling = data?.today?.status === "running" || data?.today?.status === "queued";
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") void refresh();
      },
      polling ? 5_000 : 60_000,
    );
    return () => clearInterval(timer);
  }, [refresh, polling]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section className="mx-auto max-w-5xl px-6 py-20 sm:px-8">
        <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
          {error || "正在读取任务…"}
        </p>
        {error && (
          <Button className="mt-4" variant="outline" onClick={refresh}>
            重新加载
          </Button>
        )}
      </section>
    );
  const today = data.today;
  const tasks = today?.result?.snapshot?.tasks;
  const complete = tasks?.filter((task) => task.state === "finish").length || 0;
  const running = today?.status === "running" || today?.status === "queued";
  const expired = data.credentialState !== "valid";
  const reason = today?.result?.reason;
  const history = data.history.filter((row) => row.id !== today?.id);
  return (
    <section className="mx-auto max-w-5xl px-6 pt-14 pb-16 sm:px-8 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">我的任务</h1>
      <div className="mt-9 flex items-center justify-between gap-6 border-b pb-7">
        <div>
          <label htmlFor="automation" className="text-base font-medium">
            自动任务
          </label>
          <p className="mt-2 text-sm text-muted-foreground">
            {data.enabled || expired
              ? "每天 09:15 · 北京时间"
              : "已暂停，恢复后补跑今天未完成的任务"}
          </p>
        </div>
        <Switch
          id="automation"
          checked={data.enabled}
          disabled={busy || expired}
          onCheckedChange={(enabled) => change(() => client.setEnabled({ enabled }))}
        />
      </div>
      {expired && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-md bg-amber-50 px-4 py-3 text-sm">
          <span>需要重新登录小黑盒，自动任务已暂停。</span>
          <Link to="/login" className="font-medium underline underline-offset-4">
            重新验证
          </Link>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-6 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold">今日任务</h2>
          <span className="text-sm text-muted-foreground">
            {tasks ? `${complete} / 4` : today ? statusNames[today.status] : "尚未执行"}
          </span>
        </div>
        {!expired && data.enabled && today?.status !== "completed" && (
          <Button
            variant="outline"
            disabled={busy || running}
            onClick={() => change(() => client.retry())}
          >
            {running ? statusNames[today!.status] : "重试未完成任务"}
          </Button>
        )}
      </div>
      <div className="mt-5 divide-y border-y" aria-label="今日任务状态">
        {taskIds.map((id) => {
          const done = tasks?.find((task) => task.id === id)?.state === "finish";
          const failed = !done && today && ["failed", "auth_expired"].includes(today.status);
          return (
            <div key={id} className="flex min-h-17 items-center justify-between gap-4 py-4">
              <span className="text-sm font-medium">{taskNames[id]}</span>
              <span
                className={`flex items-center gap-2 text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}
              >
                {done ? (
                  <>
                    <Check className="size-4 text-foreground" />
                    已完成
                  </>
                ) : failed ? (
                  <>
                    <CircleAlert className="size-4" />
                    未完成
                  </>
                ) : running ? (
                  <>
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    等待确认
                  </>
                ) : (
                  <>
                    <Clock3 className="size-4" />
                    未执行
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs leading-6 text-muted-foreground">
        <span>
          {reason && reason !== "auth_expired" && reason !== "cancelled"
            ? `${publicReasons[reason]}${today?.status === "queued" ? "，稍后自动重试" : ""}`
            : today?.status === "completed"
              ? `已核实全部完成 · 经验 ${rewardDelta(today.result?.expDelta || 0)} · H 币 ${rewardDelta(today.result?.coinDelta || 0)}`
              : running
                ? "执行结果会自动更新"
                : ""}
        </span>
        {data.nextRunAt && <span>下次定时执行：{dateTime(data.nextRunAt)}</span>}
      </div>
      <section className="mt-12">
        <h2 className="text-xl font-semibold">最近记录</h2>
        {history.length ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="pb-3 font-normal">日期</th>
                  <th className="pb-3 font-normal">状态</th>
                  <th className="pb-3 text-right font-normal">经验 / H 币</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.map((row) => (
                  <tr key={row.id}>
                    <td className="py-5 tabular-nums">{row.date}</td>
                    <td className="py-5 text-muted-foreground">{statusNames[row.status]}</td>
                    <td className="py-5 text-right tabular-nums">
                      {row.result?.expDelta !== undefined
                        ? `${rewardDelta(row.result.expDelta)} / ${rewardDelta(row.result.coinDelta || 0)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-5 border-t py-8 text-sm text-muted-foreground">还没有历史记录</p>
        )}
      </section>
    </section>
  );
}
