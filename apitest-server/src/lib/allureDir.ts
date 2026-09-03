/**
 * 从任务的 shell 命令里解析 allure 结果目录（P4.5-14，计划 8.11 的 B 类）。
 *
 * 存在的理由：报告格式的下拉被删了（永远 allure），报告路径也不再是一个独立的输入框
 * ——它已经写在命令里了。用户在 `pytest -q --alluredir=allure-results` 这一行里已经
 * 说明了目录，再要他在旁边的框里重复一遍，就是让同一个事实有两个可以互相矛盾的出处。
 *
 * **解析器刻意是「尽力而为」而不是「权威」**：
 * - 认三种写法：`--alluredir=<dir>`、`--alluredir <dir>`、`ALLURE_RESULTS_DIR=<dir>`。
 * - 解析不到返回 `null`，调用方**提示而不是拒绝**（8.11）：用户可能把它写在
 *   `pytest.ini` 的 `addopts` 里，那份文件在用户仓库中、平台看不见，拿一条猜测去否决
 *   保存是错的。
 * - 多处出现取**第一处**：一段脚本里跑两次 pytest 写两个目录是真实存在的，但报告视图
 *   只能有一个数据源，选第一个至少是稳定可解释的（而不是按字典序或最后一个）。
 *
 * 不引 shell 词法分析器（shell-quote 之类）：真正的 shell 解析要处理续行、变量展开、
 * 子命令、here-doc，而这里只需要在一段文本里找一个参数。一个正则的失败模式是「没解析
 * 到」，一个半吊子词法器的失败模式是「解析出一个错的目录」——前者有兜底提示，后者会让
 * 报告静默为空。
 */

/**
 * 目录必须是 workspace 相对路径：Runner 会把它拼进一次性 workspace（`report/parse.ts`
 * 的 `matchReportFiles`），绝对路径与 `..` 都能跑出那个目录。与 `ciTasks.ts` 的
 * `validatePathList` 同一组判据，只是这里发现越界时**当作没解析到**而不是报错——命令行
 * 里写绝对路径不是配置错误，只是平台没法据此渲染报告。
 */
function isUsableDir(dir: string): boolean {
  if (!dir) return false;
  if (dir.startsWith("/") || dir.startsWith("\\")) return false;
  if (dir.split(/[/\\]/).includes("..")) return false;
  return true;
}

/** 去掉包裹的引号：`--alluredir="my results"` 在 shell 里是一个词，引号不属于路径。 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/*
 * 三个模式按优先级排列。`--alluredir` 的两种写法先于环境变量：命令行参数会覆盖
 * `ALLURE_RESULTS_DIR`，pytest 的行为如此，解析顺序跟着它。
 *
 * `[^\s;&|]+` 而不是 `\S+`：`pytest --alluredir=out && echo done` 里的目录是 `out`，
 * 不是 `out`+后面整串。分隔符只列 shell 里真正终止一个词的那几个。
 */
const PATTERNS = [
  /--alluredir[=\s]+("[^"]+"|'[^']+'|[^\s;&|]+)/,
  /\bALLURE_RESULTS_DIR=("[^"]+"|'[^']+'|[^\s;&|]+)/,
];

/**
 * 返回解析到的 allure 结果目录，或 `null`。
 *
 * 调用方有两处，语义不同但共用这一个函数：任务保存时用它决定要不要提示（`ciTasks.ts`），
 * claim 组装 JobSpec 时用它填 `report.paths`（`jobSpec.ts`）。同一段命令在两处必须解析
 * 出同一个答案，所以它不能是前端的一段正则——前端只负责把同样的提示提前显示出来。
 */
export function parseAllureDir(steps: string): string | null {
  if (typeof steps !== "string" || !steps.trim()) return null;
  for (const pattern of PATTERNS) {
    const matched = steps.match(pattern);
    if (!matched) continue;
    const dir = unquote(matched[1] ?? "");
    if (isUsableDir(dir)) return dir;
  }
  return null;
}
