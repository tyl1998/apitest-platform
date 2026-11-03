import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 应用内功能说明文档（P13-3）。头像旁入口 `target="_blank"` 打开这条独立路由——
 * 独立于 DockedShell 壳（不挂站内助手），自带极简顶栏 + 左目录 + 右正文的双栏读法，
 * 与报告分享页（`ShareReportPage`）同族的「轻壳」纪律：外壳占满视口，只有正文列滚。
 *
 * 内容是**只读展示**（边界 3：不做编辑器 / 后台配置 / 版本化）——章节结构在这里用
 * 一个 `SECTIONS` 常量维护，每节的标题与正文都是 i18n 键，正文是 markdown 字符串
 * （复用 react-markdown + remark-gfm，与助手回复同一套渲染）。改内容 = 改
 * `i18n.ts` 里的 `docs.*` 键，中英双语各一份。
 *
 * 左目录点击锚点定位；正文滚动时用 IntersectionObserver 反查当前章节高亮目录项
 * （scroll-spy）——目录是「读到哪了」的读数，不是第二套导航。
 */

/** 章节清单：id 既是锚点也是目录序。标题 / 正文各一个 i18n 键。 */
const SECTIONS = [
  "intro",
  "projects",
  "endpoints",
  "specSources",
  "environments",
  "dataSources",
  "flows",
  "suites",
  "schedules",
  "mocks",
  "webhooks",
  "reports",
  "stats",
  "repo",
  "assistant",
  "mcp",
  "alerts",
  "permissions",
  "credentials",
  "account",
] as const;

type SectionId = (typeof SECTIONS)[number];

function sectionTitleKey(id: SectionId) {
  return `docs.section.${id}.title` as const;
}
function sectionBodyKey(id: SectionId) {
  return `docs.section.${id}.body` as const;
}

export function DocsPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState<SectionId>(SECTIONS[0]);
  const contentRef = useRef<HTMLDivElement>(null);

  /* 设置 tab 标题（新标签打开，浏览器标签页要有名字）。 */
  useEffect(() => {
    const previous = document.title;
    document.title = `${t("docs.title")} · ${t("app.name")}`;
    return () => { document.title = previous; };
  }, [t]);

  /* scroll-spy：正文里每个 <section> 进出视口时更新高亮。rootMargin 上偏，让「当前」
     判定落在视口上部——读者眼睛通常停在上方，不是正中。 */
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const nodes = SECTIONS
      .map((id) => root.querySelector<HTMLElement>(`#docs-${id}`))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id.replace("docs-", "") as SectionId);
      },
      { root, rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  const toc = useMemo(
    () => SECTIONS.map((id) => ({ id, title: t(sectionTitleKey(id)) })),
    [t],
  );

  function jumpTo(id: SectionId) {
    contentRef.current?.querySelector(`#docs-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  }

  return <div className="docs-shell">
    <header className="docs-topbar">
      <Link to="/dashboard" className="lockup">
        <span className="lockup-mark mono">AT</span>
        <span className="lockup-name">{t("app.name")}</span>
      </Link>
      <span className="docs-topbar-title">{t("docs.title")}</span>
    </header>
    <div className="docs-body">
      <nav className="docs-toc" aria-label={t("docs.tocLabel")}>
        <p className="docs-toc-head">{t("docs.tocLabel")}</p>
        <ul>
          {toc.map(({ id, title }) => (
            <li key={id}>
              <button
                type="button"
                className={`docs-toc-link${active === id ? " is-active" : ""}`}
                onClick={() => jumpTo(id)}
              >
                {title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="docs-content" ref={contentRef}>
        <div className="docs-measure">
          <h1 className="docs-doc-title">{t("docs.title")}</h1>
          <p className="docs-tagline">{t("docs.tagline")}</p>
          {SECTIONS.map((id) => (
            <section key={id} id={`docs-${id}`} className="docs-section">
              <h2 className="docs-section-title">{t(sectionTitleKey(id))}</h2>
              <div className="docs-md">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
                  }}
                >
                  {t(sectionBodyKey(id))}
                </ReactMarkdown>
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  </div>;
}
