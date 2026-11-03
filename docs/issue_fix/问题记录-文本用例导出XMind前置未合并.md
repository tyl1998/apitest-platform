# 问题记录：文本用例导出 XMind 时多条前置被拆成多个分支

- 日期：2026-10-09
- 状态：已修（代码落地；未重启服务，实测待用户执行）
- 发现方式：用户实测反馈

## 现象

文本用例（平台 spec case）的前置条件有多条时，导出 `.xmind` 后每条前置各占一个
`pc：` 子分支，脑图上是一排平级节点：

```
tc：xxx
├─ pc：1. xxx
├─ pc：2. xxx
├─ 步骤…
```

期望是**合并成一个子分支**，在一个主题里按行展示：

```
tc：xxx
├─ pc：
│   1. xxx
│   2. xxx
├─ 步骤…
```

## 根因

`apitest-server/src/lib/xmindWriter.ts` 的 `caseTopic()`：前置条件按 `\n` 拆行后，
每一行各生成一个 `topic(\`pc：${line}\`)`——多条前置 = 多个 `pc：` 子主题。
（该形态是 2026-09-08 为「回导闭环精确还原」落定的，导入侧 `splitCaseSubtree()`
把所有 `pc：` 子节点正文 `join("\n")`，拆多个与合一个都能还原；这次按用户口径
改为合成一个分支。）

## 修法

`apitest-server/src/lib/xmindWriter.ts` `caseTopic()`：先拆出非空前置行，再生成
**单个** `pc：` 子节点，标题为 `pc：\n` + 各行 `\n` 拼接。导入侧不变——其
`PRECONDITION_PREFIX_RE` 剥掉 `pc：` 前缀后，正文本身就带换行，`join("\n")`
逐字还原，回导闭环保持。

配套（口径同步，非行为改动）：

- `xmindWriter.ts` 头注释字段映射表 + `xmind.ts` 归一层注释：前置形态由
  「多行拆多个」改为「单个 pc 子节点，正文按行折行」。
- `buildXmindTemplate()` 用例二的 pc 改为多行形态，演示该约定。
- `DEVELOPMENT_PLAN_P6-P14.md` 11.x XMind 导出口径行同步。

## 状态

已修（仅 `xmindWriter.ts` 一处逻辑改动）。按 AGENTS.md 不重启服务，实测待用户
重新导出 XMind 后确认。
