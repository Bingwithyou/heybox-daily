// Public deployment identity; keep metadata and crawler documents on the same origin.
export const siteUrl = "https://heybox.cansiny.top";
export const repositoryUrl = "https://github.com/Cansiny0320/heybox-daily";
export const siteDescription =
  "Heybox Daily 是开源的小黑盒自动签到和每日任务工具，支持在线托管、多账号管理和 Docker 自部署。";
export const publicPages = ["/about", "/help", "/privacy", "/sponsor"] as const;

export function publicPageHead(
  path: (typeof publicPages)[number],
  title: string,
  description: string,
) {
  const url = siteUrl + path;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { name: "robots", content: "index, follow, max-image-preview:large" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "Heybox Daily" },
      { property: "og:locale", content: "zh_CN" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

export function privatePageHead(title: string) {
  return { meta: [{ title }, { name: "robots", content: "noindex, follow" }] };
}

export const websiteData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/about#website`,
      url: `${siteUrl}/about`,
      name: "Heybox Daily",
      description: siteDescription,
      inLanguage: "zh-CN",
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${siteUrl}/about#application`,
      name: "Heybox Daily",
      url: `${siteUrl}/about`,
      description: siteDescription,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Web, Docker",
      license: `${repositoryUrl}/blob/main/LICENSE`,
      sameAs: repositoryUrl,
      featureList: [
        "每日签到",
        "分享帖子",
        "分享游戏",
        "分享游戏评价",
        "多账号管理",
        "Docker 自部署",
      ],
    },
  ],
};
