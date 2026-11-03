# P2-1 数据源闭环 — 问题记录

> 记录 P2-0/P2-1（执行索引/步骤、PostgreSQL 数据源、命名 SQL、流程数据库节点）实现与
> 联调期间发现的实际缺陷。仅收录 bug 本身：现象、根因、修法、状态。
> 按发现顺序排列。

---

## #1 数据源页面报错「relation "data_sources" does not exist」

**发现阶段**：联调（进入数据源列表 / 保存数据源）。

**现象**：进入数据源列表提示「加载数据源失败」；保存数据源报 `relation "data_sources" does not exist`。
API 日志为 `500 DatabaseError code 42P01`，栈指向 `routes/dataSources.ts`。

**根因**：新增迁移 `015_p2_execution_index.sql`、`016_p2_data_sources.sql` 只落入代码仓库，
运行中的数据库从未应用。`tsx watch` 只重载服务代码，不自动执行迁移，因此 `data_sources`、
`sql_definitions`、`execution_index`、`execution_steps` 实际不存在。

**修法**：在 `apitest-server` 执行 `pnpm migrate`，应用 `015`、`016`。

**状态**：已修复

---

## #2 连接测试实际成功却提示失败

**发现阶段**：联调（点击「测试连接」）。

**现象**：后端日志显示连接测试返回 `200`，但界面提示「测试连接失败」。

**根因**：前后端契约不一致。后端 `/data-sources/:id/test` 返回 SQL 执行结果
`{ rows, rowCount, truncated, durationMs }`，前端 `DataSourceTestResult` 却声明为
`{ ok, durationMs, error? }` 并判断 `result.ok`。后端响应顶层没有 `ok` 字段，
导致成功结果被误判为失败。

**修法**：
- 前端 `DataSourceTestResult` 复用 `SqlExecutionResult`
- 连接测试以 HTTP 请求成功为准，不再判断不存在的 `result.ok`
- 列表页与详情页两处调用同步修改

**状态**：已修复

---

## #3 连接超时 / 查询超时显示 undefined ms

**发现阶段**：联调（数据源详情页查看配置）。

**现象**：详情页显示「连接超时 undefined ms」「查询超时 undefined ms」，且保存的
超时配置不生效。

**根因**：前后端字段命名漂移。后端首版使用 `connectionTimeoutMs / statementTimeoutMs`，
前端使用 `connectTimeoutMs / queryTimeoutMs`。前端保存的配置在后端读取不到，
旧字段名落入 JSONB，详情页读不出值。

**修法**：
- 后端统一为 `connectTimeoutMs / queryTimeoutMs`（`models/types.ts`、
  `routes/dataSources.ts`、`lib/sqlExecutor.ts`）
- 新增 `normalizeDataSourceConfig()`：读取时兼容旧字段名，缺失项补齐默认值
  （连接 5000ms、查询 30000ms、行数 1000、结果 1MiB）
- `loadDataSource` 与 `mapDataSource` 统一走归一化

**状态**：已修复

---

## #4 SQL 试运行参数契约不一致

**发现阶段**：联调（命名 SQL 试运行）。

**现象**：SQL 定义编辑器的试运行报参数错误，后端收不到前端提交的参数值。

**根因**：前端发送 `{ parameters: {...} }`，后端 `RunBody` 要求
`{ params: SqlParameterDefinition[], values: Record<string, unknown> }`；命名 SQL 试运行
`/sql-definitions/:sqlId/test` 同样只接收 `values`。字段名对不上，参数被当作未声明值。

**修法**：
- 前端 `SqlExecutionInput` 改为 `{ sql, statementType, params, values }`
- `queryDataSource` 传递 `params + values`
- `testSqlDefinition` 改发 `{ values }`

**状态**：已修复

---

## #5 本地未配置数据源加密密钥时保存报错

**发现阶段**：联调（保存带密码的数据源）。

**现象**：未配置 `DATA_SOURCE_ENCRYPTION_KEY` 时，保存数据源报
`DATA_SOURCE_ENCRYPTION_KEY is required`。

**根因**：`lib/crypto.ts` 对密钥缺失一律抛错；本地开发没有 .env 加载机制，
该环境变量从未设置。

**修法**：
- 生产环境（`NODE_ENV=production`）仍强制要求配置密钥，保持 fail-closed
- 开发环境回退为 `SHA-256(JWT_SECRET)` 派生的稳定密钥，保证本地可用且重启后仍能解密

**风险**：开发环境派生密钥依赖 `JWT_SECRET`，变更该值会导致已存密码无法解密；
生产必须显式配置 `DATA_SOURCE_ENCRYPTION_KEY` 且保持稳定。

**状态**：已修复
