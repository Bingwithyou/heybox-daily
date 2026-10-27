import { createFileRoute } from "@tanstack/react-router";
import { publicPageHead } from "../lib/seo";

export const Route = createFileRoute("/privacy")({
  head: () =>
    publicPageHead(
      "/privacy",
      "隐私说明 · Heybox Daily",
      "了解 Heybox Daily 保存的账号信息、加密登录态和任务记录，以及暂停任务、退出登录和删除托管数据的方式。",
    ),
  component: Privacy,
});

function Privacy() {
  return (
    <article className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 sm:pt-16">
      <div className="max-w-2xl space-y-8 text-base leading-7">
        <h1 className="text-3xl font-semibold tracking-tight">隐私说明</h1>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">保存的信息与用途</h2>
          <p>
            我们保存你的盒友 ID、昵称、头像、加密后的小黑盒登录态、网站会话和最近 30
            天的任务记录，用于执行你开启的每日任务、你选择的抽奖操作和展示结果。
          </p>
          <p>
            网站通过 Cookie
            维持登录和同一浏览器的多账号切换。执行任务时，执行端使用登录态向小黑盒接口发送请求。
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">登录信息</h2>
          <p>
            手机号和验证码仅用于登录。完成登录和人机验证所需的信息会加密暂存，最多保留 5
            分钟，登录成功后立即清理。登录态只在执行端解密。
          </p>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">暂停与删除</h2>
          <p>
            你可随时在“我的任务”暂停自动任务。退出登录会暂停当前账号任务并保留登录态和历史记录，其他账号不受影响。
          </p>
          <p>
            在顶部账号菜单选择“删除托管数据”，会撤销当前账号的网站会话并移除登录态和任务记录，停止后续任务；已经发送的小黑盒请求无法撤回。
          </p>
        </section>
      </div>
    </article>
  );
}
