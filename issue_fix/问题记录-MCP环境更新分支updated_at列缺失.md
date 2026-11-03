# 问题记录：upsert_environment 更新分支引用不存在的 updated_at 列

- 日期：2026-09-09
- 状态：已修（代码落地，实测待用户在智能体平台侧执行）
- 发现方式：为「环境变量、公共脚本增删改查」扩界 MCP 工具时做前置探查（`information_schema.columns` + 直连复现）

## 现象

`upsert_environment`（`lib/mcpToolsWriteCore.ts`）的环境**更新**分支（同名环境已存在、
合并写入普通变量）一执行即报错：

```
ERROR:  column "updated_at" of relation "environments" does not exist
```

即：任何一次「已存在环境的变量替换」都 500；只有**首次创建**分支可用。

## 根因

UPDATE 语句写了 `updated_at = now()`，但 `environments` 表从头到尾没有
`updated_at` 列——迁移 `001_p0_schema.sql` 建表没加，`027`（runner_label）、
`030`（default_headers）两笔 `ALTER` 也没加。写这行 SQL 时大概率是对着
endpoints/scripts 等表（它们在 `003`/`011` 里加了 `updated_at`）的肌肉记忆，
没有对着迁移文件核对。`pnpm check` 不查 SQL 列名，落库前的任何静态检查都拦不住。

## 修法

删除该 SET 子句（`mcpToolsWriteCore.ts` 的 UPDATE 分支）：变量替换语义本身
不依赖时间戳，表上也没有任何读者在读它。不补列：为了一个没有读者的时间戳
加一列 + 一笔迁移，不如把写错的那半行删掉。

复现证据（修前直连执行）：

```sql
-- SELECT column_name FROM information_schema.columns WHERE table_name='environments';
-- id, project_id, name, variables, secrets, runner_label, default_headers  ← 无 updated_at
UPDATE environments SET variables = variables, updated_at = now() WHERE ...;  -- ERROR 如上
```

## 状态

已修（同批扩界工作内顺手修复，代码见
`apitest-server/src/lib/mcpToolsWriteCore.ts` UPDATE 分支注释「㉙」标记）。
按 AGENTS.md 纪律不重启服务，实测待用户执行。
