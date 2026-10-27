import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { phoneSchema, type LoginProgress } from "@heybox/contracts";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { authRequest } from "../lib/client";
import { readableError } from "../lib/utils";
import { useAccount, type Account } from "../components/layout";
import { showCaptcha } from "../lib/captcha";

type LoginResult = LoginProgress | (Account & { status: "authenticated" });

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "登录 · Heybox Daily" }] }),
  component: Login,
});
function Login() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<LoginProgress | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState<"send" | "verify" | "captcha" | null>(null);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");
  const { setAccount } = useAccount();
  const navigate = useNavigate();
  const captchaAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => {
      clearInterval(timer);
      captchaAbort.current?.abort();
    };
  }, []);
  async function applyResult(result: LoginResult) {
    if (result.status === "authenticated") {
      setAccount(result);
      await navigate({ to: "/" });
      return;
    }
    setChallenge(result);
    if (result.status === "sent") {
      setCooldown(result.retryAfter);
      setSentTo(phone.slice(-4));
      if (result.message) setError(result.message);
    }
  }
  async function send() {
    setError("");
    const parsed = phoneSchema.safeParse(phone);
    if (!parsed.success) {
      setError("请输入有效手机号，海外号码需包含国家或地区区号");
      return;
    }
    setBusy("send");
    try {
      const result = await authRequest<LoginProgress>("heybox/send-code", {
        phone: parsed.data,
      });
      setSentTo("");
      await applyResult(result);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }
  async function completeCaptcha() {
    setError("");
    if (challenge?.status !== "captcha" || Date.now() >= challenge.expiresAt) {
      setChallenge(null);
      setError("登录已过期，请重新获取验证码");
      return;
    }
    setBusy("captcha");
    const controller = new AbortController();
    captchaAbort.current = controller;
    try {
      const proof = await showCaptcha(challenge.appId, challenge.expiresAt, controller.signal);
      if (!proof || controller.signal.aborted) return;
      const result = await authRequest<LoginResult>("heybox/complete-captcha", {
        challenge: challenge.challenge,
        ...proof,
      });
      await applyResult(result);
      if (result.status === "captcha") setError("小黑盒要求重新验证，请再次完成人机验证");
    } catch (e) {
      setError(readableError(e));
    } finally {
      captchaAbort.current = null;
      setBusy(null);
    }
  }
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (challenge?.status !== "sent" || Date.now() >= challenge.expiresAt) {
      setError("请先获取新的验证码");
      return;
    }
    if (!/^\d{4,8}$/.test(code)) {
      setError("请输入 4 至 8 位验证码");
      return;
    }
    setBusy("verify");
    try {
      const result = await authRequest<LoginResult>("heybox/verify-code", {
        challenge: challenge.challenge,
        code,
      });
      await applyResult(result);
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
              disabled={busy !== null || challenge?.status === "captcha"}
              className="h-12 rounded-md px-3"
            />
            <Button
              type="button"
              variant="outline"
              className="h-12 min-w-28 rounded-md px-4 text-base"
              disabled={busy !== null || cooldown > 0 || challenge?.status === "captcha"}
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
        {challenge?.status === "captcha" ? (
          <Button
            type="button"
            className="h-12 w-full rounded-md text-base"
            disabled={busy !== null}
            onClick={completeCaptcha}
          >
            {busy === "captcha" ? "正在验证…" : "完成人机验证"}
          </Button>
        ) : (
          <Button
            type="submit"
            className="h-12 w-full rounded-md text-base"
            disabled={busy !== null || !challenge || !code}
          >
            {busy === "verify" ? "正在验证…" : "登录并开启自动任务"}
          </Button>
        )}
      </form>
      <p className="mt-6 text-center text-sm leading-6 text-muted-foreground">
        登录可能导致手机 APP 账号退出，手机重新登录一次即可，网站还是可以正常运行
      </p>
    </section>
  );
}
