# 问题记录 — P2-7 数据源适配器增量（MySQL / SQL Server / Oracle / MongoDB / Redis）

对应开发计划 5.0.10（P2-7.1–P2-7.4）。本轮为代码走查发现的缺陷，未经运行验证；
下表「已修」指代码已改且两端 `tsc` 通过，功能验收仍待联调。

## 一、阻塞级缺陷

### 1. mongo/redis 命名定义一条都存不进库

- **现象**：新建或更新 `kind = 'mongo' | 'redis'` 的命名定义，Postgres 报
  `23502 null value in column "statement_type" of relation "sql_definitions"
  violates not-null constraint`。
- **根因**：`016_p2_data_sources.sql` 建表时 `statement_type TEXT NOT NULL` /
  `sql TEXT NOT NULL`；`024_p27_data_source_adapters.sql` 只加了 `kind` 与
  `operation` 两列并放宽了 `data_sources.type` 的 CHECK，**没有解除这两个 NOT NULL**。
  而 `routes/dataSources.ts` 的 POST 对非 sql 定义写 `null`，PUT 用
  `CASE WHEN $3 = 'sql' THEN … ELSE NULL END` 主动置 NULL。
- **修法**：新增 `025_p27_definition_shape.sql`：两列 `DROP NOT NULL`，并补一条
  `sql_definitions_kind_shape_check`——`kind='sql'` 必须有 statement_type + sql
  且 operation 为空，`kind<>'sql'` 反之。形状交给数据库兜住，而不是只靠路由分支。
- **状态**：已修。

### 2. 所有 Redis 操作必然失败：非 lazy 客户端上又显式 connect 了一次

- **现象**：任何 Redis 操作（含连接测试）报 `Redis is already connecting/connected`。
- **根因**：`adapters/redis.ts` 建客户端时 `lazyConnect: false`，随后又
  `await client.connect()`。ioredis 构造函数在非 lazy 时已自行调用
  `this.connect()`（`built/Redis.js:89-94`），`_connect` 在状态为
  `connecting|connect|ready` 时直接 reject（`built/Redis.js:123-129`）。
- **修法**：改为 `lazyConnect: true`，保留显式 `connect()`，让连接失败集中在一处冒出。
- **状态**：已修。

### 3. Redis 连接测试永远过不了：PING 不在白名单

- **现象**：Redis 数据源点「测试连接」返回 `redis command "PING" is not allowed`。
- **根因**：探活复用了操作执行路径发 `{ op: "command", command: "PING" }`，但
  `COMMAND_WHITELIST` 里没有 `PING`。
- **修法**：把 `PING` 加进白名单——探活与用户操作共用同一道闸门，不给探活开后门。
- **状态**：已修。

### 4. `pnpm check` / `pnpm build` 失败

- **现象**：后端类型检查报 TS7016（`mssql` / `oracledb` 找不到声明文件），另有 7 处
  其它类型错误。`tsx` 不做类型检查，所以 `pnpm dev` 一直是通的，问题只在构建时暴露。
- **根因**：
  1. `mssql@12` 与 `oracledb@7` 都不自带 `.d.ts`，而 `@types/mssql` /
     `@types/oracledb` 没进 devDependencies；`skipLibCheck` 对「缺声明」无效。
  2. `lib/sqlExecutor.ts` 把 `../models/types.js` 写成了 `./models/types.js`。
     因为是 `import type`，运行时被完全擦除，只有 `tsc` 会抓到。
  3. `mongo.ts` 把用户 JSON 的 `sort` / `pipeline` 直接喂给驱动，未在边界处转换类型。
  4. `flowRun.ts` 的 `inferred` 从内联表达式提成独立常量后，`type` 被推宽成 `string`。
  5. `resolveRun` 返回隐式联合类型，不是判别联合，`definition.kind === "sql"` 之后
     无法把 `kind` 收窄成 `"mongo" | "redis"`。
  6. 前端：Monaco 的 `onChange` 回调是 `string | undefined`；`statementType` 转可选后
     两处副标题把它当 `string` 用。
- **修法**：补两个 `@types/*`；修正 import 路径；`mongo.ts` 在驱动边界显式转型并补注释；
  `inferred` 加 `SqlParameterDefinition[]` 标注；给 `resolveRun` 显式判别联合返回类型
  （顺带去掉两处 `!`）；前端补 `?? ""` / `?? "—"` 与 `Select<string>` 泛型。
- **状态**：已修，前后端 `tsc` 均通过。

### 5. 流程数据库节点引用 mongo/redis 命名定义会被自己的校验拒掉

- **现象**：流程里给数据库节点选一条 mongo/redis 命名定义，保存或单节点试跑返回 400
  `node: choose exactly one of sqlDefinitionId, inline sql or an operation`。
- **根因**：两处叠加。
  1. 前端 `FlowNodeDrawer.selectDefinition` 在 `definition.kind !== "sql"` 时**同时**
     写了 `sqlDefinitionId` 和 `operation`，而 `validateNode` 要求三种模式恰好命中一个。
  2. 即便只写 `sqlDefinitionId`，`validateNode` 的 else 分支仍无条件要求
     `statementType` 是 query/command——mongo/redis 定义根本没有这个字段。
- **修法**：
  - 前端只写 `sqlDefinitionId`（并清掉 `statementType`）；operation 由入队时
    `prepareFlowNodes` 回读定义，编辑器里的 JSON 文本降级为纯本地预览状态。
  - `flow.ts`：`statementType` 只在**内联 SQL** 模式必填；命名定义模式交给入队校验。
  - `flowRun.ts`：sql 定义只在节点确实带了 `statementType` 时才校验是否一致，并以定义的
    值为准；mongo/redis 定义显式把 `statementType` 清成 `undefined`，避免快照里留下一个
    「只读」的假承诺。
- **状态**：已修。

## 二、第二轮修复（走查第 6–14 项）

### 6. SQL Server 上带 `ORDER BY` 或 `WITH` 的查询必挂

- **现象**：SQL Server 数据源执行 `SELECT … ORDER BY …` 报错 1033
  「The ORDER BY clause is invalid in views, inline functions, derived tables…」；
  带 CTE 的 `WITH … SELECT …` 直接语法错误。
- **根因**：行数上限用 `SELECT TOP (n+1) * FROM (<用户 SQL>) AS apitest_result` 实现。
  SQL Server 的派生表里不允许裸 `ORDER BY`，也**完全不允许** CTE——而
  `skeleton.ts` 的 `validateStatement` 明确把 `WITH` 当合法 query 放行。PG 与
  MySQL 8 两种写法都接受，所以这是 SQL Server 独有的。
- **修法**：不再包装语句，改为在同一事务里先执行 `SET ROWCOUNT n+1`。`maxRows` 是
  代码侧生成并 clamp 过的整数，不是用户文本；连接执行完即销毁，无需复位。
- **状态**：已修。

### 7. `HGETALL` 拿不到 hash

- **现象**：Redis 的 `HGETALL` 返回交错的 `{value:"字段"} / {value:"值"}` 行，而不是
  键值对；`normalizeResult` 里处理对象的分支是死代码。
- **根因**：ioredis 的 reply transformer 注册在**小写**命令名下
  （`Command.js:433` 注册 `hgetall`），而 `call()` 按传入的名字原样查表
  （`Command.js:189` + 构造函数 `this.name = name`）。代码为了过白名单先
  `toUpperCase()`，然后把大写名传给了 `call()`，transformer 静默失效。
- **修法**：白名单校验仍用大写，`call()` 传小写。
- **状态**：已修。

### 8. mongo/redis 没有读写隔离

- **现象**：`aggregate` 的 pipeline 完全不校验，`$out` / `$merge` 可从一个名义上
  「读」的操作覆盖整个集合；`$where` / `$function` / `$accumulator` 可执行服务端 JS。
- **根因**：SQL 侧的只读保证来自 `statementType` + `BEGIN READ ONLY` + 首词校验，
  操作侧一个对等机制都没有。
- **修法**：`operations.ts` 新增 `findForbiddenOperator`，深度扫描文档的**键**，
  拒绝 `$where` / `$function` / `$accumulator` / `$out` / `$merge`。
  **扫两遍**：`validateOperation` 在定义时扫一次，`mongo.ts` 在 `{{name}}` 解析**之后**
  再扫一次——因为 `json` 类型参数能整体替换成一个对象，把操作符绕过定义时校验。
  这与 `skeleton.validateStatement` 的分工一致（定义时超集校验，适配器的精确方言校验
  才是权威边界）。
- **状态**：已修。

### 9. Oracle 丢掉 `connectTimeoutMs`

- **根因**：`getConnection` 只传了 user / password / connectString。
- **修法**：补 `connectTimeout`。注意它的单位是**秒**（其余适配器一律按毫秒预算），
  且向上取整，避免亚秒配置被截成 `0` = 「不超时」。
- **状态**：已修。

### 10. mongo 超时只覆盖 `find` / `aggregate` / `count`

- **修法**：`distinct` 与全部写操作补 `maxTimeMS`（这些 options 都继承
  `CommandOperationOptions`，已核对 `mongodb.d.ts`）。
- **状态**：已修。

### 11. `validateOperation` 不校验必填载荷

- **现象**：`updateOne` 缺 `filter`/`update`、`insertOne` 缺 `document` 都能存下来，
  到驱动里才炸出难懂的错；Redis 命令也不在保存时查白名单。
- **修法**：按 op 补必填校验（`insertMany` 要求非空对象数组，`update*`/`replaceOne`/
  `delete*` 要求 filter 及各自的载荷是对象，`distinct` 要求非空 field）；
  Redis 命令白名单从 `redis.ts` 挪到 `operations.ts` 由定义时与驱动共用，保存时即校验。
- **状态**：已修。

### 12. `kind` 从不与数据源类型交叉校验

- **现象**：可以在 PostgreSQL 数据源上建 `kind: "mongo"` 的定义；错配只会以
  `redis command "UNDEFINED" is not allowed` 之类的形式在执行期冒出来。
- **根因**：`inferOperationKind` 靠文档形状猜 kind，而 `executeOperation` 实际按
  `source.type` 派发，`OperationExecutionInput.kind` 是个没人读的死字段。
- **修法**：`models/types.ts` 新增 `definitionKind(type)`（与 `defaultPort` 同类的
  按类型事实），路由层新增 `definitionKindFor`（只查 type，不解密密码），在
  **POST / PUT / 内联试跑**三处都比对一次，错配返回 400。
- **状态**：已修。

### 13. 四个新驱动在启动时全量加载

- **现象**：纯 PG 项目的 API 与 worker 也会把 `mongodb` / `mssql` / `oracledb` 载进来；
  任一加载失败会在启动时拖垮整个进程。
- **修法**：`adapters/index.ts` 的注册表改成 `Partial<Record<DataSourceType, () => Promise<…>>>`
  的动态 `import()` 加载器 + 结果 memo；`getAdapter` / `getOperationDriver` 变 async
  （两个调用方本来就是 async）。`isSupportedDataSourceType` 保持同步——回答「这个类型
  存在吗」不该触发驱动加载。原先用 `adapter.type` 做 map key 天然保证了键与驱动自述
  类型一致，改成手写键后补了 `assertType` 断言把这条保证捡回来。
- **状态**：已修。

### 14. mongo/redis 节点的操作编辑器开局是空的

- **根因**：模板判定依赖 `isOperationSource`，而它来自更晚一个 effect 异步加载的
  `dataSources`；但那个 effect 的依赖数组只有 `[node.id]`，永不重算。首次打开时
  `dataSources` 还是 `[]`，于是文本被设成 `""`。
- **修法**：把 effect 拆成两个，操作文本那一个把 `isOperationSource` 与
  `selectedSource?.type` 列进依赖。打字不会触发重算（`node.operation` 不在依赖里），
  所以不会和用户输入抢状态。
- **状态**：已修。

## 三、第三轮修复（用户实测反馈）

### 17. 无认证的 Redis 存不下来：`username` 被无条件要求

- **现象**：Redis 数据源填了主机、端口、库序号，不填账号密码，保存报「必填项未填写」。
  实际 Redis 常态就是无认证。
- **根因**：必填规则是全类型共享的一条，且**前后端各拦一次**：
  1. 后端 `validateConfig` 无条件 `if (!config.username?.trim()) return "config.username is required"`；
  2. 前端 `DataSourceList.save()` 的 `!config.database.trim() || !config.username.trim()`。
  P2-7 加了四个新类型、并把 mongodb/redis 的默认 username 设成 `""`，却没同步放宽这条
  共享校验——等于这两个类型开箱即挂。用户先撞到的是前端那道，所以报的是「必填项」而不是
  后端的字段名。
- **修法**：必填项改成按类型决定。后端新增 `requiredConfigFields(type)`：
  - Redis：`database` 与 `username` 都可选——6.0 ACL 之前 Redis 根本没有用户名概念，
    且 `database` 只是个库序号（缺省 0）；
  - MongoDB：`username` 可选（无认证 dev 集群常见），但仍需库名才能定位集合；
  - 四个关系库：保持 host + database + username 全必填。

  前端 `save()` 用同一份规则（注释里点明必须与后端 `requiredConfigFields` 一致），
  并把 Redis 的库序号、Redis/Mongo 的用户名在表单上标成「（可选）」+ 占位提示，
  否则用户仍会以为必填。
- **附带修掉两处**：
  1. `cleanConfig` 的 `merged.database.trim()` / `merged.username.trim()`——字段可选后
     请求体可以合法地不带它们，`.trim()` 会抛 TypeError 变成 500，已改 `?? ""`；
  2. Redis 的 `database` 若填了非数字，驱动的 `Number(database) || 0` 会静默连到 0 号库，
     现在校验它必须是库序号。
- **状态**：已修。

### 18. 数据源列表里过长的用户名压到 SSL 列上

- **根因**：`.data-source-grid` 是 `table-layout: fixed`，只给了 `.col-actions` 宽度；
  定宽表格不会为超长内容加宽列，而基础样式 `.grid td` 又不做裁剪，于是超出部分直接
  画到相邻单元格上。
- **修法**：SSL 列收窄到 68px（只放是/否），把宽度让给主机/数据库/用户名；三个 mono
  单元格补 `overflow:hidden + text-overflow:ellipsis`，并挂 `title` —— 定宽列里悬停
  是读全内容的唯一途径。

### 19. 操作定义下拉框保存后重新打开不显示已选项

- **根因**：那个 `Select` 是非受控的（`value` 没传，或传 `undefined`），选项的 `value`
  还是整段模板 JSON。重新打开抽屉时组件重新挂载，内部状态清空，只剩占位符——
  而它在表单里占的是 SQL 的「语句类型」那个位置，用户理应能看出这条定义是哪种操作。
- **修法**：选项的 `value` 改成操作标签（Redis 用命令名，Mongo 用 `op`），并把下拉框
  改成受控：值由编辑器文本实时反解（`operationLabelFromText`），所以手改 JSON 也会同步。
  手写了模板列表以外的命令时 antd 会把该值本身显示出来，正好是想要的效果。
  字段标签同步改为「操作类型」，不再和编辑器上方的「操作定义」标题重名。

### 20. 操作编辑器的默认内容是压缩成一行的

- **根因**：模板以单行 JSON **字符串**字面量保存，选中后原样塞进编辑器；只有读取已保存
  定义的那条路径走了 `JSON.stringify(op, null, 2)`，所以「打开是压缩的、存过再开是格式化的」。
- **修法**：新增 `src/operationTemplates.ts`，模板以**对象**保存，进编辑器前统一过
  `formatOperation`（缩进 2 空格）。同时这是唯一一份模板——原先
  `DataSourceDetail` 与 `FlowNodeDrawer` 各存一份且内容已经不一致（节点侧少 2 条），
  合并后两处可选操作一致，Redis 从 5 条补到 10 条。

### 21. Redis 命令参数个数错误只能等到执行期报，且报不出要几个

- **现象**：把 GET 模板的命令改成 `LRANGE`、忘了补 range 参数，保存能过，执行才报
  Redis 原生的 `ERR wrong number of arguments for 'lrange' command`——不说要几个。
- **根因**：白名单只校验命令名，不校验 arity。而「改命令、忘改 args」正是这个编辑器里
  最容易犯的错：下拉框换模板会整段替换，手改命令名却只动一行。
- **修法**：白名单从 `Set<string>` 换成 `Record<string, [min, max|null]>`
  （`null` 表示可变参，如 `SET k v EX 60`、`DEL k1 k2`），并抽出唯一入口
  `validateRedisCommand(command, argCount)`：`validateOperation` 在保存时用它，
  驱动在**开 socket 之前**用**解析后**的 args 个数再用一次。
  报错改成 `redis LRANGE takes 3 arguments, got 1`。
- **验证**：已对 9 组用例逐条核对（含 `HGETALL` 多给参数、`SET` 可变参、`KEYS` 非白名单、
  缺 `args`），报错文案与预期一致。
- **状态**：已修。

### 22. WRONGTYPE：命令与键类型不匹配（非缺陷）

- **现象**：`WRONGTYPE Operation against a key holding the wrong kind of value`。
- **判定**：这是 Redis 对「命令用在了错类型的键上」的正常回应，不是平台缺陷。
  典型诱因是换了命令但 `key` 参数的默认值没跟着换——`HGETALL` 指向 string 键、
  或 `LRANGE` 指向 hash 键。
- **不做静态校验的理由**：键的类型是运行期事实，定义时无从得知；真要提示只能在
  出错后补一次 `TYPE key` 往返，属于用错误路径换信息量，暂不引入。

## 四、复核后判定不改


| # | 项 | 判定 |
| --- | --- | --- |
| 15 | 译文里写 `{{参数名}}` 与 i18next 插值语法冲突 | **撤回**。仓库里 `flows.extractsHint`、`flows.scriptNodeHint`、`flows.conditionHint`、`flows.subflowInputsHint`、`endpoints.urlHint`、`editor.variableHint`、`editor.textModePlaceholder` 等七处既有译文都直接写 `{{变量名}}` / `{{token}}`，依赖 i18next 的 `skipOnVariables`（v21+ 默认 true）是本项目的既有约定。新增两条只是沿用；单独给它们换一套转义写法会引入第二种模式，违背「不要在既有约定旁边另起一套」。 |
| 16 | mongo 节点切回关系库后是 0 模式非法态 | **不改**。`FlowWorkspace` 新建数据库节点本来就是 `sql: ""`，同样落在 0 模式，需要用户敲字才合法。这不是本次改动引入的回归，而是既有交互；要改得动 `validateNode` 的接受语义，收益不抵风险。 |

## 五、顺手修掉的相邻问题


- `mongo.ts` 的 `find`：`"limit": 0` 会关掉取数上限（MongoDB 的 `limit(0)` 语义是
  「不限制」），整个集合会先进内存再被 `truncateRows` 砍。已 clamp 到正数。
- `routes/dataSources.ts` 的 PUT：切换 `kind` 时若不带新 kind 的载荷，原先会
  (a) mongo→sql 方向把 `undefined` 喂进 `validateSqlDefinition` 抛 TypeError 变 500，
  (b) sql→mongo 方向撞上迁移 025 的 CHECK 变 500。已改为明确的 400。
- 流程画布与循环体副标题对 mongo/redis 节点显示 `undefined`（`statementType` 转可选的
  连带影响），已改为显示「操作」。

## 六、迁移遗留（不追改）

- `024_p27_data_source_adapters.sql` 不幂等：`DROP CONSTRAINT` 无 `IF EXISTS`、
  `ADD CONSTRAINT` 无守卫，与迁移约定不符。已 applied，按 forward-only 不动；`025`
  用的是 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` 的幂等写法。
- 迁移编号跳过 `023`，纯观感问题，按文件名顺序执行不受影响。
