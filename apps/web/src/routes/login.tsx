import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { phoneSchema, type beginResultSchema } from "@heybox/contracts";
import type { z } from "zod";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { authRequest } from "../lib/client";
import { readableError } from "../lib/utils";
import { useAccount, type Account } from "../components/layout";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "登录 · Heybox Daily" }] }),
  component: Login,
});
function Login() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<z.infer<typeof beginResultSchema> | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const { setAccount } = useAccount();
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  async function send() {
    setError("");
    const parsed = phoneSchema.safeParse(phone);
    if (!parsed.success) {
      setError("请输入有效手机号，海外号码需包含国家或地区区号");
      return;
    }
    setBusy("send");
    try {
      const result = await authRequest<z.infer<typeof beginResultSchema>>("heybox/send-code", {
        phone: parsed.data,
      });
      setChallenge(result);
      setCooldown(result.retryAfter);
      setSentTo(parsed.data.slice(-4));
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!challenge || Date.now() >= challenge.expiresAt) {
      setError("请先获取新的验证码");
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      setError("请输入 4 至 8 位验证码");
      return;
    }
    setBusy("verify");
    try {
      const result = await authRequest<Account>("heybox/verify-code", {
        challenge: challenge.challenge,
        code,
      });
      setAccount(result);
      await navigate({ to: "/" });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="mx-auto w-full max-w-[528px] px-6 pt-16 pb-16 sm:pt-24">
      <h1 className="text-center text-4xl font-semibold tracking-tight">登录</h1>
      <p className="mt-4 text-center text-base text-muted-foreground">使用小黑盒账号开启每日任务</p>
      <form className="mt-10 space-y-6" onSubmit={login}>
        <div>
          <label htmlFor="phone" className="mb-2.5 block text-base font-medium">
            手机号
          </label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="输入小黑盒手机号"
            maxLength={16}
            value={phone}
            disabled={busy !== null || cooldown > 0}
            onChange={(event) => {
              setPhone(event.target.value);
              setChallenge(null);
              setSentTo("");
            }}
            className="h-12 rounded-md px-3"
          />
        </div>
        <div>
          <label htmlFor="code" className="mb-2.5 block text-base font-medium">
            验证码
          </label>
          <div className="flex gap-3">
            <Input
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="输入验证码"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              disabled={busy === "verify"}
              className="h-12 rounded-md px-3"
            />
            <Button
              type="button"
              variant="outline"
              className="h-12 min-w-28 rounded-md px-4 text-base"
              disabled={busy !== null || cooldown > 0}
              onClick={send}
            >
              {busy === "send" ? "发送中…" : cooldown > 0 ? `${cooldown} 秒后重发` : "发送验证码"}
            </Button>
          </div>
          {sentTo && (
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              验证码已发送至尾号 {sentTo}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm leading-6 text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          className="h-12 w-full rounded-md text-base"
          disabled={busy !== null || !challenge || !code}
        >
          {busy === "verify" ? "正在验证…" : "登录并开启自动任务"}
        </Button>
      </form>
      <div className="mt-6 space-y-2 text-center text-sm leading-6 text-muted-foreground">
        <p>我们会加密保存登录态，用于每日签到和任务。</p>
        <p>登录可能导致手机 APP 退出，登录态失效后需重新验证。</p>
      </div>
    </section>
  );
}
