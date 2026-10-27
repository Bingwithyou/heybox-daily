import { publicPages, siteUrl } from "../lib/seo.ts";

export function crawlerDocument(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== "/robots.txt" && path !== "/sitemap.xml") return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const robots = path === "/robots.txt";
  const body = robots
    ? `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /rpc/\nDisallow: /internal/\n\nSitemap: ${siteUrl}/sitemap.xml\n`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${publicPages.map((page) => `  <url><loc>${siteUrl}${page}</loc></url>`).join("\n")}\n</urlset>\n`;
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": `${robots ? "text/plain" : "application/xml"}; charset=utf-8` },
  });
}

export function shouldNoindex(path: string, status: number): boolean {
  return status >= 400 || !publicPages.some((page) => page === path);
}
