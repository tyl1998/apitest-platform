# 助手 provider 编辑面板：删除会话配置误放进「停止」步骤 — 问题记录

日期：2026-09-28

## 现象

系统管理 → 助手 provider → 新增/编辑 provider 时，分步编辑器的第 4 步「停止」（后置接口·可选）里，除了停止生成的接口配置，还挤进了「定义删除会话接口」的勾选与 method/path 表单，两类后置接口混在同一步，语义与调用链位置都不对。

## 根因

`AssistantProvidersPanel.tsx` 的分步编辑器 `steps` 只定义了 6 步（basic / create / chat / stop / history / userParams），删除会话这一后置接口从未独立成步，`hasDelete` / `deleteMethod` / `deletePath` 三组草稿字段的 JSX 直接写在 `step === 3`（停止）的片段末尾。步骤标题、描述与提示词也都没有「删除」这一档。

## 修法

把删除会话从「停止」步骤里拆出，独立成「删除会话」步骤：

- `steps` 数组在 `stop` 与 `history` 之间插入 `{ key: "delete", optional: true }`，共 7 步。
- 原 `step === 3` 只保留停止接口；删除接口的勾选 + method/path 移到新的 `step === 4`；历史改 `step === 5`、用户参数改 `step === 6`。
- 顶部编辑器注释的步骤链同步为「停止 → 删除 → 历史」。
- i18n 补 `providerStep.delete` 与 `providerStep.deleteDesc`（中英各一条，`providerStep.hint.deletePath` 复用已有关键词）。

提交载荷 `buildInput` 与草稿 `toDraft` 里 `hasDelete/delete*` 的读写逻辑不变，仅位置调整。

涉及文件：`apitest-web/src/components/AssistantProvidersPanel.tsx`、`apitest-web/src/i18n.ts`。

## 状态

已修（代码改动完成，未做自测；待用户手动验收）。
