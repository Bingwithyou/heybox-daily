import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

export async function verifySeo(base: string) {
  for (const path of ["/", "/tasks", "/tasks/", "/tasks?from=bookmark"]) {
    for (const cookie of [undefined, "better-auth.session_token=invalid"]) {
      const response = await fetch(`${base}${path}`, {
        redirect: "manual",
        headers: cookie ? { cookie } : undefined,
      });
      assert.equal(response.status, 302, `guest cannot enter ${path}`);
      assert.equal(new URL(response.headers.get("location")!, base).pathname, "/login");
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
      assert.ok(!(await response.text()).includes("正在读取任务"));
    }
  }
  const origin = "https://heybox.cansiny.top";
  const pages = [
    ["/about", "小黑盒自动签到", "分享游戏评价"],
    ["/help", "使用说明", "00:01"],
    ["/privacy", "隐私说明", "30"],
    ["/sponsor", "赞助", "支持"],
  ];
  const titles = new Set<string>();
  for (const [path, heading, content] of pages) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok(!response.headers.get("x-robots-tag")?.includes("noindex"), path);
    const dom = new JSDOM(await response.text());
    const doc = dom.window.document;
    assert.match(doc.querySelector("h1")?.textContent || "", new RegExp(heading), path);
    assert.ok(doc.querySelector("main")?.textContent?.includes(content), path);
    assert.equal(doc.documentElement.lang, "zh-CN");
    assert.equal(doc.querySelectorAll("title").length, 1);
    assert.ok(doc.title.includes(heading));
    titles.add(doc.title);
    assert.equal(doc.querySelectorAll('meta[name="description"]').length, 1);
    assert.ok(doc.querySelector('meta[name="description"]')?.getAttribute("content"));
    assert.equal(doc.querySelectorAll('link[rel="canonical"]').length, 1);
    assert.equal(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), origin + path);
    assert.equal(
      doc.querySelector('meta[property="og:url"]')?.getAttribute("content"),
      origin + path,
    );
    assert.equal(
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content"),
      doc.title,
    );
    assert.equal(
      doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content"),
      doc.title,
    );
    assert.equal(doc.querySelectorAll('meta[name="robots"]').length, 1);
    assert.ok(
      doc.querySelector('meta[name="robots"]')?.getAttribute("content")?.startsWith("index,"),
    );
    if (path === "/about") {
      const data = JSON.parse(
        doc.querySelector('script[type="application/ld+json"]')?.textContent || "null",
      );
      assert.equal(data["@context"], "https://schema.org");
      assert.ok(
        data["@graph"].some((item: Record<string, unknown>) => item["@type"] === "WebSite"),
      );
      assert.ok(
        data["@graph"].some(
          (item: Record<string, unknown>) => item["@type"] === "SoftwareApplication",
        ),
      );
      for (const link of ["/login", "/help", "/privacy"])
        assert.ok(doc.querySelector(`a[href="${link}"]`), link);
      assert.equal(doc.querySelector('a[href="/tasks"]'), null);
      assert.ok(!doc.querySelector("main")?.textContent?.includes("正在读取任务"));
    }
    dom.window.close();
  }
  assert.equal(titles.size, pages.length);
  for (const path of ["/login", "/login?account=123"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-robots-tag") || "", /noindex/);
    const dom = new JSDOM(await response.text());
    assert.match(
      dom.window.document.querySelector('meta[name="robots"]')?.getAttribute("content") || "",
      /noindex/,
    );
    assert.equal(dom.window.document.querySelector('link[rel="canonical"]'), null);
    dom.window.close();
  }
  const missing = await fetch(`${base}/missing-seo-page`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("x-robots-tag") || "", /noindex/);
  const api = await fetch(`${base}/api/auth/get-session`);
  assert.match(api.headers.get("x-robots-tag") || "", /noindex/);
  const robots = await fetch(`${base}/robots.txt`);
  assert.match(robots.headers.get("content-type") || "", /text\/plain/);
  const rules = await robots.text();
  assert.match(rules, /User-agent: \*\nAllow: \//);
  for (const path of ["/api/", "/rpc/", "/internal/"])
    assert.ok(rules.includes(`Disallow: ${path}`));
  assert.ok(rules.includes(`Sitemap: ${origin}/sitemap.xml`));
  const sitemap = await fetch(`${base}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") || "", /application\/xml/);
  const xml = new JSDOM(await sitemap.text(), { contentType: "application/xml" });
  assert.deepEqual(
    [...xml.window.document.querySelectorAll("loc")].map((node) => node.textContent).sort(),
    pages.map(([path]) => origin + path).sort(),
  );
  xml.window.close();
  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  console.log(
    "PASS: public SSR content, metadata, structured data, private noindex, robots and sitemap",
  );
}
