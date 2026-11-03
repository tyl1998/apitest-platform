import Editor from "@monaco-editor/react";

/**
 * 任务命令行的 shell 编辑器（P4.5-14，验收反馈 3「命令行输入是否可以支持 shell 语法识别，
 * 类似于校验脚本那样」）。
 *
 * 与 `ScriptCodeEditor` 分开而不是加一个 `language` 参数：那个组件的全部体量都在**补全**
 * 上——它要拉平台的 `ctx` 契约、注册 completion provider、维护公共脚本符号表。shell 命令
 * 没有等价的契约可补（补一堆猜的 pytest 参数只会碍事），所以这里只要语法高亮，一个薄壳
 * 比一个多态参数诚实。
 *
 * 三个选项与脚本编辑器保持一致（JetBrains Mono / 12px / 无 minimap）：同一个产品里两个
 * 代码框长得不一样，用户会以为它们的能力也不一样。
 */
export function ShellCodeEditor({ value, onChange, height, theme, readOnly }: {
  value: string;
  onChange: (value: string) => void;
  height: string;
  theme: string;
  readOnly?: boolean;
}) {
  return <Editor
    height={height}
    language="shell"
    theme={theme}
    value={value}
    onChange={(next) => onChange(next ?? "")}
    options={{
      readOnly,
      minimap: { enabled: false },
      lineNumbers: "on",
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      scrollBeyondLastLine: false,
      tabSize: 2,
      automaticLayout: true,
      /* 补全关掉：Monaco 默认会拿缓冲区里的词做 word-based 建议，在一段 shell 里那等于
         把上一行的路径名当成候选弹出来——比没有补全更糟。 */
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: "off",
    }}
  />;
}
