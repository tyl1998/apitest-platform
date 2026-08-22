/* P2-7 修复：mongo/redis 命名定义只带 `operation`，`statement_type` / `sql` 必须可空。

   024 给 sql_definitions 加了 kind + operation，但 016 建表时写的
   `statement_type TEXT NOT NULL` / `sql TEXT NOT NULL` 还在，于是路由层为
   kind <> 'sql' 写入的 NULL 一律被 23502 挡回来——mongo/redis 定义一条都存不进去。 */
ALTER TABLE sql_definitions ALTER COLUMN statement_type DROP NOT NULL;
ALTER TABLE sql_definitions ALTER COLUMN sql DROP NOT NULL;

/* 形状由数据库兜住，而不是只靠路由层的分支：kind='sql' 必须有 statement_type + sql
   且不带 operation，mongo/redis 反过来。少了这条约束，任何一条漏判的写路径都会留下
   「既没有 SQL 也没有 operation」的定义，而它只会在执行时才炸。 */
ALTER TABLE sql_definitions DROP CONSTRAINT IF EXISTS sql_definitions_kind_shape_check;
ALTER TABLE sql_definitions ADD CONSTRAINT sql_definitions_kind_shape_check CHECK (
  (kind = 'sql' AND statement_type IS NOT NULL AND sql IS NOT NULL AND operation IS NULL)
  OR (kind <> 'sql' AND statement_type IS NULL AND sql IS NULL AND operation IS NOT NULL)
);
