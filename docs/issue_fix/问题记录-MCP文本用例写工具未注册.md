# 问题记录：文本用例写工具（含 create_spec_module）定义但未注册进 MCP

- 日期：2026-10-08
- 状态：已修（代码落地；未重启服务，实测待用户在智能体平台侧执行）
- 发现方式：用户问「是否提供增加 case 目录 / 文本 case 入参是否齐全」，核对 MCP 注册表时发现

## 现象

外部 agent 经 `/mcp` 调用时：

- `tools/list` 里只有读侧文本用例工具：`list_spec_cases`、`get_spec_case`、`list_spec_modules`。
- 写侧 4 个工具全部不可见、调用即 `-32601`：`create_spec_case`、`update_spec_case`、
  `delete_spec_case`、`create_spec_module`。
- 于是「往某个目录建文本用例」这一步断了：`create_spec_case` 必填 `moduleId`，而建目录的
  `create_spec_module` 也调不到，agent 无法新建目录，也不知道该把 case 放进哪一个目录。

## 根因

`WRITE_SPEC_TOOLS` 在 `apitest-server/src/lib/mcpToolsSpec.ts:162` 定义并导出，但
`apitest-server/src/lib/mcpServer.ts` 的 `MCP_TOOLS` 只 spread 了 `READ_SPEC_TOOLS`，
**从未 spread `WRITE_SPEC_TOOLS`**（也没有对应 import）。全仓库搜 `WRITE_SPEC_TOOLS`
只命中的是定义本身，编译产物 `dist/lib/mcpServer.js:22` 同样缺席——是重构时漏掉的一行，
写了却未注册的死代码。

工具数是量化证据：各 `mcpTools*.ts` 的 `name:` 合计 **59** 条，与 `mcpServer.ts` 头部
注释「P12-1 上限 57 → 59」一致；但实际注册进 `MCP_TOOLS` 的只有 **55** 条，正好差
`WRITE_SPEC_TOOLS` 的 4 条。此前的 `DEVELOPMENT_PLAN.md`（P5-7 行）也写明
`mcpServer.ts` 应注册 `READ_SPEC_TOOLS`/`WRITE_SPEC_TOOLS`/`WRITE_EXTRA_TOOLS`，三方对不上。

## 修法

`apitest-server/src/lib/mcpServer.ts`：

1. import 行补 `WRITE_SPEC_TOOLS`；
2. `MCP_TOOLS` 的写侧 spread 补 `...WRITE_SPEC_TOOLS`（落在 `WRITE_CRUD_TOOLS` 与
   `WRITE_EXTRA_TOOLS` 之间）。

注册后 59 条全部可经 scope 裁剪下发，`create_spec_module`（建目录）与
`create_spec_case`（建用例）恢复可达。

## 顺带核对：create_spec_case 入参是否齐全

结论：**与 REST 面等价，齐全**。入参 schema（`mcpToolsSpec.ts:167`）与
`routes/specCases.ts` 手工建（POST `/spec-cases`）逐字同源，校验都走提取后的
`lib/validateSpecCase.ts`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `projectId` | 是（注册包装自动注入） | 目标项目，须在 Token 绑定集内 |
| `moduleId` | 是 | 用例所属目录，须属本项目 |
| `title` | 是 | 标题（trim 后非空） |
| `preconditions` | 否 | 前提条件，默认空串 |
| `steps` | 否 | `[{step, expected}]`，两列全空行归一丢弃 |
| `priority` | 否 | P0–P3，默认 P2 |
| `tags` | 否 | 字符串数组，trim + 去空 |
| `status` | 否 | unreviewed（默认）/ reviewed / deprecated |

`item_key`（TC-###）服务端生成、`source` 固定 `'manual'`、`created_by` 取自身份，
均不作为入参——与 REST 一致。

## 状态

已修（`apitest-server/src/lib/mcpServer.ts` 两行）。按 AGENTS.md 纪律不重启服务，
实测待用户执行；用户级 ToolAnnotations 已随该目录既有注册裁剪生效（`create_spec_module`
为 write 档，非 delete_*，`destructiveHint:false`）。
