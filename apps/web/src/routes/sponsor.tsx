import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { publicPageHead } from "../lib/seo";
export const Route = createFileRoute("/sponsor")({
  head: () =>
    publicPageHead(
      "/sponsor",
      "赞助 · Heybox Daily",
      "通过微信或支付宝支持 Heybox Daily 开源小黑盒自动签到项目。",
    ),
  component: Sponsor,
});
function Sponsor() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">赞助</h1>
      <p className="mt-4 text-base text-muted-foreground">觉得好用的话，欢迎支持一下。</p>
      <a href="/sponsorship.png" target="_blank" rel="noreferrer" className="mt-10 block">
        <img
          src="/sponsorship.webp"
          width={1536}
          height={1024}
          alt="微信和支付宝赞助收款码"
          className="w-full rounded-lg"
        />
      </a>
      <a
        href="/sponsorship.png"
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1 text-base text-muted-foreground hover:text-foreground"
      >
        查看原图
        <ArrowUpRight className="size-3.5" />
      </a>
    </section>
  );
}
