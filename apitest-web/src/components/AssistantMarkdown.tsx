import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 上游的「工具过程」富标记（2026-09-15 用户实测发现）：某些上游的终态全文里夹
 * `<div><markdown-custom-process …></markdown-custom-process></div>`，其自家 UI 把
 * 它渲染成过程组件；我们不解析原始 HTML，不剥就会整段裸标签进气泡。工具执行状态
 * 我们已有自己的呈现（PROCESSING 事件 → 工具行），这里剥掉即可——覆盖自闭合与
 * 配对两种写法，标签间的空行一并收掉。只剥这一种已知标记，不做泛化 HTML 清洗
 * （代码块里教 HTML 的合法内容不该被误伤）。
 */
const CUSTOM_PROCESS_TAG = /(?:\n?[ \t]*)?<div>\s*<markdown-custom-process\b[^>]*\/?>(?:\s*<\/markdown-custom-process>)?\s*<\/div>(?:[ \t]*\n)*/gi;

function stripCustomProcess(text: string): string {
  return text.includes("markdown-custom-process") ? text.replace(CUSTOM_PROCESS_TAG, "\n\n") : text;
}

/**
 * 助手回复的 Markdown 渲染（P9-4c-2）。只用于 assistant 文本块——agent 的回复天然是
 * markdown（表格/列表/代码块），pre-wrap 纯文本会把编排压成一坨；用户气泡、错误
 * 气泡、工具行维持纯文本。
 *
 * - `remark-gfm` 补表格 / 任务列表 / 删除线（agent 输出的高频形态）；
 * - 默认不吃原始 HTML（react-markdown 的安全底线，XSS 面为零）——不放开；上游
 *   自家的过程标记（markdown-custom-process）在进解析器前剥掉，理由见上；
 * - 链接强制外开（聊天窗里没有「返回」）；
 * - 流式期间半张表格 / 未闭合代码块容忍渲染，token 到齐自然收敛（每 token 全量
 *   重解析在聊天尺寸下可接受，不引增量解析器）；
 * - `apitest-proposal` 围栏渲染为普通代码块（P9-5 的预览卡扫描在其上叠）。
 */
export function AssistantMarkdown({ text }: { text: string }) {
  return <div className="assistant-md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >
      {stripCustomProcess(text)}
    </ReactMarkdown>
  </div>;
}
