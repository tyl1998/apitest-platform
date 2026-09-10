# issue_fix — Bug 修复记录索引

> 本目录集中存放平台开发期间发现的实际缺陷（bug）的修复记录，与 `DEVELOPMENT_PLAN.md`
> 分开维护：**开发计划只记录开发内容，不记录 bug 修复**；缺陷一律归档到本目录。
> 每条记录按「现象 / 根因 / 修法 / 状态」或「缺陷统计表」组织。

## 索引

| 阶段 / 主题 | 文件 | 说明 |
| --- | --- | --- |
| P1-1 接口用例 + 断言 | `P1-1_ISSUE_LOG.md` | P1-1 断言配置器收尾（JSON Schema + 自定义脚本断言、Monaco、沙箱）阶段的问题 |
| P1-1 主体实现 | `问题记录-P1-1接口用例与断言.md` | P1-1 接口用例 + 断言主体实现期间的问题（与本阶段 ISSUE_LOG 互补） |
| P1-2 Flow DAG 编排 | `P1-2_ISSUE_LOG.md` | P1-2 流程编排从首轮实现到多轮反馈修复的所有问题、根因、修法与关键取舍 |
| P1-2 体验修复 | `P1-2-体验修复记录.md` | P1-2 四轮反馈修复 + 文档整理（对应开发计划 4.0.2.1–4.0.2.4） |
| P1-3 异步执行改造 | `问题记录-P1-3异步执行改造.md` | BullMQ + Worker、SSE、取消、执行器可观测及前端体验修复 |
| P2-1 数据源闭环 | `P2-1_ISSUE_LOG.md` | P2-0/P2-1 执行索引、PostgreSQL 数据源、命名 SQL、流程数据库节点的问题 |
| P2-2 核心流程补全 | `P2-2_ISSUE_LOG.md` | P2-2 脚本节点、受控并行、条件节点、脚本智能补全等迭代期间的问题 |
| P2-2.1 收尾 | `P2-2.1_ISSUE_LOG.md` | 认证页签变量补全、项目级「明文执行记录」开关的问题 |
| P2-4 测试套件 | `P2-4_ISSUE_LOG.md` | P2-4.1 套件定义与成员选择的问题（空成员被当成非法输入、空标签 `@> '{}'` 选中全部）+ P2-4.4 走查发现的三项（单步调试的一次性父索引混进父执行列表、`pnpm check` 10 处类型错误、每页 200 条跳记录）+ P2-4.5 走查与验收发现的四项（数据源/命名定义引用扫描漏掉循环体内的数据库节点、删除后套件成员仍显示「已不存在」的一行、标签模式不自动解析成员；第三项「用例→已绑定流程同步」属新功能，记在开发计划 5.0.11） |
| P2-6 高级节点 | `P2-6_ISSUE_LOG.md` | P2-6 等待/子流程/循环节点 21 个缺陷统计 + 七轮用户反馈修正 |
| P2-7 数据源适配器 | `P2-7_ISSUE_LOG.md` | P2-7 MySQL/SQL Server/Oracle/MongoDB/Redis 走查缺陷 14 项全部已修（迁移形状、Redis 双连接与 HGETALL、SQL Server 行数包装、类型检查、命名定义节点校验、mongo 危险操作符、驱动按需加载等）+ 2 项复核后判定不改 |
| P2-8 执行分区 | `P2-8_ISSUE_LOG.md` | 队列名含 `:` 被 BullMQ 6 拒绝导致 worker 启动即崩，分隔符改为 `-` |
| 分区下拉空列表 | `问题记录-分区下拉空列表.md` | P2-8.7 分区输入框换 AutoComplete 后 `default` 仍被从候选过滤，只有 default 分区的项目（初装常态）打开必现空下拉 |
| 脚本断言契约重做 | `问题记录-脚本断言契约重做.md` | 4.0.2.5 / 4.0.2.6 `ctx.assert` 取代 `return` 期间发现的问题 |
| 脚本断言行布局重构 | `问题记录-脚本断言行布局重构.md` | 脚本断言编辑器 UI 控件合并到同一行的布局问题 |
| 接口工作台 / 环境 / 项目管理 | `问题记录-接口工作台-环境CRUD-项目管理.md` | 未保存标记、复制、环境变量 CRUD、项目管理等 |
| 环境规划与批量调试 | `问题记录-环境规划与批量调试.md` | 环境职责划分、接口批量调试、批量删除等 |
| 系统管理页标题重复 | `问题记录-系统管理页标题重复.md` | 顶部栏与正文页头标题重复 |
| worker 事务泄漏 | `问题记录-worker事务泄漏与流程保存卡死.md` | `reapStale` 漏 COMMIT 引发流程保存永久卡死、worker 掉线、回收失效 |
| tsconfig rootDir | `问题记录-tsconfig-rootDir.md` | apitest-server `rootDir` 编译报错 |
| HTTPS 企业证书不受信 | `问题记录-HTTPS企业证书不受信.md` | 平台请求内网 https 域名报 `SELF_SIGNED_CERT_IN_CHAIN`：Node 20 fetch 不读系统钥匙串，`start.sh` 注入 `NODE_EXTRA_CA_CERTS` 指向导出的企业 CA |
| P3 验收第一轮 | `问题记录-P3验收第一轮.md` | P3 验收缺陷六项全部修复并通过复验（调度页变量编辑器状态类型错误致创建白屏、运行套件乐观对象缺触发列致白屏+执行中冻结、编辑调度 TDZ 500、报告成员证据抽屉、看板调度数未接真值、套件页假脏未复现已关闭） |
| P3 验收第二轮 | `问题记录-P3验收第二轮.md` | 报告详情概览读数表头冗余、标识段单列布局挤掉首屏、面包屑缺报告详情级与错误的返回按钮、套件报告改名报告列表、接口/环境/数据源/Mock/套件成员列表五处分页补齐 |
| P3 验收第三轮 | `问题记录-P3验收第三轮.md` | 运行抽屉成员行与添加成员选择器流程 tab 分页、定时调度空态改内联「暂无数据」、定时调度与通知卡片互换、手动运行套件补变量覆盖弹窗（优先级确认：触发时的变量覆盖 > 流程 > 环境）、三处变量覆盖提示文案口径统一、变量覆盖编辑器换环境变量行样式（`VariableRowsEditor`） |
| P3 验收第四轮 | `问题记录-P3验收第四轮.md` | 环境默认头编辑器换 `VariableRowsEditor`（复制给头名）、运行弹窗抽成共享 `SuiteRunModal` 并接入套件列表行、自绘弹窗页脚按钮、变量覆盖“未生效”取证为非缺陷（成员无 `{{x}}` 引用，方法说明）、套件页补 Cmd+S/Ctrl+S 保存 |
| P3 验收第五轮 | `问题记录-P3验收第五轮.md` | 套件页白屏（第四轮 Cmd+S 的 useEffect 声明在早退之后，违反 Rules of Hooks——已移到早退前）、流程列表补服务端分页（`GET /flows` opt-in 分页 + `flowsPaged`，与接口列表同一模式）、默认头 x=2 + 覆盖 x=xxx 取证为非缺陷（值是纯文本非 {{x}} 模板，提示文案已补「固定值不会被覆盖」） |
| P4 仓库模式 SDK 首轮校验 | `问题记录-P4仓库模式SDK首轮校验.md` | 五项：① `describe()` 抛 `AttributeError: 'function' object has no attribute 'read'`（`apitrack/__init__.py` 的 `from .case import case` 把包属性 `case` 从模块遮蔽成装饰器函数，而 `plugin.py` 写的是 `from . import case`；改为直接导符号并补免 pytest 的 `FakeItem` 测试）；② 上传 TestPyPI 前不跑仓库自己的测试（新增 `test` job 并让 `build` 依赖它）；③ 修复推送后点 Re-run 导致验的仍是旧包并空转一轮（dev 版本号从 `run_number` 改为 epoch 秒、日志与 Summary 打印版本号+commit SHA+提交标题、文档写明「新建 run 而非 re-run」）；④ 三条集成测试自身写错且从未被执行过（`json.loads` 吃到 payload 之后的 pytest 摘要，改用 `raw_decode`）——顺带发现 pip 加 `--trusted-host` 即可绕过企业 CA，开发机现在能跑全部 19 条；⑤ 声明 `>=3.9` 却只在 3.11 验过（`test`/`verify` 改 3.9/3.11/3.13 matrix，classifiers 补全逐版本行） |
| P4 覆盖统计基数未去重 | `问题记录-P4覆盖统计基数未去重.md` | 仓库用例页覆盖分母按 `endpoints` **行数**计，`:id` vs `{id}`、不同 `{{host}}`、尾斜杠、import `create` 重复导入造成同行不同串 ⇒ 同一接口被数成 N 个，而匹配器只把用例挂到其中一行，覆盖率被压低。修法（读时去重，用户选定）：`coverageShapeKey`（METHOD + 占位符无名化路径）distinct 计数，分子按「同形任一行挂用例即覆盖」；树仍为行口径，dashboard 不动（边界 2） |
| SDK 参数化用例兜底名污染 | `问题记录-SDK参数化用例兜底名污染.md` | `describe()` 兜底名取 `item.name`，参数化时带 `[param]` 后缀，而 inventory 按共用 case_key 只登记一次 ⇒ 第一个参数的后缀污染整条用例名、其余场景消失。修法：兜底名取 case_key 函数名段；场景维度归 records 的 `param_id` |
| 项目管理分页补齐 | `问题记录-项目管理分页补齐.md` | `/projects` 全量渲染卡片墙无翻页器（P2-4/P3 分页补齐漏了全局层页面）。修法：`queryProjectMetrics` 可选 paging + COUNT、`GET /projects` opt-in 分页（切换器维持全量契约）、前端 `projectList` 服务端分页（URL 深链/关键字回第一页/删尾卡退页）；dashboard 聚合不分页 |
| 验收 2026-09-03：接口列表性能 / 容器档兼容 / 分享页证据 | `问题记录-验收20260903-接口列表性能与容器兼容.md` | ① 接口管理页为画「最近运行」条全量拉 200 条 `/executions`（约 254KB，随执行数线性变坏）——删掉该列，耗时/状态改由列表接口 LATERAL 随行带出；② `docker run --storage-opt size=` 在 overlay2 无 pquota 的 daemon 上必被拒（退出码 125 被当脚本失败）——两条通道撞上即去旗标重试 + 进程内降级缓存；③ 套件报告分享页成员行不可点（证据原先只有登录路由）——新增三个 token 端点按证据闭包放行，抽屉在公开页恢复 |
| 仓库用例树列宽跳动 | `问题记录-仓库用例树列宽跳动.md` | auto 布局下 colSpan 的接口行与展开的用例子行一起参与列宽分配，展开即整表跳宽；截断单元格无悬停。修法：`grid-fixed`（table-layout: fixed + colgroup 显式宽度），截断列补 title；工具类可复用 |
| 悬停提示延迟过长 | `问题记录-悬停提示延迟过长.md` | 截断单元格用原生 `title`，浏览器悬停延迟 ~1 秒且不可调。修法：`ui.tsx` 新增 `Tip`（antd Tooltip，100ms），替换树/抽屉/run 明细里的 title；其余未动 |
| P4.5 产物下载直链路由崩溃 | `问题记录-P4.5产物下载直链路由崩溃.md` | `GET /runner/artifacts/*/download` 通配符后跟字面量段，find-my-way 注册即抛错、API 启动崩溃；且 handler 用锚定结尾的正则切 `request.raw.url`（带 query string），key 恒空恒 403。修法：注册成结尾通配 `/runner/artifacts/*`，从 `params["*"]` 剥 `/download` 尾巴 |
| P4.5-13 执行详情页四处前端缺陷 | `问题记录-P4.5-13执行详情页四处前端缺陷.md` | 四处静默失效（P4.5-11 落地时体检发现）：`Tip content=` 应为 `text=`（`text` 为空即透传 children ⇒ 两处提示永不渲染）；`Empty` 缺必填 `title` 五处（tsc 能报，那轮没跑 `pnpm check`）；`status status-${x}` 应为 `data-status`（设计系统是属性选择器，状态色与呼吸动画全失效）；CSS 引用两个从未定义的 token（`--radius` 三处 → `--r`、`--rule` 三处 → `--line`，CSS 变量解析失败静默无痕） |
| 侧边栏导航视觉层级 | `问题记录-侧边栏导航视觉层级.md` | 用户走查反馈四项：分组标题间距不足（14px → 20px）、菜单项纯文字补 lucide 线框图标、选中左边条随圆角残缺改 `::before` 指示条 + hover 底色 `--raised` 在白底不可见（新增 `--hover` token）、项目标识/返回主页未与导航隔离（新增 `.sidebar-head` 分割线） |
| P4.5 仓库任务产物直传全链路失效 | `问题记录-P4.5仓库任务产物直传全链路失效.md` | `--alluredir` 任务执行成功但无报告视图/无产物，且 SDK 注入上报整体不工作。五个叠在一起的根因：`request.hostname` 剥端口 → 直传 URL 拨 80 端口 ECONNREFUSED（三处共用，含 `APITRACK_URL`）；直传路由 `parseAs:"buffer"` 把 `request.raw` 读完 → 即使通了也写 0 字节文件；fs `presignPut` 不下发 content-type → 415；终态后日志被 ACTIVE_GUARD 拒收 409 → 上传失败原因进不了 job 日志；Runner clone 刻意无 remote、平台未注入 `APITRACK_GIT_URL` → SDK 永远识别不了仓库身份 |
| P4.5 仓库模式走查五项 | `问题记录-P4.5仓库模式走查五项.md` | ① 执行详情页侧边栏高亮接口管理（`pipeline-runs` 段不在 PAGES、兜底选错，加 `SECTION_ALIASES`）；② 父执行记录「CI 执行」改名「仓库」（用户定名，触发来源留给用户管理阶段）；③ 解绑无感知（GET 仍返回 unbound 行，改为只回 active、面板落「未绑定」空态）；④ 已吊销 token 堆满列表（按 run 现签+终态吊销是既定设计，列表加 `revoked_at IS NULL`）；⑤ 任务列表看不出在途状态（列表 SQL 加 LATERAL 带出 `activeRun`/`activeRunCount`，行内状态词 + `#N` 直达 + 10s 静默轮询） |
| P4.5 仓库执行上报分支为空 | `问题记录-P4.5仓库执行上报分支为空.md` | Runner clone 是 `checkout --detach FETCH_HEAD`，workspace 无本地分支，SDK `detect_branch()` 对 detached HEAD 按设计回空串 → 永远过不了删除对账闸门二。修法：jobSpec 注入第五件 `APITRACK_BRANCH = run.git_ref`（sha 形态的 ref 不注入，报上去是假分支）；与 `APITRACK_GIT_URL` 同一条「clone 刻意不落地 git 元数据、平台也不交已知事实」的根因 |
| P4.5 SDK 在 xdist 下重复上报 | `问题记录-P4.5SDK在xdist多进程下重复上报.md` | 仓库加 pytest-xdist 后一次 run 打 5 个 `/ingest`（controller+4 worker 各自 sessionfinish 上报），各进程 seq 从 0 编号撞 `UNIQUE(ingest_run_id, seq)` 整批静默丢弃（36 用例 e2e 只剩 9 条 records），最后一批空 inventory 把 `case_total` 覆盖成 0 并触发「空 inventory 跳过对账」警告。**已修（SDK 侧，平台一字未改）**：新增 `distributed.py`，worker 经 xdist 自己的 `workeroutput` 把 cases/records/filters 交回 controller、controller `absorb` 合并后只发一次；收不到就不声明全量、一份都没收到则一个字都不发（避免空 payload 把计数覆盖成 0）；降级路径按 `gw 序号 × 1e6` 分段 seq；身份只认 `config.workerinput`（不认会被子进程继承的 `PYTEST_XDIST_WORKER`）；`pytest_testnodedown` 必须 `optionalhook=True`，否则没装 xdist 的用户 pytest 直接起不来 |
| 仓库执行详情页面包屑断头 | `问题记录-仓库执行详情页面包屑.md` | `pipeline-runs/:runId` 不在 ProjectShell 的 detail 页判定里，面包屑停在不可点的「仓库模式」上，进了执行详情回不去任务列表。修法：`pipelineRunOpen` 进 detail 判定 + run 序号经 `setDetailTitle` 上推（2026-09-02 验收反馈第 1 项，随报告体验改版批次） |
| 报告与任务列表可读性 | `问题记录-报告与任务列表可读性.md` | 2026-09-02 验收反馈第二批（开发内容见计划 8.14）里的两个真缺陷 + 一项复核不改：① 任务列表在途状态从落地起从未显示——列表查询把 LATERAL 接在 `TASK_SELECT` 后面，而那个常量的投影是 `t.*, c.name, c.method`，`ar.*` 一列都没进结果集，`activeRun` 恒 `undefined`（`t.*` 让查询不报错，列静默消失）；修法：列表路由自己的 SELECT 逐列写全。② 步骤树 caret 是装饰点不动（caret 朝向表达「有没有子步骤」而非展开态，子树无条件递归），修法：拆 `StepNode` 自持 open + 整行 `<button>`。③ 「看不到步骤日志」复核为非缺陷：平台一直会渲染步骤附件，缺席原因是任务命令带 `--allure-no-capture`（现存七个报告包附件数都是 0）——改为在报告包无附件时显式说明原因，并把测试级 log/stdout/stderr 拆成默认展开的「执行日志」块 |
| P4.5 报告体验验收第三批 | `问题记录-P4.5报告体验验收第三批.md` | 2026-09-02 验收反馈第三批（交互调整见计划 8.15）+ 2026-09-03 追加两项：① 报告附件一直「正在加载」两处根因——服务端附件引用错用展示名（`log`）取包内实体（`<uuid>-attachment.txt`）恒 404 + 前端 `AttachmentView` 的 `alive` cleanup 把在途响应丢弃且不再重发；修法：附件引用归一 `{name, source, type}` 按 source 取数、去掉 alive 旗子、`loadAttachment` useCallback 固定身份。③ 失败计数对不上——同名参数化用例被 `(run, source, suite, case_name)` 唯一键折叠（迁移 044 加 `external_id`= allure uuid）+ `error` 状态被计进跳过（改计失败）；复验时发现修复未生效的根因是 Runner 跑的 dist 未重建。④ 产物大小全 0 B——上传路由 `written` 局部量从未赋值，改读 `guard.bytesWritten`。⑥ 上报 commit 未变仍每次入库：原复核为符合设计，2026-09-03 用户改口径（数据肿胀），迁移 045 把幂等键折成按 commit 去重（同 commit 折一行，`ci_execution_count` 记执行次数，`pipeline_runs.ingest_run_id` 反查改 `(project, commit)`），旧行就地合并（16→4 行、记录 350→69 行） |
| P4.5 迁移 045 后 /ingest 全量 500 | `问题记录-P4.5迁移045后ingest全量500.md` | 045 把幂等键建成 `DEFERRABLE INITIALLY DEFERRED`，而 `/ingest` 的 `ON CONFLICT` 仲裁器必须是不可延迟唯一约束 → 045 上线后每一次上报都 500 回滚（SQLSTATE 55000），SDK 纪律把它吞成 warning，c1f4d1ba 的 5 次执行一行都没进 `ingest_runs`、run 行 `ingest_run_id` 全空。修法：迁移 048 把约束重建为 NOT DEFERRABLE；dev 库已应用并验证同形状 ON CONFLICT 语句可跑通 |
| P4.5 验收 2026-09-03 第二批 | `问题记录-P4.5验收20260903第二批.md` | 四项：① 用例树绑不到最新报告——allure-pytest 的 fullName 是 `pkg.Mod#test` 点号形态而非 nodeid，047 的匹配键形态假设不成立，LATERAL 永远匹配不上；修法两侧不回写：Runner `normalizeFullName` 归一新上报 + 服务端 LATERAL 加历史行兼容分支（dev 库实测 run 23 全部挂上树）。② 通过率口径改 passed/(passed+failed)，skipped 不进分母（error 已算失败，三层一致）；报告列表 UNION 两侧与 run 详情页三处落点。③ 任务编辑页补未保存提示（nav guard + 标题 chip）与 Cmd/Ctrl+S 快捷键保存，对齐套件编辑。④ 任务列表在途状态只在「最近执行」列展示，名字列删掉在途标签 |
| 勾选执行落库键形不匹配致全量跑 | `问题记录-勾选执行落库键形不匹配致全量跑.md` | 树上勾 N 条触发后仓库全量跑、job 日志无 `case filter` 尾段、终态无 not_run 差集：`normalizeCaseFilter` 落库 `{caseKeys}`（camel）而 JobSpec/差集对账/`mapPipelineRun` 四个读侧全按 `case_keys`（snake）读 → Runner 拿到空数组不注入 `APITRACK_CASE_KEYS`，SDK 按无选择走全量。修法：落库改 snake（读侧互相对齐不动），请求侧 camel 由归一函数翻译；dev 库旧 camel 行不回填，重触发即新行 |
| 同 commit 折行第三列失守与调度历史状态误导 | `问题记录-同commit折行第三列失守与调度历史状态误导.md` | 两项：① 045 的三列键靠「INSERT 写 ''」折形但 UPDATE 分支把真值写回键列 → 同 commit 每 3 次上报溢出一行（dev 库 c1f4d1ba 两行）；修法：键删第三列（迁移 049 重建 UNIQUE(repo, commit)+就地合并多出行），`ci_run_id` 降级纯展示列，INSERT 写真值+EXCLUDED 引用（顺带修掉 $15 越位）。② 调度触发历史 `triggered` 画成绿色 pass 被读成执行成功；修法：runs 列表 LEFT JOIN 带出执行终态（CI=run 行、套件=index 行），`ScheduleRun.executionStatus` 读时派生，前端状态列显真实结果、拉起降级副文案、引用悬空回退中性 |
| 容器档取消不杀容器 | `问题记录-容器档取消不杀容器.md` | 容器档任务点取消后容器照常跑、跑完才落 canceled：executor 的取消只杀 `currentHandle`，而它只在 spawnFn（进程档/clone）赋值，容器走 `containerRuntime.run()` 绕过它 → `kill("cancel")` 空操作。修法：`ContainerRunOpts.onReady` 把通道的杀梯子（docker stop→kill）交回 executor，取消/丢租约直达容器；cli 通道 escalator 改重复 interval 盖住镜像拉取窗口（容器未创建时首轮扑空）；≤30s 的心跳下发延迟是约定 6 既定设计，未动 |
| P4.5 S3 产物直传三缺陷 + .env 密钥漂移 | `问题记录-P4.5S3产物直传三缺陷与env密钥漂移.md` | MinIO 接入暴露三处：① `start.sh` 新增 .env 加载层后占位值进 env，`JWT_SECRET`/`DATA_SOURCE_ENCRYPTION_KEY` 空串与未配置不同义，派生密钥漂移致 Git 凭据解密失败、claim 连续 500（修为 `?.trim() \|\|`）；② s3 驱动 pre-signed PUT 成功后无任何 `uploaded_at` 落点，产物列表与报告装载按 `IS NOT NULL` 过滤永远查不到（新增 `POST /runner/artifacts/:id/uploaded` 确认路由 + Runner 直传后调用 + `objectExists` 核实）；③ `ingest_runs` INSERT 15 列 14 占位符（迁移 049 折形时漏补）致 /ingest 持续 500 |
| P4.5 容器档 SDK 回连与缓存引导 | `问题记录-P4.5容器档SDK回连与缓存引导.md` | 容器档 SDK 上报 `localhost:3000` Connection refused：容器内 localhost 指向自身。两版域名改写（`host.docker.internal` 桌面限定、自查网桥网关在 Mac 上是 VM 地址）均证伪后，落定 `--add-host host.apitrack.internal:host-gateway`（docker 20.10+ 官方 token，daemon 负责宿主网关替换，桌面/Linux 同语义）+ `jobSpec.containerLoopback` 只改写回环地址；伴生修 ingest FK 23503（`RETURNING id` 回填真实行 id）与容器档 pip/uv 下载缓存自动引导（`PIP_CACHE_DIR` 挂卷路径注入，不做安装重定向） |
| MCP 创建接口流程内显示为 id | `问题记录-MCP创建接口流程内显示为id.md` | P5-5 验收：store 不感知 MCP 带外写入 + 接口来源 Select 无兜底，流程编辑器里新接口缺失、已存节点显示裸 endpointId；顺带核查 CI 日志无同类问题 |
| 侧边栏小屏溢出与收起 | `问题记录-侧边栏小屏溢出与收起.md` | 矮窗口下侧栏 `overflow: hidden` 把底部导航项与退出按钮裁掉无路可达（nav 改局部滚动 + 细滚动条）；侧栏无收缩功能（新增 56px 图标 rail 收起态：`data-collapsed` 属性驱动 + localStorage 偏好 + Tooltip 补标签，≥940px 专用） |
| P7 用例库抽屉 | `问题记录-P7用例抽屉20260907.md` | P7-2/P7-3 落地后十五轮使用反馈三十四项，第一~十四轮见文件（抽屉编辑区 → 分栏树 → 步骤表细节 → 视图体系与 XMind 脑图 → 脑图重做在 @xyflow/react 上 → 白屏/乐观合入/最小提交 → 键位与占位槽/删除/撤销/右键菜单 → 编号自增/表单布局 → IME 键位守卫 → 抽屉细线/空目录建例重框）。第十五轮 ㊴：就地编辑打不了中文的真正根因不是键位检测，是编辑框受控 value 走画布 store 往返（passive effect 晚一拍），React 受控输入的事后校正拿旧 props 回写 DOM、拆掉进行中的输入法组合——草稿改 MindEditInput 本地态，提交时 onCommit(value) 交终值 |
| P7 脑图菜单与折叠 | `问题记录-P7脑图菜单与折叠20260908.md` | 2026-09-08 两轮共六项：① 右键菜单点画布关不掉——画布 mousedown 被 d3-zoom `nopropagation` 截在目标层，冒泡阶段的 document 监听收不到，改捕获阶段 + Esc；② 折叠子目录「用例消失」两轮归因——第一轮修引用稳定（㉓ 同类加固），第二轮查库取证（151/152 条用例在被折叠子树下）定位真凶为**视口悬空**：剩余节点聚到原点、视口停在原区域；目录 ⊕/⊖ 改按新图重新框定、用例 ⊕/⊖ 保持视口；伴随的 `reportAllChanges`/`startTime` 报错取证为 Chrome DevTools 内嵌 web-vitals 已知 bug（GoogleChrome/web-vitals#792）；③ 模块路径列挪末列 + 220px 上限悬停看全；④ 树目录名 min-width:0 修横向滚动；⑤ 删目录两层确认收敛为单层（计数本地算）；⑥ 脑图目录级「加载更多」局部加载（moduleId 按批取、id 去重、空页取尽撤节点） |
| P7 脑图第三轮 | `问题记录-P7脑图第三轮20260908.md` | 2026-09-08 第三轮八项 + 伴生：① Tab 建例后编辑不生效、② Delete 删例不消失——同根因：本地合入/删除只写首页行集（data.items），漏了「加载更多」的追加批（moduleExtra），且服务端按 item_key 排序新建例排在范围末尾、首页 100 条装不下，revision 重取整页替换后旧行接管/新例消失；修为两处行集统一合入（total 只对未知行 +1）+ 删目录按子树 moduleId 清场防孤儿挂 root；⑦ 伴生：撤销/重做闭包经 modulePathRef 守卫接上本地合入；③ 目录折叠/展开撤掉 fitView 跳变，改选中+按当前缩放平移兜底；④ 双击左树目录跳回全部用例——400ms 窗口守卫 + onDoubleClick 强制选中双保险；⑤ 脑图节点/左树/路径列原生 title（~1s）换 Tip（100ms）；⑥ 右键用例菜单 12 行收敛为 6 行——优先级/状态收进悬停子菜单（当前值打勾、右缘 is-flip 左翻、悬停桥防闪关）；⑧ 每次添加/删除后步骤内容闪一帧——revision 重取整页换行对象打穿 sameMindNode 的渲染等价保留，重取落库改按 id+updatedAt（modules 按字段）保引用合并；⑨ 节点单行 224px 装不下导入的长步骤/标题——case/pre/step/exp 改两行折行（line-clamp:2 + 高度 44 与 NODE_H 严格同步），顺带脑图提示条标注「未接入 OT，不支持多人协同」（边界 17 前端落点） |
| P7 脑图第四轮 | `问题记录-P7脑图第四轮20260908.md` | 2026-09-08 第四轮四项（承接第三轮 ⑨ 完整折行）：① 就地编辑单行 input 看不到长草稿——换 textarea（rows 随 estimateLines、Shift+Enter 换行、IME 守卫保留）；② 长标签 chip 撑爆徽记行——chip 72px 线夹 + 标签容器折行封顶；③ 完整展示后内容族悬停 Tip 多余——仅 root/dir 保留（仍单行截断）；④ 「目录下没 case 徽章却显示 1」——DB 取证数据正确（TC-150 确在该目录），矛盾在口径：徽章取树导航口径（全状态），画布内容随筛选收敛；筛选取数传 filtered，筛选态隐藏 root/dir 计数徽章 |
| P7 脑图第五轮 | `问题记录-P7脑图第五轮20260908.md` | 2026-09-08 第五轮三项 + 同日追加一项（同源：节点几何）：① 节点数据「折叠」——节点宽 300px 而列距仍 280（宽节点越进右列 20px 盖住内容）+ 行数估算按 16 字/行平估低估（case 实际 ≈15.5 字/行，DOM 比预留高、文字压到下邻）；修 PITCH 280→360、估算改显示宽度加权（CJK 1 / ASCII 0.6）+ 按实际内容宽算容量 + 高度常数对齐 CSS 几何（33+2）；② ⊕ 号挡数据——toggle 从 top:5px/right:-7px（骑在徽记行右端）改绝对定位到节点右缘外竖直中线（right:-20px，锚点 .mindmap-node）；③ 编辑框限制大——编辑节点放宽 360px + textarea 自动量高（useLayoutEffect 钉 scrollHeight，不再依赖估算），内容族编辑 .mindmap-edit.is-block 徽记首行 + 输入框整行全宽；④ 双击存量用例光标不在末尾——挂载一律全选是新建占位的策略，edit state 加 selectAll 位区分入口：新建全选（打字即覆盖）、双击存量 setSelectionRange 置尾 |
| 测试计划详情 500 | `问题记录-P7测试计划详情500.md` | 计划详情打不开、报「读取计划列表失败」：只读自动化参考列的 LATERAL SQL 多写一行 `) u` 把子查询提前闭合，`ORDER BY/LIMIT` 掉到外层、`) best ON true` 悬空（42601 syntax error at or near "ORDER"）。修法：删该行，排序/取一收回 LATERAL 内（UNION 整体排序，正是「每项取最新一条」语义）；SQL 原文已对 dev 库验证解析通过。同日第二轮反馈该列整列删除，查询随之移除（追记见文件） |
| 计划详情 result_null 键名 | `问题记录-P7计划详情result_null.md` | 自动化参考列对无自动化记录的用例显示字面 i18n 键名 `specCases.links.result_null`：LATERAL 零行被 LEFT JOIN 补 NULL，路由层 `String(null)`="null" 被当状态解析、前端查缺失键渲染键名。修法：NULL 不进 map，automation 读成缺席（前端按设计显示「—」）。同日第二轮反馈该列整列删除（追记见文件） |
| 计划详情 summary 不推进 | `问题记录-P7计划详情summary不推进.md` | 标结果后头部 Readout 与表头悬停计数不动、编辑弹窗改名后进度清零：就地合行只换项行不重算 `plan.summary`（三处：withItem / removeItem / 编辑合流铺开 PATCH 响应的零值计数）。修法：`summaryOf(items)` 按项行就地重算（与 PLAN_SUMMARY_SELECT 同口径），编辑合流显式钉住手上这份 summary |
| 计划日期时区错位 | `问题记录-P7计划日期时区错位.md` | 编辑弹窗回填后截止时间消失：pg 把 DATE 列解析成本地时区午夜的 Date 对象，`String(date)` 产出 `"Wed Sep 23 2026 …"`——date input 只认 `YYYY-MM-DD`（非法 value 即清空）。修法：`mapDateOnly` 取本地分量三件套拼回原字符串（startedOn/dueOn 共用），对 dev 库实测一致 |
| P7 脑图步骤盖住下一步骤 | `问题记录-P7脑图步骤盖住下一步骤20260909.md` | tidy tree 给父节点让位只看子代跨度：带预期的长步骤自身高度不占位、居中于短预期上下各溢出 (h−span)/2，压进下一个兄弟的槽（4 行步骤盖 15px、8 行盖 51px）。修法先量后排：measure 占位高 = max(自身高, 子代跨度)，自身更高时子代下移让位 + bottom 扩张到自身底；常规场景行为不变 |
| P8-1 口径收口三缺陷 | `问题记录-P8-1口径收口三缺陷.md` | ① 通过率三处分叉：报告详情/分享页 `success/total`、套件通知 `(s+f+skipped)`、列表 `passed/(passed+failed)` 三种算法并存——新建 `lib/metrics.ts` 口径库（`PASS_RATE_SQL` SQL 片段 + `passRateOf` TS 同款），五个落点全部收敛；② 单步调试自指索引行（`detail_id = id`）污染趋势/汇总样本（列表侧早有排除、趋势汇总漏了）——`NOT_SELF_DEBUG` 片段补进 trend ON 与 summary WHERE；③ includeRepo 只作用于 summary 第一段判定为数据源错位（失败分布读叶子 executions，ingest/runner 失败不在那张表），按计划留给 P8-4 `/stats/*` 新接口收口，注释写明防止误修；④ 自伤缺陷（用户实测发现）：`NOT_SELF_DEBUG` 改箭头函数后 summary 模板漏调用括号，函数源码拼进 SQL 致 `/reports/summary` 500、趋势页整页加载失败——补括号 + tsx 验证四种片段调用形态 |
| MCP 环境更新分支 updated_at 列缺失 | `问题记录-MCP环境更新分支updated_at列缺失.md` | `upsert_environment` 的 UPDATE 分支写 `updated_at = now()`，但 `environments` 表从 001/027/030 三个迁移都没加过这一列——已存在环境的变量替换一执行即 500（首次创建分支不受影响）。修法：删该 SET 子句（变量替换语义不依赖时间戳，表上也没有读者）。发现于 2026-09-09 MCP 扩界前置探查（information_schema + 直连复现）；顺带本批把环境删除补进工具面（`delete_environment`） |
| 计划详情计数窄屏溢出 | `问题记录-P7计划详情计数窄屏溢出.md` | 计划详情头部「N 条未执行」Readout 值位的四枚 Status chip（`.readout-marks`，nowrap inline-flex，约 260px）在窗口收窄后压过格线挤进邻格、≤560px 两列网格下顶出容器——`min-width` 只管盒子不管内容溢出。修法：`flex-wrap: wrap` + 行距收档（`gap: 4px 10px`），chip 整枚掉行（词不拆），宽屏单行形态不变 |
| P8-5 图表底座三缺陷 | `问题记录-P8-5图表底座三缺陷.md` | ① hover 错位（用户实测）：SVG 漏 `preserveAspectRatio="none"`，容器宽于 viewBox 时内容居中留白不拉伸、而 hover 反查按容器宽算比值，指针在 A 吸附到 B——四组件显式补声明；② 折线不连续（用户实测）：null 桶断线规则不可配置，稀疏窗口只剩碎段、孤立单点画不出——`pathSegments` 加 `bridgeGaps` 选项（单点段补零长 L），耗时分位/sparkline 桥接、通过率保持断线；③ 分位数 278824s（用户实测）：`ingest.ts` 写 execution_index 的 finished_at 兜底接收时刻且重投无条件覆盖，晚到重投把 3.94 天前 run 的 finished−started 拉爆 p99——首投仅无真 started_at 才兜底、重投 COALESCE 保留，库内唯一污染行 finished_at 置 NULL |
| P8-6 统计页接线两缺陷 | `问题记录-P8-6统计页接线两缺陷.md` | ① TopN「按接口/按套件」500（用户实测「按用例、按接口统计数据失败」，按用例实际 200）：P8-6 补的 refId 用了 `MAX/MIN(uuid)`——Postgres 无此聚合（42883），改 `ARRAY_AGG…[1]` 取组内最近一次失败；② `stats/overview` 带 projectIds 必炸 500（双 WHERE）：P8-4 的 assets/coverage 六个子查询 `scopeWhere` 后又跟 `WHERE status…`，scope 全量时片段为空才侥幸合法（验收用管理员没踩到），P8-6 前端永远带 projectIds 后全部触发——统一改 `scopeAnd` 并入既有 WHERE |
| P8-7 验收五轮 TopN 仓库用例身份归并 | `问题记录-P8-7验收20260910五轮TopN仓库用例身份归并.md` | 失败 TopN「按仓库用例」维按裸 `guessed_case_key` 分组，同一条用例的两种 key 形态（`pkg.Mod#test` 与 `pkg/Mod.py::test`）拆成两行（dev 库 30+10 应为 40）；且 refId 直跳「最近一次失败 run」详情替用户挑了一次执行（用户反馈「很奇怪」）。修法：LEFT JOIN `repo_test_cases` 用 ingest.ts 同一把匹配尺归并身份（未匹配退去参数化裸 key），下钻改 `/repo/tree?keyword=<规范 case_key>`（用例树 = 资产页，历史在抽屉）；flaky 新增的仓库任务腿序列分区键同款规范尺 |

## 约定

- 新增缺陷一律记录到本目录，**不写入 `DEVELOPMENT_PLAN.md`**。
- 文件命名：阶段/主题清晰即可（`P*-*_ISSUE_LOG.md` 或 `问题记录-*.md`）。
- 每条记录至少包含：现象、根因、修法、状态。

## 验收状态

- **P4.5 已于 2026-09-03 通过用户验收**（结论见 `DEVELOPMENT_PLAN.md` 8.18）。本目录
  P4.5 相关记录中遗留的「待复验 / 待重启后确认 / 待下次触发观察」事项均随该轮验收
  关闭：产物下载直链、容器档取消（含心跳间隔调整）、迁移 048/049 后的上报落库、
  勾选执行键形、上报分支注入、仓库模式走查五项、xdist 重复上报等。
- **P5 已于 2026-09-06 通过用户验收**（结论见 `DEVELOPMENT_PLAN.md` 9.9；含当日边界
  修订两笔——9.5 无环境执行证据按项目 secret 并集脱敏后返回、工具上限 43→44 增补
  `upsert_environment`——与缺陷一项：MCP 创建接口流程内显示为 id）。用户后续**持续
  测试继续**：新发现的缺陷照常记录到本目录，`DEVELOPMENT_PLAN.md` 9.7 各行遗留的
  「待用户实测」事项随该轮验收关闭。
- **P7 已于 2026-09-09 通过用户验收**（结论见 `DEVELOPMENT_PLAN_P6-P10.md` 十一章
  11.5 末「P7 验收结论」）。验收期（09-07 ~ 09-09）计划详情四轮反馈里的交互调整与
  五个缺陷全部修复关闭：详情 500（LATERAL 括号错位）、result_null 键名显示、
  summary 不推进、计划日期时区错位、Babel 注释笔误；两项口径修订（通过率
  passed/total、自动化参考列整列移除）已同步进计划文档与验收门槛。用户后续持续
  测试照常：新缺陷记本目录。
