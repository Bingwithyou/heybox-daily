import test from "node:test";
import assert from "node:assert/strict";
import { crawlerDocument } from "../src/server/seo.ts";

test("preview blocks crawlers and emits no sitemap URLs without changing production", async () => {
  const robots = new Request("https://preview.heybox.cansiny.top/robots.txt");
  assert.equal(await crawlerDocument(robots, true)!.text(), "User-agent: *\nDisallow: /\n");
  assert.match(await crawlerDocument(robots)!.text(), /Allow: \/\n/);
  const sitemap = crawlerDocument(
    new Request("https://preview.heybox.cansiny.top/sitemap.xml"),
    true,
  )!;
  assert.doesNotMatch(await sitemap.text(), /<loc>/);
  assert.equal(await crawlerDocument(new Request(robots, { method: "HEAD" }), true)!.text(), "");
  assert.equal(crawlerDocument(new Request(robots, { method: "POST" }), true)!.status, 405);
  assert.equal(
    crawlerDocument(new Request("https://preview.heybox.cansiny.top/tasks"), true),
    null,
  );
});
