/*
 * P10-6（计划 14.3）：版本历史扩面 —— 把统一版本模型（迁移 067 的 `asset_versions`）覆盖
 * 面从 4 类扩到 11 类。本迁移**只动 CHECK 约束枚举**，不动表结构（067 头就预告了「后排
 * 流程/套件时只加枚举值，不动表结构」）。
 *
 * 新增 7 类用户编写型内容资产：Mock / 脚本 / 流程 / 套件 / 数据源 / SQL 定义 / 仓库任务。
 * 它们和接口/用例同属「用户编写、值得看改了什么 + 回滚」的内容资产，复用同一张表、同一套
 * 服务端 diff、通用读侧路由、通用回滚分派与前端通用抽屉（P10-4/P10-5 已铺好的地基）。
 *
 * ── forward-only：为什么是新文件而不是改 067 ──────────────────────────────
 *
 * 067 已经 applied，`schema_migrations` 有它的行 —— 改它不会再跑到任何现有库（server-contract
 * 「Forward-only」）。故 CHECK 的扩枚举必须走新文件。Postgres 不能「就地扩」一个 CHECK，只能
 * 先 DROP 再 ADD；两步都幂等（DROP ... IF EXISTS / 用固定约束名重建）。
 *
 * 约束名沿用建表时的隐式命名 `asset_versions_asset_type_check`（067 里 CHECK 写在列上，Postgres
 * 按 `<表>_<列>_check` 生成）。这里显式点名它以便 DROP，再用同名重建，让后续迁移仍可预期名字。
 */

ALTER TABLE asset_versions DROP CONSTRAINT IF EXISTS asset_versions_asset_type_check;

ALTER TABLE asset_versions ADD CONSTRAINT asset_versions_asset_type_check
  CHECK (asset_type IN (
    'endpoint', 'test_case', 'spec_case', 'environment',
    'mock', 'script', 'flow', 'test_suite', 'data_source', 'sql_definition', 'ci_task'
  ));
