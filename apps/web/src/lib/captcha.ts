import { captchaAppIdSchema, captchaProofSchema, type CaptchaProof } from "@heybox/contracts";

type CaptchaResult = { ret?: unknown; ticket?: unknown; randstr?: unknown; errorCode?: unknown };
type CaptchaInstance = { show(): void; destroy(): void };
declare global {
  interface Window {
    TencentCaptcha?: new (
      appId: string,
      callback: (result: CaptchaResult) => void,
      options: { userLanguage: string },
    ) => CaptchaInstance;
  }
}
export function readCaptchaProof(result: CaptchaResult): CaptchaProof | null {
  if (result.ret === 2) return null;
  if (result.ret !== 0 || (result.errorCode !== undefined && result.errorCode !== 0)) {
    const detail =
      typeof result.errorCode === "number" && Number.isInteger(result.errorCode)
        ? `（${result.errorCode}）`
        : "";
    throw new Error(`人机验证服务不可用${detail}，请稍后重试`);
  }
  const proof = captchaProofSchema.safeParse(result);
  if (!proof.success) throw new Error("未取得有效的人机验证结果，请重新验证");
  return proof.data;
}
let loading: Promise<void> | undefined;
async function loadCaptcha() {
  if (window.TencentCaptcha) return;
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://turing.captcha.qcloud.com/TCaptcha.js";
      script.async = true;
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error("人机验证加载失败，请检查网络后重试"));
      };
      const timer = window.setTimeout(fail, 15_000);
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timer);
        if (window.TencentCaptcha) resolve();
        else fail();
      };
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  }
  await loading;
}
export async function showCaptcha(
  appId: string,
  expiresAt: number,
  signal: AbortSignal,
): Promise<CaptchaProof | null> {
  captchaAppIdSchema.parse(appId);
  await loadCaptcha();
  if (signal.aborted) return null;
  if (Date.now() >= expiresAt) throw new Error("登录已过期，请重新获取验证码");
  return new Promise((resolve, reject) => {
    let settled = false;
    let instance: CaptchaInstance | undefined;
    const finish = (proof: CaptchaProof | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        instance?.destroy();
      } catch {
        /* preserve the verified result if SDK cleanup fails */
      }
      if (error) reject(error);
      else resolve(proof);
    };
    const abort = () => finish(null);
    const timer = window.setTimeout(
      () => finish(null, new Error("登录已过期，请重新获取验证码")),
      expiresAt - Date.now(),
    );
    signal.addEventListener("abort", abort, { once: true });
    try {
      instance = new window.TencentCaptcha!(
        appId,
        (result) => {
          try {
            finish(readCaptchaProof(result));
          } catch (error) {
            finish(null, error instanceof Error ? error : new Error("人机验证失败"));
          }
        },
        { userLanguage: "zh-cn" },
      );
      if (!settled) instance.show();
    } catch {
      finish(null, new Error("人机验证无法打开，请稍后重试"));
    }
  });
}
