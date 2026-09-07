# 接口自动化平台 — 开发计划

> 版本: v0.8.11
> 基于: API_AUTOMATION_SPEC.md v1.9 / FRONTEND_INTERACTION_DESIGN.md v2.3 / REPOSITORY_ARCHITECTURE.md v1.1
> **P6–P10 已规划（2026-09-04 用户确认；P6-1 ~ P6-5 已于 2026-09-07 实现并暂记验收通过，其余尚未实现）**：用户与权限 / 测试管理 / 数据统计 /
> 站内助手四个新阶段插在 P5 之后，**原 P6（性能/插件/版本）顺延为 P10**。五个阶段的
> 范围、边界、迁移（051–054）、路由、批次与验收门槛见
> **`DEVELOPMENT_PLAN_P6-P10.md`**（章节映射：该文件十~十四章 = 本计划的 P6~P10；
> P10 于 2026-09-05 自本计划十四章并入该文件）。
> 当前阶段: P0、P1 全部已实现；P2 全部已实现并通过验收；**P3 十一个批次全部实现并于
> 2026-08-28 通过用户验收**；**P4（仓库模式：上报式用例 + `apitrack-sdk`）十二个批次于
> 2026-08-29 全部实现，并于 2026-08-31 通过用户验收；`apitrack-sdk` v0.1.0 已发布至
> 正式 PyPI**，范围与边界见 7.0，状态见 7.6；**P4.5（自研 Runner）全部已实现**——
> P4.5-1 ~ P4.5-13（状态见 8.8 末尾）；**P4.5-14（配置面收窄，8.11）与 P4.5-15
> （任务编辑页与执行历史交互改版，8.12）均已实现**（2026-09-01；前者迁移 041 + 五 tab
> 合并 + 四组配置删除，后者 `CiTaskEditor.tsx` 独立编辑页 + 行内展开历史 + 日志下载，
> 详见 8.11 / 8.12 末尾的实现状态）。**P4.5 十五个批次至此全部落地，并于 2026-09-03
> 通过用户验收**（含 2026-09-02/03 的报告体验改版与分享、可读性、上报幂等按 commit
> 折行、树×任务报告、通过率口径、容器档取消等反馈修复轮，见 8.13 ~ 8.17 与
> `issue_fix/`；验收结论见 8.18）。
>
> **v0.8.9 增量（验收反馈七项，2026-09-03，见 8.17 与 issue_fix）**：三缺陷——① 接口
> 列表为「最近运行」条全量拉 200 条 `/executions`（约 254KB），删列 + 耗时/状态改由
> 列表接口 LATERAL 随行带出；② `docker run --storage-opt size=` 在 overlay2 无 pquota
> 的 daemon 上必被拒（退出码 125 被当脚本失败），两条通道撞上即去旗标重试 + 进程内
> 降级；⑤ 套件报告分享页成员行不可点（无抽屉），新增三个 token 端点按证据闭包放行。
> 四调整——③ 容器档通道部署时可选（Runner 自报 + 池显示 + 部署命令 export，迁移 046）；
> ④ 通知模版新增 `{{reportUrl}}`（`PUBLIC_BASE_URL` 拼完整链接）；⑥ 上报记录明细删
> 状态码/耗时/状态三列；⑦ 用例树×任务报告（最近任务列替代请求数列、状态/最近执行从
> 报告读时关联【迁移 047 索引，绝不回写】、抽屉展示用例内步骤 + 请求序列高亮该接口）。
>
> **v0.8.11 增量（P5 范围扩界，2026-09-04 讨论确认，见 9.0 / 9.2 / 9.4）**：传输层补兼容
> 姿态——SDK v2 默认 `legacy: 'stateless'`，智能体平台 rmcp-soddygo 1.5.0 的 Streamable
> HTTP（2025-06-18）走兼容腿、零状态，老 SSE 传输（rmcp 0.10）不支持、平台侧用
> `STREAMABLE_HTTP` 注册；工具面从 16 个扩到 **43 个封顶**（读 21 / 写 17 / 执行 5）——新增
> 套件/调度/告警/CI 任务完整 CRUD（delete 走 MRTR 确认）、任务与报告读取、命名资产触发、
> 单用例调试、`get_project_overview`；**边界 3 由「不给 execute/delete」重写为动作分级**
> （可逆写直接执行 / 不可逆写 MRTR 确认回合、force 不再是入参 / 执行只跑已保存资产且不接受
> overrides）；scope 增第三种 `execute`（表结构零改动）；授权分三层——Token scope、MRTR
> 动作确认、站内助手身份绑定（9.8 三选一）。P5-3 增两条实测：elicitation/MRTR 转述、按会话
> 注入凭据。
>
> **v0.8.10 增量（验收 2026-09-03 第二批，见 8.17）**：一项缺陷一项口径两项交互——
> ① 树×报告匹配键形态缺陷（allure fullName 是 `pkg.Mod#test`，非 nodeid；Runner 侧
> 归一 + 服务端历史行兼容分支，绝不回写）；② 通过率口径改 **passed/(passed+failed)**，
> 跳过不进分母（error 已算失败）；③ 任务编辑页补未保存提示 + Cmd/Ctrl+S（对齐套件
> 编辑的整套安排）；④ 任务列表在途状态只在「最近执行」列展示。缺陷记
> `issue_fix/问题记录-P4.5验收20260903第二批.md`。
>
> **v0.8.9 增量（凭据页上报口径说明，2026-09-03）**：上报 Token 区块补三条说明
> （按 commit 去重 / 多任务共用一张 Token / 任务内「高级设置 → SDK 注入」控制注入，
> 调试任务取消勾选）——回答「正式与调试两个任务一起报会怎样」。
>
> **v0.8.8 增量（上报幂等口径变更，2026-09-03，见 8.16）**：同 commit 的上报不再每次
> 新增行——迁移 045 幂等键折成 `(repository, commit)`，同 commit 折一行 + 新列
> `ci_execution_count` 记执行次数；`pipeline_runs.ingest_run_id` 反查改
> `(project, commit)`；旧行就地合并（dev 库 16→4 行、记录 350→69 行）；前端「执行 N 次」。
>
> **v0.8.7 增量（报告体验验收第三批，2026-09-02，见 8.15）**：四缺陷三调整一说明——
> ① 报告附件一直「正在加载」两处根因修复（附件引用错用展示名取实体、前端丢弃在途响应）；
> ③ 失败计数对不上（`error` 归入失败 + 迁移 044 `external_id` 防同名参数化用例被唯一键
> 吞掉）；④ 产物大小全 0 B（落库读 `guard.bytesWritten`）；② case 明细改抽屉；⑤ 报告
> 进入全收起；⑦ 任务列表「最近执行」列后移；⑥ 上报幂等口径初判符合设计，次日用户改口径
> （见 8.16）。缺陷记 `issue_fix/问题记录-P4.5报告体验验收第三批.md`。
>
> **v0.8.6 增量（报告与任务列表可读性改版，2026-09-02 验收反馈第二批，见 8.14）**：十项，
> 全部落在「读」这一侧——① 时间轴整齐刻度 + 背景网格 + 空档标注 + 泳道按时间排序；② 概要行
> 从纯文本混排改带标签事实格（状态/阶段/提交/触发/结果）+ 计数 chip；③ 报告用例列表按文件
> 分组折叠（默认只展开有失败的）；④ 列表显示 case title（`@allure.title` → docstring 首行 →
> 函数名，函数名退成副标题）；⑤ 展开区限高自滚动 + 步骤树真折叠；⑥ 报告内搜索 + 状态筛选；
> ⑦ 任务列表补「最近执行」列（状态 + #序号 + 执行次数，服务端多一段 LATERAL）；⑧ 任务列表
> 补关键字搜索（`GET /ci-tasks?keyword=`，ILIKE 名称/描述/Git 地址）；⑩ 测试级
> log/stdout/stderr 拆成默认展开的「执行日志」块 + 报告包无附件时说明原因
> （`--allure-no-capture`）；⑪ 状态列换 `Status` 原语上语义色。其中两项是缺陷（任务列表
> LATERAL 列被 `TASK_SELECT` 投影吞掉、步骤树 caret 点不动），记
> `issue_fix/问题记录-报告与任务列表可读性.md`。
>
> **v0.8.5 增量（报告体验改版，2026-09-02 验收反馈，见 8.13）**：五项——① run 详情页
> 面包屑缺陷修复（`pipeline-runs/:runId` 进 detail 判定，回得去任务列表）；②③ 报告视图
> 合并：用例 tab 撤销，`PipelineReportBody` 三段（概要读数含通过率 / timeline / allure
> 用例明细含注释·fixture·步骤日志），junit 降级列表；任务列表历史补计数列；④ 报告列表
> 扩成**总报告列表**（套件 + 仓库执行两源 UNION，`kind` 区分、来源筛选、计数列）；⑤
> **报告分享**：迁移 043 `report_shares` + `/public/report-shares/:token` 免登录只读
> （与站内同一份拼装 `lib/reportPayload.ts`），`/share/reports/:token` 公开页。
>
> **v0.8.4 增量（P4.5-12，2026-09-01 实现）**：8.7 的两个预留接入点接上——**调度与 Webhook
> 支持 `ci_task` 目标**（迁移 042 放宽两个 `target_type` CHECK；`lib/schedule.ts` 的 `fire()`
> 分出 `fireSuite` / `fireCiTask`；Webhook 的公开路由从 `if flow / else suite` 落空写法改成
> 三分支显式分派），两条路径都走 `triggerCiTaskRun` 这一个函数（P3 边界 5）。本轮两个范围
> 扩项一并落地：**任务终态通知**（`ci_tasks.notify_config` 与套件那一列形状逐字相同，归一 /
> 投递 / 证据行全部复用；挂在 `pipeline` 终态事件的订阅上，complete 与租约回收两条路径自动
> 都覆盖）、**任务级串行**（`single_concurrency` 默认开，守卫落在 claim 侧——**排队而不是
> 拒绝**，四个出口补 `notifySerializedQueue` 唤醒）。前端 `SuiteSchedules` 泛化成
> `ResourceSchedules`，套件详情页与仓库任务共用一个组件；`start.sh` 补起 Runner 的注释
> （不自动拉起）。七处偏差与三个刻意的缺省见 8.7 与 8.8 末尾。
>
> **v0.8.3 增量（P4.5 验收反馈第二轮，2026-09-01 确认；①–③ 已于同日实现，见 8.12
> 末尾）**：五点优化，范围见 8.12 与
> 8.7 的改写——① 任务编辑从抽屉改**独立编辑页**（路由 `/repo/tasks/new|:taskId`），
> 必填项前置、高级项折叠，环境变量分区上移到代码来源之后（它是写 shell 的前置输入）；
> ② 任务列表**行内展开**执行历史（新 `GET /pipeline-runs?ciTaskId=` 列表接口），点某条
> run 直达详情页，不再绕全局报告列表；③ run 详情页默认落在日志 tab（实时 SSE / 历史
> 全量同一位置），补**整份日志下载**路由；④ P4.5-12 范围扩成「调度 + 通知 +
> **任务级串行**」（**已于同日实现**，见上）；⑤ Webhook 接 CI 任务维持原 P4.5-12 范围一并
> 落地（**已实现**）。
>
> **v0.8.2 增量（P4.5-11，2026-09-01）**：8.6 欠着的三个前端页面落地——CI 任务列表
> （顶部 Runner 池读数 + 行内执行/历史/编辑/删除）、任务编辑抽屉（代码来源只读、进程档
> 写成信任声明、secret patch 语义）、Runner 池（落在系统设置里紧挨执行器面板的第三个
> tab，含注册 Token 签发与部署命令、`draining` 下线）。两处口径改造：趋势页开关从
> 「含仓库上报」扩成**「含仓库执行」**（`includeRepo` 同时管 `ingest` 与 `runner`，
> 不给第二个复选框）、执行记录页补「只看勾选来的」（`case_filter IS NOT NULL`）。
> 新增一条 `GET /system/runner-pool`（任何登录用户可读）让非管理员也能看到池状态；
> 导航新增「仓库模式」分组（仓库用例从编排组移出、与 CI 任务并列）；看板的「CI 任务数」
> 接真值（覆盖率一个字不改）。
>
> **v0.8.1 增量（P4.5-13，2026-09-01）**：边界 13 的「不做报告渲染」**改判**——用户要
> timeline 与用例内步骤，落地为**自存原始文件、自渲染**（新边界 19）：不跑 allure-cli、
> 不 vendor allure 官方 SPA。两层落地：timeline 数据随 `complete` 的 `cases[]` 上报落
> `pipeline_run_cases` 四个新列（迁移 040）；Runner 把 allure-results 整目录打 zip
> （零依赖手写 zip 写入器）作为 `kind='report'` 产物直传，平台读取解析（零依赖 zip
> 读取器 + 归一化）、用自己的 UI 渲染——run 详情页四 tab（实时日志 / cases 时间轴 /
> 报告视图 / 产物），执行记录页 runner 行可点。
>
> **v0.8（P4，2026-08-29 实现完成）**：十二个批次全部落地，逐批落点与「相对计划的六处收窄」见 7.6。
>
> **P4 验收结论（2026-08-31）**：用户验收**通过**（P4-1 ~ P4-12 全量，含 7.6.1–7.6.4
> 四个验收后增量；结论明细见 7.7 末尾）。原唯一保留项（门槛 13 的 PyPI 实际发布）已于
> 同日完成：tag `v0.1.0` 触发全流水线（test ×3 → build → TestPyPI → verify ×3 → pypi）
> 全绿，`pip install apitrack-sdk` 生效。
>
> **v0.7 规划（P4，2026-08-29 确认）**：仓库模式的上报式用例。核心是「平台不拥有测试代码，
> 只接收上报并做覆盖可视化」。相对既有 Spec / 交互文档的**四处显式变更**：
> ① SDK 改为**零改动接入**（pytest 插件自动加载 + 传输层打桩），撤销 Spec 2.10.1 的
> `http_req.py` 封装示例与交互 3.11.2 的 `apitest-run` 命令；② 包名定为 **`apitrack-sdk`**
> （发布 PyPI，环境变量前缀 `APITRACK_`）；③ `is_full_inventory` 收窄为**范围级全量**，
> 协议新增 `scope`（否则按目录划分系统的 monorepo 永远不会对账）；④ **未匹配区从待办清单
> 改为诊断视图**，撤销交互 3.11.1 的「从未匹配区补登记接口」动作。统计口径（覆盖率、看板、
> 趋势）本阶段**一律不动**，等整体重做那一版。
>
> **v0.6**: P3（套件定时调度 / Webhook 触发 / 套件执行报告 / 流量泳道 / 告警通知 /
> 趋势分析）范围与边界已于 2026-08-27/28 确认；P3-1 数据层（迁移 030/031）、P3-2 流量泳道
> 两层（迁移 032）、P3-3 统一触发路径（lib/trigger.ts）、P3-4 调度器进程、P3-5 告警评估与
> 投递、P3-6 后端路由全套、P3-7 套件列表分页、P3-8 前端 api 与 i18n、P3-9 前端页面全套、
> P3-10 进程编排收尾均已于 2026-08-28 实现，**P3 十个批次全部完成**（状态见 6.6）。
> 相对原计划的变更：流程不做定时调度（只有测试套件可被调度）、新增「套件执行报告」、
> 新增「流量泳道」、套件相关列表补服务端分页；趋势图表撤销 `@ant-design/charts`，改手写 SVG。
>
> **2026-08-28 验收反馈增补（P3-11）**：独立「定时调度」页删除、定时配置并入套件详情页；
> 套件级通知设置（成功/失败开关 + 渠道 + 占位符模版，形状见 6.8，迁移 033）。同轮修复
> 验收缺陷六项（白屏 ×2、编辑调度 500、报告成员证据抽屉、看板调度数、mocks 存量类型错，
> 见 `issue_fix/问题记录-P3验收第一轮.md`）与环境管理列表服务端分页。
>
> **P3 验收结论**：2026-08-28 用户验收通过（P3-1 ~ P3-11 全量）。
>
> **v0.6 范围变更**: **P4.5（自研 Runner）范围与边界已于 2026-08-31 确认**，见 8.0：
> 由 4 周上调为 **6 周**（理由见 8.0 边界 18）；沙箱做**进程 + 容器**两档；仓库凭据由平台
> 加密存储并随 JobSpec 下发；报告归一走 **SDK 上报 / junit / allure** 三条路径（只有 SDK
> 路径回写用例树）；**P10 14.1（原 P6 10.1）的对象存储抽象提前到本阶段**，但只服务产物上传，执行历史归档
> 与大响应体截断仍留在 P10；勾选用例快速执行（8.3）确认进本阶段。
>
> **v0.5 增量切片**: **P2-8 执行分区（跨网段执行）** 已全部实现（P2-8.1–P2-8.6 于
> 2026-08-26 完成，P2-8.7 配置体验补齐于 2026-08-27 增补）**并于 2026-08-27 通过用户
> 验收**（范围、边界与批次见 5.0.12），解决「测试网段的 worker 打不通生产网段」这一
> 环境问题；不占核心 8 周周次、不阻塞 P2-4 / P2-5，但**有一条硬前置条件**（生产网段
> 能否出站到平台 Redis + Postgres），前置不成立则本切片作废并转 P4.5 的 Runner 协议。
>
> **v0.4 范围变更**: P1-2 的两项遗留（并行执行、流程执行记录独立视图）与全部剩余节点
> 类型（脚本/条件/数据库/循环/等待/子流程）并入 P2，P2 由 6 周上调为 8 周。见 4.0.3 与 5.0。

---

## 一、整体路线图

```
P0 ──→ P1 ──→ P2 ──→ P3 ──→ P4 ──→ P4.5 ──→ P5 ──→ P6 ──→ P7 ──→ P8 ──→ P9 ──→ P10
MVP    流程    数据源  套件调度 仓库    Runner   MCP    用户   测试   数据   站内   性能
       编排    节点补全 报告告警 用例                     权限   管理   统计   助手   插件
       断言    套件    趋势                                      （2026-09-04 新增，P6–P10 详见
                                                               DEVELOPMENT_PLAN_P6-P10.md；
                                                               原 P6 性能/插件/版本顺延为 P10）
```

---

## 二、P0 — 当前状态

### 2.1 已实现功能

状态说明：`[已实现]` 表示当前代码已具备；`[已确认]` 表示问题已完成代码定位但尚未修复；`[P0待开发]` 表示已纳入本阶段计划。


| 模块     | 后端                                            | 前端                                             | 说明                                                                                          |
| ---------- | ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 健康检查 | `GET /health`                                   | —                                               |                                                                                               |
| 认证登录 | `POST /auth/login`                              | 登录页(双栏布局)                                 | JWT + scrypt 密码哈希                                                                         |
| 当前用户 | `GET /auth/me`                                  | 用户信息展示                                     |                                                                                               |
| 项目管理 | `GET/POST/PATCH /projects`, `GET /projects/:id` | 基础列表 + 创建 + 下拉切换器                     | 事务性创建 + 自动分配 admin 角色                                                              |
| 环境管理 | `GET/POST /projects/:id/environments`           | Tab 列表 + 变量编辑器                            | `[已实现]` JSONB 变量/密钥存储                                                                |
| 接口管理 | `GET/POST/PATCH/DELETE /projects/:id/endpoints` | 列表(服务端搜索+方法筛选) +**整页编辑器** + 详情 | `[已实现]` 完整要素: method/url/headers/query/path/body(json,form,text)/auth/tags/description |
| 接口执行 | `POST /.../endpoints/:eid/execute`              | 结果抽屉(请求/响应/错误)                         | `[已实现]` 路径参数替换 + query 合并 + auth 注入 + 变量解析 + 30s 超时                        |
| 执行记录 | `GET /projects/:id/executions`                  | 全量分页列表 + 详情抽屉                          | `[已实现]` 服务端分页(20/50/100/200) + 状态/接口筛选，返回真实 total                          |
| RBAC     | `user_project_roles` 表 + `canAccess()` 中间件  | —                                               | 三级: admin/developer/viewer                                                                  |
| 数据迁移 | 自研迁移执行器                                  | —                                               | SQL 文件顺序执行, 事务保护                                                                    |

### 2.2 已实现数据模型 (6 表)

```
users           (id, email, name, password_hash, is_system_admin, status)
projects        (id, name, description, owner_id, status)
user_project_roles (project_id, user_id, role)
environments    (id, project_id, name, variables, secrets)
endpoints       (id, project_id, name, description, method, url, headers, query_params, path_params,
                 body_type, body, body_text, auth, tags, created_at, updated_at)
executions      (id, project_id, endpoint_id, endpoint_name, environment_id, status, status_code, duration_ms,
                 error, request_snapshot, response_headers, response_content_type, response_size_bytes,
                 response_truncated, response_body, created_at)
```

> `body` 存 JSON payload，`body_text` 存 form/text 原文。两者并存是为了切换 Body 类型时不丢用户已输入的内容。

### 2.3 当前架构

```
后端: 路由/权限/模型已模块化 — Fastify + @fastify/jwt + @fastify/cors + pg
前端: 路由、Zustand、i18n 已接入；全局层和项目层待重构
基础设施: compose.yaml — PostgreSQL 16 + Redis 7 (Redis 未使用)
```

### 2.4 P0 环境职责与状态

环境必须按“项目级资源、执行时选择、接口/用例可绑定默认值”分层，避免把环境下拉框的临时状态误当成接口数据或列表筛选条件。


| 能力                        | 当前状态   | 规划                                                                                                                        |
| ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 项目环境变量与 secrets 管理 | `[已实现]` | 环境属于项目，继续由`environments` 表维护 `name`、`variables`、`secrets`。                                                  |
| 执行时注入环境变量          | `[已实现]` | `POST /projects/:id/endpoints/:endpointId/execute` 接收 `environmentId`，服务端校验项目归属并解析 `{{variable}}`。          |
| 执行记录环境快照            | `[已实现]` | 执行记录保存`environment_id` 和 `environment_name`，环境删除后历史仍可读。                                                  |
| 编辑页切换环境后持久化      | `[已实现]` | 环境选择已进入接口草稿、保存 payload 和未保存判断，重新进入接口可恢复默认环境。                                             |
| 接口列表环境筛选            | `[已实现]` | 列表仅保留环境筛选并写入 URL；行内运行由服务端按接口默认环境、项目默认环境回退。                                            |
| 项目默认环境                | `[已实现]` | `project_settings.default_environment_id` 作为项目内没有更具体绑定时的默认执行环境。                                        |
| 接口默认环境                | `[已实现]` | `endpoints.default_environment_id` 已接入创建、更新、详情、复制和执行回退。                                                 |
| 列表环境筛选                | `[已实现]` | `GET /projects/:id/endpoints` 支持 `environmentId=<uuid>` 和 `environmentId=unset`。                                        |
| 用例固定环境                | `[已实现]` | `test_cases.environment_id` + `environment_name` 保存用例环境快照；用例执行使用用例绑定环境，不受接口默认环境后续变更影响。 |
| 环境执行分区                | `[已实现]` | `environments.runner_label` 表达「这个环境该从哪个网段发请求」，队列按标签路由到对应分区的 worker。见 5.0.12（P2-8）。 |

环境选择优先级统一为：用例绑定环境 > 接口默认环境 > 项目默认环境 > 当前项目第一个环境 > 不使用环境。列表页环境筛选只筛选接口默认环境，不改变接口本身的临时执行环境语义。

**环境是执行位置的归属者（P2-8，已实现）**：内网存在互不连通的网段（测试 / 生产），而 worker
只能从自己所在网段出站。执行位置挂在环境上而不是新建一层资源，正是因为上面这条选择优先级
已经被用例、接口、流程、套件、批量调试共用——环境定了，分区就定了，不需要第二套选择逻辑。

---

## 三、P0 遗留项 — 优先级最高

> **状态：全部已实现**（1–9 均完成；3.1.1 环境落地清单除验收项外全部落库）。P0 功能面已收口，进入下一阶段迭代。

### 3.1 P0 产品信息架构与可观测性（当前最高优先级）

1. `[已实现]` 全局层：新增数据看板、项目管理、系统管理；登录默认进入数据看板。
2. `[已实现]` 项目管理：卡片默认视图，支持项目 CRUD、关键词筛选与显式进入项目。（归档已从产品概念移除，故无状态筛选；项目暂无标签维度）
3. `[已实现]` 数据看板：按可见项目汇总项目、接口、通过率、完成率；**覆盖率与接口用例数已在 P1-1 接入真实值**（覆盖 = 该接口至少有 1 条用例），CI 任务、定时任务等未交付模块仍显示“未启用/待接入”；项目行可进入项目。看板指标下钻规则见交互文档 3.0.2。
4. `[已实现]` 执行信息：项目执行记录升级为未来 `ExecutionIndex` 的统一明细入口（单接口 / 批量调试两种视图）；接口详情内就地展示该接口历史和完整 HTTP 快照。
5. `[已实现]` 系统管理：新增主题、语言、恢复上次页面等个人偏好页面；快捷切换不能替代设置页。
6. `[已实现]` 导入：OpenAPI/Swagger 扩展为 cURL 解析，并提供冲突预览（新增/已存在/变更 + 全局策略 + 逐项勾选）。
7. `[已实现]` **接口工作台细化（对齐交互文档 v1.6）**：全屏工作台内的「运行记录」（P0 名为「调试记录」，P1-1 起同时收录用例执行故改名）与结果快照 **「替换当前请求」**——把某次执行的请求快照回填到请求区快速改参重发（未保存修改先确认，保留认证配置）；接口列表新增「用例数」列（P0 为预留占位显示 `—`，**已在 P1-1 接入真实 `caseCount` 并可点击进入用例框**；「保存为用例」能力整体在 P1 落地，未提前到 P0）。
8. `[已实现]` **环境默认值与接口筛选（P0）**：接口列表只承担环境筛选，执行环境由接口默认环境、项目默认环境或批量调试弹窗决定。
   - `[已解决]` 接口列表请求方法起始位置已统一左对齐。
   - `[已解决]` 接口编辑页 URL 与复制 cURL 使用未编码的可读文本；实际发送仍由请求构建器执行标准 URL 编码。
   - `[已解决]` 列表页切换项目时不再沿用上一个项目的 `environmentId`；当前选择必须属于当前项目环境集合。
   - `[已解决]` 编辑页环境选择已随接口保存，并参与未保存判断。
   - `[已解决]` 已移除列表页面级“运行环境”控件；列表只负责环境筛选，行内运行不显式传环境。
   - `[已解决]` 已新增项目设置表和默认环境 API；删除环境时外键自动清空默认环境引用。
   - `[已解决]` 接口已新增可空的 `default_environment_id`，创建、更新、详情、复制和列表均返回该字段，并校验同项目归属。
   - `[已解决]` 接口列表 API 已支持 `environmentId=<uuid>` 和 `environmentId=unset`，筛选由 SQL 作用于全量接口数据。
   - `[已解决]` 项目切换时会重置环境筛选，并防止旧项目异步请求覆盖当前项目 store。
9. `[已实现]` **接口列表批量调试（P0，范围已确认）**：只执行选中接口当前已保存的接口定义，不选择或执行接口用例；正式的用例批量执行仍由 P1/P2 的接口用例和测试套件承担。
   - `[已实现]` 列表支持勾选当前筛选结果，并在筛选变化、项目切换或离开页面时清空选择。
   - `[已实现]` 默认按每个接口自己的默认环境执行；用户可明确选择统一覆盖环境或本次不使用环境。
   - `[已实现]` 新增批次父记录，保存总数、成功数、失败数、环境策略、状态和时间范围；每个现有 `Execution` 通过 `batch_id` 关联父批次。
   - `[已实现]` 批量调试结束后在接口列表原地展示汇总与逐接口结果；项目执行记录支持查看批次父记录，单接口记录标识批量来源。
   - `[已实现]` 当前与历史批量调试结果统一使用右侧抽屉，按接口名称列出子项；点击子项打开请求/响应快照，超过 10 条分页，单条不显示分页。
   - `[已实现]` 接口列表支持事务性批量删除：整批校验项目归属后删除，任一校验失败时不删除任何接口。
   - `[已实现]` 批量调试不生成断言结果，不纳入用例通过率或正式回归统计；后端并发固定为 5，单批最多 100 个接口。

### 3.1.1 P0 环境落地清单

**数据库**

1. `[已实现]` 新增 P0 migration，创建 `project_settings(project_id PK/FK, default_environment_id FK NULL)`。
2. `[已实现]` 给 `endpoints` 增加 `default_environment_id UUID NULL REFERENCES environments(id) ON DELETE SET NULL`。
3. `[已实现]` 数据库外键只能保证环境存在，服务端写入时还必须校验环境与项目一致。
4. `[已实现]` 环境删除沿用 `ON DELETE SET NULL`，执行历史继续保留 `environment_name` 快照。

**后端 API**

1. `[已实现]` 新增 `GET /projects/:id/settings` 和 `PUT /projects/:id/settings`，读写项目默认环境。
2. `[已实现]` `POST/PATCH /projects/:id/endpoints` 接收 `defaultEnvironmentId`；`GET` 详情与列表返回该字段。
3. `[已实现]` `GET /projects/:id/endpoints` 增加 `environmentId` 服务端筛选，支持 UUID 和 `unset`，非法值返回 `400`，不静默忽略。
4. `[已实现]` 执行接口未显式传 `environmentId` 时，由服务端依次回退接口默认环境、项目默认环境；显式传空值表示本次不使用环境。

**前端状态**

1. `[已实现]` `EndpointWorkspace` 的环境选择进入 `Draft` 和保存 payload，参与 `dirty` 判断；项目或接口切换时重新加载绑定值。
2. `[已实现]` `EndpointList` 只保留 `environmentFilter` 负责列表查询；行内执行不带环境参数，由服务端按默认优先级解析。
3. `[已实现]` `environmentFilter` 写入 URL query，刷新和分享后结果一致；批量调试的环境策略只存在于该次弹窗，不写入 URL。
4. `[已实现]` 所有环境 ID 在使用前确认属于当前 `projectId` 的环境集合，并阻止旧项目异步加载覆盖当前状态。

**验收标准**

1. 编辑接口选择环境并保存，刷新或重新进入后仍显示已保存环境。
2. 环境筛选后只返回默认环境匹配的接口；“未设置环境”只返回未绑定接口。
3. 切换项目后，不显示或发送上一个项目的环境 ID。
4. 批量调试选择“不使用环境”后执行，不注入任何项目环境变量；未指定时按默认优先级执行。
5. 删除项目默认环境或接口默认环境后，相关引用自动置空，历史执行仍显示原环境名称。

### 3.2 代码重构 (单文件 → 模块化)

**后端重构** — 拆分 `src/index.ts`:

```
src/
├── index.ts          # 入口, 注册插件 + 路由
├── db.ts             # pg 连接池 (已有)
├── migrate.ts        # 迁移执行器 (已有)
├── lib/
│   ├── auth.ts       # JWT 验证 + 密码工具
│   ├── rbac.ts       # 权限中间件
│   └── resolve.ts    # 变量解析
├── routes/
│   ├── auth.ts       # /api/v1/auth/*
│   ├── projects.ts   # /api/v1/projects/*
│   ├── environments.ts
│   ├── endpoints.ts
│   └── executions.ts
├── models/
│   └── types.ts      # 公共类型定义
└── plugins/
    └── response.ts   # 统一响应格式
```

**前端重构** — 拆分 `src/main.tsx`:

```
src/
├── main.tsx          # 入口
├── api.ts            # axios 客户端 (已有)
├── components/
│   ├── Login.tsx
│   ├── Workspace.tsx
│   ├── Dashboard.tsx
│   ├── EndpointList.tsx
│   ├── EnvironmentList.tsx
│   ├── ExecutionList.tsx
│   ├── ExecutionDrawer.tsx
│   └── ProjectSwitcher.tsx
├── hooks/
│   └── useApi.ts     # 数据获取 hook
└── styles.css        # 全局样式 (已有)
```

### 3.3 前端路由 (React Router)

```
/login          → 登录页
/dashboard      → 全局数据看板（默认）
/projects       → 项目管理
/system         → 系统管理
/projects/:projectId → 项目工作台
  /overview     → 项目概览
  /endpoints    → 接口管理
  /environments → 环境管理
  /reports      → 执行记录
```

- 使用 `react-router-dom` v6
- 路由参数 + 查询参数支持深链 (drawer 状态、分页、筛选)
- 路由守卫: 未登录重定向到 `/login`

### 3.4 状态管理 (zustand)

```typescript
// store/authStore
interface AuthStore {
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

// store/projectStore
interface ProjectStore {
  projects: Project[];
  projectId: string | null;
  switchProject: (id: string) => void;
  refresh: () => Promise<void>;
}
```

### 3.5 多语言 (i18n)

- 引入 `react-i18next`
- 语言文件: `zh-CN.json` / `en.json`
- 框架 UI 文案翻译, 动态数据不翻译
- 语言偏好: 本地存储 + 服务端同步

### 3.6 导入与执行快照

- 解析 OpenAPI 3.0 / Swagger 2.0 JSON/YAML
- 解析单条或多条 cURL（方法、URL、Headers、Body、可识别认证）
- 批量创建 endpoints
- 冲突预览与处理（`method + 标准化 URL`，更新 / 跳过 / 另建 / 逐项处理）
- 落库并展示完整 HTTP 快照：请求 Method/URL/Query/Headers/Body，响应 Status/Headers/Body/Content-Type/截断元数据
- 对环境 secrets、Authorization/Cookie/Set-Cookie 等敏感字段统一脱敏
- `[已实现]` **项目级「明文执行记录」开关**（`project_settings.store_plaintext`，默认关，迁移 019）：开启后该项目执行记录的请求/响应快照不再脱敏（`run.ts`、`flowRun.ts` 按标志跳过掩码），便于内部调试签名与鉴权；环境密钥明文会随记录可见，由项目管理员在「环境管理」页头部开关显式开启。

### 3.7 验证方式

- 按当前约束不创建前后端测试文件。
- 后端执行 `pnpm run check && pnpm run build`；前端执行 `pnpm run check && pnpm run build`。
- 关键业务链路用本地服务和浏览器自动化验证：登录默认页、项目 CRUD、项目进入、接口执行、接口内历史、完整快照、OpenAPI/Swagger/cURL 导入。

---

## 四、P1 — 流程编排与测试用例 (7 周)

> **分批交付 (已确认)**: P1 拆成三批，避免单轮改动面过大、无法验收。
>
>
> | 批次 | 范围                                                                                 | 状态       |
> | ------ | -------------------------------------------------------------------------------------- | ------------ |
> | P1-1 | **接口用例 + 断言**（用例 CRUD/执行、断言引擎、工作台「用例」框、caseCount、覆盖率） | **已实现**（含断言配置器收尾：JSON Schema + 自定义脚本，见 4.0.1） |
> | P1-2 | **Flow DAG 编排**（flows/flow_executions、React Flow 画布、节点配置、单步调试）      | **已实现**（见 4.0.2；剩余节点类型与并行执行已并入 P2，见 4.0.3 / 5.0） |
> | P1-3 | **BullMQ + Worker**（队列异步执行、独立 Worker 进程、SSE 进度、取消）                | **已实现** |
>
> P1-1 先做的原因：它是 P2 套件「跨接口用例选择器」的前置依赖，并且补齐了 P0 遗留的 `caseCount: null` 占位。
>
> **P1 已全部交付。** P1-2 的两项遗留（并行执行、流程执行记录独立视图）与剩余节点类型
> 不属于 P1 范围，已确认并入 P2（见 4.0.3、5.0）。

### 4.0 P1 各批次说明

**P1-1 断言配置器收尾已实现**（见 4.0.1）；**P1-2 Flow DAG 编排已实现**（见 4.0.2）。
**脚本断言契约重做已实现**（`ctx.assert` 取代 `return`，见 4.0.2.5）；**命名与展示整理
已实现**（见 4.0.2.6）。

#### 4.0.1 P1-1 断言配置器收尾：JSON Schema + 自定义脚本 `[已实现]`

**落地内容**（新增 `scripts` 表 + `assert.ts` 扩展 + `lib/sandbox.ts` + `routes/scripts.ts`）:

- `AssertionType` 扩为 `status | header | jsonPath | jsonSchema | script`；
  `AssertionOperator` 加 `matchesSchema`、`isTrue`。断言仍只跑在**截断后**的
  响应体上（`RESPONSE_LIMIT = 10000`）；即时验证 `POST /assertions/validate` 与
  worker 内 `evaluateAssertions` 仍走同一函数。
- **JSON Schema 断言**：新类型 `jsonSchema`，schema 文档存 `expected`（文本，
  与现有结构兼容，**不引入 `params` 通用容器**——schema 与脚本的形态差异用各自的
  字段表达：schema 走 `expected`，脚本走 `script` 引用）。用 **ajv** 校验解析后的
  body（`ajv@8` 已装）；schema 非法或 body 非 JSON → 断言 failed 并附消息。
- **自定义脚本断言**：新类型 `script`，用户写 JS **函数体**，作用域内
  `ctx.response.status / .headers / .body / .text`，`return` 真值即通过。
  > **契约已在 4.0.2.5 重做**：改为脚本内 `ctx.assert` 直接断言，`return` 不再
  > 参与判定。本节其余内容（沙箱选型、脚本存储、follow/copy、执行快照）仍然有效。
  - **沙箱选型定案：`node:vm`**，不引入 `isolated-vm`。零原生依赖；worker
    进程隔离是第一道边界。三道加固：host 对象不进 context（ctx 以 JSON 字符串
    跨边界、沙箱内 `JSON.parse` 重建，防 `constructor` 逃逸）、`codeGeneration`
    禁用（禁 `eval`/`Function`）、`console` 在沙箱内定义收集。
  - **脚本 API 形态定案：`ctx` 包裹**（`ctx.response`），为 P1-2 DAG 脚本节点
    预留 `ctx.variables`/`ctx.steps` 扩展位，不重写用户已写的脚本。
  - 超时 1 秒；抛异常/超时/未返回 → 断言失败并展示异常文本（方便调试）。
  - **脚本存储与共享（本轮新增决策）**：
    - 新增 `scripts` 表（`011_p1_scripts.sql`）：**具名公共脚本**（`name` 非空、
      项目级、可被多处引用）与**匿名私有脚本**（随宿主用例生灭、`ON DELETE
      CASCADE`），CHECK 约束二选一。`language` 列现在建（只允许 `javascript`），
      理由同 `workers.mode`：事后加列无法回填历史行。
    - **follow / copy 模型**：引用方前端二选一——follow（共享更新，改公共脚本
      全部生效）或 copy（复制为私有脚本脱离）。公共脚本编辑只走
      `PATCH /projects/:id/scripts/:scriptId`（带引用清单），**用例保存时不允许
      改公共脚本**（400 拒绝），避免一次 ⌘S 静默改写其他用例行为。公共脚本管理
      页在「环境管理 → 公共脚本」tab，删除前强制扫引用返回 409 + 依赖清单，
      `?force=true` 二次确认（对齐 environments 删除语义）。
    - **保存时序**：客户端不做两阶段写。保存 body 里脚本三态——`{scriptId, content}`
      改过→UPDATE、`{scriptId}` 没动→不碰、`{content}` 新建→INSERT+回填 ID；
      **只发脏脚本的正文**，这就是"20 节点流程每步有脚本时保存 body 不膨胀"的答案。
      脚本 upsert 与用例写入在**同一事务**内（`persistCaseScripts`），失败整体回滚。
    - **执行快照**：入队时 `inlineScriptContent` 把 `scriptId` 解析成正文内联进
      `run_spec`，worker 不读 `scripts` 表——保证入队后、执行前有人改公共脚本，
      跑的还是当时那份，执行记录可复现。`run_spec` 终态置 NULL，内联正文不驻留。
    - 前端脚本编辑器支持**折叠**；环境变量编辑器内新增**内置动态变量参数速查**
      （`{{$randomStr(16)}}`、`{{$date(YYYY-MM-DD)}}` 等用法说明）。
  - **内置动态变量参数化（新增）**：`{{$name(args)}}` 形式，无参时行为不变。
    `{{$randomStr(16)}}` 定长、`{{$randomInt(10,20)}}` 定范围、`{{$date}}` 新增
    （`YYYY/YY/MM/DD/HH/mm/ss/SSS`，本地时间）、`{{$timestamp(s)}}` 秒级时间戳。
    `$randomStr` 长度钳制 1–4096，防一次分配过大的数组。

**本会话关键决策回顾**（供验收对照）:

- 具名公共脚本**本轮就做**（而非只留列）：follow/copy 复制脱离解决"改一处炸一片"。
- `node:vm` 而非 `isolated-vm`；`ctx` 包裹而非裸 `(res) => boolean`。
- 用例保存允许改公共脚本的请求被 400 拒绝；公共脚本编辑必须经独立路由确认影响面。
- 并发编辑无乐观锁（沿用全站"后写覆盖"），不为脚本单独引入 `If-Match`。

#### 4.0.2 P1-2 Flow DAG 编排 `[已实现]`

**现状锚点**（P1-2 建在这些已经验证过的能力之上，不要另起炉灶）:

- 执行链路已全异步：入队(`lib/enqueue.ts`) → BullMQ → worker(`src/worker.ts`) →
  `performRun`(`lib/run.ts`) → SSE 推送(`lib/events.ts` + `routes/stream.ts`)。flow 执行
  复用了这条链路，没有在 API 进程里同步跑。
- job 载荷只放 id，worker 从库里回读快照——flow 同理（`flow_executions.run_spec`）。
- 取消、回收、at-most-once 全是执行基础设施层的能力，flow 执行走同一队列因此自动继承。

**本轮确认的三个决策**（此前 4.0.2 留空的部分）:

1. **执行存储 = 父表 + 复用 executions**。新增 `flow_executions` 父记录（类比
   `batch_executions`），每个节点跑出来的**仍是一条 `executions` 行**，
   `source` 扩为第三个值 `flow_step`，新增 `flow_execution_id` / `flow_node_id` /
   `flow_node_name` 三列。这样取消、卡死回收、at-most-once 认领、SSE、请求/响应快照抽屉、
   接口维度历史与覆盖率统计**全部零改动继承**，而不是为流程再写一套平行设施。
   代价是 `executions` 多三列。
2. **首轮只做 request 节点 + 变量提取**。条件/循环/脚本/等待/子流程节点按需排期。
   没有变量提取的 DAG 只是一串互不相干的请求，所以「提取」与「请求节点」必须同批交付。
3. **节点完全快照隔离，可从接口种入**。节点存 `request` 副本 + 断言 + 提取规则，
   `endpointId` 只表达来源与归属（命名、接口维度统计），执行时不回读接口。
   接口后续被改不会回溯影响已建好的流程——与 P1-1 用例同一条原则。

**已落地内容**:

- 迁移 `012_p12_flows.sql`：`flows`、`flow_executions`、`executions` 三列 + `source` CHECK
  放宽；`scripts` 补 `owner_flow_id` 并把 011 的 CHECK 改为「公共脚本无宿主 / 匿名脚本恰好
  一个宿主」（布尔异或）；`flows.nodes` 加 GIN 索引供公共脚本引用扫描。
- 后端：`lib/flow.ts`（校验 + Kahn 拓扑排序 + 提取求值）、`lib/flowRun.ts`
  （`performFlowRun` 顺序执行、变量袋、失败策略）、`lib/inflight.ts`（中断句柄登记表从
  worker.ts 提取为共享模块）、`routes/flows.ts`（FLOWS 路由组）。
- `lib/run.ts` 抽出 `executeRequest`：接口调试、用例执行、流程节点走**同一个**发请求函数，
  传输、超时、截断、掩码、断言判定不可能分叉。
- 前端：`FlowList`（列表 + 新建 + 复制 + 删除 + 行内运行）、`FlowWorkspace`
  （`@xyflow/react` 画布 + 运行条 + 变量弹窗 + ⌘S + 未保存守卫 + `?run=` 深链）、
  `FlowNodeDrawer`（请求/提取/校验三页签 + 单步调试）。画布配色全部改写为设计令牌。

**关键实现取舍**:

- **变量优先级：节点提取 > 流程初始变量 > 环境变量**。提取值必须能盖掉环境里的同名变量，
  否则「先登录拿 token，后续步骤用它」毫无意义——盖不掉就永远在用环境里那个过期的。
- **提取用未掩码响应体**。掩码是给存储与展示用的；若某 token 恰好等于环境 secret，
  掩码后提取到的是一串星号，下一步会带着星号发出去。
- **提取失败让该步失败**，不写空串。后继步骤带着字面量 `{{token}}` 发出去的话，
  报错离真正原因隔了一整步。
- **流程执行占一个并发槽**，与单次执行共用 `executions` 队列（按载荷形状分派）。
  因此 `WORKER_CONCURRENCY` 是「同时几件事」而非「同时几个请求」，估容量按流程数算。
- **流程回收阈值 20 分钟 > 流程总超时 10 分钟**，否则正常长跑的流程会被回收判死。
  节点步骤仍按 `started_at` 走 5 分钟阈值，不受父记录 `created_at` 影响。
- **运行顺序由服务端给**（`POST /flows/plan`）。前端不自己实现一份拓扑排序：两份实现迟早
  分歧，而画布上显示的那个顺序是用户会相信的那个。
- **同层节点按画布位置排序**（上→下、左→右），最后才退回声明顺序。首轮顺序执行，
  边只表达依赖，并列节点必须有一个用户能预测且能通过拖动改变的先后。
- **环有环即报在画布上**，不等到保存才拒绝——那时用户已经离开编辑器。
- **公共脚本删除确认现在同时扫用例与流程**（`scriptUsage` 返回 `users`，含 `kind`）。
  只数用例会低报影响面，让一次删除静默弄坏流程。

**未做（已确认全部并入 P2，见 5.0）**: 并行执行（边目前只表达依赖）、
条件/循环/脚本/数据库/等待/子流程节点、流程执行记录进「执行记录」页的独立视图
（当前经 `?run=` 深链在画布上复盘，节点步骤本身已出现在项目执行记录里）。

#### 4.0.2.1–4.0.2.4 P1-2 多轮体验修复 `[已实现]`

> P1-2 首轮至四轮的验收反馈与体验修复记录已移出开发计划，统一归档到
> `issue_fix/P1-2-体验修复记录.md`（四轮反馈修复，共 15 项）。

#### 4.0.2.5 脚本断言契约重做：`ctx.assert` 取代 `return` `[已实现]`

原契约要求脚本 `return` 真值才算通过，实际写起来别扭：一个脚本只能表达一条判断，
多条检查得自己 `&&` 起来，失败了也说不出是哪一条。本轮把契约改成**在脚本内直接断言**。

**新契约（三条，按重要性排序）**：

1. **`ctx.assert(...)` 决定结果**。硬模式下失败即 `throw`（后续代码不再执行），沙箱
   `catch` 捕获后作为普通脚本错误上报——不新增第二条上报通道。
2. **无断言且无报错 = 通过**。脚本跑到底就是没发现问题。要求「必须 return 或必须
   assert」只是把刚去掉的仪式换个名字加回来（用户明确否决）。
3. **`return` 只是证据**。返回值记录进 `AssertionResult.actual`（与其他断言类型放
   证据的位置一致）并**明确不参与判定**，所以 `return false` 而没有断言的脚本判通过。

**软断言（可选，脚本内开关）**：脚本里写 `ctx.assert.soft = true` 后失败不中断，
全部收集，最后一起报。判定不能只看「有没有抛错」——软模式下什么都不抛——所以沙箱
额外把 `failedChecks` 计数带出边界，宿主据此判失败。

**API**：`ctx.assert(cond, msg)` / `.ok` / `.isTrue` / `.isFalse` / `.equal` /
`.notEqual` / `.contains` / `.exists` / `.notExists` / `.greaterThan` /
`.lessThan` / `.fail(msg)`。`equal` 的宽松比较**对齐 `lib/assert.ts` 的 `compare`**：
两边都是数字就按数字比，所以 header 里的字符串 `"200"` 与脚本里写的数字 `200` 相等。

**逐条明细**：每次 `ctx.assert` 调用（含通过的）记进 `ScriptCheck[]`，随
`AssertionResult.checks` 落库并在 UI 逐条渲染。通过的也留，因为「绿灯且列出验了什么」
与「绿灯但其实什么都没验」必须能区分开——这正是新契约下最容易踩的坑。

**明细是唯一的信息源（验收后修复）**：断言失败（hard 或 soft）**不再**另生成一条
汇总 message（如「1 of 3 checks failed: expected 400, got 200」）——它会和 ✗ 行重复。
沙箱用 `assertThrew` 标志区分「断言抛的错」和「脚本自己抛的错」（TypeError、超时）：
前者不产 message，明细全在 `checks` 里；后者照常带 message，因为没有哪条 check 能
解释它。编辑行的运行结果也不重复渲染 check 列表（明细在响应面板/快照/试运行各出现
一次即可），否则同一份结果会在页面上出现两遍。

**上下文变量读写（本轮新增）**：断言脚本与前置钩子拿同一个 `ctx.variables`，
`ctx.setVariable(名, 值)` 写回。同一条用例内后面的脚本能看到前面写的值（共享一个可变
bag）；流程里按 `hookVariables → extracted → assertionVariables` 顺序汇入变量袋——
断言在响应之后执行，是这一步最新的一份，同名时盖住钩子那份。

**脱敏**（与响应体同规则）：`ctx.variables` 递给脚本的是**已解析**的环境变量，含
secret 明文，所以脚本吐出的 `message`/`logs`/`debug`/`checks`/`returned` 全部过
`sanitizeValue` 再落库或返回。否则一句 `console.log(ctx.variables)` 就把密钥写进了
执行历史。

**存量脚本全部失效（用户已确认接受）**：老脚本用 `return` 表达结论，新规则下返回值不
再参与判定，于是它们变成「无断言且无报错」→ **无条件通过**。这是本轮最大的风险面：
不会报错，只会静默变绿，必须逐个改写为 `ctx.assert`。

**没动的地方**：`AssertionType` 仍是 `script`，存储的 `operator` 仍是 `isTrue`——
它落在每一行历史数据上，且求值时已无意义，改名要配一次数据迁移却换不到任何东西，
所以留着，UI 不展示它。试运行接口 `POST /scripts/try` 的环境加载从 hook 分支上提到
两种 kind 共用，否则读变量的断言会「试运行失败、真跑通过」。

#### 4.0.2.6 脚本断言命名 + 执行结果展示整理 `[已实现]`

验收后两轮体验问题：一个用例挂多个脚本断言时无法区分（编辑器都叫「私有」、结果都叫
「自定义脚本」）；脚本 `return` 的上下文值最长 4KB，直接内联在结果行里把行撑爆、和
✓/✗ 明细混在一起。

**命名（对齐 hooks 的 `HookConfig.name`）**：`Assertion` 增加可选的本地 `name`，
存在用例/节点的 jsonb 里——**纯增量字段，无 DB migration、无 SQL、无接口变更**。
名字是「引用级」的：同一个公共脚本在不同用例里可以各起各的标签，和钩子的行为一致。
编辑器脚本行加名字输入框，留空回退「脚本 N」（与「hook N」同款），执行结果用它当
标签。

**执行结果展示整理**：

- 脚本断言标签从通用「自定义脚本」换成 `name ?? 脚本 N`。
- `return` 值从内联 span 改为**独立折叠块**：≤120 字符直接显示；更长折叠成单行省略号
  +「展开/收起」，展开后等宽块内可滚动。试运行面板同一套样式。
- 试运行结果在**内容变更**或**新的执行结果落地**时自动清空——「先试运行再跑用例，
  面板还挂着旧内容」会让人以为用例没跑。

改动：后端仅 `types.ts`（1 处类型）；前端 `api.ts` / `AssertionEditor.tsx` /
`ScriptAssertionEditor.tsx` / `design-system.css` / `i18n.ts`。

#### 4.0.3 节点类型与流程遗留 → 全部并入 P2 `[已确认]`

首轮只交付 request 节点。其余节点类型与 P1-2 的两项遗留（并行执行、流程执行记录独立
视图）**已确认全部归入 P2**，落地范围与顺序见 5.0。

此处只保留「为什么不留在 P1」的判断，避免后续重新讨论。**「原建议」一列是本次变更前的
旧归属，仅作留档；实际归属一律为 P2**，批次见 5.0。

| 项 | 原建议（已作废） | 并入 P2 的理由 |
| --- | --- | --- |
| **脚本节点** | P1-3 补充（可立即做） | 技术上确实可立即做（沙箱、`scripts` 表、`owner_flow_id`、`ctx.variables` 均已就绪），但它单独交付只能算能力碎片：真实链路里脚本节点常与条件、数据库步骤同时出现。与 P2 一起做可共用同一套「节点执行结果 + 变量袋」抽象。 |
| **条件节点** | P2 | 需要「节点被跳过」状态与边条件语义，与并行调度同源，分开做必然产出两套语义。 |
| **数据库节点** | P2（依赖数据源） | 强依赖 `data_sources` / `sql_definitions`，P1 内无从执行。 |
| **循环节点** | P3 或按需 | 迭代变量、最大轮次、失败中断都与并行执行纠缠；并行执行本身也已并入 P2，因此循环节点最早只能在 P2 的并行模型确定之后——若 P2 内取舍不做，则顺延而非回到 P3。 |
| 等待 / 子流程 | 按需 | 等待节点成本极低但价值取决于真实场景；子流程需要先有稳定的流程复用语义。两者均在 P2 末尾按需取舍。 |
| **并行执行**（P1-2 遗留） | — | 首轮边只表达依赖、顺序执行。改为并行要同时定义并发上限、局部失败对后继节点的影响、以及与 `WORKER_CONCURRENCY` 的关系；条件与循环节点都建立在这套语义上，因此必须先于它们确定。 |
| **流程执行记录独立视图**（P1-2 遗留） | — | 当前节点步骤已进入项目执行记录，父记录只能经 `?run=` 深链复盘。P2 会出现套件执行这类新的父级执行，届时统一设计「执行索引」比现在单独为 flow 做一个视图更省。 |

### 4.1 数据库迁移

`[已实现]` **接口用例相关**（`007_p1_test_cases.sql`，实际序号接在 P0 的 006 之后，计划原写的 `002_p1_schema.sql` 为过时命名）:

```
test_cases         (id, project_id, endpoint_id, environment_id, environment_name,
                    name, description, request_snapshot JSONB, assertions JSONB, tags,
                    created_at, updated_at)
                   # 用例 = 接口请求快照 + 环境 + 断言，完全快照隔离；接口后续修改不影响已保存用例
executions 扩展     (source CHECK(endpoint_debug|test_case), case_id, case_name,
                    assertion_results JSONB)
                   # 接口调试与用例执行共用一张表但可分离：侧栏「运行记录」默认两类都看，
                   # 可按来源筛选；用例「最近结果」只看自己的 case_id
```

`[已实现]` **异步执行与执行器注册**（P1-3，`008~010`）:

```
008 executions 扩展   (status 扩为 queued|running|success|failed|canceled,
                     started_at, finished_at, run_spec JSONB)
                     # 「入队即落库」：前端拿到 executionId 立刻能查到这一行。
                     # run_spec 存未插值快照({{var}} 还是字面量), 终态后置 NULL——
                     # worker 只从 job 的 executionId 回读, Redis 里没有请求体/凭据
009 workers 表       (id=hostname:pid, hostname, pid, concurrency, inflight,
                     version, started_at, last_seen_at)   # 心跳注册表
    executions 扩展   (worker_id TEXT)                    # 执行归属, 无外键
010 workers 扩展      (mode TEXT CHECK(endpoint|repository), 默认 endpoint)
                     # 仓库模式预留: 现在加列免回填, 回填时无法区分历史行
```

`[已实现]` **脚本存储**（P1-1 断言收尾，`011_p1_scripts.sql`）:

```
011 scripts 表       (id, project_id FK, name TEXT NULL, language CHECK('javascript'),
                     content TEXT, owner_case_id FK ON DELETE CASCADE,
                     created_at, updated_at)
                     # 具名公共脚本: name 非空 + 无 owner, 项目级可复用
                     # 匿名私有脚本: name NULL + owner_case_id 非空, 随用例生灭
                     # CHECK: (name IS NOT NULL AND owner_case_id IS NULL) OR
                     #        (name IS NULL AND owner_case_id IS NOT NULL)
                     # name 唯一索引 (project_id, name) WHERE name IS NOT NULL
    test_cases 扩展   (assertions GIN 索引)  # 供公共脚本引用扫描 (containment 查询)
```

`[已实现]` **Flow DAG 编排**（P1-2，`012_p12_flows.sql`）:

```
012 flows 表          (id, project_id FK, name, description, environment_id/name,
                      nodes JSONB, edges JSONB, variables JSONB, tags, 时间戳)
                      # nodes[] = { id, type:'request', name, position, endpointId,
                      #             request 快照, assertions, extracts, onFailure }
                      # nodes 加 GIN 索引: 公共脚本引用扫描要能命中节点断言
    flow_executions   (id, project_id, flow_id FK ON DELETE SET NULL, flow_name 快照,
                      environment_id/name, status(同 executions 五态), total,
                      success/failed/skipped_count, error, plan JSONB, variables JSONB,
                      run_spec JSONB, worker_id, created/started/finished_at)
                      # plan 终态保留（只有标识与名称），run_spec 终态置 NULL（含 auth 明文）
    executions 扩展    (source CHECK 加 'flow_step', flow_execution_id FK ON DELETE SET NULL,
                      flow_node_id TEXT, flow_node_name TEXT)
                      # 节点 id 是流程文档内的字符串, 不是表主键, 所以无外键可加
    scripts 扩展       (owner_flow_id FK ON DELETE CASCADE, CHECK 改为
                      公共脚本无宿主 / 匿名脚本恰好一个宿主)
```

**边界决策**:

- **不引入 `assertions` 公共库表**：交互文档未提供「断言库」界面，断言直接内联存在用例的 `assertions JSONB` 里；等出现复用需求再抽表。
- **不引入 `execution_index` 统一执行索引**：当前只有接口调试与用例两类执行，`executions.source` 已足够区分；等 P2 套件带来新的父级执行时再建索引表，避免过早抽象。
- **用例删除保留历史**：`executions.case_id` 为 `ON DELETE SET NULL` 且 `case_name` 已快照，删用例不删执行记录（Spec 4.4 历史保留）。
- **run_spec 终态置 NULL**：它携带 auth 明文且没有读取方，落终态即清空，最小化凭据驻留。
- **脚本引用存在 JSONB 里，所有权用真 FK**：断言/节点在 `assertions` JSONB 内以 `{ script: { scriptId } }` 引用，删除用例时匿名脚本靠 `owner_case_id` 的 `ON DELETE CASCADE` 回收，不用多态 `owner_type/owner_id`——多态没有外键，删除必须手写清理，迟早漏。
- **flows 执行取「父表 + 复用 executions」** `[P1-2 已定]`：`source` CHECK 扩出第三个值
  `flow_step`，节点执行仍是 `executions` 行，父记录另立 `flow_executions`（迁移 012）。
  另一个选项——节点结果全塞进父表 JSONB——被否决：那样快照抽屉、取消、卡死回收、接口维度
  历史都要各写一套，且流程步骤不会出现在「执行记录」里。`scripts` 同批加 `owner_flow_id`
  并把 CHECK 改成「公共脚本无宿主 / 匿名脚本恰好一个宿主」。

### 4.2 后端新 API

```
FLOWS  [已实现] (P1-2)
  GET/POST /projects/:id/flows
  GET/PUT/DELETE /projects/:id/flows/:flowId
  GET  /projects/:id/flows/:flowId/usage            # 删除前引用扫描 (P2-4.5): 套件成员 + 子流程节点
  POST /projects/:id/flows/:flowId/execute        (可传 nodes/edges/variables 覆盖, 跑画布当前状态而不落盘)
  POST /projects/:id/flows/:flowId/nodes/execute  (单步调试: 走 enqueueRun, 返回普通 Execution)
  GET  /projects/:id/flows/:flowId/executions
  GET  /projects/:id/flow-executions/:flowExecutionId         (父记录 + 每一步的 executions)
  POST /projects/:id/flow-executions/:flowExecutionId/cancel  (已终态返回 409)
  POST /projects/:id/flows/plan                   (拓扑排序结果或「有环」原因, 供画布显示步骤序号)

TEST CASES  [已实现]
  GET    /projects/:id/endpoints/:endpointId/cases   (接口工作台「用例」框列表, 含最近结果 lastRun)
  POST   /projects/:id/endpoints/:endpointId/cases   (保存为用例: 请求快照+环境+断言)
  GET    /projects/:id/cases                          (跨接口用例检索, 供 P2 选择器复用)
  GET    /projects/:id/cases/:caseId
  PATCH  /projects/:id/cases/:caseId                  (改名称/标签/环境, 亦可整体改写 request 快照与断言)
  DELETE /projects/:id/cases/:caseId                 (被套件引用时 409 + 清单, ?force=true 才删)
  GET    /projects/:id/cases/:caseId/usage           # 删除前引用扫描 (P2-4.5)
  POST   /projects/:id/cases/:caseId/execute          (可传 request / assertions 覆盖, 试跑屏幕上的改动而不落盘)
  GET    /projects/:id/cases/:caseId/executions
  GET    /projects/:id/endpoints                      (增强, 列表返回真实 caseCount)
  # 全部挂在 /projects/:id/** 之下: requireProjectAccess 只认 :id,
  # 计划里裸 /cases/:caseId 的写法拿不到项目守卫, 已改为项目内嵌套路由

ASSERTIONS  [已实现]
  POST /projects/:id/assertions/validate  (即时验证, 可传 environmentId / variables
                                           让脚本断言的 ctx.variables 与 { secret } 与真跑一致,
                                           返回 variables = 脚本 setVariable 写回的值)
  # 不做 assertions 公共库 CRUD: 断言内联存于用例, 无「断言库」界面需求

SCRIPTS  [已实现] (P1-1 断言收尾)
  GET    /projects/:id/scripts             (公共脚本列表, name IS NOT NULL, 支持 keyword; 带 page/pageSize 走服务端分页, 缺省全量供选择器用)
  POST   /projects/:id/scripts             (新建公共脚本)
  GET    /projects/:id/scripts/:scriptId
  PATCH  /projects/:id/scripts/:scriptId   (编辑公共脚本, 响应带 follower 清单)
  DELETE /projects/:id/scripts/:scriptId   (有引用时 409 + 依赖清单, ?force=true 二次确认)
  GET    /projects/:id/scripts/:scriptId/usage  (引用此脚本的用例列表)
  POST   /projects/:id/scripts/try         (脚本试运行, 返回 console 输出与抛错文本)
  # 匿名私有脚本无独立生命周期, 由用例保存路径写入 (lib/scripts.ts), 不在本路由组暴露

EXECUTIONS  [已实现]
  GET /projects/:id/executions  (增强, 支持 source / caseId 过滤; 列表按「执行对象」显示用例名)
  GET /projects/:id/endpoints/:endpointId/executions  (增强, 默认返回全部来源, 可按 source 收窄)
```

### 4.3 前端新页面

- **Flow 编辑器** `[已实现]`: React Flow DAG 画布 (`@xyflow/react`)
  - 首轮节点类型: **API 请求**（条件/循环/脚本/等待/子流程已实现；**MCP 工具节点撤销**——
    那是「平台当 Client」方向，随 P5 范围收窄一并移出，见 9.0 第一条与交互文档 3.5.1）
  - 拖拽连接, 节点配置抽屉（请求 / 提取 / 校验三页签）
  - 单步调试 + 流程变量注入; 画布配色全部改写为设计令牌, 不用 xyflow 默认调色板
- `[已实现]` **接口工作台「用例」框** (入口在接口管理, 无独立用例导航页):
  - 右侧栏分段切换 `[用例 | 运行记录]`, 同一框内二选一, 不新增常驻空间; **用例为默认视图**
  - 用例列表支持**名称搜索 + 状态(通过/失败/未执行) + 标签**筛选; 行内常驻 运行/编辑/删除 按钮
  - 「保存为用例」: 请求快照+环境+断言, 按最近响应状态码预填 `$.status = 200`; 保存后**自动加载该用例**
  - 点击用例加载快照替换请求区 + 顶部标识与 `[返回调试]`; 用例完全快照隔离
  - 加载后顶部出现主按钮**「保存用例」**, 一次写入请求快照 + 校验规则; `[另存为新用例]` 用于派生变体
  - 未保存时点「执行用例」按**屏幕上的**请求与规则试跑, 不落盘; 深链 `endpoints/:id?case=:caseId`
  - 接口列表「用例数」可点击, 跳转并直接定位到用例框
  - **用例删除暂不做依赖扫描**: 套件在 P2 才出现, 当前无引用方; 删除保留执行历史
- `[已实现]` **工作台「校验」页签**: 仅在加载用例时出现, 与请求页签并列
  - 左侧页签描述「发什么请求」, 校验页签描述「返回必须满足什么」, 以此区分用例与接口定义
  - 表格/文本双模式; 文本格式 `$.status = 200`、`$.headers.content-type ~ json`、`$.body.data.token exists`
  - **快速提取**: JSONPath 从响应 Body 解析成可勾选树, Header 从响应头列表勾选; 勾选多个则生成多条断言
- `[已实现]` **参数 / 请求头文本模式**: `key: value` 或 `key=value` 按行解析, 便于整段复制粘贴
  (按首个分隔符切分, 故 `https://…` 与 `Bearer a=b` 不会被截断; 整行 `#` / `//` 为注释)
- `[已实现]` **保存快捷键**: `⌘S` / `Ctrl+S` 保存当前对象(用例或接口), 未保存徽章直接标注该快捷键
- **跨接口用例选择器** `[P2 交付]`: 后端 `GET /projects/:id/cases` 已就绪, 弹窗随套件一起做
- `[已实现]` **断言配置器**: 支持**状态码 / Header / JSONPath / JSON Schema / 自定义脚本**
  (P1-1 收尾, 见 4.0.1)。JSON Schema 用独立 textarea + 实时 JSON 合法性校验;
  脚本用 Monaco 编辑器 + 试运行(带示例/当前响应上下文) + 折叠。脚本断言在脚本内用
  `ctx.assert` 直接断言, 逐条通过/失败在行内展开 (契约见 4.0.2.5); 支持本地命名、
  `return` 值在结果里以折叠块展示 (见 4.0.2.6)。
- `[已实现]` **公共脚本管理页** (环境管理 → 公共脚本 tab): 公共脚本 CRUD、
  引用数、编辑时显示跟随用例清单、删除两段式确认、**列表服务端分页**
  (page/pageSize, 依赖库下拉仍走全量接口)。接口工作台内公共脚本**只读**
  (跟随态不可编辑, 编辑统一在环境管理页, 避免在接口页顺手改影响其他用例)。
- `[已实现]` **内置动态变量参数化**: `{{$name(args)}}`, 环境变量编辑抽屉内有
  可折叠的参数速查表 (`{{$randomStr(16)}}` / `{{$date(YYYY-MM-DD)}}` / ...)。

### 4.4 基础设施

- `[已实现]` **BullMQ 接入** (P1-3): 队列 `executions`, job 载荷**只有 executionId**,
  请求定义与断言一律由 worker 回读 `executions.run_spec`。这样 Redis 中不存在任何
  请求体与凭据, 队列也不会成为第二真相来源。
- `[已实现]` **Worker 进程** (P1-3): `pnpm worker` / `pnpm start:worker` 独立进程,
  全局并发由 `WORKER_CONCURRENCY` 控制(默认 10), 取代了 P0 批量调试里硬编码的并发 5。
- `[已实现]` **执行事件流**: `GET /projects/:id/executions/stream` (SSE), worker 经
  Redis pub/sub 把状态变更转给 API 进程再扇出给浏览器。

**边界决策 (P1-3)**:

- **三个入口全部真异步**: 接口调试、用例执行、批量调试统一返回 `202` + 一条
  `queued` 的 execution/batch 记录, 结果经 SSE 到达。单发调试**前端交互不变**
  (仍是按钮转圈等结果), 异步只体现在底层与「排队中」状态上。
- **入队失败直接报错, 不降级内联执行**: Redis / worker 不可用时返回 `503`, 前端提示
  「执行队列不可用」。保留内联兜底会让同一份代码有两条执行路径, 行为差异(并发、取消、
  进度)只能靠猜, 排查成本高于收益。因此**日常开发必须同时起 `pnpm dev` 与 `pnpm worker`**。
- **执行记录改为「入队即落库」**: `executions.status` 扩展为
  `queued | running | success | failed | canceled`。代价是所有读取方必须自己区分
  「还没跑完」与「跑完失败」——仪表盘通过率的分母因此只算 `success + failed`,
  否则点一次执行数字就会自己跳动。
- **取消支持中断在途请求**: 服务端置 `canceled` + Redis 广播, worker 侧用
  `AbortController` 打断 `fetch`。终态写入带 `WHERE status = 'running'` 守卫,
  以此解决「取消信号与正常完成同时到达」的竞争——先落库者胜, 不会把已成功的结果
  覆写成 canceled。
- **不做分组限流**: BullMQ 开源版无 Groups, 用多队列或自建令牌模拟的复杂度不值当。
  当前为单队列全局并发, 单项目跑大批量时会占满槽位, 内部工具的并发规模可接受。
- **不自动重试**: 一次执行是一条用户可见记录, 自动重跑会凭空多发一次请求, 对写接口
  尤其危险。`attempts: 1`, 重跑由用户决定。
- **卡死回收**: worker 每 60 秒扫一次, 把超过 5 分钟仍未终态的行判为
  `execution abandoned by worker`(单次执行上限 30 秒, 超出必属事故), 并重算所属批次。
  这同时修掉了 P0 遗留的「批次永久停在 running」问题。
  回收用 `pg_try_advisory_xact_lock` 互斥, 多 worker 时同一时刻只有一个真正执行
  ——UPDATE 本身幂等, 但紧随其后的 `settleBatch` 会被重复触发, 导致同一批次被并发
  重算并各广播一次进度。事务级锁随事务结束自动释放, 进程崩了也不会把锁留下。

### 4.5 执行器可观测 (P1-3)

- `[已实现]` **心跳注册表** (`workers` 表): worker 每 10 秒 upsert 自己的
  hostname/pid/并发度/在途数, 「在线」由 `last_seen_at` 新鲜度在读取时推断
  (阈值 30 秒 = 3 个心跳)。worker 不监听端口, 平台无法主动探它, 只能由它自报;
  在线状态不落库是为了避免 kill -9 之后留下永远「在线」的幽灵行。
- `[已实现]` **执行归属** (`executions.worker_id`): 多 worker 后「某些执行特别慢」
  必须能落到具体进程上。不加外键——worker 下线后注册行会被清掉, 而执行历史必须
  活得比它久。
- `[已实现]` **系统设置 →「执行器」**: 在线数/总容量/在途/排队/失败任务 + 每个
  worker 的负载与运行时长。仅系统管理员可见 (`requireSystemAdmin`), 对其他人整块
  不渲染而非报错。
- `[已实现]` **worker 模式** (`workers.mode`): `endpoint` | `repository`。仓库模式
  尚未实现, 但列现在就加——等真做出来再加需要回填, 而回填时无法判断历史行属于
  哪种模式。worker 通过 `WORKER_MODE` 上报, 默认 `endpoint`。
- `[已实现]` **页面结构**: 顶部 `.tabs` 分「个性设置 / 执行器」(两类互不相关的内容),
  执行器内用 `.segmented` 按模式筛选(同一份内容的不同切片)。不做两层 tab——同页
  两排下划线 tab 无法区分层级。模式切换控件**由实际上报的模式推导**, 只有一种模式
  时不渲染, 将来仓库 worker 一上线自动出现, 无需改代码解除隐藏。
- `[已实现]` **死记录清理**: worker 启动时用 `process.kill(pid, 0)` 检查**本机**
  历史行对应的进程是否还在, 仅 `ESRCH` 时删除(`EPERM` 说明进程活着只是属主不同)。
  优雅停机会自己摘注册, 但 SIGKILL 来不及——`tsx watch` 每次保存换一个 pid, 没有
  这步开发时面板会堆满死 worker。跨主机的陈旧行仍由回收扫描按 1 小时窗口清理。

**边界决策**: **只读, 不做控制**。不提供暂停队列、排空 worker、在线调并发。增减
执行能力靠启停进程, 平台不代管进程生命周期——否则平台需要持有对部署环境的写权限,
而一个「误点暂停」会让所有人的执行静默卡住。

**队列指标按模式隔离**: 「排队/失败」读的是 `executions` 队列, 只对 endpoint 模式
成立。仓库模式必然是另一个队列, 因此响应里队列指标以 mode 为键, 没有队列的模式
不渲染这两项——显示 0 会被读成「没有任务在等」, 而事实是「这个模式还没有队列」。

> **P2-8 修订（已实现，见 5.0.12）**: 执行分区落地后队列指标变成 **mode + label 双键**
> ——`executions` 一条队列会按分区标签分裂成 `executions-<label>` 多条, 面板新增
> `partitions[]` 轴。上面这条「没有队列就不渲染」的原则不变, 只是判断维度多了一层;
> `mode` 仍不参与路由, 与 `labels` 是正交轴。
> 分隔符是 `-` 而非 `:`——BullMQ 6 拒绝名字里带 `:` 的队列（它自己用 `:` 拼 Redis key
> 的层级），实现时踩过这个坑, 见 issue_fix/P2-8_ISSUE_LOG.md。

### 4.6 单机部署 (不使用 compose)

一次构建, 两个入口, 同一份产物:

```bash
pnpm build          # tsc → dist/
pnpm migrate        # 必须先跑: 新 API 会写 status='queued', 旧 CHECK 约束不允许
node dist/index.js       # API
node dist/worker.js      # worker
```

- **IO 密集, 单进程足够**: 执行是等待 HTTP 响应, 不吃 CPU。单机优先调大
  `WORKER_CONCURRENCY`, 而不是起多个 worker 进程。多进程只在响应体巨大、JSON 解析
  成为瓶颈时才有意义。
- **停机宽限期必须 > 30 秒**: worker 收到 SIGTERM 后会等在途请求跑完再退出, 而单次
  请求上限是 30 秒。systemd 默认 `TimeoutStopSec=90` 够用; **pm2 默认
  `kill_timeout` 只有 1600ms, 必须显式改成 45000**, 否则每次重启都会留下一批
  `running` 的行, 要等 5 分钟后的回收扫描才收尾, 用户看到的是「转圈五分钟然后失败」。
- **滚动更新安全**: job 载荷只有 executionId, 新旧版本 worker 可同时消费同一队列,
  不需要停机或排空。
- **worker 无入站端口**: 只出站到 Redis / Postgres / 被测目标, 因此可放在受限网段;
  存活状态从心跳表读, 不需要健康检查端点。

> **P2-8 补充（已实现，见 5.0.12）**: 上面这条「可放在受限网段」正是执行分区的实施基础，
> 但它有一个必须先落实的前提——**那台机器要能出站到平台的 Redis 6379 与 Postgres 5432**。
> 分区 worker 用 `WORKER_LABELS` 声明自己服务哪些分区（默认 `default`）。
> **推荐一个进程只服务一个标签**：BullMQ 的 Worker 绑定单队列, 一个标签一个 Worker 实例,
> 多标签进程必须按 `floor(WORKER_CONCURRENCY / 标签数)` 拆分并发, 否则上报的容量会翻倍失真。
> 生产网段那台 worker 不由 `start.sh` 代管——它不在本地, 与 4.5「平台不代管进程生命周期」
> 同一条边界。

### 4.7 P1-3 收尾修复与关键决策 (本会话)

**断言在 worker 内执行，一次写入定终态**（`lib/run.ts:188-209`）:

- 发完请求、读完响应后，断言求值与 `status` 判定在**同一个 worker 函数里完成**，
  结果、断言明细、终态 status 在同一条 `UPDATE` 落库。平台侧不参与执行。
- **有断言时断言说了算**，没断言才看 HTTP 状态码（`$.status = 404` 的用例收到 404 算通过）。
- 若改成「worker 发请求、平台再校验」，会出现终态已落、断言未判的窗口期，需要二次
  写入翻转 status——而 status 驱动仪表盘通过率、用例最近结果、批次汇总，多一次翻转
  就是多一处不一致。
- 断言跑在**截断后**的响应体上（`RESPONSE_LIMIT = 10000`），保证「断言通过」能从
  UI 看到的文本复现；JSONPath 指向 10KB 之后会取不到，大响应体接口需留意。

**多 worker 下保证 at-most-once**（非 at-least-once）:

- 第一层：BullMQ 原子出队，一个 job 只交给一个 worker。但这层不够——BullMQ 是
  at-least-once，worker 锁续期失败会重投 job。
- 第二层：`performRun` 认领带 `WHERE status = 'queued'`，被重投的 job 匹配不到
  `queued` 行，在 `fetch` 之前就返回 false。
- 三 worker 抢同一队列实测：80 次入队，靶子恰好收到 80 个请求，零重复。
- 这是刻意选择：工具会向真实服务发 POST/DELETE，「执行丢了」可重跑，「静默发了两次」
  无法挽回。代价是极端情况下会出现一条卡在 running、最终被回收判失败的无害记录。

**SSE 跨域坑**: `reply.hijack()` 之后 Fastify 不再走发送流程，@fastify/cors 挂到头上的
`Access-Control-*` 不会写出，浏览器直接拦掉流，前端退回轮询兜底——表现为「每次执行都
慢 3 秒」而不是「流坏了」。修复是手动把 CORS 头搬进 `writeHead`（只搬 access-control-*，
不整包 spread）。curl 测不出此问题，因为 curl 不检查 CORS。

**前端会话恢复 bug**: `authStore.hydrate()` 定义了但从未被调用，刷新后 `user` 恒为
`null`，任何按 `isSystemAdmin` 门控的区块（执行器面板）静默消失。修复在
`main.tsx` 的 `Root` 加一次 `useEffect(() => hydrate())`。教训：门控 UI 用
「整块不渲染」时，权限数据的初始化失败表现为功能消失而非报错，极难定位。

**前端体验修复**:

- **响应面板不再闪屏**: 运行状态只占标题栏（排队中/执行中 + 取消按钮），结果 body
  保持挂载、半透明置灰——之前是整面板替换，快响应（~50ms）下「结果→空白→结果」闪屏。
- **侧边栏分页** (`SidebarPager`): 运行记录与用例列表共用。修正了一个 antd 默认值坑：
  `Pagination` 的 `showSizeChanger` 默认是 `total > 50` 而非 false，不显式传参时列表
  跨过 50 行会凭空出现第二个页大小选择器。用例列表用**前端分页**（筛选是全量客户端
  过滤 + `lastRun` 在应用层拼装，服务端分页会让筛选退化成只筛当前页）。
- **复制按钮** (`CopyButton`): 工作台响应区 + 快照抽屉各代码块。复制的文本与渲染
  共用同一函数（响应体有 pretty/raw 切换，另走格式化路径会复制出和看到不一样的内容）；
  反馈用图标变对勾而非 toast；`navigator.clipboard` 只在安全上下文存在，textarea
  兜底是局域网 http 访问的主路径而非老浏览器兼容。
- **系统设置 tabs**: 顶部 `.tabs` 分「个性设置/执行器」（互不相关的内容），非管理员
  看不到执行器 tab 且整条 tab 栏不渲染。

### 4.5 P1-1 关键取舍 (已验收)

- **调试态「执行」会隐式保存接口定义**: `/endpoints/:id/execute` 由服务端读库发起,
  屏幕上的改动必须先落库才生效。已确认保留此行为, 但**保存 toast 静默**, 避免每次执行都弹提示;
  手动保存(按钮或 `⌘S`)仍有提示。
- **用例态「执行」不落盘**: 请求与断言作为覆盖参数传给后端, 存盘用例不受影响, 与上一条刻意不同。
- **用例编辑弹窗只管名称/标签/环境**: 请求与校验规则统一在工作台内改, 保证一份数据只有一个编辑入口。

---

## 五、P2 — 套件、Mock、数据源 + 流程补全（核心 8 周 + 数据源适配器增量）

> 场景（P2-3）已实现后撤回，编排统一由流程承担。见 5.0.6。

> **范围变更（已确认）**: P1-2 的两项遗留（并行执行、流程执行记录独立视图）与
> 全部剩余节点类型（脚本 / 条件 / 数据库 / 循环 / 等待 / 子流程）**并入 P2**。
> 核心闭环仍按 8 周规划；PostgreSQL 以外的数据源驱动按 P2 增量切片追加，不阻塞核心里程碑。
> 判断依据见 4.0.3。

### 5.0 P2 交付顺序（含 P1-2 并入项）

不按「先做完上层资源再补流程」排，而是按**依赖方向**排：下层语义没定，上层做完必然重做。

#### 5.0.1 已确认的实施边界（2026-08-13）

1. **数据源 PostgreSQL 先行**：先完成连接配置、凭据保护、命名 SQL、参数绑定、测试运行、
   流程数据库节点的完整纵向闭环。MySQL / SQL Server / Oracle / MongoDB /
   Redis 通过同一适配器契约在 P2 后续小批次加入，不要求首批同时落地。
2. **纵向闭环递增交付**：每个小批次必须能独立进入页面、保存配置、执行、取消、查看结果与历史；
   不采用「后端全部完成后再集中补前端」或「所有节点一次做完再验收」的横向大批次。
3. **高级节点留在 P2 后段独立切片**：脚本 / 数据库 / 并行 / 条件先稳定，套件不等待
   循环 / 等待 / 子流程；后三者仍属于 P2，但在核心业务闭环后分别验收。
4. **编排只有流程一种模型**（2026-08-15 修订）：原计划的场景「简化步骤编排」已撤回——它与
   流程解决同一个问题，却把「谁产出变量、谁消费变量」切到多个页面（见 5.0.6）。测试套件
   只负责编排成员，不直接执行 HTTP 或 SQL，成员之间也不传变量。
5. **Mock 与正式执行统计隔离**：Mock 请求日志不写入现有接口/用例通过率；管理 API 继续走
   JWT/RBAC，外部 Mock Runtime 使用独立路径和安全边界（定位确认见 5.0.7：面向外部联调方）。
6. **P2-1 前端边界已实现（2026-08-13）**：项目侧栏仅启用数据源入口，不提前展示 Mock /
   套件；数据源详情与 SQL 编辑目标由 URL 恢复，密码、SQL 参数值不进入 URL 或 localStorage；
   Flow 前端已升级为 `request | database` 判别联合，数据库节点使用独立配置与结果视图。

#### 5.0.2 开工前置：统一执行模型（P2-0，纳入第 1 周）

> **后端已实现（2026-08-13）**：`execution_index` / `execution_steps` 已落库，历史 Flow
> 已回填索引；新 Flow 的请求/数据库步骤、状态计数、取消和回收已接入统一模型。统一记录前端
> 视图仍按 P2-4 交付。

现有 `executions` 是 HTTP 证据表，`endpoint_id NOT NULL`，不能继续硬塞脚本、条件、数据库、
等待等非 HTTP 节点。P2 先建立以下公共模型，再开发新节点：

- 新增 `execution_index`：统一记录 flow / scenario / suite / batch 父执行的类型、目标快照、状态、
  计数和时间；状态统一沿用现有 `queued | running | success | failed | canceled`，不再引入
  `pending` / `aborted` / `cancelled` 等第二套词汇。
- 新增通用 `execution_steps`：每一步保存节点类型、名称快照、状态、耗时、输入/输出摘要和错误；
  HTTP 步骤通过可空 `http_execution_id` 关联现有 `executions`，继续复用请求/响应/断言快照；
  非 HTTP 步骤只写自己的受限结果，不伪造 endpoint。
- 新产生的 flow 执行同时写索引和步骤；历史 `flow_executions` 保持可读，迁移为其补索引，
  不重写既有 HTTP 子记录。统一执行记录 UI 到第 3 批启用，但数据模型在第 1 批先落地。
- 父任务仍占一个 BullMQ worker 槽；流程内并行另设受控上限，默认 4、最大 10。容量按
  `WORKER_CONCURRENCY × 节点并发上限` 评估，禁止无界 `Promise.all`。
- 同一并行阶段向变量袋写同名变量视为冲突并使对应步骤失败，禁止依赖完成先后产生非确定结果。
- 默认依赖边只在前驱成功后激活；失败节点 `stop` 终止整次父执行，`continue` 允许无依赖的其他
  分支继续，其默认成功后继标记 skipped，只有显式失败分支可以继续。

#### 5.0.3 核心 8 周切片

| 周次 | 切片 | 可验收交付 | 状态 |
| --- | --- | --- | --- |
| 1–2 | **P2-1 数据源闭环** | 执行索引/步骤基础；PostgreSQL 数据源 CRUD、凭据加密、连接测试；命名 SQL CRUD/试跑；流程数据库节点 | **已实现并通过用户验收** |
| 3–4 | **P2-2 核心流程补全** | 脚本节点、分层/受控并行、条件节点、非 HTTP 单步调试、节点结果与变量冲突展示 | **已实现并通过用户验收**（见 5.0.4） |
| 4+ | **P2-2.1 请求节点生命周期收尾** | 前置处理 → 请求 → 后置处理（提取+响应脚本）→ 声明式校验 → 成功提交变量；脚本校验迁入响应脚本；变量事务与使用文档分层 | **已实现，待用户验收**（见 5.0.5） |
| 5 | ~~**P2-3 场景**~~ | ~~接口用例 + 数据库步骤、后置 SQL 校验、变量映射、执行/取消/步骤报告~~ | **已撤回**（见 5.0.6，与流程编排重复） |
| 6 | **P2-4 测试套件 + 执行记录** | 手动/标签/全部选择、**用例与流程**成员快照、并发与 fail-fast、统一父执行列表和稳定详情路由 | **已实现并通过用户验收**（P2-4.1–P2-4.5 于 2026-08-26 全部验收；范围与边界见 5.0.11） |
| 7 | **P2-5 Mock** | 对外联调桩：自动快照/固定/模板/代理四种规则，独立 Runtime 公开访问、保护性安全上限、规则测试与联调请求日志 | **已实现并通过用户验收**（2026-08-27 验收；定位见 5.0.7，实现范围见「第 4 批 · Mock」） |
| 8 | **P2-6 高级节点** | 循环、短等待、子流程，递归/迭代/等待上限；核心链路遗留收口 | **已验收**（见 5.0.8） |
| — | **P2-8 执行分区** | 环境级执行分区标签、队列按标签路由、分区 worker、入队前在线检查、执行器面板分区轴 | **已实现并通过用户验收**（P2-8.1–P2-8.6 于 2026-08-26 完成，P2-8.7 配置体验补齐于 2026-08-27 增补，2026-08-27 验收；范围与边界见 5.0.12） |

PostgreSQL 以外驱动作为 **P2-7 数据源适配器增量** 逐类交付。关系库先复用 SQL 契约；
MongoDB / Redis 使用独立操作定义，不伪装为 SQL，也不阻塞 P2 核心 8 周验收。
**P2-7.1–P2-7.4 已全部实现并于 2026-08-22 通过用户验收**（范围、分批与验收结论见 5.0.10）。

**P2-8 执行分区**不占核心 8 周的周次，它是一条由环境问题触发的增量切片（内网测试/生产网段
互不连通，worker 只能从自己所在网段出站）。它**不阻塞** P2-4 / P2-5，但**有一条硬前置条件**
（生产网段能否出站到平台 Redis + Postgres），前置不成立则本切片作废并转 P4.5。范围见 5.0.12。

**第 1 批 · 数据源（约 2 周）**

后端状态：`[已实现]`。包含 PostgreSQL 数据源/命名 SQL API、AES-256-GCM 密码补丁语义、
受限参数化 SQL 执行器、usage/force 删除，以及 Flow 数据库节点和通用单步结果。本轮按约束
未运行自动验证或启动服务，联调验收状态保持未完成。

- `data_sources` + `sql_definitions`，首发 PostgreSQL；连接配置、命名 SQL、参数 `{{变量}}`
  绑定防注入、测试运行
- 命名 SQL 定义处只声明参数名、类型、必填和默认值；具体来源和值由查询面板、流程节点、
  流程数据库节点各自在引用处绑定，避免把调用方概念写进公共 SQL 定义
- 首批只允许**单条参数化语句**；区分 query / command，禁止变量替换表名或列名，禁止多语句与
  DDL。查询统一限制超时、最大行数和最大结果字节；command 返回 `rowCount`，不自动重试
- 数据源敏感配置使用应用级 AES-256-GCM 加密，API 只返回非敏感字段和“已配置”状态；密钥由
  环境变量提供，不写入数据库、Redis、执行快照或前端存储
- **先做数据源的理由**：「校验返回 body 是否符合数据库查出的数据」这类需求目前完全无法表达。
- 落地后立刻可交付 **流程数据库节点**（执行与断言实现在 `lib/databaseStep.ts`）

**第 2 批 · 流程节点补全（约 2 周）** — `[已实现，见 5.0.4]`

- ~~**脚本节点**：把变量袋读写接进 `ctx.variables`，`return` 的对象合并进袋；
  沙箱、`scripts` 表、`owner_flow_id`、`ctx.crypto` 均已就绪，是本批最小的一块~~ `[已实现]`
- ~~**断言脚本变量/密钥支持**~~ `[已实现，4.0.2.5]`：断言脚本已接入环境变量袋与
  `{ secret: "NAME" }`，与钩子共用同一套变量优先级；`evaluateAssertions` 的三个调用点
  （`run.ts`、`cases.ts`、`/scripts/try`）均传入 `variables` + `resolveSecret` + 脱敏列表，
  断言写回的值按 `hookVariables → extracted → assertionVariables` 汇入流程变量袋
- ~~**并行执行**：先定义并发上限、局部失败对后继节点的影响、与 `WORKER_CONCURRENCY` 的
  关系；执行器使用 ready-set/分层调度，同层受控并行；**必须先于条件与循环节点**，两者都
  建立在这套语义上~~ `[已实现]`
- ~~**条件节点**：引入「节点被跳过」状态与边条件语义
  （`flow_executions.skipped_count` 已有位置）~~ `[已实现]`
- 循环 / 等待 / 子流程不阻塞第 3 批，改在 P2-6 独立验收：循环只允许节点内部迭代且有硬上限；
  首版等待为有上限的短等待；子流程保存和执行时都做循环引用检测并限制递归深度 `[已实现，见 5.0.8]`

**第 3 批 · 测试套件（约 2 周）**

场景已撤回（见 5.0.6），本批只剩套件与统一执行记录 UI。
**范围、边界、分批与迁移编号以 5.0.11 为准**（迁移号 022 → 026，另有 7 处计划文本更正）。

- `test_suites` / `suite_executions`：成员支持**接口用例与流程**，标签 / 手动 / 全部三种选择；
  动态选择在入队时固化成员快照，保证本次报告可复现
- 每个成员是一次**独立执行**：用例走单次执行，流程走流程执行。成员之间不传变量——需要传值
  的链路本来就应该建成一条流程，而不是靠套件的执行顺序隐式串起来
- ~~**跨接口用例选择器**：后端 `GET /projects/:id/cases` 已就绪，只差弹窗~~
  `[已实现过，随场景一并撤回；套件实现时按套件的选择语义重做]`
- **统一执行索引 UI**：底层索引已在 P2-0 建立；此批启用「执行记录」父级视图和稳定详情路由，
  同时补上 P1-2 遗留的流程执行独立视图。HTTP 子步骤继续使用现有快照抽屉。
  > **流程执行独立视图已提前单独交付**（见 5.0.9，2026-08-16）：流程画布侧栏「运行记录」+
  > 单次运行抽屉 + 项目执行记录标记流程执行。第 3 批剩余工作为套件与统一父执行列表。

**第 4 批 · Mock（约 1 周）**

> 定位确认见 5.0.7：Mock 面向**外部联调方**，不是平台内部测试夹具；本平台流程/用例测试以
> 真实数据为主，Mock 是次要场景。

- `mocks` 表，自动 / 固定 / 模板 / 代理四种模式；固定 / 模板优先（联调最常用）
- 自动模式在创建规则时复制该接口最近一次成功响应作为固定快照，不在每次请求时回读执行历史；
  没有成功响应时要求用户补齐响应
- 模板模式变量来源优先支持从请求 path / query / body 取值（入参不同 → 响应不同）
- 代理模式必须配置目标白名单、连接/响应超时和响应大小上限，剥离平台认证及 hop-by-hop headers，
  防止形成开放代理或 SSRF 入口；连接/响应超时是 **Runtime 自身的转发预算**（保护性上限），
  不是模拟场景，超时回 504 并记日志
- `delay_ms` 保留，模拟「慢 / 超时」面向**外部调用方**——对方按自己的超时预算触发；对平台内
  流程无意义（流程 HTTP 步骤 30s 硬预算先于 mock 延迟开枪，超时场景由流程自身预算兜底）
- `mock_request_logs` 是联调排障核心：matched / 请求快照 / status_code 必须齐全
- 排在最后：它与前三批没有依赖关系，任何时候插入都不影响其他部分

**实现状态（2026-08-27）**：已落地迁移 `028_p2_mocks.sql`（含 `029_p2_mock_snapshot.sql` 补列）、
项目级 CRUD、匿名 Runtime (`ANY /mock/:publicId/*`) 与请求日志，**并于 2026-08-27 通过用户验收**。
首版采用**单规则单公开地址**，不增加规则组、版本或访问令牌；匹配字段只覆盖 method/path，
模板支持 `{{path}}`、`{{query.xxx}}`、`{{body.xxx}}` 与整包 `{{body}}`。自动模式在创建/编辑时按
用户显式选择的一条接口成功执行记录冻结状态码、响应头与响应 Body，并存储 `snapshot_execution_id`。
代理转发按 Content-Type 透传（JSON 重序列化，文本/表单/multipart 原样），剥离认证与 hop-by-hop
请求头，并受目标主机白名单、超时、响应大小上限保护；转发路径与查询参数支持拼接 / 固定 / 替换
与转发 / 丢弃 / 追加固定参数的可配置策略。

#### 5.0.4 P2-2 已实现并通过用户验收（2026-08-13 实现 / 2026-08-14 验收）

脚本节点、受控并行、条件节点一次落地，执行语义对齐 5.0.2 与 5.5.2：

**数据层（迁移 017）**：`execution_steps.status` 扩出 `skipped`；`scripts.kind`
扩出 `node`（脚本节点脚本与断言/钩子契约不同，仍挂同一张表、随 `owner_flow_id`
生灭、公共脚本可被引用）。受控并发配置存入 `run_spec` JSONB，不加列。

**执行器（`lib/flowRun.ts` 重写为 ready-set 分层调度）**：

- **受控并行**：`FLOW_PARALLELISM` 默认 4、上限 10（计划 5.0.2）。父任务仍占一个
  BullMQ worker 槽；同层 ready 节点按画布位置起跑，用 `Promise.race` 流式补位，
  禁止无界 `Promise.all`。`execution_steps.stage` 记录并行层级。
- **边条件**：`FlowEdge.on` 取值 `success`（默认）/ `failure` / `true` / `false`。
  默认边只在前驱成功后激活；失败节点 `stop` 终止整次父执行（不传播边），
  `continue` 允许失败分支（`on: "failure"`）与无依赖分支继续，其默认成功后继
  标记 `skipped` 并落证据行。条件节点的出边必须声明 `true`/`false`，未命中的
  分支整体跳过——「条件只激活命中分支」。
- **同名冲突稳定失败**：同 `stage` 内两个节点写同一变量名时，后完成者失败并
  把先完成者翻转为失败（步骤行 + `executions` 行），冲突名从变量袋移除——结论
  不依赖完成先后。
- **脚本节点**：`runScriptNode`（`lib/sandbox.ts`）读写 `ctx.variables`，
  `ctx.setVariable` 与 `return` 对象都合并进变量袋；报错或 `ctx.assert` 失败即
  该步失败。入队时 `inlineScriptNode` 内联正文（与断言/钩子同一条复现规则）。
- **取消/回收**：主循环在每次补位前检查 `AbortSignal`，取消后不再启动新步骤，
  在途请求经既有 inflight 登记中断；`execution_steps.skipped` 状态进入回收与
  取消处理路径。

**单步调试（`routes/flows.ts`）**：`/nodes/execute` 按节点类型分派——request 仍走
`enqueueRun`（HTTP 执行），database/script/condition 走 `executeGenericStep`
（通用步骤证据，不伪造 HTTP 快照）。`/nodes/executions` 合并返回两类证据
（`executions` + `execution_steps`）。`/flows/plan` 新增 `stages` 并行分组，
画布步骤序号改为显示并行批次而非平铺序号。

**前端**：新增脚本/条件节点配置抽屉（脚本节点含公共脚本 follow/copy、单步调试
与输出展示；条件节点为变量/比较符/期望值三字段编辑 + 判断结果展示），步骤选择器
增补两类节点，画布渲染对应节点卡。数据库节点单步调试此前因返回形状不匹配实际
不可用，本轮随统一步骤模型一并修复。

**验收对照（5.5.2）**：无依赖节点按上限并行 ✓；同名输出冲突稳定失败 ✓；
条件只激活命中分支 ✓；脚本/数据库/条件步骤均有可复盘结果 ✓；取消后不再启动
新步骤、已启动步骤尽力中断 ✓。

**首轮 / 二轮反馈修复（2026-08-14）**：P2-2 首轮与二轮的反馈修复记录已移出开发计划，
统一归档到 `issue_fix/P2-2_ISSUE_LOG.md`（#1–#5：脚本节点模板、公共脚本按钮、条件节点
双出口、保存后重开、空格键截获）。

**脚本智能提示补全（2026-08-14）**：`lib/scriptContract.ts` 成为 ctx 契约单一来源，按
assertion / hook / node 返回各自可用的 `ctx` 成员与调用 snippet；前端统一 Monaco 编辑器按脚本
类型提供 `ctx.*` 补全。脚本库由后端 Acorn AST 提取顶层函数/类/常量并随列表返回，补全只注入
当前脚本已声明的依赖，另提供可点击的符号速查。脚本节点补齐依赖选择器，断言/前置/脚本节点
三处一致。库内容契约明确为仅允许顶层 function、class、const/let/var（含箭头函数）声明；拒绝
顶层调用、循环、分支和带副作用的变量初始化，JSDoc 作为补全文档展示。

**条件组合与变量链路（2026-08-14）**：条件节点由单条规则扩展为扁平规则组，支持全部满足
（AND）和任一满足（OR），最多 20 条；旧单条件 JSON 在 API 边界自动归一为单条 AND，不需迁移。
执行证据逐条记录变量、操作符、期望值、实际值与结论。脚本节点文案明确变量传播：
`ctx.setVariable("name", value)` 或 `return { name: value }` 写入变量袋，后续请求/SQL/条件通过
`{{name}}` 使用，后续脚本通过 `ctx.variables.name` 使用；同层并行节点不互相读取且同名写冲突失败。

**提示分层与文档沉淀（2026-08-14）**：页面保留一行可扫描的高频规则、字段约束、跟随/依赖
状态、运行结果和错误，不删除操作所需说明；完整生命周期、ctx API、变量传播和脚本库契约后续
建设独立使用文档页面，避免同一页面堆叠长篇说明造成疲劳。已将确认内容写入 `API_AUTOMATION_SPEC.md`：请求节点生命周期
（前置处理 → 请求 → 后置处理 → 声明式校验 → 成功提交变量）、`ctx.setVariable` 临时变量与
DAG stage 传播语义、响应脚本一次遍历完成复杂校验+变量加工、条件 AND/OR、ctx 与脚本库契约；
并明确区分当前执行器行为与后续目标模型，避免文档把未实现重构写成已交付。

#### 5.0.5 P2-2.1 请求节点生命周期收尾（已实现，待用户验收）

本切片承接 P2-2 已验收的节点能力，收口请求节点的固定生命周期，避免同一份请求语义在
不同入口各长一套。

- **固定阶段**：环境/流程变量展开请求模板 → 前置处理 → 发送请求 → 后置处理 → 声明式校验
  → 节点成功后提交临时变量；失败、取消、跳过均丢弃本节点临时变量。
- **后置处理**：由简单字段提取和响应脚本组成。简单路径映射继续使用提取；循环、聚合、格式
  转换、复杂关联校验和变量生成放入一个响应脚本，一次遍历同时使用 `ctx.assert` 与
  `ctx.setVariable`，不要求校验和提取各遍历一次。
- **校验收敛**：校验区只保留状态码、Header、JSONPath、JSON Schema 等声明式规则；删除
  “脚本校验”类型，自定义脚本迁入后置响应脚本。现有数据可忽略，不做旧脚本断言迁移。
- **变量语义**：前置 `ctx.setVariable` 供同节点后续处理和节点成功后的 DAG 后继节点使用，
  但不触发当前请求模板二次展开；影响当前请求必须直接修改 `ctx.request`。后续请求/SQL/条件
  使用 `{{name}}`，后续脚本使用 `ctx.variables.name`；同 stage 不互读且同名写冲突失败。
- **界面与文档**：请求节点 Tab 调整为“请求 / 前置处理 / 后置处理 / 校验”。页面保留高频、
  就地可执行的一行提示，不做无提示化；完整说明集中到后续独立“使用文档”页面，规范来源为
  `API_AUTOMATION_SPEC.md`，页面不复制多份长文。
- **验收**：一个响应脚本可在一次数组遍历中完成聚合、复杂断言和变量写回；任一后置处理或
  声明式校验失败均不提交变量；前置变量可被同节点后置处理读取，节点成功后可被依赖后继读取。

#### 5.0.6 P2-3 场景（已实现后撤回）

场景按「串已有用例 + 传变量」的定位实现过一轮（`scenarios` / `scenario_executions`、
步骤引用用例、入队冻结、后置 SQL 校验、执行/取消/步骤报告），随后**整体撤回**。

**撤回原因**：场景与流程编排解决同一个问题，但场景的「步骤只引用用例」模型让上下文被切开。
一条真实链路——先调生券接口、再把券号传给发券接口——在场景里要求：先去接口工作台把生券
用例的提取变量定义好，再回场景，再去发券用例里把 `{{券号}}` 写进请求体。请求参数不在场景页
可编辑（那是用例的内容），于是「谁产出、谁消费」必须跨多个页面对齐；而一旦为了解决这点把
入参绑定、前置/后置脚本都搬进场景页，它就变成了流程编排的另一套实现。用户实测结论是流程
能更好地表达同一条链路，因此不保留两套语义相近、上下文割裂的编排资源。

**一并撤回的「后置 SQL 校验」**：它真实的需求是「请求之后紧跟一步查库校验」，流程里加一个
数据库节点正是这件事。一个只能挂在末尾、语义特殊的第二种校验位置定位错了。

**保留下来的部分**：`lib/databaseStep.ts` —— 数据库执行与断言的共用实现，现由流程数据库节点
使用（第 1 批约定的「共用同一套执行与断言」因此仍然成立）。

**清理方式**：`021_drop_p2_scenarios.sql` 删表、删 `executions` 上的两个场景列，并把 `source`
的 CHECK 收回三个真实来源。项目尚未上线，`scenario_step` 只存在于开发库（AGENTS.md：不为历史
数据写兼容代码），所以那些执行行一并删除，避免留一个永远不再产生、却要在每个筛选器里解释的
死值。`execution_index.kind` 的 CHECK 不动——收窄它要重建约束，而 P2-4 套件还要再改一次。

**结论写进架构决策**（5.0.1 第 4 条已同步）：编排只有流程一种模型；批量回归由 P2-4 测试套件
承担，套件成员是**相互独立**的用例与流程执行，成员之间不传变量——需要传值的链路就应该建成
一条流程。

#### 5.0.7 P2-5 Mock 定位确认（2026-08-15）

Mock 的首要消费方是**外部联调方**，不是平台内部的测试夹具：

1. **定位：对外联调桩**。被测流程/用例依赖真实数据，Mock 不是本平台回归的主要工具；它的核心
   价值是让外部团队在接口未就绪或半就绪时，通过公开路径先调通、先开发。
2. **两类超时分开**：
   - 代理模式的连接/响应超时是 **Mock Runtime 自身的转发预算**，与目标白名单、响应大小上限
     同属安全边界，不是模拟场景；超时回 504 并记日志，UI 标注「保护性上限」。
   - `delay_ms` 保留，服务对象是**外部调用方**：对方系统按自己的超时预算触发「慢 / 超时」场景，
     验证的是对方对慢依赖的健壮性。对平台内流程无意义——流程 HTTP 步骤有 30s 硬预算
     （`lib/run.ts` REQUEST_TIMEOUT_MS），先于 mock 延迟开枪，「下游超时」由流程自身预算兜底。
3. **四种模式权重按联调排序**：固定 / 模板最常用（对方按不同入参拿不同响应），自动快照次之
   （克隆真实最近一次成功响应，契约贴近真实），代理次之（半就绪时观察 / 转发真实流量）。
4. **模板模式变量来源优先请求驱动**：联调最常见需求是「入参不同 → 响应不同」，模板变量优先从
   请求 path / query / body 取值，再考虑平台环境变量。
5. **请求日志是联调排障核心**：`mock_request_logs` 记录 matched、请求快照、status_code、
   duration_ms，是双方确认「到底调了没有、参数对不对」的客观证据。
6. **公开访问安全性**：外部调用方不登录平台，直接访问 `ANY /mock/:publicId/*`；public_id 必须
   带熵不可枚举、匿名可达，可选访问 token 待拍板。
7. **平台内流程仍可用但非重点**：测试以真实数据为主；流程引用 Mock 时只承担
   「成功 / 失败 / 慢成功」三类可确定响应，超时场景由流程自身预算兜底。

#### 5.0.8 P2-6 高级节点（已验收）

三种节点一次落地：**等待**、**子流程**、**循环**。核心决定是不为它们新建一套执行语义，
而是把 P2-2 的 ready-set 调度器抽成可复用的 `runGraph`，让「节点内部再跑一整张图」复用
同一套分层并行、边条件、跳过传播与同名写冲突裁决——两套语义必然产出「同一条链路在外层
并行、抽成子流程后变串行」这种说不清的差异。

**执行层拆分**：`lib/flowRun.ts` 收缩为薄壳（认领执行、准备 run_spec、收尾），
`lib/flowGraph.ts` 持有 `runGraph` 与两个容器执行器，`lib/flowNodes.ts` 持有不递归的
叶子执行器（数据库/脚本/条件/等待）。依赖单向：flowRun → flowGraph → flowNodes。

**并发模型（本切片最容易做错的一处）**：整次执行共享一个容量固定为 `FLOW_PARALLELISM`
的令牌池，**只有叶子步骤取令牌，loop/subflow 容器不取**。容器持令牌就会死锁——容器占满
额度后，它自己的循环体永远等不到令牌。循环的 `concurrency` 是**局部信号量**而不是抬高
全局容量：后者在两个循环重叠时会互相踩保存/还原，并把池子永久放大。因此嵌套三层的真实
并发仍被单次预算封顶，不会变成 4×4×4。

**「同一个接口的并发请求」的表达方式（用户验收后修订）**：**请求步骤自身的
`RequestFlowNode.concurrency`**——并发只属于请求，不经过循环。并发只属于请求的理由：
它是「同一个接口发 N 个并发请求」的表达，数据库/SQL、脚本、等待并发跑没有价值，
所以不给它们这个字段。请求自己跑 N 次，提取按迭代序收集成数组，证据是 N 个子步骤行。

**迭代语义**：迭代**互相独立**，每次都从同一份外层快照起步——并发下让迭代互读必然产生
调度相关的非确定结果。跨迭代汇总由循环之后的脚本节点读取出参完成。出参按迭代序压实成
JSON 数组（未产出的迭代不占位，不会出现 `null` 空洞）。

**循环是画布容器（用户验收后修订）**：`LoopFlowNode` 从「引用一条流程」改为**内联 body
子图**。循环在画布上是一个**真正的 React Flow 父节点**（虚线大框），被它框住的步骤是真正的
子节点（`parentId` 指向循环）：因此可以**把已有步骤拖进框**、**从框里拖出去**、**双击框内
步骤打开它自己的抽屉**，与顶层步骤没有区别；框右上角的 `+` 直接往框里加一步。体内可以是
任意节点，包括**子流程节点**——「循环内引用子流程」由此成立，不需要循环自己引用。循环自身的
`concurrency` 是「N 次迭代在飞」，与请求并发正交。

坐标与作用域的换算集中在 `apitest-web/src/lib/flowCanvas.ts`（展平/写回/重父/边分派/框尺寸），
不散落在组件里。故意**不用** `extent: "parent"`——那会把子节点锁死在框内、再也拖不出来；
进出由拖拽结束时的中心命中判定完成。**连线不能跨越框**：框内每轮迭代跑一遍、框外只跑一次，
一条跨界边没有可执行语义，`onConnect` 当场拒绝并说明原因。体内无连线时按数组顺序串成链执行。
`materialize()` 是画布→文档的唯一出口，保存、运行、计划、脏检查共用它，避免四条路径对
「文档现在长什么样」给出不同答案。

**引用而非快照**：子流程节点引用另一条流程，与请求节点复制 endpoint 相反。请求节点
快照是为了让流程独立于后续编辑；子流程存在的意义恰恰是一份定义多处复用，所以改子流程
要影响所有调用方。单次运行的可复现性用另一种方式保证：入队时把内层图连同脚本正文整份
冻进 `run_spec`。

**四条硬上限**（对应 5.5.2 第 6 条验收）：迭代 ≤ 100（超限直接失败，不静默截断）；
循环并发 ≤ 10；单次等待 ≤ 30s（等待占着并发额度，长等待需要挂起-恢复模型，不在本版）；
嵌套深度 ≤ 3 且嵌套总步骤数 ≤ 200（仅限深度不能约束体积）。

**循环引用检测**（`lib/flowRefs.ts`）：保存、执行、入队三处都做，且必须给出同一答案——
被引用的流程可能在上次保存后被改坏。报错按名字给出路径（「A → B → A」），而不是 id。

**嵌套证据**（迁移 022）：`execution_steps` 增 `parent_step_id` / `iteration`，容器内部
每一步都有可复盘的证据行，否则一次失败的循环只留下「第 3 次迭代失败」。015 的唯一键按
`position`（节点声明下标，用于同名冲突的确定性裁决）建立，循环会让同一内层节点重复出现，
故改为两条分区唯一索引：顶层保持原语义，嵌套按 (容器行, 节点, 下标, 迭代号) 唯一。
**父级计数只统计顶层步骤**——取消、worker 兜底、回收的聚合都加 `parent_step_id IS NULL`
过滤，否则会出现「12/5 步通过」。

**前端**：三个节点配置抽屉（`FlowAdvancedNodeDrawers.tsx`，共享「引用流程 + 入参 + 出参」
表单）、嵌套步骤证据视图（`NestedStepList.tsx`，循环按迭代分组可折叠，HTTP 子步骤复用既有
快照抽屉）、画布节点卡与节点选择器扩展。出参白名单进入变量补全（脚本节点仍不可知，只有
它自己知道写了什么）。嵌套证据按需拉取（`/execution-steps/:stepId/children`），不随父详情
返回——100 次迭代的嵌套行数可能比顶层步骤多一个量级。

**首轮自审修正**：并发模型返工（容器持令牌导致的死锁、`setCapacity` 的全局踩踏与容量泄漏）；
`onProgress` 改为只在顶层图回调（内层局部计数会把父级进度刷成小数字）；入参解析去掉
`as string`（`resolveDeep` 对整字段引用会还原出数组）；单步调试容器/等待节点补上真实超时
（原先传的是永不 abort 的信号，一个 100 次迭代的循环能把 HTTP 请求挂住近一小时）；循环出参
去空洞；`enqueue.ts` 复用 `inlineFlowNodeScripts`，消掉那份重复的脚本内联实现。

**未验证**：按项目约定未运行测试、未启动服务。两端 `pnpm check` 与前端 `pnpm build` 通过，
但并发模型改动较大，联调验收状态为未完成。
**验收结论**：2026-08-16 用户验收通过（缺陷统计见 `issue_fix/P2-6_ISSUE_LOG.md`）。

#### 5.0.8 P2-6 缺陷统计

> P2-6 的 21 个缺陷统计与七轮用户反馈修正记录已移出开发计划，统一归档到
> `issue_fix/P2-6_ISSUE_LOG.md`（缺陷分组表 A–E、遗留项、教训、多轮修正、执行语义）。

#### 5.0.9 流程执行记录独立视图（P2-4 先行切片，2026-08-16 范围已确认）

> 本切片从 P2-4「统一执行索引 UI」中提前单独交付**流程执行记录独立视图**（P1-2 遗留项），
> 在计划 5.0.3 第 3 批的「统一父执行列表」之前先落地，直接回应「流程历史执行记录 + 统一概览」。
> **已通过用户验收（2026-08-25）**。它交付的「流程执行记录」大类已由 P2-4.4 改造成带 kind
> 筛选的「父执行记录」（`recordType: parent`），见 5.0.11 边界决策 7 与「P2-4.4 落地时确定的
> 6 处细节」。

**已确认范围**：

1. **流程画布编辑器侧栏「运行记录」**：`FlowWorkspace` 增加类似接口编辑器（`EndpointWorkspace`
   的 `workbench-side`）的侧栏，列出该流程的执行历史（复用 `GET /flows/:flowId/executions`），
   支持分页与状态筛选。选中某次运行 → 抽屉打开。折叠后显示 rail（对齐接口编辑器），
   从画布顶部按钮改为侧栏折叠/rail 展开。**侧栏已抽成共享组件 `HistorySidebar`**，流程与
   接口两端共用同一套面板/折叠/rail（顶部间距统一放 flow-body，展开与 rail 与画布严格平齐）。
   `[已实现]`
2. **运行抽屉展示整次运行**：抽屉打开后**一次展示该次运行的全部步骤**（批量调试抽屉的样式——
   每步一行、可展开，行显示「状态码 · 耗时」与批量调试完全同款），不再嵌套一层运行列表。
   步骤渲染：HTTP 步骤复用 `ExecutionDetail`（请求/响应/断言），非 HTTP 步骤复用
   `DatabaseResult` / 脚本 / 条件结果展示，loop/subflow 容器**递归**复用 `NestedStepList`
   ——循环内每一迭代、每一步都点开对应到**那一次具体执行**的快照，支持循环/子流程再套
   循环/子流程。数据来源 `GET /flow-executions/:id`（`steps` + `executionSteps` 已齐备）。
   `[已实现]`
3. **项目级执行记录标记流程执行**：`ExecutionRecords` 页新增「流程执行记录」大类
   （`recordType: flow`，经 `GET /execution-index?kind=flow` 聚合列出流程父执行，点开即
   运行抽屉——与批量调试同类展示），单接口记录默认排除 flow_step；流程步骤行显示
   `流程执行` chip + 流程名；后端项目级 executions 列表 `LEFT JOIN flow_executions`
   带出 `flow_name`，`SOURCE_FILTERS` 放开 `flow_step`。**支持按流程名称搜索**
   （`GET /execution-index?keyword=` 对 `target_name` 做 ILIKE，前端「流程执行记录」
   视图提供搜索框）。`[已实现]`（P2-4.4 起该大类为 `recordType: parent`，`kind` 变成它的
   子筛选；搜索框同时覆盖套件名）

**边界决策**：

- 不做统一父执行列表、不做稳定详情路由、不建 `batch`/`suite` 分支——那些仍留在 5.0.3 第 3 批
  的「统一执行索引 UI」；本切片只做流程侧栏入口 + 单次运行抽屉 + 项目记录标记。
- 后端无新增迁移、无新表；`execution_index` / `execution_steps` 数据模型本轮不改。
- 抽屉内步骤展示「整合一次运行」，与批量调试的交互一致：行点击展开，展开区显示请求/响应快照
  或非 HTTP 步骤结果。
- 项目级「单接口记录」默认排除 flow_step（流程已是大类，避免同一运行步骤重复散落）；接口
  工作台历史仍按 `endpointId` 维度包含流程步骤。

#### 5.0.10 P2-7 数据源适配器增量（2026-08-16 范围已确认；P2-7.1–P2-7.4 已实现并通过用户验收，2026-08-22）

> PostgreSQL 以外的数据源驱动按 P2 增量切片追加（见 5.0.3 末尾），不阻塞 P2 核心里程碑。
> 关系库（MySQL / SQL Server / Oracle）复用 SQL 契约；MongoDB / Redis 使用独立操作定义，
> 不伪装为 SQL。每类按 5.0.1「纵向闭环递增交付」：数据源 CRUD → 连接测试 → 命名定义/试跑
> → 流程数据库节点 → 结果与历史，一类一条闭环，逐类验收。

**已确认的边界决策**：

1. **命名定义仍是 `sql_definitions` 一张表**：CRUD、usage 扫描、流程节点引用、快照、试跑
   五条路径共用，不为 mongo/redis 另开操作定义表（那会把五条路径各复制一份）。迁移 024
   给它加 `kind`（`sql|mongo|redis`）与 `operation` JSONB 列，`statement_type` 语义收窄为
   只对 `kind='sql'` 有效；API 路径 `/sql-definitions` 不变，mongo/redis 定义在 UI 上标注
   「操作定义」。项目未上线，无历史数据要兼容。
   **实现期补充**：迁移 025 放宽 `statement_type` / `sql` 的 `NOT NULL`（024 只加列，没解除
   建表时的约束，导致 mongo/redis 定义写不进库），并把形状收成一条 CHECK——`kind='sql'`
   必须有 statement_type + sql 且无 operation，`kind<>'sql'` 反之。形状由数据库兜住，
   而不是只靠路由分支。
2. **交付顺序（已确认）**：MySQL → SQL Server + Oracle → MongoDB → Redis。MySQL 与 PG 的
   占位符（`?`）、行数包装、只读事务最接近，先验证适配器契约扩展性；SQL Server + Oracle
   收方言差异；Mongo/Redis 另起操作定义模型。
3. **输出契约不因类型改变**：所有类型仍返回 `{ rows, rowCount, truncated, durationMs }`。
   数据库步骤用「200 + JSON content-type」虚拟 HTTP 主体跑断言/提取（`databaseStep.ts`），
   Mongo 文档、Redis 标量/数组全部归一进 `rows`，断言编辑器与 `DatabaseResult` 不出现第二套
   语法。
4. **安全与限制同 PG**：config 只存非敏感字段、密码 AES-256-GCM；参数只经驱动绑定
   （`{{name}}` 在 filter/args 内深解析，不字符串拼接）；超时/行数/结果字节上限逐类型生效；
   连接测试按类型（Oracle 用 `SELECT 1 FROM dual`、Mongo 用 `count`、Redis 用 `PING`）。
5. **连接必填项按类型决定**（实现期确认）：Redis 在 6.0 ACL 之前没有用户名概念且常见于
   无认证部署，它的 `database` 只是库序号（缺省 0）——两者都可选，但填了必须是数字；
   MongoDB 的 `username` 可选（无认证 dev 集群常见），`database` 仍必填（要库名才能定位
   集合）；四个关系库保持 host + database + username 全必填。前后端共用这一份规则。
6. **操作路径的只读边界**（实现期确认，属范围收窄）：SQL 侧的只读保证来自
   `statementType` + `BEGIN READ ONLY` + 首词校验，操作侧没有对等机制，因此**直接拒绝**
   `$where` / `$function` / `$accumulator`（服务端 JS）与 `$out` / `$merge`（会让名义上
   「读」的 aggregate 覆盖整个集合）。深度扫描文档的**键**，且**扫两遍**——定义时一次、
   `{{name}}` 解析后一次，因为 `json` 类型参数能整体替换成对象绕过定义时校验。
   这与 `skeleton.validateStatement` 的分工一致：定义时超集校验，执行时精确校验才是权威边界。
7. **Redis 白名单同时约束参数个数**（实现期确认）：白名单是
   `Record<command, [min, max|null]>`（`null` 表示可变参），唯一入口
   `validateRedisCommand(command, argCount)` 在保存时与驱动开 socket 前各用一次。
   理由：Redis 只回「wrong number of arguments」而不说要几个，而「改命令、忘改 args」
   是这个编辑器里最容易犯的错。
8. **驱动按需加载**（实现期确认）：`lib/adapters/index.ts` 的注册表是动态 `import()`
   加载器 + 结果 memo，不再静态 import 六个驱动。纯 PG 项目的 API 与 worker 不该为
   `mongodb` / `mssql` / `oracledb` 付启动成本，任一驱动加载失败也只应废掉一种数据源类型，
   而不是让整个进程起不来。`isSupportedDataSourceType` 保持同步——回答「这个类型存在吗」
   不该触发驱动加载。

**落地内容**（P2-7 全部已实现并验收）：

- **适配器契约抽取**：`sqlExecutor.ts` 拆为 `lib/adapters/`——`types.ts`（`SqlAdapter` 接口
  + 按 `data_source.type` 的注册表）、`skeleton.ts`（方言感知 SQL 骨架：引号/注释/占位符
  识别）、`common.ts`（参数值转换、行数/字节截断、clamp 共享）、各类型实现。`sqlExecutor.ts`
  收缩为「载入数据源 → 按 type 查 adapter → 分派」的薄壳。
- **关系库方言**（校验规则与防注入原则全部保持，仅骨架/占位符/事务/行数上限不同）：

  | 维度 | MySQL | SQL Server | Oracle |
  |---|---|---|---|
  | 驱动 | `mysql2` | `mssql` | `oracledb`（thin 模式，免 Instant Client） |
  | 占位符 | `?` | `@p1` | `:1` |
  | 行数上限 | `SELECT * FROM (...) AS t LIMIT n+1` | `SET ROWCOUNT n+1`（**不包装语句**） | 驱动 `maxRows: n+1`（**不包装语句**） |
  | 只读事务 | `START TRANSACTION READ ONLY` | 不支持 → 普通事务 + 语句校验兜底 | `SET TRANSACTION READ ONLY` |
  | 超时 | session `max_execution_time` | 驱动 `requestTimeout` | 无驱动选项 → 客户端竞速 + 关连接终止会话 |
  | 连接超时 | 驱动 `connectTimeout`（ms） | 驱动 `connectionTimeout`（ms） | 驱动 `connectTimeout`（**秒**，向上取整） |
  | 骨架补充 | 反引号、`#` 注释 | `[ ]` 方括号标识符 | 同 PG |

  > **行数上限为何两处不再包装语句**（实现期修正）：原计划的
  > `SELECT TOP (n+1) * FROM (<用户 SQL>) AS t` 在 SQL Server 上会让**所有**带
  > `ORDER BY` 的查询报错 1033（派生表不允许裸 ORDER BY），带 CTE 的查询更是直接语法错误
  > ——而 `skeleton.validateStatement` 明确把 `WITH` 当合法 query 放行，两者本身矛盾。
  > 改用 `SET ROWCOUNT`（仅对 query 生效，连接执行完即销毁，无需复位）。Oracle 同理走
  > 驱动 `maxRows`，比 `ROWNUM` 包装更不干扰用户语句。MySQL / PG 的派生表接受
  > `ORDER BY` 与 `WITH`，保持包装不变。

  结果归一化在 adapter 内、进 `rows` 之前：`datetime2` / Oracle `NUMBER`/`DATE` / MySQL
  `BigInt` 显式转字符串或 JSON，保证 `JSON.stringify` 与前端渲染不炸。
- **MongoDB 操作**（kind=`mongo`，`operation` JSONB）：读 `find`（filter/projection/sort/
  limit）、`aggregate`、`count`、`distinct`；写 `insertOne/Many`、`updateOne/Many`、
  `replaceOne`、`deleteOne/Many`。filter/pipeline 内 `{{name}}` 深解析后走驱动绑定；
  `maxTimeMS` 对**全部**操作生效（含 distinct 与写操作）；`limit(maxRows+1)`，且用户传
  `limit: 0` 会被抬到正数——Mongo 的 `limit(0)` 语义是「不限制」，会把整个集合读进内存；
  写结果映射为单行。按边界决策 6 拒绝 `$where`/`$function`/`$accumulator`/`$out`/`$merge`。
  `validateOperation` 逐 op 校验必填载荷（`updateOne` 要 filter+update、`insertMany` 要
  非空对象数组…），不把缺字段留给驱动去抛栈。
- **Redis 操作**（kind=`redis`，`operation` JSONB）：命令白名单 + 参数个数（见边界决策 7），
  覆盖 PING/GET/SET/MSET/MGET/DEL/EXISTS/EXPIRE/TTL/PERSIST/INCR(BY)/DECR(BY)/
  LPUSH/RPUSH/LPOP/RPOP/LRANGE/LLEN/HSET/HMSET/HGET/HGETALL/HDEL/HLEN/HEXISTS/
  SADD/SREM/SMEMBERS/SCARD/SISMEMBER/GETSET/SETNX/INCRBYFLOAT；args 支持 `{{name}}` 绑定；
  标量→单行、数组→逐元素、hash→键值对展开（`{field, value}` 两列）；复用现有 `ioredis`
  （零新依赖）；**不做 pub/sub、阻塞命令与 EVAL**（Lua 等于从数据源配置执行任意代码）。
  下发命令用**小写**——ioredis 的 reply transformer 注册在小写名下，大写会静默跳过，
  `HGETALL` 就会退化成扁平数组而不是 hash。
- **流程数据库节点**：`DatabaseFlowNode` 增可选 `operation`，三种模式（`sqlDefinitionId` /
  内联 `sql` / 内联 `operation`）**恰好命中一个**。引用命名定义时节点只存 `sqlDefinitionId`，
  不拷 operation 副本——入队时 `prepareFlowNodes` 从定义回读，且以定义的 `statementType`
  为准；`statementType` 只在内联 SQL 模式必填（mongo/redis 定义没有这个字段）。
  `databaseStep` / `flowNodes` / `flowGraph` / `flow.ts` 按数据源类型分派 SQL/操作执行与校验。
- **前端**：`DataSourceList`/`DataSourceDrawer` 类型下拉 + 各类型默认端口（5432/3306/1433/
  1521/27017/6379）+ 按类型表单（SQL Server encrypt/trustServerCertificate、Oracle
  serviceName、Mongo authSource、Redis db index）与按类型必填项（见边界决策 5）；
  `DataSourceDetail` 与流程数据库节点在 mongo/redis 时切换为操作编辑器（JSON + 操作模板
  下拉 + 参数声明）；操作模板集中在 `src/operationTemplates.ts` 一份，以**对象**保存并统一
  缩进后进编辑器（两处各存一份字符串模板时内容已经走偏）；模板下拉是**受控**的，值由编辑器
  文本实时反解，重开一条已保存定义能看出它是哪种操作；SQL 定义列表显示 kind 徽标；
  `DatabaseResult` 提供整行展开弹窗（定宽单元格截断后读全长值的出口）。

**分批交付**（纵向闭环，逐类验收）：

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-7.1 | 适配器契约抽取 + MySQL | ~5 天 | **已验收** |
| P2-7.2 | SQL Server + Oracle（方言收尾） | ~6 天 | **已验收** |
| P2-7.3 | MongoDB（kind/operation 落库、操作编辑器、节点操作模式、文档渲染） | ~5 天 | **已验收** |
| P2-7.4 | Redis（命令白名单、操作编辑器、结果展示） | ~2–3 天 | **已验收**（Redis 侧以本地实例逐条操作核对） |

**验收门槛**（逐类型对齐 5.5.1）：密码保存后不回显且可单独更新；连接测试通过；命名定义
试跑与流程数据库节点使用同一执行器；参数值只经驱动绑定；超时/行数/结果大小限制对该类型
生效；删除引用资源返回 usage 清单。

**验收结论（2026-08-22）**：P2-7.1–P2-7.4 全部通过。Redis 侧以本地实例逐条操作核对
（string / hash / list / set 四种键型 × GET、HGETALL、LRANGE、SMEMBERS、TTL、INCR、SET，
外加非白名单命令与参数个数错误两组负向用例）。走查与实测共发现 22 项问题，全部记录在
`issue_fix/P2-7_ISSUE_LOG.md`（20 项已修，2 项复核后判定不改），本节只保留由此产生的
范围与边界变更。

**风险**：oracledb 包体大、首次下载依赖网络（thin 模式免装 Instant Client，Node ABI 需
匹配）；SQL Server 无只读事务靠语句校验兜底、自签名证书需 `trustServerCertificate`；
方言骨架识别（MySQL 反引号/`#` 注释、SQL Server 方括号）必须进 skeleton，否则只读 CTE
校验会被字符串内容骗过。`mssql` 与 `oracledb` 不自带类型声明，需显式装
`@types/mssql` / `@types/oracledb`，否则 `tsc` 过不去而 `tsx` 照常运行——问题只在构建时暴露。

#### 5.0.11 P2-4 测试套件 + 统一执行记录（2026-08-24 范围与边界已确认）

> 本节是 P2-4 的权威范围。5.0.3 第 3 批的概要、5.1 的迁移清单、5.2 的 API 清单与之冲突时
> 以本节为准。**P2-4.1（2026-08-24）、P2-4.2、P2-4.3 与 P2-4.4（均 2026-08-25）已通过用户
> 验收**（缺陷记录见 `issue_fix/P2-4_ISSUE_LOG.md`），**P2-4.5 已于 2026-08-26 通过用户验收**，
> 验收期间修订一处边界并增补一项功能（见下方「P2-4.5 验收增补」）。
> 5.0.9 也已于 2026-08-25 验收。

**计划文本更正（走查代码后确认的 8 处）**

1. 套件迁移号 `022` → **026**：022 已被 `022_p26_advanced_nodes.sql` 占用（P2-6 提前落地）。
   `023` 是历史空洞（现有文件为 001–022、024、025），**永久弃用**——补一个 023 会让
   「文件名顺序 = 实际应用顺序」这条前提失效；Mock 迁移顺延为 `027_p2_mocks.sql`
   （**再次顺延为 `028_p2_mocks.sql`**：027 已被 P2-8 执行分区占用，见 5.0.12）。
2. `execution_index.kind` 的 CHECK **已经包含 `'suite'`**（015），026 不需要为套件放宽约束。
   5.0.6 里「CHECK 不动，P2-4 还要再改一次」只剩一个动作：顺手去掉死值 `scenario`，
   收窄为 `flow|suite|batch`（`batch` 保留，仍是规划中的父执行类型）。
3. `suite_executions` 与 `flow_executions` 对齐：明细表**不放** `canceled_count`，canceled 只在
   `execution_index` 上派生（`lib/flowRun.ts` 的 `finish` 已是这个做法，两张表两套算法必然分叉）。
4. 5.2 的套件 API 清单缺 `GET /projects/:id/suite-executions/:executionId`——运行抽屉需要成员行
   与子执行指针，补入。
5. 026 需要给 `execution_steps` 加一列 **`child_index_id`**：现有只有 `http_execution_id`，
   表达不了「这个成员本身是一次完整的流程父执行」。
6. 用例/流程的 usage 保护是 P2-4 欠的债——`routes/cases.ts` 与 `routes/flows.ts` 的注释都写着
   「套件是第一个引用方，usage 扫描属于那个切片」，目前两者都是无保护硬删除。本切片补齐；
   **只有 `manual` 成员算引用**，tag/all 是动态选择，不产生引用。
7. `GET /projects/:id/cases` 目前无分页，且每条返回完整 request/断言/钩子/提取/响应脚本。
   本切片改为分页 + 列表瘦身，并把 `FlowNodeDrawer` 的用例下拉改为服务端搜索（它只需要
   id/name/接口名，请求正文另走 `flowNodeSource`，所以瘦身安全）。
8. 统一父执行列表建立在 5.0.9 之上，因此它排在本切片**最后几批**，前三批只新增、不触碰
   5.0.9 已交付的视图。**5.0.9 已于 2026-08-25 验收**，这条前置条件解除。

**已确认的边界决策（13 项）**

1. **成员证据 = 该套件 index 下的一行 `execution_steps`**。用例成员 `step_type='case'`，
   `http_execution_id` 指向 `executions` 行（与流程 request 步骤同构）；流程成员
   `step_type='flow'`，`child_index_id` 指向那次流程执行的 `execution_index` 行。
   不采用批量调试式的「子表加 FK + 派生计数」：那要多加两列、join 两张子表重算计数，
   且**表达不出「因 fail-fast 未启动的成员」**（没有行可写），而 index 那套仍然要维护。
2. **成员在套件自己的 worker 槽内进程内 fan-out**，不给成员单独入队。流程的 HTTP 步骤本来
   就是进程内 `executeRequest`（不走队列），成员入队会让「等子任务的父槽」把
   `WORKER_CONCURRENCY` 吃光——与 5.0.8 容器持令牌的死锁同一类错误。
   `enqueue.ts` 因此拆出 `insertRun` / `insertFlowRun`（现有 `enqueueRun` / `enqueueFlowRun`
   = insert + `queue.add` + publish，既有调用方行为不变）。
3. **并发预算**：见下节「并发预算与原子领取」。
4. **fail-fast = 不再启动新成员，在途成员跑完**。成员是独立执行，它的证据值得留；中途 abort
   会写出一行看起来像用户取消的 `canceled`。未启动的成员写 `skipped`（`execution_steps.status`
   已有这个值），父执行终态 `failed`。
5. **环境支持套件级覆盖**：`member_default | override`，沿用批量调试的两种策略。现在不做的话
   以后补要改 `run_spec` 与 `member_snapshot` 形状。
6. **套件触发的流程执行算该流程的一次正式运行**：出现在流程运行记录侧栏与流程列表 lastRun。
   本切片不加「由套件触发」标记（要标记就得在 `flow_executions` 上再加一列，反查
   `execution_steps.child_index_id` 已经够用）。
7. **统一列表 = 把 5.0.9 的「流程执行记录」改造成带 kind 筛选的「父执行记录」**（全部/流程/
   套件），不平行新增第三个父执行大类——三个语义重叠的大类是坏 UI。批量调试**不并入**
   `execution_index`（它从未写入过），保持独立大类；单接口记录不变。
8. **稳定详情 = `?parent=<indexId>` 按 id 拉取**，不做 `/reports/:indexId` 路径路由。
   现状只在「该行正好在当前页」时才能恢复，且 flow/batch 完全不恢复；改成按 id 拉取
   同时修掉这个限制（单接口 `?run=` 一并改）。
9. `execution_index.kind` 顺手收窄为 `flow|suite|batch`（021 明确把这件事留给 P2-4，
   scenario 行已被 021 删净）。
10. `GET /projects/:id/cases` 改为分页 + 瘦身（见更正项 7）。
11. **manual 成员去重**：同一用例/流程只允许出现一次。成员之间不传变量，重复执行同一成员没有
    语义价值；tag/all 天然去重。
12. **套件不能包含套件**：保存与执行两处都拒绝。
13. **保护性上限**：成员 ≤ 200；`SUITE_TIMEOUT_MS` 30 分钟；`REAP_SUITE_AFTER` 45 分钟
    （沿用「回收阈值必须显著大于自身超时」的既有比例，flow 是 10/20 分钟）。

**并发预算与原子领取（本切片最容易做错的一处）**

现有三层不是一回事：`WORKER_CONCURRENCY`（同时几件**任务**，默认 10）、
`FLOW_PARALLELISM`（一次流程执行内同时几个**叶子**在飞，默认 4）、节点上的 `concurrency`
（**形状声明**，要向令牌池借令牌才真的跑）。套件是流程之上又一层容器，如果每个流程成员各建
一个池子，一个套件任务就能打出 `C × 4`（上限 100）并发——正是 5.0.8 拒绝过的乘法换了一层。

- **一次套件执行共享一个令牌池**，容量 `SUITE_LEAF_BUDGET`（默认 8，上限 20），传给每个流程
  成员（`performFlowRun` 加可选 `tokens` 参数，它现在自己 `new TokenPool`）。
- **成员数由独立信号量 C 控制**（`execution_config.concurrency`，默认 4、上限 10，校验
  `C ≤ 池容量`）。套件容器与流程成员容器**都不拿令牌**——容器拿令牌就会「攥着额度等自己的
  身体要额度」，这是 5.0.8 已经付过一次代价的死锁。
- **请求节点并发改为原子领取**：声明 N 就凑齐 N 枚令牌一起发，凑不齐整批等。现状是逐枚领
  （`lib/flowGraph.ts` 请求并发分支），池子紧张时 `concurrency=3` 会被静默拆成 2+1——而
  「同一接口并发 N」的用例本意就是让服务端真的同时收到 N 个请求，拆开等于结论失真。
  **这项修改动到 P2-6 已验收的代码，属本切片有意的范围扩张。**
- 原子领取的两个风险都必须封死：**真死锁**靠保存时与入队时两处校验 `N ≤ 池容量`，超限
  直接报错（不静默降级，与「循环迭代 >100 硬失败」同一原则）；**饿死**靠等待队列
  FIFO 且**禁止插队**——队头是多枚请求时，即使有空闲令牌也不发给后面的单枚请求。
  代价是攒令牌期间短暂空置几枚，空置窗口上限 = 最长在飞叶子寿命（请求 30s）。
- `TokenPool` 只加 `acquireMany(n)`，把 `acquire()` 实现成 `acquireMany(1)` 的薄壳：
  **一套等待队列**。两套队列必然互相插队，等于没做。
- 循环并发**不用**原子：迭代互相独立，先后跑不改变结论，它只是吞吐。
- 排队不吃单请求 30s 预算（令牌在 `executeRequest` 之前领），但**吃流程 10 分钟预算**
  （`performFlowRun` 认领即起表）。`C ≤ 池容量` 保证每个在跑的成员至少能拿到 1 枚，一定有进展。
- 套件预览时算出峰值需求，超过池容量就明确写出来（「声明并发合计 X，平台上限 Y，实际分批」）
  ——用户看得见，才不会把一份被降级的报告当并发结论。

**分批交付**（纵向闭环，逐批验收）

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-4.1 | 迁移 026；套件 CRUD + `preview` 成员解析；`GET /cases` 分页瘦身；侧栏/路由/列表页/编辑页/成员选择器。**不含执行**，运行按钮不出现 | ~3–4 天 | **已验收**（2026-08-24） |
| P2-4.2 | 执行后端：`enqueue.ts` 拆分 + `enqueueSuiteRun`/`cancelSuiteRun`；`lib/suiteRun.ts`；`TokenPool.acquireMany` 与请求节点原子领取；queue/worker 五处接入（job 联合、processor、`on("failed")`、`reapStale`、`requeueOrphans`）；`events.ts` 加 `kind:"suite"`；execute/executions/detail/cancel 四条路由 + `executionIndex.ts` 取消分支 | ~4–5 天 | **已验收**（2026-08-25） |
| P2-4.3 | 前端闭环：`api.ts` 套件全套 + 缺失的 `executionIndexDetail`/`cancelExecutionIndex`；列表运行按钮与状态列；编辑页 `HistorySidebar` 运行记录；`SuiteRunDrawer`（成员行复用 `.batch-item`，用例成员展开 `ExecutionDetail`，流程成员展开该次流程步骤——需把 `FlowRunDrawer` 的 `StepEvidence` 导出复用）；SSE 进度与取消 | ~3–4 天 | **已验收**（2026-08-25） |
| P2-4.4 | 统一父执行列表 + 稳定详情路由 + `ExecutionRecords` 接入 stream | ~2–3 天 | **已验收**（2026-08-25） |
| P2-4.5 | 引用保护：用例/流程 `GET .../usage`，删除返回 409 + 清单 + `?force=true`，前端删除前扫描 | ~1–2 天 | **已验收**（2026-08-26，验收增补见下方） |

**明确不做**：套件级变量传递（成员相互独立，需要传值就建流程）· 套件定时调度（P3）·
成员级重试 · 套件嵌套套件 · 把批量调试并入 `execution_index`。

**P2-4.2 落地时确定的 7 处细节**（实现即决策，与上文边界不冲突，只是把它们说到可执行）

1. **两个预算常量搬进 `lib/flow.ts`**（`FLOW_PARALLELISM`、`SUITE_LEAF_BUDGET`）。它们现在
   有三个读者且必须是同一个数：调度器建池、入队校验、保存校验。留在 `flowRun.ts` 会让
   路由层去 import 执行器。
2. **`SUITE_LEAF_BUDGET` 的下界是 `FLOW_PARALLELISM`**。套件池小于流程池会让「单独跑得起
   来、放进套件就超预算」成立，于是「按流程预算校验过就够了」这条前提失效。
3. **请求节点并发的保存上限从 `MAX_LOOP_CONCURRENCY`（10）改为 `FLOW_PARALLELISM`（默认 4）**。
   原子领取之后 N > 池容量就是永远凑不齐，只能在保存时就拒绝。**这会让先前存下的
   `concurrency` 5–10 的请求节点在保存/入队时被拒**——属本切片有意的收紧（循环并发不受
   影响，迭代不需要原子性）。第二道校验在 `insertFlowRun`：预算是可配置的，一份旧流程
   完全可能在预算调小之后才被运行。
4. **并发请求的容器耗时改为墙上时钟**（原先是各次耗时相加）。N 个请求真的同时在飞之后，
   相加会把 3 个 1 秒的并发请求报成 3 秒。
5. **`POST .../execute` 接受可选的 `execution` 部分覆盖**（并发/fail-fast/环境策略），与用例、
   流程的「改了还没保存也能跑一次」同一条规则（交互文档 3.1.3）；成员清单不接受覆盖
   ——随手指定一批成员是「批量执行」而不是「运行这个套件」。
6. **`preview` 返回 `concurrency: { declared, peak, budget }`**，`peak` = 需求最大的 C 个成员
   之和，算法与入队时的硬校验共用 `memberTokenDemand`。单个成员一次要的比整池还多 →
   执行入口 400 拒绝；只是合计超预算 → 只提示「会分批发出」。
7. **被取消的成员计入 `failed`**（它不是一次通过），但成员行本身保留 `canceled`；取消路径下
   父级计数由 `cancelSuiteRun` 写，`finish` 的 `status = 'running'` 守卫让它保持胜出。
   套件整体超时（30 分钟）与用户取消都落 `canceled`，但 `error` 分别写清楚。
8. **新增 `GET /system/limits`**（见 5.2），前端同步接入：`stores/limitsStore.ts` 登录后拉一次，
   四个输入框的 `max` 与提示文案都改成读它——请求并发（`flowParallelism`）、循环迭代
   （`maxLoopIterations`）、循环并发（`maxLoopConcurrency`）、等待秒数（`maxWaitMs`）、套件成员
   并发（`min(suiteMaxConcurrency, suiteLeafBudget)`）。预算是环境变量，界面写死必然与服务端
   不一致（填得进去、保存被拒）；读不到时用与服务端一致的兜底值，不让编辑器打不开。

**P2-4.3 落地时确定的 6 处细节**（前端闭环，实现即决策）

1. **成员行来自 `member_snapshot`，不是 `execution_steps`**。没开跑的成员根本没有步骤行，
   只按步骤行渲染的话，一个 10 成员的套件跑到第 3 个时抽屉里只有 3 行，读起来像「这个套件
   只有 3 个成员」。快照是那次运行的完整计划，它才是清单；步骤行按 `type:id` 挂上去。
2. **运行已结束而某成员没有步骤行 ⇒ 该成员是 `skipped`**。fail-fast 会由 `performSuiteRun`
   补写 skipped 行，但**取消**只把已存在的行改成 canceled（`cancelSuiteRun`），没排到的成员
   一行都没有、只进父级 `skipped_count`。前端不做这个推导就会把一次已结束的运行画成
   「还有成员在排队」。三种「没开跑」分别给不同文案：等名额 / fail-fast 停下 / 没轮到。
3. **流程成员展开走 `childIndexId` 两跳**（`executionIndexDetail` → `flowExecution(detailId)`），
   不走 `output.flowExecutionId`：后者只在成员跑完时才写，而 `child_index_id` 在开跑前就落库，
   所以正在跑的流程成员也能展开。两跳都只在展开时发——套件详情不该为了摘要搬十棵步骤树。
4. **`FlowRunDrawer` 导出 `flowStepRows` 与 `StepEvidence`**。只导出 `StepEvidence` 不够：
   「怎么把一次流程执行摊成行」还包含旧 run 的退路与容器行过滤，抄第二份必然分叉，
   而分叉出来的那份在用户眼里只是「同一次运行在两个地方长得不一样」。
5. **成员行重取只在抽屉打开时或终态才发**。成员级事件不存在（成员发的是自己的
   execution / flow 事件，不带 suiteExecutionId），所以成员行只能靠重取详情；而详情带着每个
   用例成员的完整响应快照，按事件次数取会让 200 成员的套件把同一批证据反复搬上来。
6. **执行入口传 `execution` 但不传成员**，因此**选择方式改了没保存就拒绝运行**（面板与点击
   两处都说明）。只提示不拦，等于让用户以为刚加的成员会跑到。并发峰值提示只说「会分批」：
   「单个成员要的比整池还多」那一档在保存时就被挡住了（请求节点并发 ≤ 流程池 ≤ 套件池），
   走不到预览。

**P2-4.4 落地时确定的 6 处细节**（统一列表 + 稳定详情 + 事件流，实现即决策）

1. **大类 `flow` 改名为 `parent`，`kind` 成为它的子筛选**（全部/流程/套件），地址栏为
   `?type=parent&kind=suite`。旧地址里的 `type=flow` 在读取时映射成 `parent`（`toRecordType`），
   未知值一律回落到 `single`——一个认不出的大类会让页面渲染成空清单，看起来像「没有记录」。
2. **父执行行显示类型 chip + 跳过列**。类型必须在收起状态下就能读到：一份混着流程与套件的
   清单里，点开看到的是步骤树还是成员行，名字本身说不清。跳过列为 0 时写 `—` 而不是 `0`
   ——它只在 fail-fast 与取消时才有值，写成 0 会让人以为这个数字有含义。
3. **稳定详情三个参数一起改成按 id 拉取**：`?parent=<indexId>`（先 `executionIndexDetail`
   解析 kind + detailId，再按 kind 取流程/套件明细）、`?run=<executionId>`、
   `?batch=<batchId>`。原先只有 `?run=` 有恢复逻辑，且是在刚取回的那一页里 `find`——深页与
   换过筛选条件都恢复不了，而流程与批量调试连参数都没写进地址栏。**读失败就摘掉参数并明确
   报「这条记录不在了」**：留着参数会让每次筛选变化都重试一次注定失败的请求，而静默失败会让
   人以为是自己点错了。
4. **事件流的分工是固定的：状态与计数就地打补丁，要完整字段才重取。** 重取只有两个时机——
   终态一次，以及**停在第一页**时收到一条打不到当前页的事件（那是刚产生的新记录）。深页不为
   新记录重取：偏移分页会让整页往后错一行，正在读的人会以为自己看错了。重取本身是
   600ms 尾随合并的一次（`revision` 计数器进取数 effect 的依赖，取数仍然只有一处），否则一次
   200 成员的套件运行会打出 200 次列表请求。
5. **抽屉开着时按事件重取详情，关着时不取**（与套件编辑器同一条规则）。父级每落地一个
   成员/步骤才发一条进度，所以这个频率本来就是对的；而详情带着完整响应快照，没人看的时候
   重取只是白搬数据。这条重取是**静默**的——一次读失败弹一条报错盖在正在看的抽屉上只是噪音，
   下一条事件还会再试。
6. **`GET /execution-index/:indexId` 收窄为只回顶层步骤**（`parent_step_id IS NULL`），与套件
   明细一致。它的两个调用方（套件里的流程成员、记录页的 `?parent=` 深链）都只读父行本身，
   而不过滤的话一次 100 迭代的循环会把上千行带完整快照的步骤塞进这个响应里。嵌套证据仍按需
   走 `GET /execution-steps/:stepId/children`。

**本切片不做**：记录页的取消入口（`cancelExecutionIndex` 因此仍无调用方）。记录页是审计视图，
运行中的父执行在流程/套件编辑器里有自己的运行条与取消按钮；在两个地方各放一个取消按钮，
就要在两个地方各维护一套「取消后计数怎么算」。

**P2-4.5 落地时确定的 5 处细节**（引用保护，实现即决策）

1. **反向扫描统一走 `lib/flowRefs.ts` 的 `flowsReferencing`，用 `jsonb_path_exists` 递归。**
   循环体是内联子图（`LoopFlowNode.body.nodes`），所以子流程节点/数据库节点完全可能躺在循环里。
   原先数据源与命名定义的扫描用 `nodes @> '[{...}]'` 只看顶层数组元素，循环体内的引用会漏成
   「没人用」，删完被引用的资源后外层流程要到入队时才报错。`$.** ? (@.key == $value)` 一层
   查询覆盖任意嵌套深度，值走 `jsonb_path_exists` 的 `vars` 参数绑定、不进路径文本（规范 4.4）。
   这个漏扫顺带在 dataSources 的两处旧扫描上修掉了（见 `issue_fix/P2-4_ISSUE_LOG.md` #10）。
2. **用例的引用只有「套件 manual 成员」一种**。流程请求节点的 `sourceCaseId` 只是来源标记
   （节点自带完整请求/断言快照，改用例不影响已存流程），执行历史靠 `case_name` 快照——两者都不
   拦，只把历史条数报出来供人判断。流程的引用是「套件 manual 成员 + 别的流程的子流程节点」两种，
   都拦。
3. **tag/all 是动态选择，不产生引用**（边界决策 6），扫描用 `selection_type = 'manual'` 排除；
   套件引用匹配用 `selection_config @> '{"members":[{"type":…,"id":…}]}'`，撞上 026 建的 GIN 索引。
4. **`?force=true` 之后有两类引用，各自处置（验收时修订）**：
   - **套件 manual 成员不再悬空**：删除与「把它从每个引用它的手动套件里摘掉」在同一个事务里
     完成（`lib/suiteMembers.ts` 的 `detachSuiteMember`）。原设计「悬空并显示一行已不存在」
     在验收时被用户否决——那行除了解释自己为什么在那儿之外没有用途，唯一合理操作就是删掉它，
     而删除路径可以直接做完（见下方「P2-4.5 验收增补」甲）。
   - **别的流程的子流程节点保持悬空**：那是一个画布节点，静默删掉会改变流程的结构与连线，
     属于「删一个东西连带改一串东西」；它在入队时报「references a flow that does not exist」，
     由人去改那张图。
5. **前端扫描失败就**不删。一个「查不到有没有人引用」的答案不能当成「没人引用」；有引用时对话框
   列出清单（复用 `.usage-list`）并把主按钮从「删除」换成「仍然删除」（`action.deleteAnyway`），
   而不是把 409 当成需要重试一次的错误。

**P2-4.5 验收增补（2026-08-26，用户验收时提出的 3 项）**

> P2-4.5 于 2026-08-26 通过用户验收。验收期间针对悬空引用、标签选择与用例→流程的改动传播
> 提出 3 项增补，随验收一并落地。前两项是套件页行为修订（缺陷记录见 `issue_fix/P2-4_ISSUE_LOG.md`
> #11 / #12），最后一项是新增功能，写在这里。

**甲 · 删用例/流程时级联摘掉套件成员（修订「force 之后悬空」边界）**

原设计是 force 之后让引用悬空、套件预览把悬空成员挑进 `missing` 显示成一行「已不存在」。
用户明确否决：**已经不存在的用例/流程不该出现在套件成员列表里**。悬空行不能运行、不能打开、
没有可修的内容，唯一合理操作就是删掉它——于是删除路径直接做完：

- 新增 `lib/suiteMembers.ts` `detachSuiteMember`：用 `jsonb_set` 把 `selection_config.members`
  里目标引用就地摘除（`jsonb_agg ... ORDER BY ord` 保住剩余成员的声明顺序，摘空写 `[]`）。
- `DELETE /cases/:caseId` 与 `DELETE /flows/:flowId` 的 force 路径改为**先开事务 → DELETE →
  `detachSuiteMember` → 提交**，两步不再可能分离。返回 `detachedSuites` 清单供界面表态
  「已从 N 个套件中移除该成员」。
- 子流程节点引用**不**级联——那是一张图上被连线引用的节点，静默删掉会破坏流程结构。
- 前端 `SuiteWorkspace` 对历史遗留的悬空引用就地清除并进入未保存态，由保存确认（不偷偷写库）。

**乙 · 标签/全部选择自动解析成员**

原设计要手动点「解析当前成员」。标签与全部的成员本来就是算出来的，刚改完标签正是最想知道
「现在会跑到谁」的那一刻，让它停在「尚未解析」上等一次点击等于没给答案：

- `SuiteWorkspace` 对 tag/all 选择增加防抖（400ms）自动 preview：进页面一次、条件（标签/
  匹配方式/成员范围）变化一次。手动按钮保留为「重新解析」，自动失败的报错靠它兜底。
- 预览用序列化键作依赖而不是对象引用，改名、改并发不会白白重解析；`previewing` 态显示
  「搜索中」而不是闪一下「尚未解析」。

**丙 · 用例 → 已绑定流程的同步 tab（新增功能）**

快照隔离保证「改用例不会自动改动已存流程」，代价是用例修好之后，引用它的每条流程都要手工
重新导入。同步 tab 把那件事变成一次显式点击：

- 后端两条路由：
  - `GET /projects/:id/cases/:caseId/flow-bindings`：返回引用该用例的全部流程与节点
    （含循环体内节点，`inLoop` 标记）。复用 `lib/flowRefs.ts` 的递归 jsonpath 扫描，
    并把 `sourceCaseId` 加进 `FlowNodeRefKey`。
  - `POST /projects/:id/cases/:caseId/sync-to-flows`：body 为 `{ flowIds, nodeIds? }`，
    **一次事务同步全部选中的流程**（全部成功或全部不动；flowIds 排序后加锁防死锁）。
    覆盖节点的请求快照、断言、前置钩子、提取、响应脚本与 `endpointId`/来源标记，节点名、
    画布坐标、失败策略、并发次数保留（那是流程自己的编排决策）。脚本引用走 `adoptScriptRefs`
    接手（与 `flows/node-source` 同规则），写库走 `toFlowNode` + `persistFlowScripts`。
  - 实现以 `lib/caseSync.ts` 为中心：扫描、payload 整理、树内替换、写回都在一处。
- 前端 `EndpointWorkspace` 在「校验」后新增「同步」tab（仅在加载用例时存在），支持
  **多选流程**（勾选 + 全选），同步前对话框逐条列出将被覆盖的节点；用例有未保存改动时
  先提示保存——同步读的是库里那份定义。
- 同步是显式操作，自动传播仍然不做。

#### 5.0.12 P2-8 执行分区：跨网段执行（2026-08-24 范围与边界已确认）

> 本节是 P2-8 的权威范围。**P2-8.1–P2-8.6 已全部实现**（2026-08-26）；**P2-8.7 配置体验
> 补齐（分区候选下拉 + 无在线执行器提示 + 环境复制）于 2026-08-27 增补**。**已于 2026-08-27
> 通过用户验收**（期间一个 UI 缺陷记录见 `issue_fix/问题记录-分区下拉空列表.md`）。
> 实现时新增的边界决策 10 与两处补充见本节末尾「分批交付」之后。

**问题**

公司内网存在多个互不连通的网段（测试网段 / 生产网段）。平台与 worker 部署在测试网段，
worker 只能从**自己所在网段**出站，因此指向生产的接口用例根本发不出去。

这不是环境配置问题，而是**执行位置**问题：现有模型里没有任何东西能表达「这次执行该从哪个
网段发出」。被测地址只是 endpoint URL 里的 `{{var}}`，`environments` 只有 `variables` /
`secrets`；`lib/run.ts` 的 `fetch` 没有 proxy、没有自定义 dispatcher；队列名是模块常量
`"executions"`，worker 无条件消费它；`workers.mode` 只是个上报标签，**不参与路由**。

要分清两堵独立的墙，不能混在一起解：

1. **平台 → 被测服务** 不可达。
2. **生产网段机器 → 平台的 Redis / Postgres** 也往往不可达。

只有第一堵墙时是简单问题；两堵都在时，现有的「worker 拉队列」模型从根上不成立。

**开工前置条件（硬门槛）**

生产网段那台机器必须能**出站**到平台 Redis 6379 与 Postgres 5432。这是拉队列模型的下限，
无法绕过，方案的全部有效性押在这一条上。**必须在写代码前拿到运维答复**：

- 能出站 → 按本节 P2-8 实施。
- 不能出站 → P2-8 交付为零，直接转 P4.5 的 HTTP 长轮询 Runner（只需出站 443）。

**方案选型（三条路线的取舍）**

| 方案 | 改动量 | 前提 | 结论 |
|---|---|---|---|
| A. 出口代理（`undici` `ProxyAgent` + 环境级 proxy 配置） | 小 | 有一台两边都能到的正向代理/跳板 | **不采用**：只解决第一堵墙，且生产网段通常不提供这种代理 |
| B. 分区 worker + 队列路由 | 中 | 生产网段能出站到 Redis + Postgres | **采用为 P2-8** |
| C. Runner 反向拉取（HTTP 长轮询） | 大 | 生产网段只需出站 443 | **推迟到 P4.5**：前置条件不成立时才必须做，届时同时覆盖仓库用例 |

选 B 的两个决定性前提均已确认：**凭据继续留在平台库**（不做「只下发变量名 + runner 侧取值」
的改造），**生产准入走后续权限与审批流程**（本切片不做）。这两条一定，B 就不需要先建
HTTP 协议。

采用 B 的已知代价，明确接受：生产网段的 worker 持有平台 Postgres 的写凭据，且直接
`UPDATE executions` / 写 `workers` 表——worker 侧目前没有认证边界。这是选择 B 而非 C
换来的实施成本节约，不是被忽略的问题；安全评审若否决这一点，处置办法是转 C，而不是给 B 打补丁。

**核心模型**

**environment 持有分区标签，队列按标签分裂，worker 声明自己服务哪些标签。**

选 environment 作为归属者，因为它是唯一天然携带「我指向哪套系统」的实体。环境选择链
（用例绑定 → 接口默认 → 项目默认，见 2.4）已经存在且被套件/流程/批量调试共用，分区自动
沿用，不需要第二套选择逻辑。分区（`labels`）与 worker 模式（`mode`）是两个**正交轴**：
本切片只让 `labels` 参与路由，`mode` 仍是上报标签。

**已确认的边界决策（9 项）**

1. **标签写进三张执行表做快照**（`executions` / `flow_executions` / `suite_executions`）。
   理由与 `environment_name`（迁移 004）完全一致：environment 改标签或被删后历史仍要说清
   这次执行从哪跑的；更关键的是**认领与取消都要靠这一列找队列**，不能回查 environment。
2. **`suite_executions` 一起加列**，尽管套件执行后端（P2-4.2）尚未实现。迁移 010 已经吃过
   「等做出来再加列就要回填、而回填时分不清历史行」这个亏，同一个理由。
3. **标签格式必须约束**：`^[a-z0-9][a-z0-9-]{0,31}$`。它**会进 Redis key**
   （`executions-<label>`），不约束就会写出奇怪的键。校验放在路由层而非 CHECK——错误信息
   要能回给用户。
4. **入队前检查该标签有在线 worker，没有就拒绝，绝不写行。** 这是本切片最容易漏、代价最高
   的一处。少了它，用户看到的是一条永远 `queued`、5 分钟后被回收判成
   `execution abandoned by worker` 的记录——排查方向会完全跑偏到 worker 崩溃上，而事实是
   这个分区根本没有执行器。检查放在 `INSERT` **之前**，因此连补偿删除都不需要。
5. **用真错误码而非字符串嗅探**：新增 `NoRunnerError` + 错误码 `2004`，`data` 带 `label`。
   现有 6 处前端错误分支靠 `detail?.includes("queue unavailable")` 判断，分区化之后
   「队列挂了」与「这个分区没人」是两个完全不同的处置动作，必须能分开。
6. **认领语句加分区防御**：`WHERE id = $1 AND status = 'queued' AND runner_label = ANY($2)`。
   at-most-once 的第二层保护（4.7）现在多一个维度——万一有 job 被投进了错的队列，worker 在
   `fetch` **之前**退出，而不是从错误的网段发出一个真实请求。这是本切片唯一的安全性增量，
   不能省。
7. **多标签进程必须拆分并发**：`perLabel = max(1, floor(WORKER_CONCURRENCY / labels.length))`，
   心跳上报 `perLabel × labels.length`。BullMQ 的 Worker 绑定单队列，一个标签一个 Worker
   实例，各给一份 `CONCURRENCY` 会让容量凭空翻倍，执行器面板上的数字就是假的。
   **推荐一个进程只服务一个标签**，多标签只作为单机开发的便利。
8. **`requeueOrphans` 只补投自己服务的分区**（`WHERE runner_label = ANY($1)`），并投进对应
   队列。一个 worker 不该对它看不见的分区采取行动。**`reapStale` 保持全局**——它管的是 DB
   状态而不是队列，advisory lock 已经解决并发。
9. **`CANCEL_CHANNEL` 保持单条全局频道**。取消是广播 + 持有者对号入座，按标签分频道只会让
   每个 worker 多订阅几条，没有收益。

**已知行为，必须写进代码注释**

某分区 worker 在**入队之后**掉线，那批行仍会在 5 分钟后被 `reapStale` 判失败。决策 4 的
入队前检查只挡新的，挡不住这种。这是可接受的，但不写注释下一个人会当成 bug 查。

**一次性代价**

队列名从 `executions` 变为 `executions-<label>`，Redis 里现存的 job 会成为孤儿。按
AGENTS.md 的数据兼容条款不写兼容代码，改完清一次开发 Redis 即可——库里 `queued` 的行由
worker 启动时的 `requeueOrphans` 自己捡回来。

**执行器面板：加分区轴，不加第二排 segmented**

`/api/v1/system/workers` 返回新增 `partitions: [{ label, online, total, capacity, inflight,
waiting, failed }]`，而不是把 `queues` 改成两层嵌套 record。标签全集 = `workers.labels` ∪
`SELECT DISTINCT runner_label FROM environments` ∪ `'default'`——取并集是为了让一个
「配了但没人服务」的分区**显式出现在面板上且 online=0**，这正是用户最需要看到的那一行。

前端**不再加一排 segmented**：现有 mode segmented 已占那个位置，4.5 明确否决过「同页两排
下划线 tab」。分区用 worker 表格上方一个小表呈现，是同一份数据的另一个切片而不是导航层级。
`capacity` / `inflight` 的 mode 键保持不变（`repository` 预留位不动）。

**分批交付**（后端先行，P2-8.1–P2-8.3 完成后即可手工起一个带标签的 worker 验证路由是否正确，
P2-8.4 起才是可视化）

| 批次 | 内容 | 预估 | 状态 |
|---|---|---|---|
| P2-8.1 | 迁移 `027_p2_execution_partition.sql`；`queue.ts` 队列名按标签分裂（`Map<label, Queue>`）；`enqueue.ts` 的 `resolveRunnerLabel` + 入队前在线检查 + `NoRunnerError`；`cancelRun`/`cancelBatch` 按行标签找队列 | ~1–2 天 | **已实现** |
| P2-8.2 | `run.ts` / `flowRun.ts` 认领语句加 `runner_label` 防御 | ~0.5 天 | **已实现**（`suiteRun.ts` 一并加了同款守卫） |
| P2-8.3 | `worker.ts`：`WORKER_LABELS`、每标签一个 Worker、并发拆分、心跳写 `labels`、`requeueOrphans` 按分区过滤、启动日志打印实际队列 | ~1–2 天 | **已实现** |
| P2-8.4 | `types.ts`（`Environment.runnerLabel` / `Worker.labels`）+ `environments.ts` 读写与校验 + `system.ts` 分区轴 + 四处 enqueue 调用方错误映射（`endpoints.ts` / `cases.ts` / `flows.ts` ×2） | ~1–2 天 | **已实现**（`suites.ts` 一并映射，共 6 处） |
| P2-8.5 | 前端：`api.ts` 类型；`i18n.ts`（`environments.runnerLabel*` / `workers.partition*` / `run.noRunner`，zh+en 各一行扁平键）；`Environments.tsx` 抽屉与表格列；`GlobalApp.tsx` 分区表格 + worker 表分区列；6 处错误分支改判 `2004` | ~2 天 | **已实现** |
| P2-8.6 | `.env.example` 加 `WORKER_LABELS`；`start.sh` 注释给出起第二个分区 worker 的命令（**不自动拉起**，那台机器不在本地） | ~0.5 天 | **已实现** |
| P2-8.7 | 配置体验补齐（2026-08）：`GET /system/runner-labels`（任意登录用户可读，只回标签与在线/注册台数，不带 hostname/pid）；环境编辑器分区建议源换成「worker 分区 ∪ 本项目已用标签」，选中分区无在线执行器时提前给出提示（保存仍不阻，分区可先于 worker 存在）；环境复制 `POST /environments/:environmentId/duplicate`，服务端 `INSERT … SELECT` 连 variables/secrets/runner_label 一起复制（secret 明文不出服务端，read-then-create 会产出一个 secret 全空的副本） | ~0.5 天 | **已实现** |

**实现时新增的一条边界决策（10）**

10. **套件在 `member_default` 策略下若成员跨分区，入队直接拒绝**（400，文案给出涉及的分区
    列表）。套件的成员是**进程内扇出**的（5.0.11 边界 2），它们由持有这一个 job 的那台
    worker 就地发请求，而 worker 只能从自己所在网段出站——所以一次套件执行必然整体落在
    一个分区上，这不是可放宽的实现细节。挑一个分区跑会让另一半成员从错误的网段发出，
    得到的失败会被读成「被测服务挂了」；让用户拆成两个套件或设一个套件级环境
    （`override`）比给一份混着两个网段结论的报告诚实。相应地 `suite_executions.runner_label`
    由入队时解析并冻结，成员行**继承**它而不是各自重新解析（否则入队后改标签会写出一行
    本机 worker 认领不了的记录）。

**实现时的两处补充**

- `WORKER_OFFLINE_AFTER_SECONDS`（30 秒）从 `routes/system.ts` 提到 `models/types.ts`：入队前
  的在线检查与执行器面板必须用同一个阈值，两个数会让「面板显示在线、入队却说没有执行器」成立。
- 错误码 `2004` 的响应带 `data: { label }`（与 2003 同一类刻意变体），HTTP 用 503——输入没有
  问题，缺的是基础设施。前端由 `api.ts` 的 `noRunnerLabel()` 单点判定，不再嗅探文案。

**明确不做**

- **按环境配代理**（方案 A）。只在生产网段根本放不了 worker 时才需要，是 P2-8 失败后的备选，
  不提前埋。
- **HTTP 长轮询 Runner**（方案 C，P4.5 的 `POST /worker/register|claim|heartbeat|complete`）。
  只在前置条件不成立时才必须做。
- **凭据下沉 / 只下发变量名**：维持现状，凭据继续留在平台库。
- **生产准入的权限与审批**：后置。相关提示：分区打通后工具就能对生产发 `POST` / `DELETE`，
  而 `lib/queue.ts` 的 `attempts: 1`「绝不重试」（理由见 4.7）保护的正是这个场景——审批做
  之前，这一条不能松。
- **仓库模式的队列**：`workers.mode` 仍只是标签。等仓库模式真做时它自己开队列，本切片的标签
  机制可直接复用，不需要返工。
- **worker 侧认证边界**：不在本切片解决，见上文「采用 B 的已知代价」。

**待决策（2026-08-27 记录，未排期）：分区 worker 与平台 pg/redis 的连通性**

场景：目标网段（如办公内网 / 生产 DMZ）能访问被测系统，但**访问不到平台的 Postgres 与
Redis**，那台机器上按现状起不了 worker。这是部署拓扑问题，不是 `runner_label` 模型的问题
——分区标签回答「这次执行从哪个网段发出」，仓库自动化（`workers.mode='repository'`，
环境执行 vs 容器执行）同样要靠它区分业务系统所在网段，模型继续成立。要换的只是传输层：

| 方案 | 做法 | 评价 |
|---|---|---|
| A 反向隧道 | worker 侧 SSH/frp 把平台 5432/6379 映射到本地 | 0 代码、当天可用；把平台库暴露给该网段、凭据留在对端，只适合临时过渡 |
| B HTTP 拉取型 agent | worker 只出站 HTTPS，`register/claim/heartbeat/complete` 走 P4.5 规划的那组接口 | 长期正确方向；需要 worker 注册凭据、租约续约与超时、结果/日志上报、进度事件回灌 |
| C 双传输并存 | 认领+上报抽一层：可信网段继续 pg+redis 直连，隔离网段走 B | 务实路径；认领语义就是一条 `UPDATE … WHERE status='queued'`，HTTP 版只是把这条 UPDATE 搬回服务端执行 |
| D 跳板机放 worker | 找一台双网段可达的机器 | 0 代码，多数内网场景可行；「客户内网」类无解 |

决策时必须一起掂量的安全账：分区 worker 持平台 Postgres **写**权限、且无 worker 侧认证
边界（上文「采用 B 的已知代价」已按可控网段记为接受成本）。往不受控网段扩 worker 时这笔
账不能再按「已接受」记——那是 B 的真正驱动力，隧道只是缓兵。**在选定方向之前，不向不受控
网段的机器部署分区 worker。**

> **2026-08-31 更新**：上表方案 B 已被采纳为 **P4.5 的正式形状**，范围与边界见 8.0，协议见
> 8.2。方案 C（双传输并存）**不做**——两条认领路径共存意味着 at-most-once 要在两个地方各证
> 一次，而 P4.5 的 Runner 本身就同时覆盖「跨网段」与「跑仓库代码」两个需求，B 落地后 C 想
> 保留的那点复用价值不存在了。可控网段继续用 P2-8 的分区 worker（它更省一次 HTTP 往返），
> 不受控网段用 Runner，两者靠**同一套 `runner_label`** 区分——这不是「双传输」，而是两种
> 执行器服务不同标签。

### 5.1 数据库迁移（从 015 顺序追加）> 序号说明：计划原写的 `003_p2_schema.sql` 为过时命名，实际接在 `014` 之后。
> 按上述批次拆分为多个迁移，而不是一个大文件。

按纵向切片拆分，文件名在实现时保持一批一个主题：

```
015_p2_execution_index.sql
  execution_index  (id, project_id, kind, target_id, target_name, detail_id, status,
                    total, success_count, failed_count, skipped_count, canceled_count,
                    created_at, started_at, finished_at)
  execution_steps  (id, index_id, step_id, step_type, step_name, status, stage, position,
                    input_snapshot JSONB, output_snapshot JSONB, error, http_execution_id,
                    started_at, finished_at)
                   # kind 首批: flow | scenario | suite | batch
                   # http_execution_id 可空；HTTP 证据仍在 executions，非 HTTP 结果不伪造 endpoint

016_p2_data_sources.sql
  data_sources      (id, project_id, name, type, config JSONB, credentials_encrypted,
                    key_version, created_at, updated_at)
  sql_definitions   (id, project_id, data_source_id, name, statement_type, sql,
                    params JSONB, description, created_at, updated_at)
                   # 首发 type=postgresql；statement_type=query|command

017_p2_flow_nodes.sql
  scripts 扩展      (kind 增加 node)
  execution_steps  (status 增加 skipped)
  # 受控并发配置存 run_spec JSONB，不加列；并行层级写 execution_steps.stage

018_p22_request_lifecycle.sql
  test_cases 扩展   (pre_request_hooks / extracts / response_scripts JSONB，默认 '[]')
  executions 扩展   (response_script_results JSONB，默认 '[]')
  scripts 扩展      (kind 增加 response)

020_p2_scenarios.sql   # 场景已撤回，见 5.0.6
021_drop_p2_scenarios.sql
  # 删 scenarios / scenario_executions 与 kind='scenario' 的父索引；
  # 删 executions 的 scenario_execution_id / scenario_step_id 两列；
  # source 的 CHECK 收回 endpoint_debug | test_case | flow_step。

026_p2_suites.sql      # 计划原写 022，已被 022_p26_advanced_nodes.sql 占用；023 是历史空洞，永久弃用
  test_suites        (id, project_id, name, description, selection_type,
                     selection_config JSONB, execution_config JSONB, tags, 时间戳)
  suite_executions   (id, project_id, suite_id, suite_name, environment_id, environment_name,
                     status, total, success_count, failed_count, skipped_count, error,
                     member_snapshot JSONB, run_spec JSONB, worker_id,
                     execution_index_id, 时间戳)
                     # 与 flow_executions 对齐：明细表不放 canceled_count，canceled 只在
                     # execution_index 上派生；run_spec 在终态置 NULL
  execution_steps 扩展 (child_index_id → execution_index(id) ON DELETE SET NULL)
                     # 成员是一次完整的父执行（流程成员）时指向它的 index 行；
                     # 用例成员仍用 http_execution_id 指向 executions
  execution_index    (kind 的 CHECK 收窄 → flow|suite|batch，去掉 021 留下的死值 scenario)
                     # 'suite' 015 就已在 CHECK 里，套件本身不需要放宽约束

027_p2_execution_partition.sql   # P2-8 执行分区（跨网段执行），规划见 5.0.12
  environments 扩展     (runner_label TEXT NOT NULL DEFAULT 'default')
                        # 「这个环境指向的系统该从哪个网段发请求」。选 environment 承载是因为
                        # 它是唯一天然携带「我指向哪套系统」的实体，且环境选择链（2.4）已被
                        # 用例/接口/流程/套件/批量调试共用，分区自动沿用，不需要第二套选择逻辑
  workers 扩展          (labels TEXT[] NOT NULL DEFAULT ARRAY['default'])
                        # 这个 worker 服务哪些分区。与 mode 是正交轴：本切片只有 labels 参与路由
                        # 不建 GIN 索引：这张表是几十行量级，顺序扫比索引快
  executions 扩展       (runner_label TEXT NOT NULL DEFAULT 'default')
  flow_executions 扩展  (runner_label TEXT NOT NULL DEFAULT 'default')
  suite_executions 扩展 (runner_label TEXT NOT NULL DEFAULT 'default')
                        # 三张执行表都要快照列，理由同 environment_name（004）：环境改标签或被删后
                        # 历史仍要说清从哪跑的；更关键的是认领与取消都靠这一列找队列，不能回查环境
                        # suite_executions 一起加——套件执行后端未实现，但 010 已经吃过
                        # 「等做出来再加列就要回填、而回填分不清历史行」这个亏
                        # 标签格式 ^[a-z0-9][a-z0-9-]{0,31}$ 在路由层校验而非 CHECK：它会进
                        # Redis key（executions-<label>），但错误信息要能回给用户

028_p2_mocks.sql       # 计划原写 023 → 027，随套件与执行分区两次顺延；定位见 5.0.7（对外联调桩）
  mocks               (id, project_id, endpoint_id, name, public_id, mode, enabled, priority,
                      request_match JSONB, response JSONB, proxy_config JSONB, delay_ms, 时间戳)
                      # public_id 带熵不可枚举、匿名可访问；proxy_config 含白名单/连接/响应超时/大小上限
                      # delay_ms 面向外部调用方模拟慢/超时；request_match 支持从请求取模板变量
  mock_request_logs   (id, mock_id, method, path, matched, status_code, duration_ms,
                      request_snapshot JSONB, response_size_bytes, created_at)
                      # 联调排障核心：matched / 请求快照 / status_code 齐全

022_p26_advanced_nodes.sql   # 实际先于套件/Mock 落地（P2-6 提前实现）
  execution_steps 扩展  (parent_step_id 自引用 ON DELETE CASCADE、iteration)
  # 容器节点（loop/subflow）内部每一步都留证据行，parent_step_id 指回容器行；
  # 015 的 UNIQUE(index_id, step_id, position) 改为两条分区唯一索引：顶层保持原语义，
  # 嵌套按 (容器行, 节点, 声明下标, 迭代号) 唯一（position 仍是节点声明下标，
  # 它承担同 stage 同名写冲突的确定性裁决，不能改成按启动顺序自增）。
  # 父级计数只统计 parent_step_id IS NULL 的顶层步骤。

024_p27_data_source_adapters.sql  # 编号顺延；P2-7 规划见 5.0.10
  data_sources  (type CHECK 放宽 → postgresql|mysql|sqlserver|oracle|mongodb|redis)
  sql_definitions 扩展 (kind TEXT NOT NULL DEFAULT 'sql' CHECK(kind IN ('sql','mongo','redis')),
                      operation JSONB)
  # kind='sql' 时 statement_type(query|command) 有效；mongo/redis 的操作类型由
  # operation JSONB 内部表达，不新增第二张定义表（CRUD/usage/引用/快照/试跑五条路径复用）

025_p27_definition_shape.sql      # 024 的收尾：只加列不够，建表时的 NOT NULL 还在
  sql_definitions   statement_type / sql 解除 NOT NULL（mongo/redis 定义这两列为 NULL）
  sql_definitions   + CHECK sql_definitions_kind_shape_check
                    # kind='sql'  → statement_type/sql 非空且 operation 为空
                    # kind<>'sql' → statement_type/sql 为空且 operation 非空
                    # 形状由数据库兜住，避免任何漏判的写路径留下「既无 SQL 也无 operation」
                    # 的定义——那种行只会在执行时才炸
```

所有历史表继续保留名称快照并使用 `ON DELETE SET NULL`；配置资源被流程、套件或 Mock
引用时先返回 usage 清单和 409，只有 `?force=true` 二次确认后才能破坏引用。敏感字段不进入 mapper。

### 5.2 后端新 API

```
SCENARIOS                                      # 已撤回，见 5.0.6

TEST SUITES                                    # 成员为接口用例与流程，各自独立执行
  GET/POST /projects/:id/test-suites
  GET/PUT/DELETE /projects/:id/test-suites/:suiteId
  POST /projects/:id/test-suites/:suiteId/preview
  POST /projects/:id/test-suites/:suiteId/execute
  GET  /projects/:id/test-suites/:suiteId/executions
  GET  /projects/:id/suite-executions/:executionId   # 明细 + 成员行（含子执行指针），运行抽屉必需
  POST /projects/:id/suite-executions/:executionId/cancel

MOCK
  GET/POST /projects/:id/mocks
  GET/PUT/DELETE /projects/:id/mocks/:mockId
  POST /projects/:id/mocks/:mockId/test
  GET  /projects/:id/mocks/:mockId/logs        # 联调排障：matched / 请求快照 / status_code
  ANY  /mock/:publicId/*                       # 独立 Runtime，不使用项目 JWT，面向外部联调方匿名访问

ADVANCED NODES (P2-6)                          # 已实现
  GET  /projects/:id/execution-steps/:stepId/children
  # 一个 loop/subflow 容器步骤内部跑过的步骤 + 它们的 HTTP 快照。按需拉取而不是随
  # /flow-executions/:id 一起返回：100 次迭代 × 多节点循环体的嵌套行数可能比顶层步骤
  # 多一个量级，默认带上会让运行面板变重。
  # 循环/子流程本身没有独立 CRUD——它们是流程节点，随 PUT /flows/:flowId 保存。

DATA SOURCES
  GET/POST /projects/:id/data-sources  GET/PUT/DELETE /projects/:id/data-sources/:dataSourceId
  GET  /projects/:id/data-sources/:dataSourceId/usage
  POST /projects/:id/data-sources/:dataSourceId/test
  POST /projects/:id/data-sources/:dataSourceId/query
  GET/POST /projects/:id/data-sources/:dataSourceId/sql-definitions
  GET/PUT/DELETE /projects/:id/sql-definitions/:sqlId
  POST /projects/:id/sql-definitions/:sqlId/test              # v1.8 测试运行预览结果

EXECUTION INDEX
  GET  /projects/:id/execution-index           # ?kind=flow|suite|all &status &keyword &page &pageSize
                                               # 单步调试的一次性父索引（detail_id 自指）不返回
  GET  /projects/:id/execution-index/:indexId  # 父行 + 顶层步骤行（嵌套证据另走 children）
  POST /projects/:id/execution-index/:indexId/cancel

PLATFORM LIMITS (P2-4.2)                       # 登录即可读，无敏感信息
  GET  /system/limits                          # flowParallelism / suiteLeafBudget /
                                               # maxLoopIterations / maxLoopConcurrency /
                                               # maxWaitMs / suiteMaxMembers
  # 存在的理由：请求节点并发改为原子领取后，「一个请求最多并发几次」= FLOW_PARALLELISM，
  # 而它是环境变量。编辑器写死上限必然与服务端不一致（填得进去、保存被拒），所以由
  # 服务端说出这些数。

EXECUTION PARTITION (P2-8)                     # 无新路由，只扩现有形状；规划见 5.0.12
  POST/PATCH /projects/:id/environments        + runnerLabel（校验 ^[a-z0-9][a-z0-9-]{0,31}$）
  GET        /projects/:id/environments        + runnerLabel
  GET  /system/workers                         + partitions[{label,online,total,capacity,
                                                 inflight,waiting,failed}] + Worker.labels
  # 标签全集 = workers.labels ∪ DISTINCT environments.runner_label ∪ 'default'，
  # 取并集是为了让「配了但没人服务」的分区显式出现且 online=0——那正是最需要看到的一行。
  # capacity/inflight 的 mode 键不变（repository 预留位不动）。
  # 所有 execute 路由新增失败分支：错误码 2004「该分区无在线执行器」，data 带 label。
  # 不用现有的字符串嗅探（前端 6 处 detail.includes("queue unavailable")）——分区化之后
  # 「队列挂了」与「这个分区没人」是两个不同的处置动作。
```

### 5.3 前端新页面

- 项目侧栏调整为「接口资产：接口/环境/数据源/Mock」「编排与回归：流程/套件」
  「通用：执行记录」；入口随切片启用，未实现能力不展示空页面
- 测试套件配置 (标签选择 / 手动选择 / 全部，**用例 + 流程**) + **跨接口用例选择器**
- Mock 管理 (自动 / 固定 / 模板 / 代理模式) —— 面向外部联调方：公开访问地址、请求日志（排障核心）、
  规则测试；代理超时标注为保护性上限，delay_ms 标注为面向外部调用方的慢/超时模拟
- 数据源连接配置 (首发 PostgreSQL；敏感字段不回显，只显示是否已配置)
- **数据源 SQL 定义**: 命名 SQL 列表 + 编辑器 (参数 `{{变量}}` 绑定防注入, 测试运行), 供流程数据库节点复用
- 执行记录拆成父执行与 HTTP 明细两层；父执行使用稳定详情路由，HTTP 子步骤继续复用
  `ExecutionSnapshot`，不把复杂流程/套件报告塞进抽屉
- 跨接口用例 API 在选择器上线前补服务端分页和接口摘要字段；选择器支持搜索、接口/标签筛选、
  单选/多选与按接口分组，供流程来源与套件成员共用
- 所有 P2 详情页和执行详情以 URL 恢复状态；新增 Drawer 在窄屏全宽，继续遵守单主滚动容器和
  Quiet Console 的单一运行中动画预算
- **执行分区（P2-8）**：环境编辑抽屉加「执行分区」输入 + 环境列表加分区列；执行器面板在
  worker 表格**上方**加一个分区小表（label / 在线 / 容量 / 在途 / 排队 / 失败），worker 表格
  加分区列。**不再加第二排 segmented**——现有 mode segmented 已占那个位置，4.5 明确否决过
  「同页两排下划线 tab」，分区是同一份数据的另一个切片而非导航层级。

### 5.4 流程编排补全（P1-2 并入项）

沿用已交付的画布与执行链路，不另起炉灶：

- **新节点类型**: 脚本 / 条件 / 数据库 / 循环 / 等待 / 子流程。节点抽屉已是页签结构
  （请求 / 前置 / 提取 / 校验），新类型按 `FlowNode.type` 分派到各自的配置页签。
- **节点模型**: `FlowNode` 改为带公共字段的判别联合，`FlowEdge` 保留条件/分支元数据；画布
  读取和保存不能再把节点、边压缩成 request 专用字段，避免静默丢数据。
- **并行执行**: 边语义从「只表达依赖」扩展为可并行；当前 `topologicalOrder` 实际返回平铺
  顺序，P2 改为 stages/ready-set 计划，同层受控并行，并按 5.0.2 的失败传播规则结算。
- **执行索引**: P2-0 先建立父执行索引与通用步骤证据；P2-4 再切换执行记录 UI。现有 flow
  `?run=` 深链继续兼容，但复盘指定历史时节点抽屉必须读取同一次 run，不能回退到节点最新结果。
- **变量袋扩展**: `ctx.variables` 已在沙箱预留；脚本节点与数据库节点的输出统一写回
  同一个变量袋，沿用「节点提取 > 流程变量 > 环境变量」优先级，不新增第二套作用域。

### 5.5 分批验收门槛

1. **P2-1**：数据源密码保存后不回显且可单独更新；连接测试、命名 SQL 试跑、流程数据库节点
   使用同一执行器；参数值只经驱动绑定；超时/行数/结果大小限制可见；删除引用资源返回 usage。
2. **P2-2**：无依赖节点按上限并行；同名输出冲突稳定失败；条件只激活命中分支；脚本/数据库/
   条件步骤都有可复盘结果；取消后不再启动新步骤，已启动步骤尽力中断。
3. ~~**P2-3**~~：**已撤回**（见 5.0.6）。编排统一由流程承担，跨接口传值、库校验、前置/后置
   脚本都在一条流程内完成，不再有第二套语义。
4. **P2-4**：标签/全部选择在入队时固化成员快照；套件并发和 fail-fast 生效；每个成员（用例 /
   流程）作为独立执行，互不传变量；flow/suite 均可从执行记录打开稳定详情，删除原资源后
   历史仍可读。
   补充（5.0.11 确认）：一次套件执行只有一个令牌池，成员数与叶子并发是两个旋钮，
   嵌套不放大并发（`C × FLOW_PARALLELISM` 的乘法不成立）；请求节点声明的并发**原子领取**
   ——声明 3 就真的同时 3，凑不齐整批等，`N > 池容量` 在保存与入队两处直接报错；
   fail-fast 后未启动成员留 `skipped` 证据行，在途成员跑完；套件预览把峰值并发需求
   与平台上限一起写出来。
5. **P2-5**：四种 Mock 模式按优先级匹配；禁用规则不响应；代理只访问白名单；敏感头和响应受限；
   Mock 流量不改变接口用例通过率或正式执行统计；外部调用方可匿名访问 `/mock/:publicId/*` 并在
   日志中确认 matched 与请求快照；代理超时作为保护性上限回 504；delay_ms 对平台内流程不构成
   超时语义（流程自身 30s 预算兜底）。
6. **P2-6**：循环达到硬上限必停；等待不超过首版上限；子流程循环引用在保存和运行时均拒绝，
   递归深度受限；高级节点失败仍遵循统一传播和取消语义。
   补充（实现后固化，见 5.0.8）：容器节点不占并发额度，嵌套不放大并发（三层嵌套的真实
   并发仍受单次 `FLOW_PARALLELISM` 封顶）；循环迭代互不可见，同一接口的并发请求由
   「按次数循环 + 单节点循环体 + concurrency」表达；父级计数只统计顶层步骤，容器内部
   每一步都有可复盘证据行。
7. **P2-8**（见 5.0.12）：环境可配执行分区标签，指向该环境的用例/流程/套件/批量调试全部
    路由到对应分区的 worker；一个只服务 `prod-dmz` 的 worker 不会领到 `default` 的任务，
    反之亦然；**目标分区无在线 worker 时执行请求直接失败（错误码 2004，文案指明是哪个分区
    没有执行器），不写出一条会被回收判死的 `queued` 记录**；执行器面板列出全部分区（含
    「配了但没人服务」且 online=0 的那些）；环境改标签或被删后，历史执行仍显示原分区名。

#### 5.0.13 流程编辑器「列表模式」（2026-08-29 范围与边界已确认）

**定位**：后端零改动（不加路由、不加迁移、不动 `api.ts`）。列表模式是同一份流程文档
（`nodes`/`edges`）在 `FlowWorkspace` 的**第二个投影**：保存、运行、撤销、脏检查、
`flowPlan` 计划、运行状态、节点抽屉、运行记录侧栏全部复用画布现有逻辑，列表不建第二套
状态。两模式随时互切（顶栏分段开关，`localStorage apitest.flowViewMode` 记忆，默认画布），
未保存守卫与撤销栈天然跨模式共享。

**已确认边界**：

1. **拓扑编辑平价**：列表内新增步骤自动接在前一步后（复用 `insertAfter` 语义，条件节点
   提供「满足/不满足」两个分支入口），**不提供**任意两节点手工连线；改接已有节点回画布做。
2. **排序与拖动换位**（2026-08-30 用户确认增补并两次修订）：列表支持行拖动换位，语义是
   **改连线**（链表式 splice：X 的入边/出边改接到新邻居，缺口两侧直连，沿用原边的分支
   标签；拖回原位是净空操作，不压捷径边）。坐标处理（二次修订，验收发现「列表改完切回
   画布，连线对不上卡片」）：**换位后坐标按新序列重排**——顶层摞成 x=80 的竖链
   （`restackTopLevel`，与 `addNode` 同一起点与间距）、循环体按 `addStep` 摞放规则重排
   （`restackLoopBody`），画布与列表从此一一对应。代价：列表一拖，画布二维布局压成
   竖链——「顺序即语义」，以列表为准时就该如此（撤销可恢复）。顶层行序另做乐观 order
   更新让行立即到位（计划回来内容一致则保持原数组）。顶层顺序沿用服务端计划的
   `order`/`stages`（与画布批次号同一来源，含并行语义）；循环体不在计划内、按坐标排；
   计划不可用时退回声明顺序、未入序节点沉底。
   **分支守卫**（二次修订，验收发现「拖动后执行顺序变乱」的根因是 splice 静默改分支）：
   会改变分支归属的拖动一律拒绝（提示回画布）——X 挂在条件出口下但落点换了挂点；
   落点的前驱是条件节点或插入点带分支标签（X 要顶替另一条分支的后继）；X 留在原出口
   下但插入点标签与原标签冲突。两个安全例外：X 仍挂在原出口下挪位置（标签原样带走）、
   X 贴身换位到原后继的正后方（仍在原路径下游）。此外 X 有多条入边或多条出线（汇聚
   点/并行扇出）时同样拒绝。splice 在无环图上不会造出环（插入点两侧行的拓扑层级保证
   了这一点），历史（撤销）走文档快照。
3. **移入/移出循环**（2026-08-30 两次修订，纯拖拽、不再有独立虚线区）：拖拽对齐画布
   手感——顶层步骤拖到**循环容器行的中段** = 移入该循环（上/下边缘仍是插前/插后，三段
   式命中；循环本身被拖时没有「移入」，循环不嵌套循环）；体内步骤拖到**任何顶层行** =
   移出并 splice 插在该行的前/后（`moveStepOutAt`：一次完成移出 + 接链 + 坐标摞放，
   分支守卫同样生效），拖到**另一个循环行的中段** = 直接换进那个循环。悬在体内行上不
   放行（往体内指定位置 = 先移入再体内换位两步，与画布一致）。菜单「移入循环 / 移出」
   保留作为键盘路径；首版的「列表底部虚线区移出」已撤——长列表里沉底的落点没人找得到。
   **自动接线**（三次修订，验收发现「拖进循环后线没连上」）：列表的移入/移出都会把两
   处的线接好——原位置合拢（P→X→S 变回 P→S，沿用 P 的分支标签）；移入时 X 接在目标
   体内所有「无出边的叶子」后面（简单链 = 最后一步，并行分支 = 公共尾巴），移出（菜单）
   时 X 接在顶层叶子后面、拖拽移出时 splice 进指定位置且体内缺口同样合拢。X 原位置有多
   条入边/出线时合拢没有唯一答案，退回画布行为（只清线不接）。画布上的拖进/拖出框保持
   原语义（视觉上看得见断线，手工补）——自动接线只属于列表。
4. **列表新增步骤**（2026-08-30 增补，修订「追加不接线」）：列表模式里点行上的 + 或
   工具栏「添加步骤」，新步骤**接进链条**而不是另起一条并行线——断开锚点原来的后继边
   （同分支那条），改走「锚点 → 新步骤 → 原后继」（画布出口圆点保持「另起并行线」的
   原语义，不 splice）。工具栏新增的锚点是**所选行**（最后点过的行，accent 左边框标示），
   没有所选行就接在列表最后。
5. **保存拦截未连线步骤**（2026-08-30 用户规则，画布与列表同一条）：任一作用域里有
   超过一个节点、且某节点既无入边也无出边，保存直接拒绝并点名这些步骤（单节点作用域
   没有连线可言，不算未链接）。游离节点进不了任何执行批次，留着它保存等于埋雷。
6. **画布专属能力**：框选/多选/整组拖动/自由连线/拖拽换框在列表模式不出现（入口隐藏，
   功能不删减）。
7. **分支语义**：列表不渲染连线本身（顺序即语义），条件分支用行上 chip（满足/不满足）表达。
   **IF 缩进**（2026-08-30 增补）：条件的两条分支链缩进进 `.flow-cond-children`（竖线与循环
   体同一语义），嵌套条件/循环递归渲染；**汇合点**（两分支都能到达的节点）退回外层——它
   属于「整个条件之后」。归属判定按作用域计算（`branchOwnersOf`）：在某条分支标签边的
   下游、不在另一条分支的下游、且全部入边来自条件或同块节点（共享节点退回外层）；按显示
   序（拓扑序）处理条件，外层先认领、内层后改写，嵌套逐层加深。循环体内的条件同样以块
   缩进。**「条件后」加一步**（同日增补）：条件行第三个入口——分支已汇合时插在最早的
   汇合点后（splice）；没汇合时接到**所有**分支尾巴上（每条路径走完才轮到它），未接线
   的分支由条件本身按该分支标签引出；一个分支都没有时用条件 → 新步骤的**无标签边**
   （执行器里无标签边 = 来源成功即激活，两种结果都执行——正是「整个条件后」）。
9. **循环尾部落点条**（2026-08-30 增补）：循环是最后一行时「循环后」没有下一行的上半区
   可落，循环块底部加一条**透明命中条**（覆盖块底与下一行的间隙，不占布局高度），拖着
   步骤悬上时亮 accent 插入线：顶层步骤落下 = 插到循环后，体内步骤落下 = 移出并插到
   循环后。
10. **块折叠与列表滚动**（2026-08-30 增补）：循环块与条件块可折叠（块头行前的 chevron；
    折叠只藏子行，块头信息还在——条件行上补折叠计数 chip，循环行副标题本就带「N 步」）。
    往块里加步骤（+ / 拖入 / 分支按钮）自动展开——藏起来的新增会让人以为没加成功。
    折叠状态不持久化（阅读动作而非文档结构，重开恢复全展开）。长列表**永远在一个框内**：
    `.flow-list-wrap` 上限 `calc(100dvh - 300px)`、超出框内滚动（`overflow-y: auto` +
    `overscroll-behavior: contain`），与画布的 `overflow: hidden` 同一约束——页面高度
    不随步骤数增长。
8. **画布新增步骤落点**（2026-08-30 增补）：工具栏「添加步骤」落在**视口中心**
   （`useReactFlow().screenToFlowPosition` 换算画布容器的几何中心——用户正在看哪里，
   新卡就出现在哪里）；出口圆点新增落在锚点下方一格。两处都走碰撞避让
   （`findFreePosition`：从落点向下逐格让位，直到不压住任何现有卡；循环框按实际尺寸
   占位 `nodeFootprint`）。取代旧的「x=80, y=60+序号×130」固定落点——节点多了必然
   重叠，序号还会在删除/撤销后失步。循环体内新增不受影响：`addStep` 摞到框内最后
   一张卡下面，天然不冲突。

**组件落点**：`FlowStepList.tsx`（纯投影组件，回调与画布 `StepData` 同款）；
`FlowStepPresentation.tsx`（`stepSubtitle`/`KIND_BADGE`/`NodeKindIcon` 共享，卡片与行对
同一节点永远显示同一句描述）；`flowCanvas.ts` 增 `moveStepIntoLoop`/`moveStepOutOfLoop`
（坐标换算集中在树 ↔ 画布模块，不散落组件）。

**实施状态**（2026-08-29，已实现待用户验收）：

- [x] 共享展示模块抽取（画布行为不变）
- [x] `viewMode` 切换 + localStorage 记忆
- [x] `FlowStepList` 渲染（排序、循环嵌套缩进、分支 chip、运行态 `[data-status]`）
- [x] 增删交互（行间 +、行尾 X、开抽屉、条件分支入口、列表尾「添加步骤」）
- [x] 移入/移出循环菜单
- [x] 拖动换位（HTML5 DnD，同作用域 splice 改线；多连线步骤拒绝并提示，2026-08-30 增补）
- [x] 拖入循环 / 拖出循环（循环行中段移入、体内拖到顶层行 = 移出并接进链，2026-08-30 三次修订）
- [x] 移入/移出自动接线（原位置合拢 + 叶子接入 + 拖出缺口合拢，修复「拖进循环线没连上」，2026-08-30）
- [x] 换位后坐标重排（顶层竖链 + 体内摞放，修复切回画布连线对不上卡片，2026-08-30 二次修订）
- [x] 分支守卫（拒绝会改分支归属的拖动，修复「拖动后执行顺序变乱」，2026-08-30）
- [x] 列表新增步骤接进链条 + 所选行作锚点（2026-08-30）
- [x] 保存拦截未连线步骤（`unlinkedSteps`，画布与列表同一条规则，2026-08-30）
- [x] 画布新增步骤落点：视口中心 + 碰撞避让（`findFreePosition`/`nodeFootprint`，2026-08-30）
- [x] IF 分支链缩进 + 汇合点退回外层（`branchOwnersOf` 递归渲染，2026-08-30）
- [x] 「条件后」加一步（汇合点后 splice / 全部尾巴接线 / 无标签边兜底，2026-08-30）
- [x] 循环尾部落点条（循环是最后一行时「循环后」的可落区，2026-08-30）
- [x] 块折叠（循环/条件 chevron + 折叠计数 + 结构变更自动展开，2026-08-30）
- [x] 列表框内滚动（`.flow-list-wrap` max-height + overflow-y，页面高度不再随步骤数增长，2026-08-30）
- [x] CSS（`.flow-list` 系列，全复用现有令牌）+ i18n（zh/en）

---

## 六、P3 — 调度、触发、报告、告警、趋势 (3 周)

> 本节是 P3 的权威范围（2026-08-27/28 确认，已全部实现并于 2026-08-28 验收通过）。
> 计划原写的迁移名 `004_p3_schema.sql` 为过时命名：实际序号接在 `029` 之后，即
> `030` / `031`。原 6.1/6.2 那三行表结构与六条路由是占位草案，已被本节取代。
>
> **用户修正与增补已并入本节**：① 流程不做定时调度（边界 1）；② 增加套件执行报告，
> 统一报告名 `套件名_日期`，含触发源与整体耗时（边界 13、6.4）；③ 套件相关列表补服务端
> 分页（边界 14）；④ 多套测试环境的流量泳道：环境默认头 + 触发时变量覆盖，两层都做
> （边界 16、17、6.5，2026-08-28 确认）。**批次见 6.6（P3-1 ~ P3-11 全部已实现，2026-08-28
> 验收通过；验收反馈增补的 P3-11 见 6.8）。**

### 6.0 P3 范围与边界（已确认）

**问题**

P0–P2 把「怎么执行」做完了：一次执行有统一的父索引（`execution_index`）、统一的入队路径
（`lib/enqueue.ts`）、统一的分区路由（P2-8）。缺的是另外四件事：

1. **谁来按时触发**——现在只有人点按钮。夜间回归、每小时冒烟都办不到。
2. **跑完之后能拿走什么**——套件执行详情能看，但说不出「这是哪天哪次、谁让它跑的、一共
   花了多久」，因此它是一份排障视图而不是一份可以交出去的报告。
3. **失败了谁知道**——一次失败只写进库，没有任何东西会主动告诉人。
4. **一段时间里质量在往哪走**——`/dashboard` 只有累计值，看不出「昨天开始变差」。

四件事共享一个前提：**必须能分辨一次执行是谁触发的**。库里现在没有任何一列记录这件事
（`executions.source` 说的是「跑的是什么定义」，不是「谁让它跑」），所以调度列表读不到
「上次结果」、报告说不出触发来源，趋势也无法把人工调试的噪声与定时回归分开。这是 P3 的
第一块砖。

**核心模型**

**触发源写进 `execution_index`；报告是 `suite_executions` 上的一个入队时命名 + 一个只读
视图；调度靠 `next_run_at` 的行级认领去重；告警在调度器进程里订阅执行事件流派发。**

- **触发源归属父索引**，不是三张执行表都加列。`execution_index` 已经是「报告/统计/告警的
  唯一查询入口」（Spec 2.1 归一原则），而可被调度/Webhook 触发的对象只有流程与套件，两者
  都有 `execution_index_id`。叶子 `executions` 不加这一列——它的触发源由父级回答，单接口
  调试永远是 `manual`。
- **报告不新建表**：一份报告就是一次套件执行，缺的只是一个稳定名字与一处能读到触发信息的
  地方（见边界 13）。新建 `suite_reports` 表意味着同一次执行的结论存两份，而两份计数迟早
  在取消与回收路径上分叉。
- **去重用行级认领而不是分布式锁**：`UPDATE schedules SET next_run_at = <重算> WHERE id = $1
  AND next_run_at = $2`，`rowCount` 就是「我抢到了没有」。这与全库已有的
  `WHERE status = 'queued'` 认领是同一个惯用法（4.7 at-most-once），不引入第二套并发原语。
  也**不用 BullMQ repeatable jobs**：那会让「下次什么时候跑」在 Redis 与 Postgres 里各有
  一份，而用户改 cron 时改的是 Postgres 那份。
- **告警不侵入执行路径**：`lib/events.ts` 已经把每次状态变化广播到 Redis
  `executions:events`，调度器进程订阅它即可。往 `run.ts` / `flowRun.ts` / `suiteRun.ts` 的
  收尾里插通知发送会把「发一条 HTTP 通知」的延迟与失败算进用户那次执行的耗时里。

**已确认的边界决策（15 项）**

1. **定时调度的目标只有测试套件**（2026-08-27 用户确认收窄）。**流程不给定时入口**：
   一条要按时跑的链路本来就该是套件的成员——套件已经承担「一次跑一批 + 一份统一报告 +
   fail-fast + 并发」，给流程再开一条定时入口就会出现两种「定时产物」（一次流程执行 vs
   一次套件执行），而报告、告警、趋势三处都要各自兼容两种形状。需要定时跑单条流程时，
   建一个只含它一个成员的套件——这不是绕路，它换来的正是一份可读的报告。
   接口用例同理不给入口（交互文档 3.7），CI 任务等 P4.5。
   因此 `schedules.target_type` 的 CHECK 只有 `'suite'` 一个值——**保留这一列而不是删掉**，
   是为了 P4.5 的 CI 任务接进来时不必回填历史行（迁移 010 已经吃过这个亏）。
   **Webhook 触发仍然支持流程**：它是「外部系统把一次业务事件转成一次执行」，天然是单条
   链路且要带入参（边界 7 的变量注入），与「按时跑一批回归」不是同一件事。
2. **漏跑不补，只留一条 `skipped` 证据**。调度器停机一个周末后，一条每小时的调度会攒下
   40 多个到期时刻；补跑等于同一刻对被测系统打 40 发，且产出 40 份没人会看的失败报告。
   超过宽限期（`SCHEDULE_MISS_GRACE_MS`，2 分钟）的到期时刻写一行
   `schedule_runs(status='skipped')` 并把 `next_run_at` 快进到当前之后的第一个时刻。
   **漏跑必须留痕**：不留痕的话「昨晚没跑」与「昨晚跑了但没失败」在界面上无法区分。
3. **触发失败不自动禁用调度**。目标分区没有在线执行器（2004）、套件解析成零成员、流程引用
   了已删除的子流程——这些都记 `schedule_runs(status='failed')` 并带上原因，调度保持启用。
   自动禁用会让一个临时故障静默变成永久停跑，而用户以为它还在跑。
4. **调度可以覆盖环境，且沿用既有的覆盖路径**。`schedules.environment_id` 为空就用目标自己
   的配置；有值时流程直接换 `environmentId`，套件走它已有的
   `environmentStrategy='override'`。不新造第三条环境选择链（2.4 那条链已被五处共用）。
   代价要明说：换环境就是换分区（P2-8），所以「白天手动跑得起来、夜里定时跑报 2004」是
   成立的，调度编辑器因此要显示所选环境的分区在线状态。
5. **触发必须走与手动执行完全相同的校验**。为此把 `flows.ts` / `suites.ts` 执行路由里的
   校验与入队抽成 `lib/trigger.ts`：流程的图校验 + 跨流程递归检测 + 资源归属，套件的成员
   解析 + 成员上限 + 令牌预算。**这是本阶段唯一的重构，且不可省**——留两条入口，就等于
   定时跑的那条迟早会缺一项检查，而它恰好是没人盯着的那条。
6. **Webhook 触发是公开无鉴权路由，凭 HMAC 准入**，形状照 P2-5 的 Mock 运行时
   （`/mock/:publicId/*`）——那是本仓库唯一已有的「外部可直接调用」先例。
   签名串是 `timestamp.nonce.body`，`X-Apitest-Signature` / `-Timestamp` / `-Nonce` 三个头
   缺一不可；时间戳窗口 ±300 秒，nonce 用 Redis `SET NX EX` 挡重放。
   **密钥用 `lib/crypto.ts` 的 AES-GCM 加密存库**：验签必须拿到明文，所以不能存哈希；
   创建时回明文一次，之后接口只回 `hasSecret`。
7. **Webhook 的请求体只注入流程变量，套件忽略它**。套件没有变量模型（5.0.11：成员之间不
   传变量），硬塞一份会造出一个只有 Webhook 才有的隐形入参。注入只取顶层的字符串/数字/
   布尔，且键必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`——嵌套对象要展开就得定义一套扁平化规则，
   而那是流程变量该管的事。
8. **通知渠道只做「POST 一段 JSON 到一个 URL」这一族**：通用 Webhook / 企业微信 / 钉钉 /
   Slack 四种，差别只在默认模板。**Email 不做**——它需要 SMTP 主机、发件人身份与投递重试，
   是一套独立的基础设施，塞进本阶段只会做成一个发不出去的开关。
9. **告警在事件到达时评估，用冷却窗口而不是定时扫表**。终态事件本来就会来，扫表是重复
   劳动。窗口型规则（连续失败 N 次 / 成功率 / 平均耗时）在同一条事件上跑一次聚合查询，
   命中后按 `cooldown_seconds` 压制——没有冷却，一次雪崩会把渠道刷爆，而第 2 条到第 200 条
   通知不携带任何新信息。
10. **每次派发都落 `notification_deliveries`**。通知本身是「发出去就看不见了」的动作，不留
    投递记录时「没收到告警」有三种同样可能的原因（规则没命中 / 渠道配错 / 对方 5xx），
    没有证据就只能猜。
11. **趋势用 SQL 补齐空桶**（`generate_series` LEFT JOIN）。前端补桶会让「这一小时没有执行」
    与「这一小时全失败」在折线上长得一样。分位数用 `percentile_cont`，不自己在 Node 里排序
    ——那要把窗口内所有行拉进内存。
12. **图表手写 SVG，不引入图表库**。计划 11.2 原本给 P3 记的 `@ant-design/charts` 在此
    **撤销**：Quiet Console 把 `--pass/--fail/--skip/--busy` 定为保留语义色、禁渐变与发光
    （见 skill `quiet-console`），而图表库带的是自己一整套配色与动效，接进来的工作量是「逐项
    对抗它的默认值」，多于画一条折线；`@antv/*` 还会把前端包体积抬高一个量级。趋势图只需要
    折线 + 柱 + 环形三种，各几十行 SVG。**这是与原计划的偏离，记在此处而不是悄悄换掉。**
13. **套件执行报告：不建新表，在 `suite_executions` 上补一个报告名，触发信息取自
    `execution_index`**（2026-08-27 用户要求新增）。

    要的是一份「一次套件跑完之后可以拿去交差」的东西：**有稳定名字**（`套件名_日期`）、
    **说清是谁触发的**（手动 / 定时 / Webhook / 将来的 CI）、**说清整体耗时与通过率**。
    这些事实今天分散在三处：计数与起止时间在 `suite_executions`，触发源在
    `execution_index`（P3-1 新增），成员明细在 `execution_steps`。用户已经指出「与当前
    信息有一点冗余」——所以关键是**别把冗余变成第二份真相**：

    - **名字在入队时定下并存进 `suite_executions.report_name`**，不在读取时算。
      入队是单一写入点（`enqueueSuiteRun` 的那一个事务），而读取端有列表、详情、告警
      模板三处——放在读取端就是三份各自算一遍的重名规则。
    - **同一天同一套件跑多次要能区分**：名字是 `套件名_YYYYMMDD`，第二次起追加 `_2`、
      `_3`。序号在入队事务里按「这个套件今天已有几行」算出来，因此它**一次定终身**，
      不会因为后来删了某次运行而让别人的名字发生位移。**用套件改名前的当时名字**——
      报告名是那一刻的事实快照，与 `suite_name` 快照同一条理由（Spec 4.4）。
    - **耗时不新存一列**：`finished_at - started_at` 是整体墙钟耗时，`started_at -
      created_at` 是排队等待，两者已经在表上，再存一个 `duration_ms` 只会在取消/回收
      路径上与它们对不上。报告接口把它算出来返回，界面不自己减时间戳。
    - **触发者的名字要快照**：`execution_index` 除 `trigger_source` / `trigger_ref_id`
      外再加 `trigger_ref_name`。调度被删掉之后，一份写着「由定时任务触发」却说不出是哪个
      的报告等于没说——而这正是回看两个月前那次失败时唯一想知道的事。
    - **报告是只读派生物，不可编辑、不单独删除**。它跟着那次执行走：执行在，报告在；
      套件被删，`suite_id` 置空而报告仍读得通。
    - **`ci` 这个触发源现在就写进 CHECK**，尽管 P4.5 才产出它。理由与迁移 010/027 同款：
      等做出来再改 CHECK 就要回填，而回填时分不清历史行。

14. **套件相关列表全部服务端分页**（2026-08-27 用户要求补齐）。现状 `GET /test-suites` 一次
    返回全部（`routes/suites.ts:301`，只回一个 `total` 充数），前端 `SuiteList.tsx` 也没有
    分页器——项目里套件多起来之后这是一次全表扫描 + 一屏读不完的表。改成与执行记录同一套
    约定：`page` / `pageSize`（默认 20，上限 100）+ SQL 里的 `keyword` / `tag` 过滤，`meta`
    回 `{ page, pageSize, total }`。**报告列表同款分页。**

    **不分页的两处，理由要写下来**：套件的**成员清单**（手动选择的成员表、tag/all 的预览
    清单）与**一次报告的成员明细**不分页——它们有 `SUITE_MAX_MEMBERS`（200）硬上限，
    且它们的用途就是「通读一遍确认会跑到谁 / 哪几个失败了」，翻页会让「一共有几个失败」
    需要翻完才数得出来。成员选择器里的用例清单**保持分页**（它是全项目的用例，没有上限）。

15. **报告不引入第二条「谁触发的」查询口径**。调度列表的「上次结果」、报告列表的触发列、
    告警消息里的触发说明，三处都读 `execution_index` 的那三列，不各自去 join
    `schedule_runs`。`schedule_runs` 只回答「调度自己有没有按时触发成功」（含漏跑与触发
    失败——那两种情况根本没有执行，也就没有报告），两张表回答的是不同的问题，不能互相替代。

16. **多套测试环境的流量泳道：环境默认头 + 触发时变量覆盖，两层都做**（2026-08-28 用户
    场景确认）。详细形状见 6.5。要点：

    - **环境加 `default_headers`**，在 `buildRequest` 里以**最低优先级**合并进每一个 HTTP
      请求。这是「整套换头」唯一能落地的位置——`buildRequest` 是全平台唯一的请求组装点
      （单接口调试、用例、流程节点、套件成员都走它），放在别处必然漏掉一类。
    - **套件/流程执行与三种触发（手动、调度、Webhook）都接受 `variables` 覆盖**，冻进
      `run_spec`，以最高优先级压过环境变量。复用既有的 `RunSpec.variables` 通道（P1-2
      单步调试建的那条），不新造第二条变量层。
    - 于是一条「夜里 2 点，按 lane-b 跑一遍冒烟」的调度 = 一个套件 + 一条 cron + 一行
      `{ "lane": "lane-b" }`，接口定义、用例、流程一个都不用改。

17. **不做「触发时直接传一组 header」**。参数只能是**变量**，头由环境的 `default_headers`
    用 `{{lane}}` 引用。让触发方直接塞 header 会让「这次执行实际发了什么头」散落在调度
    配置、Webhook 请求体、套件运行参数三处，而 `buildRequest` 已经是唯一答案；更实际的
    问题是 header 名字可以任意，一次误传 `Authorization` 就是一次凭据注入，而变量走的是
    既有的脱敏与快照路径。**触发参数里不要放密钥**：它按明文冻进 `run_spec` 并出现在
    执行快照里，密钥仍然只放环境 secret。

**明确不做**

- **流程的定时调度**（边界 1）。要定时跑一条流程，把它放进一个套件。
- **一次性定时执行**（Spec 2.5.1）。它要在 `cron` 之外再加一个 `run_at`，且每处「算下次
  时间」都要分叉；真需要跑一次的场合，手动点一下就是。
- **日历排除 / 节假日跳过**（Spec 2.5.1）。需要一份可信的节假日数据源与它的年度维护，
  平台自己造一份只会过期。
- **Cron 可视化配置器**（交互文档 3.7 的分钟/小时输入格）。只做表达式输入 +
  服务端算出的下 5 次执行时间预览——预览是可视化真正解决的那个问题，而输入格另建一套
  与表达式互相同步的状态。
- **Email 告警渠道**（见边界 8）。
- **告警的自定义消息模板语法**。渠道有默认模板 + 一个可选的自定义前缀文案；引入模板语言
  等于再做一个沙箱。
- **报告导出**（PDF / Excel / 分享链接）。本阶段只做站内可读的那一份；导出要先定版式与
  权限（分享链接等于一条免鉴权读接口），是独立一件事。报告名已经定好，导出接上去时不必
  返工。
- **报告的编辑、备注与手工归档**：它是执行的派生物（边界 13），可编辑就意味着报告与执行
  可能互相矛盾。
- **流程执行报告**：流程执行详情（P1-2 的步骤树）已经是它的报告。本阶段的「报告」特指
  套件那一份统一摘要，不为流程再做一层。
- **AI 趋势洞察 / 失败根因分析**（Spec 2.4.4）：由外部 AI 经 P5 的只读 MCP 工具读走数据后
  自己生成，平台侧不调模型、不存 LLM 凭据（P5 边界 16）。
- **覆盖率趋势与 `CoverageSnapshot`**（Spec 2.3）：覆盖率现在是即时算的，做趋势要先决定
  快照频率，与本阶段无关。
- **调度产生的执行不参与「重跑对比」**（交互文档 3.6.1 的 A/B）：那是报告页的能力，本阶段
  只保证调度产生的执行能从调度列表点进统一执行详情。
- **多租户级的调度配额**：不限制一个项目能建多少条调度，只按 `SCHEDULE_MAX_PER_PROJECT`
  给一个软上限拒绝，避免误建循环。

### 6.1 数据库迁移（接在 029 之后）

**`030_p3_scheduling.sql`**

```
schedules        (id, project_id, name,
                  target_type CHECK(suite)   -- 只有套件（边界 1）；留列是为了 P4.5 接 CI 任务
                  target_id, environment_id, cron, timezone, enabled,
                  variables JSONB DEFAULT '{}',   -- 每次触发都带的变量覆盖（6.5）
                  next_run_at, last_run_at, created_at, updated_at)
schedule_runs    (id, schedule_id, project_id, planned_at, triggered_at,
                  status CHECK(triggered|skipped|failed), execution_index_id, error)
webhook_triggers (id, project_id, name,
                  target_type CHECK(flow|suite),   -- Webhook 仍支持流程（边界 1 末段）
                  target_id, environment_id,
                  public_id UNIQUE, secret_encrypted BYTEA, enabled,
                  last_triggered_at, created_at, updated_at)
execution_index  += trigger_source CHECK(manual|scheduled|webhook|ci) DEFAULT 'manual'
                 += trigger_ref_id UUID    -- 调度 / Webhook 的 id，无 FK（历史要活过删除）
                 += trigger_ref_name TEXT  -- 触发者名字的快照（边界 13）
suite_executions += report_name TEXT       -- 「套件名_YYYYMMDD[_n]」，入队时定（边界 13）
environments     += default_headers JSONB  -- 环境默认头，buildRequest 最低优先级合并（6.5）
```

**`031_p3_alerts.sql`**

```
notification_channels  (id, project_id, name, type CHECK(webhook|wecom|dingtalk|slack),
                        url, secret_encrypted BYTEA, template_prefix, enabled, ...)
alert_rules            (id, project_id, name, metric, comparator, threshold,
                        window_minutes, cooldown_seconds, channel_ids UUID[],
                        enabled, last_fired_at, ...)
notification_deliveries(id, project_id, channel_id, rule_id, execution_index_id,
                        status CHECK(sent|failed), status_code, error, payload, created_at)
```

**`032_p3_suite_variable_overrides.sql`**（P3-2 实现时增补，030 草图的缺口）

```
suite_executions += variable_overrides JSONB NOT NULL DEFAULT '{}'
                     # 6.5「证据与可读性」要求变量覆盖出现在报告标识段（6.4），而
                     # suite run_spec 落终态即置 NULL——标识段缺一个终态后仍可读的
                     # 存放位置。刻意不叫 variables：flow_executions.variables 是
                     # 「跑完后的最终变量袋」，这里存「入队时给的覆盖」，撞名会读错。
```

### 6.2 后端新 API

```
SCHEDULES（目标只有套件）
  GET/POST      /projects/:id/schedules                       分页 + keyword/enabled 筛选
  GET/PUT/DELETE /projects/:id/schedules/:scheduleId
  GET           /projects/:id/schedules/:scheduleId/runs      触发历史（含漏跑/失败），分页
  POST          /projects/:id/schedules/:scheduleId/run       立即跑一次（trigger_source=manual）
  POST          /projects/:id/schedules/preview               校验 cron + 返回下 5 次时间

WEBHOOK 触发（目标为流程或套件）
  GET/POST      /projects/:id/webhook-triggers
  PUT/DELETE    /projects/:id/webhook-triggers/:triggerId
  POST          /projects/:id/webhook-triggers/:triggerId/rotate-secret
  POST          /webhooks/:publicId                            公开，HMAC 准入

套件执行报告（边界 13）
  GET /projects/:id/suite-reports                              分页：报告名/触发源/耗时/通过率
  GET /projects/:id/suite-reports/:executionId                 一份报告：摘要 + 成员明细（不分页）

执行入参（6.5，改既有路由）
  POST /projects/:id/test-suites/:suiteId/execute              Body 可带 variables 覆盖
  POST /projects/:id/flows/:flowId/execute                     已支持 variables，不改
  GET/PUT /projects/:id/environments                           default_headers 读写

分页补齐（边界 14，改既有路由）
  GET /projects/:id/test-suites                                加 page/pageSize，meta 回 total

告警
  GET/POST      /projects/:id/notification-channels
  PUT/DELETE    /projects/:id/notification-channels/:channelId
  POST          /projects/:id/notification-channels/:channelId/test
  GET/POST      /projects/:id/alert-rules
  PUT/DELETE    /projects/:id/alert-rules/:ruleId
  GET           /projects/:id/notification-deliveries          派发证据

报表
  GET /projects/:id/reports/trend?range=24h|7d|30d             按桶的通过率 + P50/P90/P99
  GET /projects/:id/reports/summary?range=...                  总量、失败分布（按接口/按错误类型）
```

### 6.3 新进程：`src/scheduler.ts`

worker 之外的第三个进程（`pnpm scheduler`，`start.sh` 一并拉起）。三件事：

- **cron tick**（10 秒）：认领到期调度 → `lib/trigger.ts` → 写 `schedule_runs`。
- **漏跑判定**：超过宽限期的到期时刻记 `skipped` 并快进 `next_run_at`（边界 2）。
- **告警派发**：订阅 `executions:events`，终态事件上评估规则并投递（边界 9、10）。

多实例安全（行级认领 + 冷却写回都带 `WHERE last_fired_at = <读到的那个>`），但**推荐单实例**
——它不是吞吐瓶颈，多起只会让日志难读。

### 6.4 套件执行报告（边界 13 的落地形状）

**一份报告 = 一次套件执行的只读视图**，三段：

| 段 | 字段 | 来源 |
|---|---|---|
| 标识 | 报告名（`套件名_YYYYMMDD[_n]`）、套件名、环境名 | `suite_executions`（都是入队时的快照） |
| 触发 | 触发源（手动/定时/Webhook/CI）、触发者名字、执行分区 | `execution_index.trigger_*` + `suite_executions.runner_label` |
| 结论 | 状态、成员总数/通过/失败/跳过、通过率、整体耗时、排队等待、开始与结束时刻 | `suite_executions`，耗时由时间戳算出 |
| 明细 | 每个成员一行：类型、名字、状态、耗时、失败原因 | `execution_steps`（不分页，边界 14） |

**入口三处，同一份数据**：套件配置页的运行抽屉（已有，加一条报告名 + 触发行）、报告列表页
（新，分页 + 按触发源/状态筛选）、执行记录页的父执行抽屉（已有，加同样两行）。不为报告
再做第四个页面——它就是套件执行详情，只是把「谁触发的、跑了多久」补齐了。

### 6.5 多套测试环境的流量泳道（边界 16、17 的落地形状）

**问题**（2026-08-28 用户提出）

测试环境有多套，靠 **header 或请求参数**区分流量（灰度泳道 / 全链路压测那一类
`X-Env-Tag: lane-b`）。现在要给一个套件换泳道，只能把每个接口的 header 挨个改一遍，
或者复制一套环境；定时任务更没有入口——它跑的永远是保存下来的那份。

**为什么不是插件**

插件（P10）解决的是「平台不知道你要干什么」的扩展点。这里不是：**「一次执行该带哪些头」
本来就是执行模型的一部分**，缺的只是两样东西——一个「整套生效」的头的存放位置，和一条
「触发这一次时把某个值换掉」的通道。这两样都落在既有结构上，等插件反而会把一个 3 行的
合并写成一套钩子生命周期。

**两层，各解决一半**

| 层 | 放哪 | 解决 |
|---|---|---|
| 环境默认头 `environments.default_headers` | `buildRequest` 里最低优先级合并 | 「整套请求都带这个头」——不用逐个接口改 |
| 触发时变量覆盖 `variables` | 冻进 `run_spec`，最高优先级 | 「这一次/这条定时任务用哪个泳道」 |

两层是配合关系：默认头写 `{"X-Env-Tag": "{{lane}}"}`，`lane` 的值由环境变量给默认、由
触发参数按次覆盖。

**优先级（自低到高，`buildRequest` 里的合并顺序）**

```
环境 default_headers  →  接口/用例定义的 headers  →  auth 注入  →  前置钩子改写
```

- **默认头垫在最底层**，接口自己写了同名 header 就以接口为准（大小写不敏感比对——HTTP
  头名不区分大小写，两份 `content-type` 同时出现在快照里比覆盖更糟）。理由：默认头是
  「这套环境的公共前缀」，它不该有能力悄悄改掉某个接口刻意写死的头。
- **钩子仍在最后**（`lib/hooks.ts` 的注释已经解释过：签名必须签最终字节）。默认头因此
  是「被签进去」的一部分，这是对的——泳道头本来就要参与签名。

变量优先级不变，仍是 P1-2 定下的那条：`环境变量/secret → run_spec.variables`（后者胜）。

**触发参数的形状**

```
POST /projects/:id/test-suites/:suiteId/execute   { execution?, variables? }
POST /projects/:id/flows/:flowId/execute          { ..., variables? }        // 已有
schedules.variables JSONB                          调度每次触发都带这一份
webhook_triggers                                   请求体注入（边界 7，仅流程）
```

`variables` 只接受 `Record<string, string>`，键匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。套件的
这一份**下发给每个成员**（成员的 `insertRun` / `insertFlowRun` 都带上它）——这是套件唯一
一处「成员共享一个值」，与 5.0.11「成员之间不传变量」不矛盾：那条说的是成员**之间**不
互相传递运行产物，而这是整次执行的入参，对每个成员都一样，且不随执行改变。

**证据与可读性**

- 一次执行的 `variables` 覆盖要出现在**报告的标识段**（6.4），否则两份跑同一个套件的报告
  长得一模一样而结论不同。
- 默认头进请求快照（走既有脱敏），所以「这次到底带了什么头」在执行详情里一眼可见。
- 环境编辑器里默认头与变量分两块：头是「每个请求都加什么」，变量是「`{{}}` 展开成什么」，
  混在一起用户会往变量里写 `X-Env-Tag` 然后奇怪它没生效。

**明确不做**

- 触发时直传 header（边界 17）。
- 项目级默认头：环境已经是「我指向哪套系统」的归属者（同 P2-8 的分区决策），再加一层
  项目级会让「这个头从哪来」需要查两个地方。
- 按 header 名的删除语义（用默认头「去掉」某个头）：`buildRequest` 是加法，引入删除就要
  定义空串与 null 的区别，而泳道场景不需要。

---

### 6.6 分批交付

| 批次 | 内容 | 状态 |
|---|---|---|
| P3-1 | 迁移 `030` / `031`：`schedules` / `schedule_runs` / `webhook_triggers` / 通知三表 / `execution_index.trigger_*` / `suite_executions.report_name` / `environments.default_headers`；`models/types.ts` 新类型 + mapper | **已实现**（2026-08-28，仅结构与类型；路由/触发路径在 P3-3/6 接入） |
| P3-2 | **两层泳道**（6.5）：`buildRequest` 最低优先级合并环境默认头（大小写不敏感）；`RunSpec.variables` 承接套件/流程执行与三种触发的变量覆盖，套件成员逐一下发；`environments.ts` 读写校验 + 复制带上默认头 | **已实现**（2026-08-28，含迁移 032 `suite_executions.variable_overrides`；前端默认头编辑块在 P3-9） |
| P3-3 | `lib/trigger.ts` 抽取统一触发路径；`flows.ts` / `suites.ts` 执行路由改为调用它并接受 `variables`；`enqueue.ts` 透传 `triggerSource` / `triggerRefId` / `triggerRefName`，入队事务里生成 `report_name` | **已实现**（2026-08-28；含流程成员经 run_spec 冻结的 trigger 继承套件触发者，趋势/筛选才不会把回归成员算成手动） |
| P3-4 | `lib/schedule.ts`（cron 解析、下次时间、行级认领）+ `src/scheduler.ts` 进程（tick / 漏跑 / 告警派发） | **已实现**（2026-08-28；告警只落订阅管线与评估入口 `lib/alerts.ts`，规则评估/冷却/投递是 P3-5。`cron-parser` 直接依赖与 `pnpm scheduler` 脚本从 P3-10 提前落地，P3-10 剩 start.sh/stop.sh/.env.example） |
| P3-5 | `lib/notify.ts`（四种渠道的载荷 + 投递 + 落 delivery）+ `lib/alerts.ts`（规则评估 + 冷却） | **已实现**（2026-08-28；窗口统计只看已定局的 flow/suite 父执行，canceled 不计入；冷却 = 读判 + `last_fired_at IS NOT DISTINCT FROM` 写回认领；钉钉加签用渠道 secret，wecom/slack/通用 webhook 的准入凭据在 URL 里） |
| P3-6 | 路由：`schedules.ts`（含 preview / runs / 立即执行，`variables` 进调度配置）、`webhooks.ts`（含公开 HMAC 入口）、`alerts.ts`、`reports.ts`（trend / summary / suite-reports）；`index.ts` 注册；`executionIndex.ts` 加 `triggerSource` 筛选；`dashboard.ts` 的 `scheduleCount` 变真值 | **已实现**（2026-08-28；文件按「一资源一文件」拆成 `schedules.ts` / `webhookTriggers.ts`（含 `POST /webhooks/:publicId`）/ `notificationChannels.ts` + `alertRules.ts` + `notificationDeliveries.ts` / `reports.ts`。调度软上限 50/项目、`meta.scheduler.overdue` 活性提示；HMAC 三头 + 原始字节验签（子作用域 buffer 解析器）+ nonce `SET NX EX` 防重放；test-suites 列表分页（边界 14）；渠道删除 409+force 并摘规则里的悬空 id；trend 空桶由 `generate_series` 补齐 + `percentile_cont` 分位数） |
| P3-7 | **分页补齐**（边界 14）：`GET /test-suites` 服务端分页；`SuiteList.tsx` 加分页器与 total | **已实现**（2026-08-28；服务端分页随 P3-6 落地，本批补前端：`api.testSuites` 返回 `Paged<SuiteSummary>`，列表加分页器（20/50/100、真实 total），关键字输入重置页码、删掉本页最后一行自动退页、执行流终态重取不丢当前页） |
| P3-8 | 前端 `api.ts` 类型与调用、`i18n.ts` 两份键（zh-CN + en） | **已实现**（2026-08-28；`Environment.defaultHeaders`、`ExecutionIndex.triggerSource/refId/refName`、`SuiteExecution.reportName/variableOverrides`、`Dashboard.scheduleCount` 必填真值；新增 Schedule/ScheduleRun/WebhookTrigger/NotificationChannel/AlertRule/NotificationDelivery/SuiteReport(±Summary)/TrendReport/ReportSummary 全套类型与 33 个 api 调用；`executeSuite` 补 variables 入参、`executionIndex` 补 triggerSource 筛选、schedules 列表带 `scheduler.overdue` 活性提示。i18n 双语各 1191 键，已脚本校验两份键集完全一致且无重复键） |
| P3-9 | 前端页面：`Schedules.tsx`（列表 + cron 抽屉 + 变量覆盖 + 触发历史）、`Alerts.tsx`（渠道 + 规则 + 派发记录）、`SuiteReports.tsx`（报告列表 + 详情，标识段含变量覆盖）、`Trends.tsx`（手写 SVG 折线/柱/环形）；`Environments.tsx` 加默认头编辑块；`SuiteRunDrawer` 补报告名与触发行；导航与路由 | **已实现**（2026-08-28；含少量后端/键增补：`/suite-executions/:id` 详情带触发三列（抽屉数据源，边界 15）、i18n 补 nav/空态/时段等 16 键（两份各 1207 键，脚本校验一致）。调度列表带 overdue 活性提示、cron 防抖预览下 5 次、变量覆盖 KeyValueEditor；报告列表行内显示变量覆盖、详情为独立路由；趋势页手写 SVG（折线断开=无执行、柱堆叠通过/失败、环形失败类型）；导航编排组加「定时调度」、通用组加套件报告/趋势/告警） |
| P3-10 | `.env.example`（SCHEDULER_TICK 之类）/ `start.sh` / `stop.sh` 拉起第三个进程；`package.json`（`cron-parser` 提为直接依赖）/ 依赖清单 | **已实现**（2026-08-28；`cron-parser` 直接依赖与 `pnpm scheduler` 脚本已随 P3-4 提前落地。本批：`SCHEDULER_TICK_MS`/`SCHEDULER_MISS_GRACE_MS` 改为环境变量可调（钳位 1s–60s / 30s–1h）、`.env.example` 调度器段落（含三进程共用密钥的说明）、`start.sh`/`stop.sh` 拉起与回收 scheduler（日志就绪检查 `ticking every`）、`AGENTS.md` 服务段落同步为四进程） |
| P3-11 | **验收反馈重构（2026-08-28 用户确认）**：① 删除独立「定时调度」页，定时配置并入套件详情页（`schedules` 表与 CRUD 路由不动，`GET /schedules` 加 `targetId` 过滤；套件页新建的调度 target 固定为该套件）；② 套件级通知设置：`test_suites.notify_config`（onSuccess / onFailure 开关 + channelIds），套件执行终态按配置投递（复用渠道与投递证据表，`rule_id` 为空）；③ 通知模版支持 `{{suiteName}}` 等占位符，套件级可覆盖默认模版（标题 + 正文，未知占位符原样保留） | **已实现**（2026-08-28，形状见 6.8；迁移 `033`） |
| P3-12 | **验收反馈第二轮（2026-08-28 用户确认）**：① 「套件报告」改名「报告列表」（导航 + 页面标题；路由 `/suite-reports` 不动）——为后续接入仓库类报告（单测/流水线）预留泛化入口；② 报告详情接入通用面包屑 `{项目}/报告列表/{报告名称}`（报告名经 Outlet context 上抛，`DetailCrumbContext`），删除页内返回按钮；③ 列表分页补齐：`GET /endpoints`、`GET /data-sources`、`GET /mocks` 加 **opt-in** 分页（不传 `pageSize` 仍回全量，项目 store / 流程节点选择器 / Mock 快照来源依赖全量契约），接口/数据源/Mock 列表页走 `endpointsPaged` 等新客户端读法；环境管理与套件成员解析列表数据源是共享全量（store / preview 一次解析），就地分页 | **已实现**（2026-08-28；界面缺陷明细见 `issue_fix/问题记录-P3验收第二轮.md`。i18n 双语各 +2 键（`suiteReports.memberPass` / `suiteReports.current`）、改 2 键（nav/title）） |
| P3-13 | **验收反馈第三轮（2026-08-28 用户确认）**：① 手动运行套件补**变量覆盖**入口——「运行」改为先弹确认窗（键约束与服务端同一条），覆盖随 `POST /execute` 的 `variables` 入队，不落库；至此手动/调度/Webhook（含 CI 泳道场景）三种触发源同一能力，替换优先级确认为 触发时的变量覆盖 > 流程种子变量 > 环境变量（`run.ts` / `suiteRun.ts` / `flowRun.ts` 既有实现即此链）；② 成员相关列表分页补齐：运行抽屉成员行、添加成员选择器流程 tab（报告成员明细按边界 14 维持不分页）；③ 套件页「定时调度」空态改内联「暂无数据」（`common.noData`），删 `schedules.emptyTitle/emptyHint` 两键；④ 定时调度卡片移到通知设置之前；⑤ 变量覆盖提示文案口径统一（运行弹窗/调度/环境默认头三处，同一层名「触发时的变量覆盖」+ 同一条优先级链）；⑥ 变量覆盖编辑器（运行弹窗 + 调度编辑）换用新组件 `VariableRowsEditor`——环境抽屉普通变量行的同款排版（列头 + 键/值/复制/删除），弃用为请求头/参数设计的 `KeyValueEditor` 双模式控件 | **已实现**（2026-08-28；明细见 `issue_fix/问题记录-P3验收第三轮.md`。i18n 双语各 +6 键（含 `common.variableName/variableValue`）、删 2 键、改 3 处提示。无后端改动——分页均为前端就地分页，`variables` 通道 P3-3 已就绪） |
| P3-14 | **验收反馈第四轮（2026-08-28 用户确认）**：① 环境抽屉「默认请求头」编辑器换 `VariableRowsEditor`（`copyTemplate=false`，复制给头名）——变量覆盖行样式三处对齐，`KeyValueEditor` 保留给请求头/参数（停用一行、批量粘贴是那两处的真实动作）；② 运行弹窗抽成共享 `SuiteRunModal`（自持变量状态 + 键校验 + 自绘 `.btn` 页脚），套件配置页与**套件列表行**共用——列表行运行也从一键直跑改为先确认变量覆盖；③ 「变量覆盖未生效」经 DB 取证为非缺陷：`variable_overrides={"x":"123"}` 已冻结入库，但该套件成员无任何 `{{x}}` 引用（覆盖是替换值，只在占位符处出现，另见报告标识段）；④ 套件页补 Cmd+S / Ctrl+S 快捷保存（与接口/流程工作台同一模式） | **已实现**（2026-08-28；明细见 `issue_fix/问题记录-P3验收第四轮.md`。i18n 无新增键。无后端改动） |
| P3-15 | **验收反馈第五轮（2026-08-28 用户确认）**：① 流程列表补**服务端分页**——`GET /flows` 加 opt-in 分页（传 `pageSize` 才分页，与 endpoints / data-sources / mocks 同一约定；lastRun 只查当前页），前端 `flowsPaged` + 列表页分页器（20/50/100、筛选重置页码、删空本页退页），成员选择器等全量调用方不受影响；② 修复第四轮 Cmd+S 引入的套件页白屏回归（useEffect 声明在 `if (!draft)` 早退之后，违反 Rules of Hooks；移到早退前）；③ 「默认头 x=2 + 覆盖 x=xxx 未生效」取证为非缺陷（默认头值是纯文本非 `{{x}}` 模板；`defaultHeadersHint` 补「固定值不会被覆盖」显式对照） | **已实现**（2026-08-28；缺陷明细见 `issue_fix/问题记录-P3验收第五轮.md`。i18n 改 1 处提示。后端有改动：`routes/flows.ts`） |

### 6.7 验收门槛

1. **P3-1/3**：手动执行流程/套件的行为与 P2 完全一致（校验、错误码、202 载荷都不变），
   `execution_index.trigger_source` 对手动执行为 `manual`；执行记录页可按来源筛选。
2. **泳道（P3-2）**：环境默认头 `{"X-Env-Tag": "{{lane}}"}` 下，接口自己写了 `X-Env-Tag` 的
   以接口为准；触发套件传 `variables: {"lane": "lane-b"}` 后，该次执行所有成员的请求快照里
   `X-Env-Tag` 全部是 `lane-b`，而环境不变、接口定义不变；同一套件的两次执行（一次带覆盖、
   一次不带）报告里能看出差别；带 `Authorization` 字样的头照常被掩码。
3. **P3-4**：一条 `*/1 * * * *` 的套件调度按分钟产出执行，`schedule_runs` 一行一次；停掉
   调度器十分钟再拉起，**不会**补跑那十分钟，而是留下 `skipped` 证据并从下一个整点继续；
   两个调度器实例同时跑，同一个到期时刻只产出一次执行；流程页面上**没有**定时入口。
4. **P3-5**：一条「本次失败」规则在套件失败后 10 秒内投递到渠道，`notification_deliveries`
   记下 `status_code`；渠道 URL 改错后规则仍命中，但投递记 `failed` + 原因；冷却期内的第二
   次失败不再发。
5. **P3-6**：`reports/trend` 的空桶返回 0 而不是缺桶；`reports/summary` 的失败分布合计等于
   窗口内失败总数；`/dashboard` 的定时任务数不再显示「未启用」。
6. **报告（P3-6/9）**：同一套件同一天跑三次得到 `名_日期`、`名_日期_2`、`名_日期_3` 三个
   互不相同且**不再变化**的报告名；报告显示触发源与触发者名字，删掉那条调度后仍显示原名字；
   整体耗时与排队等待分开显示；套件改名后旧报告仍是旧名字。
7. **分页（P3-7）**：套件列表按 20 条分页并显示真实总数，关键字搜索命中的是全量而不是当前
   页；成员清单与报告成员明细**不分页**（有 200 上限）。
8. **P3-8/9**：调度列表显示下次执行时间与上次结果，上次结果可点进统一执行详情；调度所选
   环境的分区无在线执行器时，编辑器提前给出提示（与环境编辑器同款，P2-8.7）；趋势页在两种
   主题下都不出现横向滚动，图表只用保留语义色。

**验收结论**：2026-08-28 用户验收通过（P3-1 ~ P3-11 全量；首轮验收发现的六项缺陷
已修复并随 P3-11 增补一并复验，缺陷明细见 `issue_fix/问题记录-P3验收第一轮.md`）。

### 6.8 P3-11：套件级定时与通知（验收反馈，2026-08-28 确认）

用户验收后确认的三个范围决策：**删除独立「定时调度」页**（定时配置并入套件详情页）、
**套件内通知设置**（成功 + 失败开关，选渠道）、**通知模版支持占位符**。

- **定时并入套件**：`schedules` 表、CRUD 路由、调度器认领全部不动；前端删掉
  `Schedules.tsx` 页面与导航入口，套件详情页加「定时调度」面板（本套件的调度列表 +
  创建/编辑抽屉，抽屉里不再选目标套件）。`GET /schedules` 加 `targetId` 查询参数
  （套件页过滤用）。调度的「触发历史」与「立即跑一次」随面板进套件页。
- **通知设置**：`test_suites.notify_config JSONB`，形状
  `{ onSuccess: boolean, onFailure: boolean, channelIds: string[], template?: { title?: string, body?: string } }`。
  投递挂在调度器的事件订阅管线上（与告警同一条 `executions:events` 订阅）：套件终态
  事件到达时读套件配置，按开关投递到所选渠道；`canceled` 不通知（用户动作不是结果）。
  投递走 `lib/notify.ts` 同一条路径，`notification_deliveries.rule_id` 为空（与渠道
  「测试」同款），`execution_index_id` 指向该次执行。
- **模版**：默认模版内置（标题「【接口自动化】套件 {{suiteName}} {{status}}」，正文
  带结论/通过率/耗时/触发者/报告名/时间）；占位符 `{{suiteName}}`、`{{status}}`、
  `{{passRate}}`、`{{successCount}}`、`{{failedCount}}`、`{{skippedCount}}`、
  `{{total}}`、`{{duration}}`、`{{reportName}}`、`{{trigger}}`、`{{finishedAt}}`。
  渲染是纯字符串替换：未知占位符原样保留（写错了看得见，静默吞掉反而难查）。
  套件级 `template` 覆盖默认（title / body 均可只覆盖其一）；项目级告警规则的固定文案
  不变——那是规则语义，不是套件通知。

---

## 七、P4 — 仓库模式: 上报式用例 (4 周)

### 7.0 P4 范围与边界（2026-08-29 确认）

**问题**

P0–P3 做完的是「测试资产在平台里」这一条路：接口、用例、流程、套件、调度、报告全部以平台
为唯一存放点。但已经有 pytest 仓库的团队进不来——他们的测试逻辑在 Git 里，重写一遍进平台
既不现实也没道理。于是平台看到的接口覆盖永远只是自己那一半，而「这个系统到底测到了多少」
这个问题答不出来。

P4 要的不是把那些代码搬进来，而是**让它们跑完之后把结果说给平台听**：用例挂到「系统 →
接口 → 用例」树上，接口下有用例 = 已覆盖。平台不拥有代码、不执行代码、不重放代码。

**核心模型**

**平台只暴露一个上报入口 `POST /ingest`；用例身份是 `case_key`，与显示名解耦；一次上报是一个
commit 快照，按 `(project, case_key)` upsert、按 `(repo, commit, ci_run_id)` 幂等；SDK 在用户
进程内零网络地采集，跑完一次性上报。**

- **上报归一进 `execution_index`（`kind='ingest'`）**，理由与 P2-0 建这张表时相同：执行记录
  页的来源筛选、统一详情跳转、告警订阅三处都读它，不归一就要各写一套仓库模式分支。
- **用例不存 endpoint 外键，而是一张关系表**。一个用例打三个接口是常态（先登录再下单再查
  详情），归给「主接口」会让另外两个显示未覆盖，而它们明明被测到了。
- **SDK 不要求用户改任何一行测试代码**：pytest 插件靠 entry point 自动加载，请求靠传输层
  打桩采集。要求用户改 client 或写 conftest，接入率就止步于「愿意重构的那几个仓库」。

**已确认的边界决策（21 项）**

1. **上报归一进 `execution_index`，但趋势与通过率的口径默认排除它**（用户选定）。
   `kind` 的 CHECK 加 `'ingest'`，`trigger_source` 用已有的 `'ci'`（P3 边界 13 已提前写进
   CHECK，正是为这一刻）。于是执行记录页的来源筛选、`executions/by-index/:indexId` 统一
   详情入口一处不改就能看到仓库模式。
   **但 `reports/trend` 与 `reports/summary` 仍只算 `kind IN ('flow','suite')`**：外部 CI 的
   `latency_ms` 是用户进程里的客户端耗时，与平台的墙钟耗时不是一个口径，混进同一条分位数
   曲线得到的是一个谁都不认的数；而一次 `-m smoke` 的局部跑会把通过率拉出一个没人认的台阶。
   趋势页给一个**默认关闭**的「含仓库上报」开关，让人可以自己要那份混合视图。
   **取消 / 重跑 / 回收三条路径要显式拒绝 `ingest`**：它们对一次「别人已经跑完的历史」没有
   意义，而这三处现在都只按 `kind` 分派——不拒绝就会走到一个空实现里静默失败。
2. **统计口径（覆盖率、看板、通过率）本阶段一律不动**（用户明确）。仓库用例的覆盖只在
   「仓库用例」页自己算自己显示，`routes/dashboard.ts` 的 `coverageRate` 保持只数
   `test_cases`。整套统计要重新设计一版，那是独立一件事——本阶段先把数据收进来，不去改一个
   即将被重做的口径，否则等于改两遍。
3. **SDK 本阶段一起做，并且发布到 PyPI**（用户 2026-08-29 决定，推翻了先前「不发 PyPI、用
   git 直链」的方案）。理由是 `pip install git+ssh://…` 要求每台 CI 机器有仓库读权限，而这
   恰好是接入时最难协调的一项授权；PyPI 让第 ① 步退化成一行无凭据的 `pip install`。
   **包名 `apitrack-sdk`**（2026-08-29 用户改名，原拟 `apitest-sdk`）；导入名与环境变量
   前缀随之改为 `apitrack` / `APITRACK_*`。包名与发布形状见 7.4。
4. **零改动接入是硬指标**：装包 + 配两个环境变量 + 原样跑 `pytest`。为此三件事都要成立
   ——pytest 插件靠 `pytest11` entry point 自动加载（不要 `conftest.py`、不要 `-p` 参数）、
   请求靠传输层打桩（不要用户换 client）、CI 命令不变（不要 wrapper 命令）。
   **这与两份既有文档冲突，在此记下而不是悄悄改掉**：Spec 2.10.1 的示例要求把请求集中封装
   进 `http_req.py` 并改用 `apitest_sdk.client`——**撤销**，那等于让用户重写全部请求代码；
   交互文档 3.11.2 第 ④ 步的「CI 里跑 `apitest-run` 并上报」——**降级为非 pytest 场景的备用
   入口**，pytest 场景下 CI 命令一个字都不改。接入指引页的四步要照此重写，包名与命令一并
   换成 `apitrack-sdk` / `APITRACK_*`。
5. **打桩打在传输层，不打门面函数**：`requests` 打 `HTTPAdapter.send`，`httpx` 打
   `HTTPTransport.handle_request` 与 `AsyncHTTPTransport.handle_async_request`。打
   `requests.get` 那一层必然漏掉所有用 `Session` 或自建 client 的仓库（也就是绝大多数）；
   打 socket 层则拿不到 URL 与 header 语义，还会连带采到 SDK 自己的上报请求。
   **`aiohttp` 首版不做**（它没有干净的 transport 层，拦截点脏），走边界 7 的装饰器路径。
6. **上报只发生一次，在 `pytest_sessionfinish`**。桩体只做「往内存 list 追加一条 dict」，
   全程零网络——这是「上报不能影响用例执行」这条要求的落地形状（用户 2026-08-29 提出）。
   桩里的纪律要写进代码注释：
   - **绝不读 body**（`.content` / `.text` / `.json()`）。`stream=True` 与 httpx 的未读流被
     桩读一次就被吃掉了，那是真正会改变用户测试行为的事。响应大小只从 `Content-Length` 取，
     取不到记 `null`。
   - **延迟用桩自己的 `perf_counter` 差**，不用 `response.elapsed`（adapter 层还没有它）。
   - **桩自身的失败不外溢**：整体裹 `try/except BaseException`，异常只计数；连续失败 3 次
     自我卸载并打一条 warning。用户的测试不该因为上报库有 bug 而变红。
   - **最后那一次上报也不动退出码**：5 秒超时 + 一次重试，失败只 warning。
7. **`case_key` 是身份，`name` 是显示，两者分开**。合成一个的话，用户改一句 docstring 就会
   在树上长出一条新用例、旧的那条被判 `removed`。映射规则（pytest nodeid
   `tests/order/test_create.py::TestCreate::test_create_order[vip]`）：

   | 字段 | 来源 | 优先级 |
   |---|---|---|
   | `case_key` | nodeid 去掉 `[...]` | `@case(key=…)` > nodeid |
   | `param_id` | `[...]` 内容 | pytest 的 parametrize id |
   | `name` | 显示名 | `@case("…")` > docstring 首行 > 函数名原样 |
   | `description` | docstring 首行之后全部 | 无则空串 |
   | `file_path` | nodeid 的文件路径段 | 仓库根的相对路径 |
   | `tags` | pytest marker 名（剔除内置 parametrize/skip/xfail 等） | 与 `@case(tags=[…])` 取并集 |

   首行当名字、余下当描述，是 PEP 257 已有的约定，也是 pytest `-v` 的习惯——不让用户学新
   东西。函数名兜底时**保持原样**，不做中文猜测。
8. **目录路径只是用例行上的元数据，不做成树的一层**。平台的树是「系统 → 接口 → 用例」，
   而 `tests/order/` 下的用例完全可能打 `POST /payments`——把目录塞进树就有两套互相打架的
   层级。`file_path` 用于详情显示与按前缀搜索，**不参与 `removed` 判定**（文件移动了但
   `@case(key=…)` 没变，仍是同一条用例）。真需要「按目录看」时那是第二种**视图**，不是第二
   种存储。
9. **一个用例挂它实际打过的每一个接口**（用户 2026-08-29 确认：「一个接口本身就有可能在多个
   用例下」，反向同理）。落地为关系表 `repo_case_endpoints`，而不是 `repo_test_cases.
   endpoint_id` 单列。
   **两个计数口径因此不同，必须在界面上写明**：接口节点上的「用例数」数的是**关系数**，
   项目级「仓库用例总数」数的是 **distinct `case_key`**，两者相加不相等。不写明就会被当成
   bug 报上来。
10. **只有 `call` 阶段的请求建立用例关系**。登录、造数这类请求发生在 fixture 里，
    `contextvar` 此时指向触发该 fixture 的第一个用例，直接归进去会得到「登录接口的用例数
    = 恰好第一个用例」这种失真。`setup` / `teardown` 阶段的请求**仍进 `ingest_records`
    并计入接口覆盖**，但不挂到用例节点上——于是 `POST /login` 显示为「已覆盖，但没有专属
    用例」，这正是事实。`phase` 列因此是必需的，不是调试信息。
11. **全量是「范围内的全量」，不是「仓库的全量」**（2026-08-29 用户场景修正）。
    `is_full_inventory` 决定平台是否执行删除对账（软删 `removed`），判错一次就删掉一片
    用例树。

    **原写法有一处硬错误，在此改掉**：原文把「指定了文件或目录参数」列为「不是全量」的
    依据之一。但一个仓库常按目录划分系统，该项目的 CI 每次都是 `pytest tests/order/`
    ——按原规则，这类仓库的对账**永远不会发生**，用例删掉了平台永远不知道，树只会越长越长。
    这跟多目录仓库其实没有必然关系：同一项目里有人跑 `pytest tests/order/smoke/`，没有范围
    概念就会把 `tests/order/regression/` 下的用例全判成消失。**范围是必需的，不是特设的。**

    于是分成两件事：**范围**（跑的是哪一片）与**过滤**（片内挑了几个）。

    - **`scope` 随上报带上**（相对仓库根的路径数组，进协议 v1.0，见边界 19），从 pytest 自己
      的参数取，零配置：`config.args` → 退到 ini 的 `testpaths` → 都没有则仓库根。
    - **`is_full_inventory` 的含义变成「这个范围内没有过滤」**。`-k` / `-m` / `--lf` /
      `--ff` / `-x` / `--deselect` / collect error 仍然一律判非全量——它们是范围内的挑选。
    - **对账只删 `file_path` 在 `scope` 之内、且本次 inventory 里缺失的用例**；范围之外的
      一律不动。

    | 命令 | scope | 全量 | 对账范围 |
    |---|---|---|---|
    | `pytest` | 仓库根 | 是 | 全仓 |
    | `pytest tests/order/` | `tests/order` | 是 | 只 `tests/order` 下 |
    | `pytest tests/order/ -m smoke` | `tests/order` | 否 | 不对账 |
    | `pytest tests/order/test_a.py` | 该文件 | 是 | 只该文件 |

    **对账只看 `inventory`，绝不看 `records`**。被 `skip` 掉的用例、或这一轮恰好没打到任何
    接口的用例，`records` 里是空的；按「没报到就算消失」去删，一次全量跑就会把所有 skip
    的用例判成 `removed`，某个依赖服务当天没起更会让一整片用例集体消失。分工是：**存在性看
    inventory**（用例还在不在代码里），**归属看 records**（这一轮它打到了谁）。因此
    `repo_case_endpoints` 的关系是**累积的，不是每轮重建**——有 inventory 无 records 的用例
    保留上一轮的接口关系，状态不动。

    **宁可少报一次全量**（后果：本该删的用例多留一天），**不可多报一次**（后果：跑个 smoke
    删掉 90% 的树）。平台侧再叠一道闸门：只有 `is_full_inventory=true` 且
    `branch = repositories.tracking_branch` 才对账，实际有没有对账记在 `ingest_runs.reconciled`。
12. **崩溃兜底的落盘补投放二期，本阶段不做**（用户 2026-08-29 决定）。`-x` 中断、CI 超时、
    OOM 会让 `sessionfinish` 不执行，那一次运行就**整份不上报**——这是有意的：宁可界面上
    「昨晚那次没有记录」，也不要半份数据被当成全量去对账。二期的形状留在这里备查：
    `.apitrack/spool/*.jsonl` 边跑边追加（纯本地 IO），`sessionfinish` 读盘上报后删除，CI 的
    `always()` 步骤跑 `python -m apitrack flush` 补投——幂等键在，补投是合并不是新增。
    **本阶段的 `/ingest` 与幂等键必须已经支持重投**，否则二期要改协议。
13. **默认只报摘要，body 默认不传**：method、raw path、`status_code`、`latency_ms`、
    `passed`、`error` 摘要。`APITRACK_BODY_CAPTURE=1` 才带，且截断。这条同时挡掉「测试数据
    被搬进平台」这一类合规问题——默认不传，就不需要为它做审批。
14. **脱敏在 SDK 侧就做**，不指望平台侧。`Authorization` / `Cookie` / `Set-Cookie` 与名字
    含 `token|secret|key|password` 的头只留键名。数据一旦离开用户机器，平台侧再脱敏已经晚了。
15. **path 归一留在平台侧，SDK 只报 raw path**。归一规则一定会随 `endpoints` 的实际形状
    演进，而 SDK 装在用户仓库里、版本完全不可控——规则冻在用户机器上就再也改不动了。
    这也是 7.4「协议版本与包版本分开」的同一条理由。
16. **绝不自动登记 endpoint**。上报到未登记的接口就自动建一条 `endpoints` 的话，覆盖率会
    永远是 100%——分母跟着分子长。这正是「未匹配区」存在的理由：让分母保持诚实，并把「该
    补登记接口了」显式摆出来。
    **未匹配不做回溯改写**：人工去补登记接口后，**下一次上报**自动归位，不回头重写历史
    `ingest_records`。回溯改写要定义「改到哪一天为止」，而那个界线没有正确答案。
17. **上报 Token 用哈希存库，与 Webhook 密钥的加密存储刻意不同**。Webhook 必须拿到明文才能
    验签（P3 边界 6），所以那里是 AES-GCM；上报 Token 只需比对，因此走 `scrypt` 哈希
    （与 `users.password_hash` 同款），明文只在创建时回一次。库被读走时，前者能被解密、
    后者不能——能哈希的地方就不该加密。
    另存 `token_prefix`（前 8 位明文）用于列表展示与「这条是哪个」的辨认。
18. **仓库唯一绑定 + 首次上报登记**（Spec 2.10.1 基数约束）。首次上报按 Token 所属项目登记
    该项目的唯一仓库；此后每次校验 `git_url`，不一致直接拒绝——否则持有 Token 的任意 CI 都
    能往这棵树里灌用例。换仓库由项目 admin 在 UI 显式解绑，解绑**保留**历史用例与上报记录
    （置 `status='unbound'`），不做级联删除。

    **`project_id UNIQUE` 禁止的是「一项目挂两仓库」，不禁止「一个仓库出现在多个项目里」**
    ——`git_url` 上没有全局唯一约束，同一个 git_url 可以在多个项目里各登记一行，每个项目看到
    的仍是自己的单例视图。一个 monorepo 按目录划分多个系统时就是这么用的（边界 19）。
19. **一次运行只上报一个项目**（2026-08-29 用户确认）。一个 monorepo 里可能放着多个系统的
    测试，但**该项目的 CI 只跑它自己那个目录**（`pytest tests/order/`），因此一次上报天然
    只对应一个项目、一个 Token、一行 `ingest_runs`。
    **不做「一次上报按 endpoint 匹配结果分派到多个项目」**：那需要 Token 携带一份跨项目授权
    清单、`/ingest` 一次写 N 行、以及一套跨项目越权校验，而它解决的是一个不存在的场景。
    `scope`（边界 11）就是这条决定在协议上的落点——它同时表达了「这次跑的是哪个系统的目录」
    与「对账该限制在哪一片」。

    **跨目录引用要分两种，答案完全不同**：
    - **共用代码**（`tests/order/` 里 import `tests/common/auth.py`）：**不需要任何处理**。
      `case_key` 与 `file_path` 取的是测试函数自己的 nodeid，它在 `tests/order/` 下；被
      import 的模块里没有测试函数，不进 inventory。共用得再多都不影响归属。
    - **跨系统调用**（订单的用例先调用户系统登录、调商品系统建 SKU）：这些请求打的是本项目
      **没有登记**的接口，会全部涌进未匹配区。见边界 20。
20. **未匹配区是诊断视图，不是待办清单**（2026-08-29 多轮讨论后定案）。

    先确认一件事：**「这条未匹配记录属于谁」这个问题，平台不需要答案**。覆盖率的分子只数
    匹配到已登记接口的记录，分母只数已登记接口——未匹配记录既不进分子也不进分母，怎么归类
    都不影响任何数字。
    真正的风险来自**界面形状**：原交互文档 3.11.1 把它做成「未匹配上报 (3) → 人工关联/
    补登记接口」这样一份待清空的清单。清单会被清空，清空的动作是补登记，补登记就是把别的
    系统的接口拉进本项目的分母——**风险全部来自这个待办形状，不来自数据**。

    **依次否掉的三个方案，理由记下以免重提**：
    - **SDK 侧自动判定归属**：仓库里读不到判据。同网关时 URL 的 host 一样；`file_path` 说的
      是「用例写在哪」而不是「请求打给谁」（跨目录调用的前提就是两者不一致）；import 关系
      只能看出代码依赖，看不出服务归属。唯一能"读到"的是用户提交进仓库的一份声明，那不是
      读到，是让用户告诉我们。
    - **按「别的项目是否登记过这条路径」自动标外部**：方向是错的——它只在别人已登记时才
      生效。用户中心的自动化还没做时，它不报警、不标记，静默落回「可能是我们的」。一个安全
      的默认值不该在信息缺失时倒向「是我们的」（用户 2026-08-29 指出）。
    - **项目声明 `owned_path_prefixes` 反向判定**：一个系统有多个前缀、前缀还可能跨系统重复
      （用户 2026-08-29 指出），说明「路径长什么样」与「归属哪个系统」之间没有稳定映射；
      任何形式的配置都只是把一个不存在的规律写成一份要长期维护的清单。

    **定案的形状**：

    - **不显示待处理计数、不放红点、不放「全部处理」**。它是一张按出现频次排序的路径列表。
    - **删掉「从这里补登记接口」这个动作**（与原交互文档 3.11.1 冲突，在此显式撤销）。要登记
      接口就去接口管理页手工建——保留这一步摩擦是有意的，它让「把一个接口放进本系统的分母」
      始终是一次显式决定，而不是清列表的副产品。
      **2026-08-30 修订（7.6.1）**：这道摩擦被证明挡住的是接入而不是误登记——仓库模式团队
      为了统计要把仓库里已有的接口清单再抄一遍，路径其实已经躺在未匹配区里。恢复**单行**
      「登记接口」动作：仍是一次显式决定（确认一个预填好的模板），仍无批量、无待办形状，
      同形重复 409 拦截。
    - **保留「关联到已登记接口」**。它安全：目标接口本来就在本项目、本来就在分母里，关联只是
      把记录挪过去。它解决的也不是归属问题，而是 path 归一没匹配上（`/users/abc-123` 这类）
      ——那是技术缺陷，该修。
    - **保留「人工标注为外部依赖」，可顺手把这条路径写成一条前缀规则**（`ingest_path_rules`，
      用户 2026-08-29 确认保留）。**前缀可以写多层**（`/api/v2/user/`），命中即在这张列表里
      静默。它**只影响这张诊断列表的显示，不影响任何统计**——所以规则写错的代价是「列表里
      多一条或少一条」，不是一次分类错误。前缀在项目内可以重复、可以有多条，因为它不承担
      归属判定，重复也就无害。
    - **读时标注代替判定**：判定要落库、要承担错误；标注只是摆在人眼前的事实，错了也没有
      后果。列表每行给三样信息——出现频次 + 打过它的用例、`phase` 分布（集中在 `setup` 的
      几乎一定是跨系统前置，这是仓库里唯一真正有判别力的信号，且是行为特征而非命名约定）、
      **别的项目是否登记过这条路径**（只显示项目名，不显示接口详情）。
      跨项目那一项**在读取时查，不在 `/ingest` 时查**：既不进上报热路径，又是活的——用户
      中心那边今天才登记，昨天那条记录的标注今天自动出现。它从不参与任何判定，所以「别人
      还没做自动化」时标注缺失什么都不代表。
    - **不变量**：未匹配记录与被静默的记录**永不计入覆盖分子**，覆盖率不会因为这套规则的
      任何误判而虚高。
21. **有 inventory 但一个接口都没打到的用例，进「未归位用例」分组**。跨系统调用一多就会出现
    「这条用例只打了外部接口」的情况——它在 inventory 里，但在本项目拿不到任何
    `repo_case_endpoints` 关系，而树是「系统 → 接口 → 用例」，它没有地方挂。
    **不能藏掉**：藏了之后「上报了 36 条用例，树上只数出 31 条」会被当成 bug 报上来。树底下
    一个「未归位用例」分组，与未匹配区并列——两者是同一件事的两端：一个是「有记录找不到
    接口」，一个是「有用例找不到接口」。

**明确不做**

- **平台执行或重放上报用例**：平台只有请求摘要，没有代码。这是模式 B 的定义，不是取舍。
- **CI 任务与自研 Runner**：P4.5 整个阶段，含 8.3 的勾选用例快速执行。本阶段产出的
  `repo_test_cases.last_result` 已为它的 `not_run` 兜底留好位置（枚举本阶段就写进 CHECK，
  理由同 P3 边界 13）。
- **覆盖率趋势与快照**：见边界 2，统计整体重做时一起定。
- **多语言 SDK**（js / java）：先让 Python 这一条路被真实仓库用起来，再谈复制。
- **按目录的用例树视图**：见边界 8。
- **上报数据的编辑**：`ingest_records` 是不可变日志（Spec 2.10.1），可编辑就意味着上报的
  事实与树上的显示可以互相矛盾。
- **`aiohttp` / `urllib3` 直连 / `http.client` 的打桩**：见边界 5。
- **上报量的软配额与计费**：只做一道硬上限（7.2 的 413），不做项目级配额。
- **一次上报分派到多个项目**（边界 19）：含 Token 的跨项目授权清单与一次写 N 行 `ingest_runs`。
- **自动判定记录归属哪个系统**（边界 20）：三个方案都已否掉，理由记在那里以免重提。
- **从未匹配区直接补登记接口**（边界 20）：与原交互文档 3.11.1 冲突，显式撤销。
  **2026-08-30 修订**：恢复为单行「登记接口」（见 7.6.1）；「批量补登记 / 全部处理」仍不做。
- **`ingest_path_rules` 用正则**：正则要防灾难性回溯，而这里要表达的就是「`/api/v2/user/`
  开头的不是我的」。只做前缀，可多层。

### 7.1 数据库迁移（接在 033 之后）

> 计划原写的 `005_p4_schema.sql` 为过时命名，实际接在 `033` 之后。

**`034_p4_repositories.sql`**

```
repositories        (id, project_id UNIQUE, git_url, provider, tracking_branch DEFAULT 'main',
                     status CHECK(active|unbound), first_seen_commit,
                     last_ingest_at, created_at, updated_at)
                     # project_id UNIQUE = 「一个项目 = 一个仓库」（Spec 2.10 基数约束）
                     # 由数据库保证，不靠路由里的一次查询

ingest_tokens       (id, project_id, name, token_hash TEXT, token_prefix TEXT,
                     created_by, last_used_at, revoked_at, created_at)
                     # 哈希不加密（边界 17）；prefix 供列表辨认
```

**`035_p4_ingest.sql`**

```
ingest_runs         (id, project_id, repository_id, execution_index_id,
                     protocol_version, commit_sha, branch, ci_run_id, ci_run_url,
                     scope TEXT[] NOT NULL DEFAULT '{}',          -- 本次跑的范围（边界 11/19）
                     is_full_inventory BOOLEAN NOT NULL DEFAULT false,
                     reconciled BOOLEAN NOT NULL DEFAULT false,   -- 实际有没有对账（边界 11 双闸门）
                     case_total, passed_count, failed_count, request_count,
                     added_count, removed_count, updated_count,   -- 全量 run 的 diff（交互 3.11.3）
                     unmatched_count, unplaced_count,             -- 未匹配记录数 / 未归位用例数（边界 20/21）
                     sdk_name, sdk_version, warnings JSONB DEFAULT '[]',
                     started_at, finished_at, created_at,
                     UNIQUE (repository_id, commit_sha, ci_run_id))
                     # UNIQUE 就是协议的幂等键（Spec 2.10.1）；重投命中它 → 合并不新增
                     # ci_run_id 可能为空（本地跑），用 '' 而不是 NULL —— NULL 在 UNIQUE 里不去重
                     # scope 为空数组 = 全仓；对账时按它裁剪（边界 11）

repo_test_cases     (id, project_id, repository_id, case_key,
                     name, description, file_path, tags TEXT[],
                     status CHECK(active|removed) DEFAULT 'active',
                     last_result CHECK(passed|failed|unknown|not_run) DEFAULT 'unknown',
                     last_seen_commit, last_ingest_run_id, last_run_at,
                     removed_at, created_at, updated_at,
                     UNIQUE (project_id, case_key))
                     # case_key 在项目内唯一（Spec 2.10 基数：项目内仓库唯一，无需叠仓库维度）
                     # not_run 现在就写进 CHECK，P4.5 的勾选执行要用（边界「明确不做」末条）
                     # file_path 是对账的裁剪依据（边界 11），不参与 removed 身份判定（边界 8）

repo_case_endpoints (repo_case_id, endpoint_id, first_seen_run_id, last_seen_run_id,
                     request_count, PRIMARY KEY (repo_case_id, endpoint_id))
                     # 一个用例挂多个接口（边界 9）。接口节点的「用例数」= COUNT(*) here；
                     # 项目级「仓库用例数」= COUNT(DISTINCT case_key) —— 两个数不相加
                     # 关系累积、不每轮重建（边界 11）：有 inventory 无 records 的用例保留上轮关系
                     # 一条 active 用例在此没有任何行 = 未归位用例（边界 21），不新增状态列

ingest_records      (id, ingest_run_id, project_id, repo_case_id, endpoint_id,
                     phase CHECK(setup|call|teardown) DEFAULT 'call',   -- 边界 10
                     param_id, seq INTEGER,
                     method, path_raw, path_normalized,
                     status_code, latency_ms, passed, error,
                     request_summary JSONB, created_at,
                     UNIQUE (ingest_run_id, seq))
                     # 不可变日志。UNIQUE(run, seq) 让分批重投在批次内也幂等（Spec 2.10.1）
                     # endpoint_id 可空 = 未匹配（边界 16/20）；path_normalized 亦然
                     # 刻意不加 external/silenced 列：静默是读时按规则前缀匹配算出来的（边界 20），
                     # 落列就意味着改一条规则要回填全部历史，且与「不可变日志」冲突

ingest_path_rules   (id, project_id, path_prefix, note, created_by, created_at)
                     # 人工标注的外部依赖前缀（边界 20），可多层如 '/api/v2/user/'
                     # 只影响未匹配诊断视图的显示，不影响任何统计；项目内允许重复与多条
                     # 前缀匹配，不用正则（见「明确不做」）

execution_index     += kind CHECK 放宽加 'ingest'（边界 1）
```

索引：`ingest_records(endpoint_id, created_at DESC) WHERE endpoint_id IS NOT NULL`（接口详情的
最近上报）、`ingest_records(ingest_run_id, seq)`、`ingest_records(project_id, created_at DESC)
WHERE endpoint_id IS NULL`（未匹配诊断视图）、`repo_test_cases(project_id, status)`、
`repo_test_cases(project_id, file_path)`（对账按 `scope` 前缀裁剪，边界 11）、
`repo_case_endpoints(endpoint_id)`（接口 → 用例反查，覆盖判定用它）、
`ingest_path_rules(project_id)`。

### 7.2 上报接口 `POST /ingest`（协议 v1.0，冻结）

平台**只暴露这一个入口**（Spec 2.10.1）。请求形状见 `REPOSITORY_ARCHITECTURE.md` 3.4，
本阶段落地时补齐的实现约定：

```
POST /ingest
  Authorization: Bearer apitrack_<token>       # 项目级，scrypt 比对（边界 17）
  Content-Type: application/json
  → 200 { runId, indexId, matched, unmatched, unplaced, warnings[], reconciled }
  → 401 token 无效或已吊销
  → 409 git_url 与已绑定仓库不一致（边界 18），message 说清绑的是哪个
  → 413 超过 INGEST_MAX_RECORDS / INGEST_MAX_BODY_BYTES
  → 422 protocol_version 未知 / inventory 与 records 的 case_key 不自洽
```

**协议 v1.0 相对 `REPOSITORY_ARCHITECTURE.md` 3.4 草图的增补，全部在 `run` 段**：

```yaml
run:
  scope: ["tests/order"]        # ★ 本次跑的范围，相对仓库根（边界 11/19）
  is_full_inventory: bool       # 含义收窄为「这个范围内没有过滤」
  sdk: { name, version }        # 平台侧回 warnings 提示升级时要知道对方是谁
records:
  - phase: setup|call|teardown  # ★ 只有 call 阶段建立用例关系（边界 10）
```

**`scope` 必须进 v1.0，不能等**（用户 2026-08-29 确认）：协议只增不改
（`REPOSITORY_ARCHITECTURE.md` 3.1 最严格一档），首版漏掉之后再加，就要面对「老 SDK 报上来
的没有 scope，那它算全仓全量吗」——这个问题的两个答案一个会误删用例、一个会让对账永久失效，
没有安全解。`phase` 同理。

**处理顺序（单事务）**：校验 Token → 登记或校验仓库 → `ingest_runs` upsert（命中幂等键则
走合并分支）→ `repo_test_cases` 按 `case_key` upsert → `repo_case_endpoints` upsert（累积，
不重建）→ `ingest_records` 批量插入 → 全量且在跟踪分支则按 `scope` 裁剪后对账（软删）→
写 `execution_index` 一行 → 算 diff 与未匹配/未归位计数回填 `ingest_runs`。

**为什么单事务**：一次上报要么整份进去要么一份都不进。半份进去之后，`is_full_inventory`
的对账就会拿一份不完整的清单去删用例——那正是边界 11 要防的事故，只是换了个成因。

其余路由：

```
GET    /ingest/protocol                                 协议自描述（版本 + 两道上限），要 Token
GET    /api/v1/projects/:id/repository                  单例视图（Spec 2.10 基数）
PATCH  /api/v1/projects/:id/repository                  只改跟踪分支与托管方标注（git_url 不可改）
DELETE /api/v1/projects/:id/repository                  解绑（保留历史，置 unbound）
GET    /api/v1/projects/:id/ingest-tokens               列表（只回 prefix）
POST   /api/v1/projects/:id/ingest-tokens               创建，明文只回一次
DELETE /api/v1/projects/:id/ingest-tokens/:tokenId      吊销（软删，留 revoked_at）
GET    /api/v1/projects/:id/repo-cases                  用例树数据 + 覆盖统计，分页
GET    /api/v1/projects/:id/repo-cases/:caseId          单用例：上报历史 + 接口关系
GET    /api/v1/projects/:id/repo-cases/unplaced         未归位用例（边界 21），分页
GET    /api/v1/projects/:id/ingest-unmatched            未匹配诊断视图（边界 20），分页
                                                        每行带频次 / phase 分布 / 别的项目是否登记过
                                                        （跨项目那一项在此读时查，只回项目名）
POST   /api/v1/projects/:id/ingest-unmatched/link       关联到已登记接口（不回溯，边界 16）
POST   /api/v1/projects/:id/ingest-unmatched/register  一键登记：建最小接口并归位历史（7.6.1）
GET/POST/DELETE /api/v1/projects/:id/ingest-path-rules  人工标注的外部依赖前缀（边界 20）
GET    /api/v1/projects/:id/ingest-runs                 上报记录，分页
GET    /api/v1/projects/:id/ingest-runs/:runId          单次 run：diff + 请求明细，分页
```

`git_url` **刻意不可改**（落地时补的一条）：它是上报的准入判据（边界 18），在 UI 里改掉等于
绕过那道校验换一个仓库进来。要换仓库走解绑，那是一次显式决定。

**补登记接口的形状（2026-08-30 修订，见 7.6.1）**：`register` 是**单行显式**动作——建最小
接口（method + 模板，其余全空）+ 按**匹配语义**归位历史记录 + 同形 409 拦截；仍然没有批量
与待办形状。P4 落地时这条路完全不存在（边界 20 原判），登记只能去接口管理页手工建。

### 7.3 前端页面

- **仓库用例树**（`repo-cases`，交互文档 3.11.1）：左树「系统 → 接口 → 用例」+ 右详情。
  与接口列表同构，因此复用现有列表约定（URL query 深链、服务端分页、Quiet Console 语义色）。
  `removed` 默认折叠置灰。树底部两个并列分组：**未归位用例**（边界 21）与进入未匹配诊断的入口。
- **接入指引**（`repo-cases/onboarding`，交互文档 3.11.2）：Token 管理 + 三步复制块。
  **照边界 4 重写**——`pip install apitrack-sdk` / 两个环境变量（`APITRACK_URL`、
  `APITRACK_TOKEN`）/ `pytest`（原样，命令不变）+ 连通状态，而不是原文档的「封装
  http_req.py」+「跑 apitest-run」那四步。
- **上报记录**（`repo-cases/runs`，交互文档 3.11.3）：run 列表带 commit/分支/**scope**/
  是否全量/diff；非全量行显式标「不参与删除对账」，全量行显示对账范围是哪一片。
- **未匹配诊断视图**（独立标签页）：按频次排序的路径列表，**无待处理计数、无红点、无「全部
  处理」**（边界 20）。每行三样标注（频次与打过它的用例 / `phase` 分布 / 别的项目是否登记过）
  与两个动作（关联到已登记接口 / 标为外部依赖并可写成前缀规则）。规则管理在同页。
- **趋势页加「含仓库上报」开关**（边界 1），默认关。

### 7.4 SDK 包 `apitrack-sdk`（发布 PyPI）

**包名（2026-08-29 用户改名，原拟 `apitest-sdk`）**：分发名 `apitrack-sdk`，导入名
`apitrack`，pytest 插件注册名 `apitrack`（于是关掉它就是 `-p no:apitrack`）。首版 `0.1.0`。

PyPI 占用已核（2026-08-29）：`apitrack-sdk` / `pytest-apitrack` / `apitrack` /
`apitrack-python` 四个名字**全部空闲**；原拟的 `apitest` 已被他人占用，这也是改名的一项
额外收益。

**只发一个分发包**：`apitrack-sdk`。
- 主包叫 `apitrack-sdk` 而不是 `pytest-apitrack`，因为 pytest 只是首版**唯一**的自动挡，
  而 SDK 的能力边界不止 pytest（边界 4 的降级阶梯里还有 `python -m apitrack` 的非 pytest
  入口、二期的 `flush` 补投）。叫 `pytest-*` 会把包的定位锁死在一个框架上，之后要么改名
  （用户侧要改一行 install），要么长期名不副实。
- **`pytest-apitrack` 占位包已撤销**（2026-08-30 用户决定）。原计划注册它但不放任何代码
  （只 `dependencies = ["apitrack-sdk"]`），理由是 pytest 生态的人找插件的第一反应是搜
  `pytest-` 前缀，名字空着早晚被别人拿去发一个同名不同物的包并误装进接入方的 CI。撤销的
  权衡：它的代价是**每次发版多一处版本号要同步**（占位包必须钉死主包同版），而收益只是一个
  防御性的名字占用。**已知代价**：该名字仍然空闲，可能被他人注册；届时只能靠 README 与
  接入指引页说明「正确的包名是 `apitrack-sdk`」。

```
apitrack-sdk-python/
├── apitrack/
│   ├── plugin.py        # pytest 插件：hook + contextvar 当前 item + phase 标记
│   ├── patch/
│   │   ├── requests.py  # HTTPAdapter.send
│   │   └── httpx.py     # HTTPTransport.handle_request / async 版
│   ├── collector.py     # 内存缓冲 + inventory 收集 + 上限降级
│   ├── case.py          # @case 装饰器（可选，边界 7 的显式覆盖）
│   ├── reporter.py      # sessionfinish 一次性 POST
│   ├── masker.py        # 头部脱敏（边界 14）
│   ├── config.py        # 环境变量 + CI 元数据探测
│   └── cli.py           # 非 pytest 备用入口 + --dry-run
├── tests/
└── pyproject.toml       # [project.entry-points.pytest11] apitrack = "apitrack.plugin"
```

**环境变量前缀随包名改为 `APITRACK_`**：`APITRACK_URL` / `APITRACK_TOKEN` /
`APITRACK_BODY_CAPTURE`。落盘目录（二期）为 `.apitrack/spool/`。前缀与包名一致是唯一能让人
「看到变量名就知道是谁在读它」的做法，留 `APITEST_` 只会在两年后变成一处考古题。
**不做 `APITEST_*` 的兼容读取**：这个包一次都还没发出去，没有存量用户需要兼容（AGENTS.md
数据兼容原则同理）。
Token 明文前缀同步改为 `apitrack_`（`ingest_tokens.token_prefix` 存的就是它的前 8 位）。

**接入形状（边界 4 的硬指标）**

```
① pip install apitrack-sdk
② CI 加两个 secret：APITRACK_URL / APITRACK_TOKEN
③ pytest            ← 原样，命令不变
```

**发布约定**

- **协议版本与包版本分开**：`protocol_version` 独立于 semver。SDK 装在用户仓库里、版本
  不可控（`REPOSITORY_ARCHITECTURE.md` 3.1「最严格」），所以包可以随便发，协议只增不改。
- **PyPI 发布走 Trusted Publishing（OIDC），不在 CI 里存长期 API Token**：长期 token 泄露
  等于任何人都能往这个包名发一个版本，而它会被自动装进所有接入方的 CI。
- **先发 TestPyPI 验一次真实 `pip install`**：`pyproject.toml` 写对但 entry point 没生效
  这类错，只有真装一次才看得见——而 PyPI 的版本号不可重用，发错就烧掉一个号。
- **调试路径必须每次带一个新版本号**（落地时补的一条）：TestPyPI 与 PyPI 一样版本号不可
  重用，而重跑必需的 `skip-existing` 会把重复上传**静默跳过**，于是验证步骤装下来的是第一次
  上传的旧包并绿着通过——调试时改了代码却什么都没验到。落地形状：手动触发时把版本改写成
  `<主包版本>.dev<run 号>`（PEP 440 合法预发布号，跟 run 号递增），只上 TestPyPI 且不执行
  PyPI 那一步；打 tag 才走真发布。验证步骤相应**钉死本次版本**并加 `--pre`（pip 默认跳过
  预发布版本）。
- **`requests` / `httpx` / `pytest` 全部不进 `dependencies`**：它们是用户已有的东西，声明
  依赖会在用户环境里触发一次不必要的版本解析，甚至升级掉他们钉住的版本。`pytest` 进
  `[project.optional-dependencies].dev`，两个 HTTP 库靠 `importlib.util.find_spec` 探测，
  探不到就不打那个桩。
- **`APITRACK_TOKEN` 缺失则完全 no-op**，连桩都不打。本地开发跑测试时 SDK 等于不存在——
  否则第一个在自己机器上跑全量的人就会误报一次「全量快照」并触发对账。
- **`--apitrack-dry-run`**：把这次会上报什么打到 stdout 而不发出去。第一次接入的人一定会
  想看这个，而「先看一眼再开」是让人敢装一个拦截全部 HTTP 流量的包的前提。

### 7.5 分批交付

| 批次 | 内容 | 依赖 |
|---|---|---|
| **P4-1** | 迁移 034/035 + `models/types.ts` 行→API 映射 + `kind='ingest'` 放宽 | — |
| **P4-2** | Token 哈希与仓库绑定：`lib/ingestAuth.ts` + 仓库单例路由 + Token CRUD | P4-1 |
| **P4-3** | `POST /ingest` 主链路：幂等、upsert、关系表累积、records 批插、写 index | P4-2 |
| **P4-4** | path 归一 + 按 `scope` 裁剪的全量对账（双闸门）+ diff / 未匹配 / 未归位计数 | P4-3 |
| **P4-5** | 查询侧路由：用例树、单用例、上报记录、未归位用例 | P4-4 |
| **P4-6** | 未匹配诊断视图：读时三样标注（含跨项目登记查询）+ link + 前缀规则 CRUD | P4-4 |
| **P4-7** | 取消/重跑/回收三条路径显式拒绝 `ingest`（边界 1 末段） | P4-1 |
| **P4-8** | 前端：树页（含未归位分组）+ 接入指引 + 上报记录 + 趋势开关 + 双语 i18n | P4-5 |
| **P4-9** | 前端：未匹配诊断页 + 前缀规则管理 | P4-6、P4-8 |
| **P4-10** | SDK：插件 + 两个桩 + collector（scope/phase）+ reporter + masker + dry-run | P4-3 |
| **P4-11** | SDK 打包与发布：TestPyPI 验证 → PyPI Trusted Publishing（两个名字）→ 指引页填真实命令 | P4-10 |
| **P4-12** | 文档回写：Spec 2.10.1 撤销 `http_req.py` 示例、交互 3.11.1 撤销「补登记接口」动作与 3.11.2 三步重写、`REPOSITORY_ARCHITECTURE.md` 3.4 补 `scope`/`phase` 与改包名 | P4-9、P4-11 |

P4-7 与主链路无依赖，可并行。P4-10 只依赖 `/ingest` 可用，不必等前端。P4-6 与 P4-5 都依赖
P4-4，但彼此独立。

### 7.6 实现状态（2026-08-29）

十二个批次全部实现，落点如下。

| 批次 | 状态 | 落点 |
|---|---|---|
| P4-1 | **已实现** | `migrations/034_p4_repositories.sql`、`035_p4_ingest.sql`；`models/types.ts` 新增 `Repository` / `IngestToken` / `IngestRun` / `RepoTestCase` / `IngestRecord` / `IngestPathRule` 六个类型与映射，`ExecutionIndex.kind` 加 `'ingest'` |
| P4-2 | **已实现** | `lib/ingestAuth.ts`（scrypt 签发与比对、`bindRepository` 的 409）、`routes/repositories.ts`（单例视图 / 改跟踪分支 / 解绑 / Token CRUD） |
| P4-3 | **已实现** | `lib/ingest.ts`（单事务：校验 → 绑定 → run upsert → 用例 upsert → records 批插 → 关系累积 → 对账 → 写 index → 回填计数）、`routes/ingest.ts` 的 `POST /ingest` |
| P4-4 | **已实现** | `lib/ingestPath.ts`（`endpointPath` / `buildEndpointMatcher` / `normalizePath` / `comparableTemplate`）、`lib/ingest.ts` 的 `reconcile` 与 `underScope` |
| P4-5 | **已实现** | `routes/ingest.ts`：`/repo-cases`（按接口分组 + 覆盖统计）、`/repo-cases/unplaced`、`/repo-cases/:caseId`、`/ingest-runs`、`/ingest-runs/:runId` |
| P4-6 | **已实现** | `routes/ingest.ts`：`/ingest-unmatched`（按归一模板聚合 + 三样读时标注）、`/ingest-unmatched/link`、`/ingest-path-rules` CRUD |
| P4-7 | **已实现** | `routes/executionIndex.ts` 的取消路径显式拒绝 `ingest`（400 + 说明）；重跑与回收本就只作用于 `flow`/`suite` 的明细表，`ingest` 没有对应明细行，因此不存在第二处分派点 |
| P4-8 | **已实现** | `components/RepoShell.tsx`（四页共用标签条）、`RepoCaseTree.tsx`、`RepoOnboarding.tsx`、`IngestRuns.tsx`；`Trends.tsx` 的「含仓库上报」开关（默认关）；`ExecutionRecords.tsx` 的来源筛选加 `ingest` 并把点击改为**跳去上报记录页**（`ingest` 的 `detailId` 指向 `ingest_runs`，按流程去读一定 404）；`i18n.ts` 双语约 130 键；侧栏「仓库用例」入口 |
| P4-9 | **已实现** | `components/IngestUnmatched.tsx`（无计数徽标、无红点、无补登记入口）+ 同页前缀规则管理 |
| P4-10 | **已实现** | `apitrack-sdk-python/apitrack/`：`plugin.py`（nodeid 拆分、contextvar 三阶段、scope 与过滤推导）、`patch/requests_patch.py`、`patch/httpx_patch.py`、`collector.py`、`reporter.py`、`masker.py`、`case.py`、`config.py`、`cli.py`；单测 + 子进程集成测试 |
| P4-11 | **已实现** | `apitrack-sdk-python/pyproject.toml`（零 `dependencies`、`pytest11` entry point）、`.github/workflows/publish.yml`（双路径：手动触发发 `.devN` 到 TestPyPI 供调试 / 打 tag 走 TestPyPI → 行为验证 → PyPI Trusted Publishing）。**只发一个分发包**，`pytest-apitrack` 占位包已撤销（见 7.4）。**SDK 已独立建仓并推送**（`github.com/tyl1998/apitrack-sdk-python`，2026-08-30）；**已发布至正式 PyPI**（`v0.1.0`，2026-08-31，流水线全绿），前置留档见下 |
| P4-12 | **已实现** | Spec 2.10.1 改写（撤销 `http_req.py`、补零改动接入与范围级对账）、交互 3.11 全节重写（三步接入、三种对账状态、新增 3.11.4 未匹配诊断）、`REPOSITORY_ARCHITECTURE.md` 2.3 与 3.4 改写并改名 |

**落地时相对 7.0/7.1/7.2 的六处收窄**（都是执行时才暴露的细节，记下而不是悄悄改掉）：

1. **协议 v1.0 增补的是四个字段，不是三个**。7.2 记了 `run.scope`、`records[].phase`、
   `run.sdk`，但漏了 **`inventory[].result`**。用例结果不能由 `records[].passed` 推出来：
   一条被 `skip` 的用例、或只断言本地计算的用例，records 里是空的，按「没有失败的请求就算
   通过」会把它算成绿的；一条断言「404 是预期行为」的用例反过来会被算成红的。理由与 `scope`
   同款——首版漏掉之后再加，就要面对「老 SDK 没报，那它算通过吗」这个两个答案都错的问题。
   缺省时仍从 records 回退推断，所以 3.4 草图形状的上报也能进来。
2. **`ingest_records.path_normalized` 在未匹配时也要填**。7.1 原写「未匹配时 path_normalized
   亦为空」，落地时改为填**通用归一**的结果（`/users/abc-123` → `/users/{id}`）。未匹配诊断
   视图要按频次聚合、要跟别的项目登记过的路径比对，两件事都需要一个稳定的分组键；按
   `path_raw` 聚合的话，`/users/1`…`/users/900` 会长成 900 行各出现一次的列表，那张表就再也
   读不出「哪条路径最常被打到」。
3. **`ingest_tokens.token_prefix` 存的是「`apitrack_` + 随机段前 8 位」，不是「明文前 8 位」**。
   7.4 的字面写法会得到常量 `apitrack`——它辨认不了任何东西，也无法把 `/ingest` 鉴权时的
   scrypt 候选集收窄。
4. **`ingest_runs` 的计数分成三类刷，不是「每次都刷」**。重投同一份 payload 时用例已经全部
   存在，diff 三列（`added/removed/updated`）算出来必然是「+0 −0 ~N」——照它回写就会把上报
   记录页里已经定局的「+2 −1 ~33」抹掉，而 diff 描述的是「那一次上报改变了什么」，不该随
   重投次数变化。落地形状：**diff 三列只在首次写入时算**（靠 `xmax = 0` 判断 upsert 走的是
   INSERT 还是 UPDATE），**请求数与未匹配数按真正插进去的行累积**（分批重投时会增长，完全
   重复的重投增量为 0），**其余每次重算**。同理 `matched` / `unmatched` 只数
   `ON CONFLICT DO NOTHING ... RETURNING` 真的返回的行，否则一次重投会让未匹配数凭空翻倍。
5. **跨项目登记标注要按「占位符无名化」的形状比对**。本项目未匹配记录归一出的是
   `/users/{id}`（通用归一不知道别人管它叫什么），而用户中心那边登记的可能是 `/users/{userId}`
   ——按原样比，这条标注几乎永远为空，而它空着与「真的没人登记」看起来一样。落地为
   `lib/ingestPath.ts` 的 `comparableTemplate`（任何占位符段归成 `{}`），**只服务于诊断视图
   的显示，不参与统计、不落库**。
6. **归一进执行记录页 = 能筛出来 + 能点进去，但「点进去」是跳转不是抽屉**。边界 1 说「统一
   详情入口一处不改就能看到仓库模式」，落地时发现前端那一处是按 `kind` 分派抽屉的：
   `ingest` 的 `detailId` 指向 `ingest_runs`，按流程去读 `flow_executions` 必然 404。而它的
   明细本来就在上报记录页（那里才有 scope、对账状态与请求明细），所以点击改成跳过去。
   `?parent=` 深链指到一条 `ingest` 时同样先摘参数再跳，否则浏览器回退回来会再试一次。

**曾未做的一项（2026-08-31 已完成）**：**PyPI / TestPyPI 的实际发布**。工作流就位、SDK
独立建仓推送后，三步人工前置已全部执行：TestPyPI 与 PyPI 各登记 pending publisher、
GitHub 建 `testpypi` / `pypi` environments、手动触发在 TestPyPI 调试到绿后打 tag `v0.1.0`
触发真发布（全流水线全绿，见 7.7 验收结论）。原始三步说明留档如下：

1. **两个站点各一条 pending publisher**（包还没发过，所以用「发布前先登记」）：TestPyPI 与
   PyPI 的 *Publishing* 页各登记 `apitrack-sdk`。四项元数据必须与工作流逐字一致：
   owner `tyl1998` / repo `apitrack-sdk-python` / workflow `publish.yml` / environment
   `testpypi` 或 `pypi`。错一个字符的表现是 OIDC 拒绝，报错长得像权限问题。
2. **GitHub 仓库 Settings → Environments 建 `testpypi` 与 `pypi`**。job 上的 `environment:`
   与登记的 environment name 必须对上，否则 OIDC 的 subject 不匹配。
3. **先用手动触发在 TestPyPI 上调试到绿**（Actions 页 Run workflow，每次自动发一个
   `.devN`，不烧正式版本号），再**打 tag 触发真发布**：`git tag v0.1.0 && git push --tags`。
   建议同时给 `pypi` environment 加一个 required reviewer——那是最后一道人工闸门，即使误打
   了 tag 也会停下来等确认。

包已发出（`v0.1.0`，2026-08-31）：接入指引页里的 `pip install apitrack-sdk` 从正式 PyPI
安装；验收门槛 13 的「唯一无法在本地验证」一条已由发布流水线与 PyPI 上线事实闭环。

**同轮修掉的四处工作流缺陷**（写的时候没想周全，都会在包完全正常的情况下误判或漏判）：

- **`verify` 的判据从「读 `--trace-config` 的输出文本」改成两条行为判据**。原判据有两个
  假阳性来源：那段输出里本来就有安装路径 `.../site-packages/apitrack/plugin.py`，
  `grep apitrack` 会被它蒙过去；措辞还随 pytest 版本变。现在改为 ① `--apitrack-dry-run`
  出现在 `--help` 里（证明 `pytest_addoption` 跑过 = entry point 被发现并加载），
  ② dry-run 真打出标记行且 payload 里那条探针用例的 `name` 取自 docstring 首行（证明
  `configure`/`sessionfinish` 都跑到、采集与边界 7 的映射也是对的）。
- **探针目录里要放一个真能被收集到的测试**。原来在空的 `/tmp` 里跑 `--collect-only`，
  pytest 收不到测试时返回退出码 5（`EXIT_NOTESTSCOLLECTED`）——它没让 job 红纯属侥幸：
  `| tee` 吃掉了退出码，而 Actions 默认 shell 没开 `pipefail`。
- **TestPyPI 那一步加 `skip-existing: true`，PyPI 那一步刻意不加**。同一个 tag 重跑（第三步
  失败后重试是常态）时 TestPyPI 会因版本号重复整个拒绝，而这次上传本身没问题；真发布重复
  则必须硬失败。另外 `verify` 装的是**钉死本次版本**的包而不是「TestPyPI 上最新的」，否则
  它可能装到上一次发布的包并绿着通过，完全没验到本次改动。
- **调试路径每次带一个新的 `.devN` 版本号**。上面那条 `skip-existing` 单独存在时会制造一个
  更隐蔽的问题：调试时改了代码却复用 `0.1.0`，上传被静默跳过，`verify` 装下来的是第一次上传
  的旧包并绿着通过。两条一起才成立——`skip-existing` 让 tag 重跑可行，`.devN` 让调试跑不会
  复用版本号。

**另加的一道闸门**：tag 路径在构建前检查 **tag 与 `pyproject.toml` 的 `version` 逐字一致**。
不查的话，打 `v0.2.0` 但忘改 `pyproject.toml` 会走完整个 TestPyPI 上传，然后在 `verify` 里
花 100 秒重试一个永远装不到的版本才失败，而报错指向索引延迟、完全看不出真实原因。

**本地已验证的部分**（不需要真跑 Actions 就能确认的）：把 `build` job 里那两段 shell/python
原样抽出来在本地执行，三条分支的行为都对 —— tag 与 pyproject 一致时输出
`version=0.1.0 is_release=true`，不一致时报 `::error::tag 0.2.0 != pyproject version 0.1.0`
并以退出码 1 中止，手动触发时输出 `version=0.1.0.dev13 is_release=false`；版本重写那一步能把
`pyproject.toml` 的 `version` 行正确改写成 `.devN` 且恰好替换一处。另外用真实的
`build_payload` 构造了一份 dry-run 输出，确认 `verify` 里那两条 `grep` 判据都能命中
（含中文 docstring 那一条）。**未验证**：TestPyPI 上传、索引传播延迟的重试、干净 venv 里的
entry point 加载——这三段只有实际发布时才会被执行到。

### 7.6.1 P4 后续增量：快速登记接口（2026-08-30）

用户验收后反馈的两件事之一：仓库模式的覆盖分母是已登记接口，而仓库模式团队把接口写在
代码里、本来就不进平台——为了统计再录入一遍，接入成本被这最后一步吃掉。同轮的另一件
（覆盖基数没按 path 去重）是缺陷，修法记 `issue_fix/问题记录-P4覆盖统计基数未去重.md`，
不在此展开；但它带出一个口径决定需要记下：`/repo-cases` 的分子分母按**形状**
（`coverageShapeKey`，method + 占位符无名化路径）去重计数，树上的接口行仍是行口径——
重复登记时行数 ≥ 形状数，两处对不上是登记侧该清理的信号。

**两个入口，同一套「最小接口」语义**（仓库模式平台不执行请求，这批接口的职责就是进
覆盖分母；headers/body/auth 全空，要调试时在接口管理页补全）：

- **未匹配区一键登记**（`POST /ingest-unmatched/register`，修订边界 20）：单行显式动作。
  url 记 `{{baseUrl}}` + 模板，守住「绝对地址或含 `{{`」的 URL 契约。历史归位按**匹配
  语义**筛——用新模板建单形状匹配器逐条试未匹配记录的 `path_raw`（与 ingest 同一条
  代码路径），所以模板可以从 `/users/abc` 改成 `/users/{username}`：通用归一只认
  「长得像 id」的段，改模板正是补它的盲区，否则下一轮 `/users/bob` 又掉回未匹配。
  同形（同 method + 归一形状）已登记时 409，让人改用「关联」。被前缀规则静默的记录
  一并归位：静默只是显示规则，登记是一次显式决定。
- **接口导入弹窗第三格式「路径清单」**（前端 `parsePaths` → 既有 `/endpoints/import`）：
  每行 `METHOD /path [名称]`，`#` 注释；解析严格，认不出的行抛行号与原文而不是悄悄
  丢掉（悄悄丢掉的行不会出现在任何计数里）。冲突判定沿用 import 的精确 `(method, url)`
  ——清单生成的 url 形状一致，精确串即同形。

**刻意不做的**：批量补登记 /「全部处理」——清空未匹配列表的形状，边界 20 否掉的正是它，
这次没有翻案；登记完整定义（headers/body 等）——那是接口模式的场景，不在未匹配区顺带做。

### 7.6.2 P4 后续增量：参数化场景维度最小可见（2026-08-30）

用户提出讨论：「case 做了参数化、场景不一样，是不是就拿不到 case 的名称了」。结论：
**用例名（函数级）拿得到**，且是边界 7 的刻意设计（参数表一改不能让树换一批用例）；
真正缺的是**场景维度**——per-param 结果在 SDK collector 里按 failed 优先合并成一条
（验收门槛 4 写的「两个子结果」实际落成了合并结果），场景名只以 pytest param id 的
形式存在于 records，且 param id 质量参差（非字符串参数是 `scene0` 这类自动 id）。

本次只做两个纯增益小修；**结构化子结果（Spec 原案的 `IngestCaseResult`，按
`(run, case_key, param_id)` 存结果）明确推迟**，等第一个真实仓库抱怨「找不到哪个
场景挂了」再做——现在做是在猜需求。场景**命名**（`@case` 扩展 param_names 之类）
同样不做：约定性强，容易变成没人填的字段。

- 上报记录 run 明细的请求表加「场景」列（`records[].param_id` 显示成 `[vip]`）：
  数据本就在 API 里（`mapIngestRecord` 一直带 `paramId`），纯展示补齐。
- SDK `describe()` 兜底名从 `item.name` 改为 case_key 的函数名段：参数化子项的
  `item.name` 带 `[param]` 后缀而 inventory 只登记一次，名字会被第一个参数污染
  （缺陷记录见 `issue_fix/问题记录-SDK参数化用例兜底名污染.md`）。

### 7.6.3 P4 后续增量：用例详情抽屉（2026-08-30）

用户确认的形态：**抽屉**而非独立路由（原交互文档路由表预留过 `repo-cases/:caseId`）——
点树上的用例行就地打开，不打断树的浏览/折叠状态。同轮确认三件事：场景级红绿结果
（IngestCaseResult）**继续推迟**；上报的幂等 commit 语义澄清为「执行时所在 git 工作树的
HEAD」（monorepo 各系统共享同一 commit，无目录级 commit 概念；跨项目幂等键按各自的
repository 行隔离，本地无 ci_run_id 的两系统上报互不顶掉）；**pytest-xdist 当前不支持**
——每个 worker 各自上报，records 的 seq 从各自 0 起而互相冲突被丢（case/结果仍对），
修复方向是 controller 汇总（worker 落临时文件 + `pytest_configure_node` 传 run id +
合并重排 seq 后单次上报），未排期。

- 内容两轮定版（2026-08-30 同日第二轮：用户看过后砍掉请求步骤与涉及接口——树本身已
  回答「在哪个接口下」，请求记录 run 明细页已有；用户想要的步骤是 allure 式用例内
  步骤，桩挂传输层看不见 `allure.step`，**明确不采**，留作将来 SDK 的独立采集项）：
  身份事实一块（case_key/文件/标签/最近执行，`.detail-facts` 清单式布局）+ **参数化
  场景**（records 里 distinct `param_id`，后端 `GET /repo-cases/:caseId` 聚合返回，
  只有参数化用例显示这一行）。
- 配套缺陷修复：树表列宽随展开跳动（auto 布局下 colSpan 的接口行与子行一起参与列宽
  计算）→ `grid-fixed`（table-layout: fixed + colgroup 显式宽度）；截断单元格补 title
  悬停（记录见 `issue_fix/问题记录-仓库用例树列宽跳动.md`）。
- 全量上报的负担边界同轮澄清（无代码变更）：每次上报 = 逐条 upsert 全量 case
  （`upsertCases` 为单条循环，可优化为分块多行 INSERT——尚未做）+ 本轮请求数的 records
  分块插入；长期增长点是 `ingest_records` 只增不减（不可变日志，回收显式拒绝 ingest），
  保留策略是将来的独立设计题。monorepo 无关目录变更是否重报由 CI path filter 决定，
  平台侧可做 inventory 指纹短路（未做）。

### 7.6.4 P4 后续增量：上报记录降噪过滤（2026-08-30，两处口径）

用户要的是**run 展开后的记录明细**只看有变动的（首轮实现成了筛 run 列表，用户纠正；
列表过滤保留不删）：

- **run 明细过滤（`GET /ingest-runs/:runId?changes=1`，用户确认的语义）**：记录只留
  未匹配（`endpoint_id IS NULL`）+ **本轮新增的覆盖**（`repo_case_endpoints.
  first_seen_run_id = 本 run` 的关系对应的记录——新用例挂上接口、或老用例第一次挂上
  这个接口）。绝大多数记录是既有关系的重复，「有变动」是扫明细时唯一值得看的。
  **消失（−N）在记录层没有行**——那些请求没发生，由 diff 列汇总。过滤后为空显示专门
  空态；截断提示改用当前过滤口径的 total（meta），不再拿 `run.requestCount` 比。
- **run 列表过滤（`changed`/`unmatched`，OR 语义）**：只看「用例有变动（新增或消失
  > 0）」或「有未匹配」的 run；`updated`（~N）刻意不算变动——改名也会推高它。

同轮 UI 修复：截断单元格的原生 `title` 悬停换成 antd Tooltip（`ui.tsx` 的 `Tip` 原语，
100ms 出现）——原生 title 延迟 ~1 秒且不可调，用户嫌慢（记录见
`issue_fix/问题记录-悬停提示延迟过长.md`）。

### 7.7 验收门槛

1. **零改动接入**：一个既有 pytest 仓库只做「装包 + 两个环境变量」，`pytest` 命令不变，
   跑完后用例出现在树上，`name` 取自 docstring 首行、`description` 取自其后、`file_path`
   是仓库相对路径；没有 `conftest.py` 改动，没有 `-p` 参数。
2. **不影响执行**：同一仓库接入前后的 `pytest` 墙钟耗时差在噪声范围内；`APITRACK_TOKEN`
   未设时不打桩；把上报地址改成一个黑洞端口后测试仍然全绿、退出码不变、只多一条 warning。
3. **流不被吃**：一个用 `stream=True` 逐块读响应的用例，接入后读到的内容与接入前逐字节相同。
4. **一对多**：一个用例先 `POST /login` 再 `POST /orders`（登录在 fixture 里），结果是
   `POST /orders` 下挂着这条用例、`POST /login` 显示「已覆盖但无专属用例」；参数化用例
   `[vip]` / `[normal]` 在树上是**一条**用例、两个子结果。
5. **幂等**：同一份 payload 重投三次，`ingest_runs` 只有一行，`ingest_records` 不翻倍，
   用例的 `last_result` 不变。
6. **范围级对账（边界 11）**：
   - `pytest tests/order/` 全量跑，删掉 `tests/order/` 下缺失的用例，**`tests/user/` 下的
     用例一个都不动**；上报记录页显示这次的 scope 与对账范围。
   - `pytest tests/order/ -m smoke` **不删**任何用例（`reconciled=false`，记录页标「不参与
     对账」）。
   - 一个被 `@pytest.mark.skip` 的用例在全量跑后**仍是 `active`**、接口关系保留上一轮的
     （对账只看 inventory，不看 records）。
   - 软删的用例历史与最后结果仍可读，下次再出现自动回 `active`。
   - 非跟踪分支上的全量跑不对账。
7. **越权**：拿 A 项目的 Token 报 B 仓库的 `git_url` 得到 409 且消息说清已绑的是哪个；
   吊销后的 Token 立即 401。
8. **未匹配诊断视图（边界 20）**：上报一个未登记的路径后，它出现在诊断视图而**不自动建
   endpoint**；页面上**没有**待处理计数、红点与「全部处理」，**也没有**「补登记接口」按钮；
   每行能看到频次、`phase` 分布与「别的项目登记过此路径」的项目名；标一条 `/api/v2/user/`
   前缀规则后同类记录从列表消失，而**覆盖率数字前后完全不变**；删掉规则后它们重新出现
   （静默是读时算的，历史记录未被改写）。
9. **未归位用例（边界 21）**：一个只调用了外部系统接口的用例出现在「未归位用例」分组里，
   且「上报了 N 条用例」与「树上各接口用例数之和 + 未归位数」对得上。
10. **脱敏**：带 `Authorization` 与 `X-Api-Token` 的请求，平台侧存的 `request_summary` 里
    只有键名没有值；`APITRACK_BODY_CAPTURE` 未开时不存任何 body。
11. **归一与口径**：执行记录页能按来源筛出仓库上报并点进详情；`reports/trend` 默认**不**
    含它，打开开关后才含；`/dashboard` 的覆盖率数字**保持不变**（边界 2）。
12. **取消/重跑/回收**对一条 `ingest` 索引返回明确的 400，不是静默无操作。
13. **PyPI**：从干净虚拟环境 `pip install apitrack-sdk` 后，插件**自动生效**且未安装
    `httpx` 的环境不报错。判据不看 `--trace-config` 的输出文本（那里本来就有安装路径里的
    `apitrack` 字样，且措辞随 pytest 版本变），而是两条行为判据：`--apitrack-dry-run` 出现在
    `pytest --help` 里，且 dry-run 的 payload 里那条探针用例的 `name` 取自 docstring 首行。

**验收结论**：2026-08-31 用户验收**通过**（P4-1 ~ P4-12 全量，含 7.6.1–7.6.4 四个
验收后增量与 SDK 首轮 TestPyPI 校验修复）。门槛 13 的 PyPI 实际发布已于同日完成：tag
`v0.1.0` 触发全流水线（test ×3 → build → TestPyPI → verify ×3 → pypi）全绿，
`pip install apitrack-sdk` 生效（`pypi.org/project/apitrack-sdk/0.1.0`）。验收期间发现
的缺陷已全部修复并归档至 `issue_fix/`（索引见 `issue_fix/README.md`：P4 覆盖统计基数
未去重、SDK 参数化用例兜底名污染、仓库用例树列宽跳动、悬停提示延迟过长、P4 仓库模式
SDK 首轮校验）。

---

## 八、P4.5 — CI 任务: 自研 Runner (6 周，范围与边界见 8.0)

> **与 P2-8 执行分区的关系（见 5.0.12）**：本阶段的 Runner 协议（8.2，runner 主动出站、
> 无入站端口、只需 443）是「生产网段连不上平台 Redis / Postgres」情况下的**唯一解**。
> P2-8 采用的分区 worker 依赖出站 Redis + Postgres，若该前置条件不成立，P2-8 作废并把
> 本阶段的 Runner 协议提前。反之，P2-8 已落地的分区标签机制可被本阶段直接复用——
> 仓库模式自带队列，标签只需照搬，不需要返工。
> 另：仓库用例的 `git clone` 与用户脚本执行**只能**发生在能访问被测服务的网段里，
> 因此跨网段的仓库用例最终一定要走本阶段的协议，而不是分区 worker。

### 8.0 P4.5 范围与边界（2026-08-31 确认）

**问题**

P4 让既有 pytest 仓库能把结果**说给平台听**，但「谁来跑」这件事仍在平台之外：用户得自己有
一套 CI（GitHub Actions / GitLab CI / Jenkins），平台只是那套 CI 的下游听众。三个后果：

1. **平台不能主动触发仓库用例**。树上看到一条失败用例，想重跑一次，唯一办法是切到 Git 仓库
   或 CI 页面手动跑——P4 的树因此是只读的观察窗，不是操作台。
2. **没有 CI 的团队进不来**。他们有 pytest 仓库、有被测服务，但没有跑它的地方。
3. **跨网段的仓库用例无解**（5.0.12 待决策项）。`git clone` 与用户脚本**只能**发生在能访问
   被测服务的网段里，而 P2-8 的分区 worker 要求那台机器能出站到平台的 Redis 6379 +
   Postgres 5432。这一条不成立时，P2-8 交付为零，只剩本阶段这一条路。

P4.5 要的是**平台自己拥有一套执行器，且这套执行器可以部署在任何只能出站 443 的机器上**。

**核心模型**

**Runner 主动外连平台，全部交互都是 Runner 发起的 HTTP；认领是一条搬回服务端执行的
`UPDATE … WHERE status='queued'`，靠租约（lease）而不是队列保证 at-most-once；平台下发
JobSpec，Runner 在自己那台机器上 clone + 跑脚本 + 按 offset 推日志 + 回传结构化结果。**

三条与既有实现的关系必须一开始就说清，否则会写出第二套并行机制：

- **不复用 BullMQ**。Redis 出站不可达是本阶段存在的**全部理由**，把 pipeline 排队建在
  BullMQ 上等于把 P2-8 的前置条件重新引进来。排队就是 `pipeline_runs.status='queued'`，
  认领就是 `UPDATE … FOR UPDATE SKIP LOCKED`。这正是 5.0.12 待决策表里方案 C 的原话
  ——「认领语义就是一条 `UPDATE … WHERE status='queued'`，HTTP 版只是把这条 UPDATE 搬回
  服务端执行」。
- **不复用 `workers` 表**（迁移 009/010/027）。那张表是平台自己 BullMQ worker 的注册表：
  id 是 `hostname:pid`、无 token、无信任边界、心跳靠**直写 Postgres**、掉线只影响调度。
  Runner 是自托管的、需注册凭据、心跳走 HTTP、掉线要判 `aborted` 并回收租约。两者信任模型
  与 liveness 语义都不同，塞进一张表会让「离线」这个词在同一列上有两种含义。
- **复用 `runner_label` 分区机制**（5.0.12）。标签格式（`RUNNER_LABEL_PATTERN`）、
  「入队前检查有在线执行器、没有就拒绝且绝不写行」（边界 4）、错误码 `2004` +
  `failNoRunner`、前端 `noRunnerLabel()` 单点判定——四样全部照搬，一个字不改。分区回答的
  是「这次执行从哪个网段发出」，对 Runner 与对 BullMQ worker 是同一个问题。

**已确认的边界决策（18 项）**

1. **归一进 `execution_index`，`kind` 加 `'runner'`**（Spec 3.x 的
   `source_type: flow|scenario|suite|ingest|runner` 早已预留这个名字）。迁移照抄 035 的
   「**按定义内容找约束，不按名字**」写法——015 建表时那个 CHECK 是 Postgres 自动命名的，
   `DROP … IF EXISTS` 猜错名字会静默成功、然后在第一次触发时才炸。
   **与 `ingest` 相反，三条路径这次全部要支持**：取消（经心跳下发指令）、重跑（新建一条
   不可变的 run，见边界 9）、回收（租约超时判 `aborted`）。边界 1 的 P4 版本说的是
   「对一次别人已经跑完的历史，这三个动作没有意义」——Runner 是平台自己在跑，意义完全成立。
2. **趋势与通过率的口径：`runner` 与 `ingest` 同档，默认排除**。理由与 P4 边界 1 完全一致
   ——Runner 里跑的是用户脚本，`latency_ms` 是用户进程里的客户端耗时；一次 `-m smoke`
   任务会把通过率拉出一个没人认的台阶。趋势页那个「含仓库上报」开关的语义因此扩成
   「含仓库执行」，一个开关同时管 `ingest` 与 `runner`——不给第二个复选框，那两者对用户是
   同一件事（「仓库里跑的」）。
3. **Runner 的排队与 BullMQ 完全隔离，但「无在线执行器就拒绝」这一条照搬**（P2-8 边界 4）。
   少了它，用户看到的是一条永远 `queued` 的 run，90 秒后被 reaper 判 `aborted`，排查方向
   会跑偏到「Runner 崩了」，而事实是这个标签下从来没有 Runner 注册过。检查放在 `INSERT`
   **之前**，因此连补偿删除都不需要。
4. **认领用 `FOR UPDATE SKIP LOCKED`，不用「先 SELECT 再 UPDATE」**。多个 Runner 同时长
   轮询是常态，两步式在中间那个窗口里会让两台 Runner 拿到同一个 run；`SKIP LOCKED` 让第二
   个请求直接跳到下一条候选而不是排队等锁，这对长轮询尤其重要——等锁会把 25 秒的轮询窗口
   耗在互相阻塞上。
5. **租约（lease）是 Runner 存活的唯一判据，不是 `runners.last_seen_at`**。判据必须挂在
   **任务**上而不是挂在机器上：一台 Runner 可以进程还活着、心跳照发，但某个 job 的子进程已
   经僵死。`pipeline_runs.lease_expires_at` 由每次心跳续到 `now() + 90s`（Spec 2.10.2 的
   90 秒，照用）。`runners.last_seen_at` 仍然要有，但它只回答「这台机器在不在线」（用于面板
   与边界 3 的入队前检查），不回答「这个任务还活着吗」。
6. **心跳的响应体是下发取消指令的唯一通道**（`{ cancel: true }`）。平台永不反向连接 Runner
   ——这是自托管 Runner 能待在 NAT 后面的全部前提，破一次就等于要求客户开入站端口。
   取消因此**必然有延迟**（最长一个心跳间隔），界面上状态要用 `cancelling` 而不是直接
   `canceled`（交互文档 1.4 的统一生命周期已经有这个状态）。
7. **日志 offset 单调递增，去重靠 `UNIQUE (pipeline_run_id, byte_offset)`**，不靠「服务端
   记住上次收到哪」。Runner 断线重连后从自己记的 offset 续传，重复 chunk 撞唯一约束
   `DO NOTHING`。offset 的单位是**字节**而不是行号：行是要靠内容切分才知道的，断在半行上时
   行号没有定义。
8. **退出码落盘再上报**（Spec 2.10.2(d)）。Runner 进程被 kill -9 后重启，读 workspace 里那个
   `exit_code` 文件补报 `complete`；读不到才判 `aborted`。少了这一步，Runner 每次重启都会
   在平台侧留下一批永久 `running`、最后被租约超时判死的 run，而它们其实是跑完了的。
9. **重跑 = 新建一条 run，绝不改写旧行**（交互文档 1.5 的「新执行不可变 + A/B 对比」）。
   `pipeline_runs` 是一份不可变的执行账本，`aborted` 的那一条要留在历史里——它是「那天
   Runner 掉线了」的唯一证据。
10. **`trigger_source` 不加第五个值**。§8.3 初稿写的 `trigger_type=manual_case_selection`
    有两处不对：列名实际是 `trigger_source`（迁移 030），而 CHECK 是
    `('manual','scheduled','webhook','ci')`。勾选触发仍然是**人按了按钮**，
    `trigger_source='manual'` 就是事实；「这次是勾选来的」记在
    `pipeline_runs.case_filter IS NOT NULL` 上。加第五个值会让执行记录页「手动触发」这个
    筛选项分裂成两个必须都勾的框。
11. **deploy key 存平台并随 JobSpec 下发**（用户 2026-08-31 选定，推翻了「凭据留在 Runner
    侧机器」的备选）。用 `lib/crypto.ts` 的 AES-GCM 加密进 `repositories.deploy_key_encrypted`
    ——与数据源凭据、webhook secret 同一套密钥与同一套形状，不引入第二种加密方式。
    **这笔账的代价必须写明，不能记成零成本**：
    - 平台库里出现用户 Git 仓库的读凭据；下发意味着这份凭据会离开平台边界，落到那台自托管
      机器的内存里。
    - 缓解三条，全部是硬要求：① **只支持只读 deploy key**，表单上写明并在文案里要求用户在
      Git 平台侧勾掉写权限——平台无法验证这一点，只能说清；② key 只出现在 claim 的**响应体**
      里，不进 `pipeline_runs` 快照、不进日志、不进任何 GET 接口的返回；③ Runner 侧写成 0600
      的临时文件、用 `GIT_SSH_COMMAND` 指向它、`finally` 里删除，绝不写进 `~/.ssh/`。
    - **HTTPS + token 也要支持**，而且它是更该推荐的那一种：token 可以精确到单仓库只读、
      可以随时吊销、不需要用户在机器上配 SSH。表单默认给 HTTPS token。
12. **secret 脱敏在 Runner 侧做，不在平台侧做**。日志一旦按 offset 上报，那份原文已经在网络
    上了，平台侧再脱敏已经晚了——这与 P4 边界 14（SDK 侧脱敏）是同一个道理。
    **同时要写明能力边界**：只做**原文逐行替换**，不承诺挡住 base64 / URL-encode / 逐字符
    echo 等变形。承诺挡不住的东西，用户会按承诺去用。
13. **报告归一走三条路径，优先级明确，不是三选一**（用户 2026-08-31：「接入 allure，或者
    根据用户上报的内容」）。三条并存，因为它们回答的不是同一个问题：

    | 路径 | 拿到什么 | case_key 语义 | 首版 |
    |---|---|---|---|
    | **A. SDK 上报**（P4 已有） | case ↔ endpoint 关系 + 用例树归位 | **精确**，`case_key` 是 SDK 自己生成的 | ✅ 必做，零解析成本 |
    | **B. junit.xml** | case 级通过/失败/耗时 | best-effort（`classname::name` 猜） | ✅ 做，几乎所有框架都产它 |
    | **C. allure-results** | 同 B，外加 step / attachment / 分类 | 同 B | ✅ 做**结果解析**，不做报告渲染 |

    - **A 是干净路径**：平台把 `APITRACK_CI_RUN_ID` 注入成 `pipeline_run_id`，于是
      `ingest_runs` 与 `pipeline_runs` 天然对得上，一次 CI 执行在树上和在执行记录里是同一件
      事的两个视图。**回写树上 `last_result` 只认 A**——B/C 的测试名与 `case_key` 没有稳定
      映射，用它们回写会把树写脏，而写脏的树没有办法回滚。
    - **C 只解析 `allure-results/*-result.json` 的结构化 JSON**——这条仍然成立；但
      「不做报告渲染」**已于 2026-09-01 改判**（用户要求看 timeline 与用例内步骤），
      平台改为**自存原始文件、自渲染报告视图**（P4.5-13，见边界 19）：不跑
      `allure generate`、不托管 allure 静态站点、不 vendor allure 官方 SPA——数据源
      就是 allure-results 目录本身（格式是稳定的公开事实），Runner 自动把它打成 zip
      作为 `kind='report'` 产物直传对象存储，平台从对象存储读、用自己的 UI 渲染，
      附件走 presigned GET 直链。不装 Java、不引 allure-cli。
    - **解析在 Runner 侧做，上报结构化 JSON**。让平台解析 XML 意味着把整个报告文件传上来
      （几十 MB 起）、在 API 进程里解析不可信 XML（XXE / 十亿笑声）、再引一个 XML 依赖。
      Runner 侧解析后只上报几 KB 的 case 数组，三个问题一起消失。
14. **产物与对象存储从 P10 14.1 提前，但只服务 artifacts**（用户 2026-08-31 确认提前）。抽
    `lib/objectStore.ts` 一层、两个驱动：`fs`（本地目录，dev 默认）与 `s3`（MinIO / S3，
    生产）。**硬约束：平台永不代理大文件流。** Runner 先 `POST …/artifacts` 申请一个
    pre-signed PUT URL，然后**直传对象存储**；`fs` 驱动下退化为一个带一次性 token 的平台
    上传地址。
    **明确不做**：P10 14.1（原 P6 10.1）的另外两件（执行历史归档分区表、大响应体截断进对象存储）不动。
    本阶段只是把「对象存储这一层抽象」提前落地，`executions.response_body` 一个字都不改
    ——那是一次口径变更，要连着归档策略一起想。
15. **沙箱两档都做，容器档是默认，进程档是逃生口**（用户 2026-08-31：「容器 + 进程」）。
    两档的差别不是「隔离强度」的量级差异，而是**有没有网络策略**这个质变：

    | 能力 | 进程档（`process`） | 容器档（`container`） |
    |---|---|---|
    | 超时 kill 整个进程树 | ✅ | ✅ |
    | workspace 隔离 + 执行完清理 | ✅ | ✅ |
    | CPU / 内存 / 磁盘限额 | ❌ 做不到 | ✅ `--cpus` / `-m` / `--storage-opt` |
    | 出站白名单（禁访平台内网 / `169.254.169.254`） | ❌ **做不到** | ✅ 独立 network + iptables |
    | 文件系统隔离（脚本读不到 Runner 自己的配置） | ❌ 同一 FS | ✅ |
    | 依赖缓存复用 | ✅ 天然（同一 FS） | ✅ 挂缓存卷 |
    | 前置要求 | 无 | 目标机器有 docker |

    - **进程档不是「简化版容器档」，它是一个信任声明**：选它等于声明「我信任这个仓库里的
      脚本，就像信任一个传统 CI agent 上的脚本一样」。UI 上要这么写，不能写成「轻量模式」。
    - **容器档是任务级默认**。理由：Runner 跑的是**用户仓库里的任意脚本**，而 Runner 那台
      机器上有平台下发的 deploy key 和 secret（边界 11、12）——没有文件系统隔离时，一个脚本
      可以读到另一个任务留下的东西。
    - **Spec 2.10.2(a) 的 `isolated`（Job per build / K8s Job）本阶段不做**。容器档已经拿到
      文件系统与网络隔离；`isolated` 换来的是「每次全新镜像」，代价是镜像拉取与依赖重装，
      而 2.10.2(b) 要求的那一整套冷启动优化（预烤镜像 / 缓存卷 / venv hash 缓存 / 镜像预热）
      是独立的一大块。留字段位（`isolation_mode`），首版只接受 `shared`。
16. **勾选用例快速执行（§8.3）进本阶段**（用户 2026-08-31 确认）。它是 P4.5 里唯一能对
    **既有 P4 用户**立刻产生可见价值的部分：P4 交付后树是只读的，勾选执行让它变成操作台。
    `not_run` 已经在 `repo_test_cases.last_result` 的 CHECK 里（迁移 035:102，当时就是为这
    一刻留的），**不需要新迁移**。
    **`not_run` 由平台侧标，不是 SDK 的事**：run 结束后，`case_filter.case_keys` 减去本次
    `ingest_run` 实际报到的集合，差集标 `not_run`。让 SDK 报「我没跑这些」是错的——脚本可能
    根本不认识 `--apitrack-case-keys`，那时它会全量跑，而全量跑里这些 key 都报到了，差集为
    空，结论正确；反过来若脚本认识但崩在中途，差集非空，标 `not_run` 也正确。平台侧算差集
    对这两种情况都成立，SDK 侧上报只对第一种成立。
17. **`Idempotency-Key` 与审计日志本阶段建，且是通用设施**（REPOSITORY_ARCHITECTURE.md 3.2
    「触发类接口支持 `Idempotency-Key`」的第一次落地）。两张表都不带 `ci_` 前缀
    （`idempotency_keys` / `audit_logs`），因为它们从第一天起就该能被套件触发、流程触发复用
    ——只是本阶段只有 CI 触发接上去。**不追溯改造既有触发接口**：那是一次跨 6 个路由的改动，
    与 Runner 无关，混进来会让本阶段的验收边界说不清。
18. **4 周装不下，实际排 6 周**。诚实记下而不是压进去：Runner 是**第四个仓库**（新建
    `apitest-runner`）、**第一次**出现平台侧 HTTP 长轮询、**第一次**引入对象存储、**第一次**
    引入容器执行，同时还要做 CI 任务的完整 CRUD + 执行详情 + 实时日志三个前端页面。
    压回 4 周要砍的东西按此顺序（见 8.8 的批次表）：先砍容器档（P4.5-10，退到只有进程档
    并在 UI 上说清）、再砍 allure 解析（P4.5-6 的 C 路径）、再砍产物上传（P4.5-7，只留日志）。
    **勾选执行（P4.5-9）不在可砍列表里**——见边界 16。
19. **报告视图自渲染，不做 allure 静态站**（P4.5 边界，用户 2026-09-01：「平台托管
    allure 静态站点」+「不用 allure-cli，自己保存产生的文件，然后渲染」；与 P4 的
    边界 19「一次上报分派到多个项目」只是跨节同号，不是同一条）。落地形状分两层，
    两层都绕开 allure-cli：
    - **timeline 层不碰文件**：allure 的 `start` / `stop` / `host` / `thread` 随
      `cases[]` 上报（`ReportCase` 加 4 个可选字段），`pipeline_run_cases` 加
      `started_at_ms` / `finished_at_ms` / `host` / `thread` 四列（迁移 040），前端在
      run 详情页的 cases tab 直接画 gantt——时间轴只要结构化数据，不需要原始报告。
    - **报告层走既有产物线**：Runner 在 `report_format='allure'` 且解析到文件时，把
      匹配到的 allure-results 目录（含 `*-container.json` 与附件实体文件）打成 zip，
      作为 `kind='report'` 的 artifact 直传对象存储（artifacts 表当时就为此留了这个
      kind，不是新概念）。平台读路由从对象存储取 zip、在请求内解析、用自己的 UI 渲染；
      附件下载走一个**按 run 归属鉴权的下载路由**（对象存储的 storage_key 不是浏览器
      能直接消费的东西，presignGet 直链 5 分钟短活罩不住报告页里一张 10 分钟后才点开
      的截图）。
    - **v1 视图清单封顶**：timeline + suite 树 + case 详情（steps / attachments /
      parameters / categories）。behaviors / severity / graph 分组、allure 的
      `history/` 趋势机制都不做——趋势从自己的 `pipeline_runs` 历史算（数据在库里，
      平台比 allure 有资格算）。
    - **代价换来的边界**：权限就是普通项目访问控制（不为静态站开公开下载口）；报告 UI
      进 Quiet Console 体系；镜像不装 Java / allure-cli。长期维护归平台——用户拿
      allure 官方功能来比时，答案在 8.10。

### 8.1 数据库迁移（接在 035 之后，按批次拆四个文件）

> 序号说明：计划原写的 `006_p45_schema.sql` 为过时命名，实际接在 `035` 之后。
> **一批一个主题，不写一个大文件**——迁移是 forward-only 的，一个文件里塞四张表意味着任何
> 一处写错都要靠一个新文件去补，而补丁文件读起来永远不知道原意是什么。

```
036_p45_runners.sql        runners / runner_tokens
037_p45_ci_tasks.sql       ci_tasks / repositories.deploy_key_encrypted
038_p45_pipeline_runs.sql  pipeline_runs / pipeline_run_logs / pipeline_run_cases
                           + execution_index.kind 加 'runner'
039_p45_infra.sql          artifacts / idempotency_keys / audit_logs
```

**036 — Runner 注册表**

```sql
runner_tokens (
  id UUID PK,
  name TEXT NOT NULL,                    -- 「办公内网 01」，人给的
  token_hash TEXT NOT NULL,              -- scrypt "salt:digest"，照抄 ingestAuth.ts
  token_prefix TEXT NOT NULL,            -- "apirunner_" + 前 8 位，候选收窄用
  labels TEXT[] NOT NULL DEFAULT ARRAY['default'],   -- 这张 token 允许声明的分区
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
-- 部分索引，与 ingest_tokens_prefix_idx 同款
CREATE INDEX runner_tokens_prefix_idx ON runner_tokens (token_prefix) WHERE revoked_at IS NULL;

runners (
  id UUID PK,                            -- 平台发的，不是 hostname:pid
  runner_token_id UUID NOT NULL REFERENCES runner_tokens(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- Runner 自报的 hostname，仅显示
  labels TEXT[] NOT NULL,                -- ⊆ runner_tokens.labels，注册时校验
  capacity INTEGER NOT NULL DEFAULT 1,
  sandbox_modes TEXT[] NOT NULL DEFAULT ARRAY['process'],  -- 这台机器实际支持哪几档
  version TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL DEFAULT '1.0',
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','draining','offline')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

四处必须解释的设计：

- **`runner_tokens` 是系统级的，不带 `project_id`**。一台自托管机器服务的是一个**网段**，
  而网段上可能有多个项目的被测服务。绑到项目上会逼用户为每个项目在同一台机器上起一个
  Runner 进程。项目隔离靠 `labels` + 后续的分区准入，不靠 token 归属。
  （对比 `ingest_tokens` 确实带 `project_id`——那是因为一份上报**必然**属于一个项目，
  `/ingest` 从 token 反查 `project_id` 是它的核心机制。）
- **`labels` 在 token 上而不只在 Runner 上，且注册时校验子集关系**。否则任何一台拿到 token
  的机器都能声明 `labels=['prod-dmz']` 并开始领生产网段的任务——这正是 P2-8 边界 6
  「认领语句加分区防御」担心的那件事，只是那里的攻击面是「job 被投错队列」，这里是
  「机器自称在别的网段」，后者更严重。
- **`sandbox_modes` 由 Runner 自报**（探测本机有没有 docker）。任务配了容器档但没有一台
  在线 Runner 支持它，这个错误要在**触发时**就报出来（复用 `2004` / `failNoRunner` 的形状），
  不能等到 claim 之后 Runner 自己失败——那会得到一条 `failed` 的 run 和一段看不懂的日志。
- **`status='draining'`**（交互文档 3.12.4 的「下线」）：不再参与 claim，但在跑的任务跑完。
  它是 `runners` 上唯一一个**人可以改**的列。

**037 — CI 任务与仓库凭据**

```sql
ALTER TABLE repositories
  ADD COLUMN clone_method TEXT NOT NULL DEFAULT 'none'
      CHECK (clone_method IN ('none','https_token','ssh_key')),
  ADD COLUMN clone_url TEXT NOT NULL DEFAULT '',      -- 可与 git_url 不同：git_url 是身份，这个是拉取地址
  ADD COLUMN credential_encrypted BYTEA,              -- AES-GCM，lib/crypto.ts
  ADD COLUMN credential_updated_at TIMESTAMPTZ;

ci_tasks (
  id UUID PK,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  git_ref TEXT NOT NULL DEFAULT 'main',
  runner_label TEXT NOT NULL DEFAULT 'default',
  sandbox_mode TEXT NOT NULL DEFAULT 'container' CHECK (sandbox_mode IN ('process','container')),
  isolation_mode TEXT NOT NULL DEFAULT 'shared' CHECK (isolation_mode IN ('shared')),  -- 留位，见边界 15
  image TEXT NOT NULL DEFAULT '',                     -- container 档必填，process 档忽略
  steps TEXT NOT NULL,                                -- 用户脚本原文，一整段 shell
  env JSONB NOT NULL DEFAULT '{}'::jsonb,             -- 明文变量
  secrets_encrypted BYTEA,                            -- {k:v} 整体加密，日志脱敏用它的 values
  cache_paths TEXT[] NOT NULL DEFAULT '{}',
  cache_key_files TEXT[] NOT NULL DEFAULT '{}',       -- 这些文件的内容 hash 作 key
  report_format TEXT NOT NULL DEFAULT 'none'
      CHECK (report_format IN ('none','junit','allure')),
  report_paths TEXT[] NOT NULL DEFAULT '{}',
  artifact_paths TEXT[] NOT NULL DEFAULT '{}',
  sdk_ingest_enabled BOOLEAN NOT NULL DEFAULT true,   -- 注入 APITRACK_* 三件套
  timeout_seconds INTEGER NOT NULL DEFAULT 1800,
  is_default BOOLEAN NOT NULL DEFAULT false,          -- 勾选执行的推荐兜底，见 §8.3
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at / updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
CREATE UNIQUE INDEX ci_tasks_project_default_idx
  ON ci_tasks (project_id) WHERE is_default;          -- 一个项目最多一个默认任务
```

- **`steps` 是一整段 shell 文本，不是 `TEXT[]`**。Runner 把它写成一个脚本文件执行
  （Spec 2.10.2(d)），拆成数组只会诱导人以为「每一步是独立的阶段、可以单独重试」——而它们
  共享一个 shell 进程与工作目录，`cd` 和变量都是跨行生效的。阶段划分是 Runner 固定的四段
  （clone / cache / script / report），不是用户脚本的行数。
- **`clone_method='none'` 是默认值**：公开仓库不需要凭据，而「不需要凭据」应该是默认状态而
  不是一个特例。
- **`clone_url` 与 `git_url` 分开**：`git_url` 在 P4 里是**身份**（`/ingest` 靠它防越权，
  迁移 034 刻意不加唯一约束但校验绑定），改它会打断已绑仓库的上报。拉取地址是另一件事
  （同一个仓库可以有 https 和 ssh 两个地址），必须是另一列。
- **`runner_label` 直接放在 `ci_tasks` 上，不从 environment 取**。这是与 P2-8 唯一的不同点，
  必须讲清：P2-8 选 environment 做标签归属者，因为接口模式的执行「指向哪套系统」这件事完全
  由 environment 决定（5.0.12 核心模型）。CI 任务里被测地址在**用户脚本和它自己的 env 里**，
  平台不知道也不该知道；这里的标签回答的是「在哪台机器上 clone 与执行」，那是任务自己的属性。
  **标签的命名空间是共享的**（同一个 `RUNNER_LABEL_PATTERN`、同一份候选来源、
  面板上同一列），共享的是「哪个网段」这个语义。
- **同一个标签下可以既有 BullMQ worker 又有 Runner，两者互不相干**：接口模式的入队前检查读
  `workers`，CI 触发的检查读 `runners`。`GET /system/runner-labels` 的返回要**分别**给出这两个
  台数，不能相加——把它们加成一个「在线 3 台」会让「配了 CI 任务但那个标签只有 BullMQ worker」
  这种情况显示为可用，而它触发时会被拒。

**038 — 执行账本**

```sql
pipeline_runs (
  id UUID PK,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ci_task_id UUID NOT NULL REFERENCES ci_tasks(id) ON DELETE CASCADE,
  execution_index_id UUID REFERENCES execution_index(id) ON DELETE SET NULL,
  run_number INTEGER NOT NULL,                        -- 任务内自增，界面上的 #128
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','claimed','running','cancelling','success','failed','canceled','aborted','timed_out')),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN
    ('pending','clone','cache','script','report','done')),
  runner_label TEXT NOT NULL,                         -- 触发时冻结，照 P2-8 边界 1
  sandbox_mode TEXT NOT NULL,                         -- 快照，任务改配置后历史仍说得清
  runner_id UUID REFERENCES runners(id) ON DELETE SET NULL,   -- 无 FK 级联：Runner 删了历史要留
  lease_expires_at TIMESTAMPTZ,                       -- 边界 5：存活判据挂在任务上
  trigger_source TEXT NOT NULL DEFAULT 'manual'
      CHECK (trigger_source IN ('manual','scheduled','webhook','ci')),
  trigger_ref_id UUID, trigger_ref_name TEXT,
  triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  git_ref TEXT NOT NULL,                              -- 触发时的任务配置快照
  commit_sha TEXT NOT NULL DEFAULT '',                -- clone 完了 Runner 回填
  case_filter JSONB,                                  -- NULL = 全量；{case_keys:[…]} = 勾选执行
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  exit_code INTEGER,
  error TEXT,
  log_bytes BIGINT NOT NULL DEFAULT 0,                -- = 下一个期望的 offset
  case_total / passed_count / failed_count / skipped_count INTEGER NOT NULL DEFAULT 0,
  ingest_run_id UUID REFERENCES ingest_runs(id) ON DELETE SET NULL,   -- SDK 路径回填
  created_at / claimed_at / started_at / finished_at TIMESTAMPTZ
)
CREATE UNIQUE INDEX pipeline_runs_task_number_idx ON pipeline_runs (ci_task_id, run_number);
CREATE INDEX pipeline_runs_claimable_idx
  ON pipeline_runs (runner_label, created_at) WHERE status = 'queued';
CREATE INDEX pipeline_runs_lease_idx
  ON pipeline_runs (lease_expires_at) WHERE status IN ('claimed','running','cancelling');

pipeline_run_logs (
  id BIGSERIAL PK,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  byte_offset BIGINT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, byte_offset)               -- 边界 7：断线重传靠它去重
)

pipeline_run_cases (
  id UUID PK,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('junit','allure')),   -- 注意：没有 'sdk'
  suite_name TEXT NOT NULL DEFAULT '', case_name TEXT NOT NULL,
  guessed_case_key TEXT,                              -- 命名即声明：这是猜的，不回写树
  status TEXT NOT NULL CHECK (status IN ('passed','failed','skipped','error')),
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  UNIQUE (pipeline_run_id, source, suite_name, case_name)
)
-- execution_index.kind 加 'runner'，照抄 035 的「按定义找约束」DO 块
```

- **`pipeline_run_cases.source` 没有 `'sdk'` 这个值**。SDK 路径的 case 级结果已经在
  `repo_test_cases` + `ingest_records` 里了，再存一份就有两个都自称权威的副本。这张表专门
  装**报告解析出来的、不可信到不能回写树**的那一类结果——`guessed_case_key` 这个列名就是
  在说这件事（边界 13）。
- **`log_bytes` 同时是「日志总长」和「下一个期望 offset」**，一个数不会自相矛盾。Runner 断线
  重连时 `GET …/claim` 之外还需要能问「我上次报到哪了」，答案就是这一列。
- **`stage` 是固定四段而不是自由文本**：界面上的阶段进度（交互文档 3.12.3）要能画出来，
  自由文本画不出固定的进度条，而排队与冷启动耗时可见是那个设计的全部目的。

**039 — 通用设施（对象存储 / 幂等 / 审计）**

```sql
artifacts (
  id UUID PK,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('pipeline_run')),   -- 首版只有一种，留扩展位
  owner_id UUID NOT NULL,                             -- 多态，无 FK
  kind TEXT NOT NULL CHECK (kind IN ('log','report','file')),
  name TEXT NOT NULL,
  storage_driver TEXT NOT NULL CHECK (storage_driver IN ('fs','s3')),
  storage_key TEXT NOT NULL,                          -- 驱动内的路径/对象键
  size_bytes BIGINT NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ,                            -- NULL = 申请了但没传成
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)

idempotency_keys (
  scope TEXT NOT NULL,                                -- 'ci_task_trigger' 等
  key TEXT NOT NULL,                                  -- 客户端给的 Idempotency-Key
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  result_id UUID NOT NULL,                            -- 首次调用产生的那一行
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, project_id, key)
)

audit_logs (
  id BIGSERIAL PK,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,   -- 可空：系统级动作
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                               -- 'ci_task.trigger' / 'runner_token.create' …
  target_type TEXT NOT NULL, target_id UUID,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,          -- 绝不放 secret 值
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
CREATE INDEX audit_logs_project_created_at_idx ON audit_logs (project_id, created_at DESC);
```

- **`idempotency_keys` 用复合主键而不是「UUID 主键 + 唯一索引」**：这张表**只**被
  「按 key 查有没有」这一种方式访问，一个自增 id 是纯粹的多余空间。`result_id` 无 FK——scope
  决定它指向哪张表。
- **`artifacts` 用 `owner_type` + `owner_id` 多态而不是 `pipeline_run_id`**：P10 要把大响应体
  和归档也放进来（边界 14 说了本阶段不做，但表结构现在就别把自己锁死）。CHECK 里现在只有
  一个值，加值时是一次 DROP/ADD CHECK，比加一张表便宜。
- **`audit_logs.detail` 不放 secret 值**要写进列注释。审计日志天然会被广泛读取，是最容易
  发生「顺手把 payload 整个塞进去」的地方。

### 8.2 Runner 协议 v1.0（Runner → Server，冻结）

**全部由 Runner 主动发起，平台永不反向连接**（REPOSITORY_ARCHITECTURE.md 1.3 / 3.3）。
路径前缀 `/runner`（不在 `/api/v1/projects/:id` 之下——Runner 是系统级的，项目从 job 来），
认证 `Authorization: Bearer apirunner_<token>`。

> **与三份既有文档的三处冲突，在此记下而不是悄悄改掉**（照 P4 边界 4 的做法）：
> ① 路径前缀用 `/runner` 而非 Spec 2.10.2(c) 与本计划原 8.2 的 `/worker`——平台内部已经有
> 「worker」这个词且指的是 BullMQ worker（`src/worker.ts`、`workers` 表、执行器面板），
> 两个 worker 会让代码里每一处都要先问「哪个 worker」。
> ② 领取用 `POST /runner/claim` 而非 REPOSITORY_ARCHITECTURE 3.3 的 `GET /worker/jobs/claim`
> ——它带请求体（`capacity_available`）且**有副作用**（改 `status` 与租约），`GET` 是错的。
> ③ 心跳、日志、产物、完成四个接口挂在 `/runner/jobs/:id/*` 下（与 3.3 一致），
> 而本计划原 8.2 写的扁平 `POST /worker/heartbeat` 作废——job id 必须在路径里，否则四个接口
> 都要在 body 里带一个「其实是资源标识」的字段。

| # | 接口 | 请求 | 响应 |
|---|---|---|---|
| 1 | `POST /runner/register` | `{name, labels[], capacity, sandbox_modes[], version, protocol_version}` | `{runner_id, heartbeat_interval_seconds, poll_timeout_seconds}` |
| 2 | `POST /runner/claim` | `{runner_id, capacity_available}` | **长轮询** → `JobSpec` 或 `204` |
| 3 | `POST /runner/jobs/:id/heartbeat` | `{runner_id, stage, log_bytes}` | `{lease_expires_at, cancel: bool}` |
| 4 | `POST /runner/jobs/:id/logs` | `{runner_id, byte_offset, chunk}` | `{next_offset}` |
| 5 | `POST /runner/jobs/:id/artifacts` | `{runner_id, kind, name, size_bytes, content_type, checksum}` | `{artifact_id, upload_url, method, headers}` |
| 6 | `POST /runner/jobs/:id/complete` | `{runner_id, status, exit_code, commit_sha, cases[]?, error?}` | `{ok:true}` |

**JobSpec**（claim 的响应体，也是**唯一**出现凭据的地方，边界 11）

```yaml
job_id:         uuid
project_id:     uuid
ci_task_id:     uuid
run_number:     int
repo:
  clone_url:    string
  clone_method: none | https_token | ssh_key
  credential:   string | null        # ★ 只在这里出现；不进快照、不进日志、不进任何 GET
git_ref:        string
sandbox:
  mode:         process | container
  image:        string               # container 档必填
  cpu_limit / memory_limit / disk_limit
  network:      { deny_cidrs: [...] }   # container 档才生效，见边界 15
steps:          string               # 一整段 shell
env:            { KEY: VALUE }       # 含平台注入的 APITRACK_* 三件套
secrets:        [{ key, value }]     # Runner 侧按 value 逐行脱敏
cache:          { paths: [...], key_files: [...] }
report:         { format: none|junit|allure, paths: [...] }
artifact_paths: [...]
case_filter:    { case_keys: [...] } | null
timeout_seconds: int
protocol_version: "1.0"
```

**八条关键约定**

1. **认领是一条服务端 UPDATE，不是队列 pop**（边界 4）：
   ```sql
   WITH picked AS (
     SELECT id FROM pipeline_runs
      WHERE status = 'queued' AND runner_label = ANY($labels)
        AND sandbox_mode = ANY($sandbox_modes)
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
   )
   UPDATE pipeline_runs SET status='claimed', runner_id=$1, claimed_at=now(),
          lease_expires_at = now() + interval '90 seconds'
    WHERE id IN (SELECT id FROM picked) RETURNING *
   ```
   `sandbox_mode = ANY(...)` 这一条是 P2-8 边界 6 的同构物：万一一台不支持容器的 Runner 领到
   了容器档任务，它在 `git clone` **之前**就领不到，而不是跑到一半失败。
2. **长轮询用 `LISTEN/NOTIFY`，不用 `setInterval` 轮 DB**。25 秒窗口（与 SSE 心跳同款，
   避开常见 30 秒代理超时），触发时 `NOTIFY pipeline_queued`，等待中的 claim 立刻醒。轮
   DB 的话「秒级启动」这个指标就取决于轮询间隔，而把间隔压到 1 秒会让 20 台 Runner 变成
   每秒 20 次全表扫。
   **Fastify 侧要注意**：长轮询请求会占住一个连接 25 秒，`keepAliveTimeout` 必须大于它，
   否则平台会在响应前先关掉连接。
3. **`register` 幂等于 `(runner_token_id, name)`**：Runner 重启后用同一个 `runner_id` 回来，
   否则每次重启都在面板上留一行僵尸。
4. **心跳超时 90 秒判 `aborted`**（Spec 2.10.2）。回收器与 `worker.ts` 的 `reapStale` 同款：
   `pg_try_advisory_xact_lock` + 一个独立 key，放在**已有的 scheduler 进程**里而不是新起
   第四个进程——它已经在做「定时扫一遍 DB 并推进状态」这件事，形状完全一样。
5. **`complete` 必须幂等**：终态写入守卫照抄 `run.ts:497` 的形状
   （`WHERE id=$1 AND status IN ('claimed','running','cancelling')`）。Runner 在收到响应前
   断线会重发，第二次撞守卫返回 `{ok:true}` 而不是报错——报错会让 Runner 无限重试。
6. **取消只经心跳下发**（边界 6）。`POST /pipeline-runs/:id/cancel` 把状态推到
   `cancelling`，下一次心跳的响应带 `cancel:true`，Runner kill 进程树后自己 `complete`
   报 `canceled`。**`queued` 状态下的取消是直接终态**——还没有 Runner 持有它，没有人要通知。
7. **协议版本 N 与 N-1 双支持**（REPOSITORY_ARCHITECTURE.md 3.3）。自托管 Runner 的升级
   不由平台控制，这一条是它的直接后果。首版只有 `1.0`，但 `protocol_version` 现在就要在
   register 与 JobSpec 里，且服务端要有一处集中的版本分派点——补协议字段比补版本机制便宜
   得多（P4 边界 19 是同一个教训）。
8. **`APITRACK_*` 三件套由平台注入**：`APITRACK_URL`、`APITRACK_TOKEN`（复用项目的
   `ingest_tokens`，没有就在触发时报错而不是静默跳过）、`APITRACK_CI_RUN_ID = job_id`。
   第三个是 SDK 路径与 Runner 路径能对上的**全部机制**（边界 13）：SDK 拿它当幂等键的一部分
   报上来，平台反查 `pipeline_runs.ingest_run_id`。

**平台侧 REST（server ↔ web，与上表是两组不同的接口，别混）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/v1/projects/:id/ci-tasks` | 列表 / 创建 |
| GET/PUT/DELETE | `/api/v1/projects/:id/ci-tasks/:taskId` | 详情 / 更新 / 删除（`credential` 永不出现在 GET 里）|
| POST | `/api/v1/projects/:id/ci-tasks/:taskId/trigger` | 触发；支持 `Idempotency-Key`；body 可带 `parameters` / `case_filter` |
| PUT | `/api/v1/projects/:id/repository/credential` | 仓库拉取凭据写入（只写不读，与 `ingest_tokens` 的明文只回一次同款纪律）|
| GET | `/api/v1/projects/:id/pipeline-runs` | 分页；可按 `ciTaskId` / `status` / `hasCaseFilter` 筛 |
| GET | `/api/v1/projects/:id/pipeline-runs/:runId` | 详情（含阶段、计数、`runner` 名）|
| GET | `/api/v1/projects/:id/pipeline-runs/:runId/logs` | `?offset=` 增量拉取，历史与实时同一个接口 |
| GET | `/api/v1/projects/:id/pipeline-runs/:runId/cases` | `pipeline_run_cases`（junit/allure 那份）|
| GET | `/api/v1/projects/:id/pipeline-runs/:runId/artifacts` | 列表；下载走 `presignGet` 直链 |
| POST | `/api/v1/projects/:id/pipeline-runs/:runId/cancel` | 推到 `cancelling`，见约定 6 |
| GET/POST | `/api/v1/system/runner-tokens` | 系统管理员；创建时明文只回一次 |
| DELETE | `/api/v1/system/runner-tokens/:tokenId` | 软吊销（`revoked_at`）|
| GET | `/api/v1/system/runners` | Runner 池；含在线判定与 `sandbox_modes` |
| PATCH | `/api/v1/system/runners/:runnerId` | 只允许改 `status` → `draining` |

### 8.3 勾选用例快速执行 (`[已确认]` 范围，与 7.x 上报式用例配合)

> **定位**: 在「仓库用例」树上勾选若干上报用例 → 触发对应 CI 任务，带 `case_filter` 筛选，
> 由仓库代码按 key 只跑选中用例，结果经上报接口回传归位到树节点。**不是**接口模式批量调试
> (EndpointList bulk-bar) 的等价物——平台不拥有测试代码，只传参 + 接收结果 + 对账。

**链路**: 树行勾选 → 「触发 CI 任务」→ 校验(仓库已绑 + 有任务 + 有在线 Worker) → 选任务
(默认推荐「最近成功跑过并上报过这些 case_key 的任务」，其次默认任务) → 触发 run，
JobSpec 携带 `case_filter: { case_keys: [] }` → Runner 注入 env `APITRACK_CASE_KEYS` + CLI 参数
→ 用户脚本只跑选中 → SDK/报告回传 → 树上 `last_result` 刷新，未报的标 `not_run`。

**支持 (平台侧开箱即用)**:
- 勾选→触发链路，`Idempotency-Key` 防重（8.1 的 `idempotency_keys`，scope `ci_task_trigger`）。
  **不加第五个 `trigger_source` 值**（边界 10）：勾选就是人按了按钮，`trigger_source='manual'`
  是事实；「这次是勾选来的」记在 `pipeline_runs.case_filter IS NOT NULL` 上，执行记录页按
  这一条筛。
- 结果归位: run 结束 SDK 经 `/ingest` 回传，`APITRACK_CI_RUN_ID = job_id` 命中幂等键
  `(repo, commit, ci_run_id)`，按 `(project, case_key)` upsert 树节点；参数化用例按
  `case_key` 归并为一条节点。
- 缺失对账: **平台侧算差集**标 `not_run`（边界 16：`case_filter.case_keys` 减去本次
  `ingest_run` 实际报到的集合），区别于失败；部分运行不触发删除对账 (沿用 2.10.1，
  `is_full_inventory=false` 时 `reconciled=false`)。
- 跨任务: 一次勾选可触发多个任务 (各跑全集筛选，脚本自行跳过不认识的 key)。
- 复用 Runner 全套: PipelineRun 状态、心跳、取消、租约回收、实时日志 SSE；触发动作落
  `audit_logs`（`action='ci_task.trigger'`，`detail` 带勾选的 key 数量而不是全量 key 列表）。
- 触发时可顺带填任务 `parameters`。

**依赖用户侧 (平台传参，效果取决于脚本)**:
- 「只跑选中」本身需脚本调用 SDK `apitrack.select(case_keys)` / `--apitrack-case-keys`；无视筛选 = 全量跑，
  平台以 `not_run` 兜底，不误报成功。
- case_key ↔ 可执行单元映射: SDK 装饰器天然带 key；裸 pytest 等需用户适配。
- 前置条件 (依赖/数据/登录态) 用户侧保证；`cache_config` 命中才「快」。
- 结果语义以触发时 HEAD 为准，不追溯旧 commit。
- junit/allure 报告解析路径: case 级结果可落 `PipelineRunCase`，但回写树上 `last_result` 仅 best-effort
  (测试名 ↔ case_key 无稳定映射)；SDK 上报路径才是干净路径。

**明确不支持**:
- 平台直接执行/重放上报用例 (无代码、仅请求摘要)。
- 保证任意脚本「只跑选中」；精细到函数/行的调度 (无行号语义，粒度止步 case_key 集合)。
- 纯外部 CI 上报、无自研 Runner 的仓库: 无法触发，仅提供带筛选参数的触发命令/清单旁路。
- 任意 ref 选择 (默认用任务配置 `ref`)；跨项目勾选。

**落地点 (最小改动)**:
- JobSpec + `POST /ci-tasks/:id/trigger` payload 加 `case_filter`（8.1 的 `pipeline_runs.case_filter`）。
- `RepoTestCase.last_result` 的 `not_run` **已在 CHECK 里**（迁移 035:102，当时就是为这一刻
  留的），不需要新迁移；要改的只有前端 `RepoCaseTree.tsx` 的 `caseStatus()`——它现在把
  `not_run` 折进 `skip`，与 `unknown` 长得一样。
- SDK 加 `select()` / `--apitrack-case-keys` / `APITRACK_CASE_KEYS`（三者现在**一个都没有**）；
  实现是 `pytest_collection_modifyitems` 里按 key 做 deselect——那个钩子现在是只读的，
  要改成会 mutate `items`。
- 任务表 `is_default` + 「最近命中」推荐逻辑（最近一次成功且其 `ingest_run` 报到过这些
  `case_key` 的任务）。
- 体验预期: 常驻 Runner + 缓存命中时秒级~数十秒级，相对「手动去仓库跑」成立，非接口模式
  毫秒~秒级。**这个预期要在 UI 上说出来**，否则用户会拿它跟接口模式的批量调试比。

### 8.4 报告归一与产物（边界 13、14 的落地形状）

**三条路径的分工**（不是三选一，见边界 13）

```
用户脚本跑完
   ├─ A. SDK 上报 ──→ POST /ingest ──→ repo_test_cases.last_result  ← 唯一能回写树的路径
   │     (APITRACK_CI_RUN_ID = job_id 把两边缝起来)
   ├─ B/C. junit.xml / allure-results/*-result.json
   │     └─ Runner 侧解析 ──→ complete 的 cases[] ──→ pipeline_run_cases (guessed_case_key)
   └─ artifact_paths ──→ 申请 pre-signed URL ──→ 直传对象存储 ──→ artifacts
```

- **解析在 Runner 侧**（边界 13）：平台不接收报告文件，只接收 `complete` 里几 KB 的
  `cases[]`。这一条同时挡掉在 API 进程里解析不可信 XML 这一类问题（XXE / 十亿笑声）——
  不解析就不需要防。
- **allure 只解析 `*-result.json`，不跑 `allure generate`、不托管静态站点**。要看 HTML
  报告的人走产物下载。
- **B/C 绝不回写 `repo_test_cases`**。`guessed_case_key` 这个列名是在说这件事：写脏的树
  没有办法回滚，而 junit 的 `classname::name` 与 pytest nodeid 之间没有稳定映射
  （类名、参数化 id、`conftest` 层级都会让它对不上）。

**对象存储抽象 `lib/objectStore.ts`**（从 P10 14.1 提前，只服务 artifacts）

```ts
type PutTarget = { artifactId, uploadUrl, method: "PUT"|"POST", headers, expiresAt };
interface ObjectStore {
  presignPut(key: string, opts: {contentType, sizeBytes}): Promise<PutTarget>;
  presignGet(key: string, opts: {expiresSeconds}): Promise<string>;
  delete(key: string): Promise<void>;
}
```

- 两个驱动：`fs`（本地目录，dev 默认，`presignPut` 退化为一个带一次性 HMAC token 的平台
  上传地址）与 `s3`（MinIO / S3，生产）。
- **硬约束：平台永不代理大文件流**。Runner 直传对象存储，浏览器下载也走 `presignGet` 出来的
  直链。让 API 进程转发一个 200MB 的 allure 报告，等于让一次下载占住一个 Node 进程。
- **`fs` 驱动的一次性 token 必须绑 `artifact_id` + 过期时间**，不能是「知道路径就能传」——
  那等于开了一个匿名上传口。
- 依赖：`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`（按需 `import()`，不进启动
  路径，照 P2-7 边界 8 的形状）。
- **P10 14.1（原 P6 10.1）的另外两件不动**：执行历史归档分区表、大响应体截断进对象存储。
  `executions.response_body` 一个字都不改——那是一次口径变更，要连着归档策略一起想。

### 8.5 沙箱两档（边界 15 的落地形状）

| | 进程档 `process` | 容器档 `container`（默认） |
|---|---|---|
| 实现 | `spawn` + `detached:true`，超时 `kill(-pid)` 杀进程组 | 容器 + 限额 `--cpus/-m/--storage-opt`，超时 stop→kill；通道 `cli`（`docker run --rm`，默认）或 `api`（Engine API over unix socket，P4.5-10b） |
| workspace | Runner 数据目录下一次性子目录，`finally` 删除 | 同款目录 bind-mount 进容器 |
| 缓存 | `cache_paths` 在 Runner 数据目录下按 key 建目录，软链进 workspace | 同款目录挂进容器 |
| 网络策略 | **做不到** | 独立 network + 拒绝 `deny_cidrs`（含平台内网与 `169.254.169.254`）|
| 前置 | 无 | 目标机器有 docker（`cli` 要二进制，`api` 要 socket 权限）；注册时自报进 `sandbox_modes` |

- **进程档在 UI 上不叫「轻量模式」，叫「信任仓库脚本（无隔离）」**。选它是一个信任声明，不是
  一个性能选项（边界 15）。
- **容器档要处理 docker-in-docker 这个坑**：Runner 自己跑在容器里时挂 `/var/run/docker.sock`
  会让「容器隔离」变成假的（兄弟容器共享宿主）。首版**要求 Runner 直接跑在宿主机上**，
  并在 README 里写明；检测到自己在容器里且拿不到独立 docker 时，注册时不上报 `container`。
  **两条通道一视同仁**：`api` 通道能连上 socket 不构成放宽这一条的理由——容器里能摸到
  socket 通常正是因为宿主把它挂进来了。
- **`deny_cidrs` 必须落宿主 iptables，这不是实现偷懒**：docker 只提供「选网段」与
  `--internal`（全断外网）两种粒度，而用户脚本恰恰需要出网（pip install、调被测服务）。
  「能出网但打不到这几个地址」在 docker 的模型里没有对应物。要防的东西很具体：云上
  `curl 169.254.169.254` 无需任何漏洞就能取到宿主绑定的 IAM 角色临时凭据；平台内网段
  不封则脚本能绕过自己那份 Token 直接打平台内部端点。容器隔开了文件系统与进程空间，
  网络可达性是宿主给的——所以规则只能落在宿主上，两条通道都得 `spawn iptables`。
- **超时必须杀整个进程树**（Spec 2.10.2(e)）：`pytest` 起的子进程、脚本里 `&` 起的服务，
  漏一个就永久占着 Runner 的槽位。进程档靠 `detached` + 负 pid 杀进程组；容器档天然全杀。

### 8.6 前端页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/projects/:pid/ci-tasks` | 任务列表 | 顶部 Runner 池实时状态（在线/槽位/空闲/排队 N 个）；每行 `[▶执行][历史][编辑]`。**已实现**（P4.5-11） |
| 任务编辑抽屉（同上路由内） | 任务编辑 | 代码来源只读（继承仓库），只能改 `ref`；沙箱档/镜像/脚本/缓存/env/secret/报告/产物/超时。**已实现**（P4.5-11，偏差①：抽屉而不是 `ci-tasks/:taskId` 路由——配置无子状态、不需要被分享成链接。**2026-09-01 改判：P4.5-15 起改独立编辑页，偏差①撤销，理由与落点见 8.12**） |
| `/projects/:pid/pipeline-runs/:id` | 执行详情 | `?tab=log\|cases\|report\|artifacts`；阶段进度四段 + SSE 实时日志 + 取消。**已实现**（P4.5-13） |
| 系统设置 → Runner tab | Runner 池（系统管理员） | 注册 Token 签发（部署命令一键复制）+ 在线状态 + `draining` 下线。**已实现**（P4.5-11，偏差②：与执行器面板同页相邻 tab 而不是独立路由 `/system/runners`——「挨着放」的最直接形状） |

- **实时日志复用既有 SSE 通道**（`routes/stream.ts` + `lib/events.ts` 的
  `executions:events`），`ExecutionEvent` 联合类型加两个变体（`pipeline` 状态变化、
  `pipelineLog` 增量），**不新建第二条 SSE 路由**。理由：前端 `executionStream.ts` 已经有
  refcount、重连与轮询降级；再开一条就要把那套东西写第二遍。
  **但日志内容不进事件体**——事件只带 `{pipelineRunId, logBytes}`，前端据此 `GET
  …/logs?offset=` 拉增量。这与 `lib/events.ts` 现有的纪律一致（事件不带响应体，客户端按 id
  回查），也避免 Redis pub/sub 里流过几十 MB 日志。
- **Runner 池页在 `/system` 下而不是项目下**：`runner_tokens` 是系统级的（8.1）。它与
  `GlobalApp.tsx` 现有的执行器面板是**两张表两个概念**，页面上要挨着放并写明区别：
  「执行器（平台内部 BullMQ worker）」vs「Runner（自托管，跑仓库代码）」。不写明会被当成
  重复功能报上来。**落地形状是系统设置里的相邻 tab**（P4.5-11 偏差②）。
  另加一条 `GET /api/v1/system/runner-pool`（**任何登录用户可读**，P4.5-11 偏差③）：
  任务列表顶部那一行不能用系统管理员专属的 `/system/runners`，否则非管理员在自己的 CI
  任务页上吃 403。与 `/system/runner-labels` 对 `/system/workers` 的关系同构——只回标签
  与数字，不泄露机器信息。
- **CI 任务在导航上属于「仓库模式」分组**，与「仓库用例」并列（交互文档 1.2 的导航分组）。
  P4.5-11 落地时把仓库用例从「编排与回归」组移进了这个新组。
- **执行记录页**（`ExecutionRecords.tsx`）的 kind 筛选加 `runner`；点进去跳
  `pipeline-runs/:id` 而不是开抽屉（照 `ingest` 现在的形状）。P4.5-11 另补
  「只看勾选来的」复选（`?caseFilter=1`，只在 `kind=runner` 下出现）。

### 8.7 调度与 Webhook 接入
 
**已经预留好的接入点**，本阶段把它们接上（2026-09-01 第二轮验收确认：范围在原「调度与
Webhook」之上**加通知与任务级串行**——用户明确提出「仓库任务也需要支持定时任务以及通知」
「同一任务并发导致测试数据不稳定、要排队不要报错」，套件在 P3-11 已有通知同款能力，CI
任务没有对应物）：

**迁移 042 一份承载本节全部列**（P4.5-12 与 P4.5-15 共用，落地顺序见 8.8 表）：
`schedules.target_type` CHECK 扩展（DO 块先 DROP CONSTRAINT 再 ADD，照迁移 037 的
clone_method 形状）、`webhook_triggers.target_type` CHECK 扩展、
`ci_tasks.notify_config JSONB NOT NULL DEFAULT '{}'::jsonb`（照 033）、
`ci_tasks.single_concurrency BOOLEAN NOT NULL DEFAULT true`；实现时**多一列**
`schedule_runs.pipeline_run_id`（偏差①）。

- `schedules.target_type` 的 CHECK 当前只有 `'suite'`，但迁移 030:32 的注释写明「留列是为了
  P4.5 接 CI 任务」。改成 `CHECK (target_type IN ('suite','ci_task'))`，并接上
  `lib/schedule.ts:151` 那个 `targetType !== "suite"` 的守卫——它就是为这一刻留的分派点。
  **CI 目标不传 `environmentId`**（那是套件触发的概念；CI 的环境由仓库里的脚本自己决定）。
  ~~`variables` 也置 null~~ → **实现时改判（偏差⑧）**：`variables` 当 `parameters` 传给
  `triggerCiTaskRun`。两者的键形约束是同一条（`VARIABLE_NAME_PATTERN`）、语义也是同一句
  「这次触发带什么」，为它在 `schedules` 上加第二列只会让「我该填哪个框」变成新问题；
  界面上这一栏在 CI 目标下改称**触发参数**。调度触发的 `trigger_source='scheduled'`，
  refId/refName 落 schedule 行——`triggerCiTaskRun` 已支持 trigger 载荷，与套件同款。
- `webhook_triggers.target_type` 加 `'ci_task'`（当前 `('flow','suite')`）。HMAC 验证、
  时间窗、nonce 防重放一处不改。
- **`lib/trigger.ts` 加 `triggerCiTaskRun`**，与 `triggerSuiteRun` / `triggerFlowRun` 并列，
  错误照 `failTrigger` 映射。这是 P3 边界 5 定的「单一触发路径」，加第三个目标类型不能绕过它。
- **通知（本轮新增）**：`ci_tasks` 加 `notify_config JSONB NOT NULL DEFAULT '{}'::jsonb`，
  形状照 `test_suites.notify_config`（P3-11 迁移 033：`onSuccess` / `onFailure` /
  `channelIds` / `template{title,body}`），复用 `normalizeSuiteNotify` 归一。投递走
  scheduler 的事件订阅（`scheduler.ts:45` 那条管线）——pipeline 终态事件已经在发
  （`publishEvent kind:'pipeline'`），在那里加 `notifyPipelineResult` 分支，与
  `notifySuiteResult` 并排、各自 catch：complete 与租约回收（abort）两条终态路径自动都
  覆盖，不用各插一次。占位符换成 CI 语境：`taskName` / `runNumber` / `status` /
  `passedCount` / `failedCount` / `skippedCount` / `total` / `duration` / `gitRef` /
  `commitSha` / `trigger` / `finishedAt`。`canceled` 不通知（与套件同款口径：用户动作不是
  执行结果）；`aborted` / `timed_out` **要通知**（归一成失败文案，run 行上的原状态保留）。
- **任务级串行开关**（2026-09-01 第二轮确认；用户理由：同一任务共享的测试数据在多并发
  下导致 case 不稳定）：`ci_tasks.single_concurrency BOOLEAN NOT NULL DEFAULT true`。
  语义是**排队而不是拒绝**——研发的 CI 流水线经 webhook 触发后需要等待结果，触发永远
  202 受理、新 run 照常入 `queued`；串行由 **claim 侧守卫**保证：claim SQL 加
  `NOT EXISTS (同任务更早 run_number 且 status IN ('queued','claimed','running','cancelling'))`
  （走 `pipeline_runs_task_number_idx`），被挡住的排队 run 在前置 run 终态后自动变为可
  认领。**终态顺手唤醒**：`completePipelineRun` 与租约回收（abort）落终态时，若该任务
  开着串行且仍有排队 run，补发 `pg_notify('pipeline_queued', <label>)` 让等待中的长轮询
  立刻醒——「上一个终态时触发下一个」不依赖下一个轮询周期（否则最坏多等 ~25s）。开关
  关闭则回到现状（并发由 Runner 槽位兜底）。手动触发同样不报错、同样排队；run 详情页
  在排队且被串行挡住时显示「等待 #N 终态后开始」。
- 调度与通知的配置入口在**任务编辑页**（8.12 的独立页），照套件详情页的形状：调度列表
  （`GET /schedules?targetType=ci_task&targetId=`，创建时目标固定当前任务）+ 通知开关/渠道/
  模版面板。`schedules` 路由的 `targetType` 校验放开到 `suite|ci_task`，target 校验按类型
  分派查表；`webhook_triggers` 路由同款放开。**P4.5-12 先落在现有的任务抽屉与一个日历抽屉
  里**（P4.5-15 把抽屉改成独立页时这两块随之搬过去，组件不重写）。

**落地形状与八处偏差**（P4.5-12，2026-09-01；逐条理由见 8.8 末尾的实现状态）

- **偏差①**：`schedule_runs` 加一列 `pipeline_run_id`。套件触发即产出一行 `suite_executions`，
  它**入队时**就带 `execution_index_id`（030:74 当场填得上）；`pipeline_runs` 的 index 行只在
  **终态**才写（`lib/pipelineRun.ts`）。不加这一列只有两条差路：让 `triggered` 行的 index id
  长期为空（界面无法回答「昨晚那次定时跑到哪去了」），或者在 complete 的事务里反查
  `schedule_runs` 回填（一次与执行无关的写，且回收路径还要抄一遍）。
- **偏差②**：调度的目标类型进了请求体与列表过滤。`POST /schedules` 的 `target_type` 此前是
  SQL 里硬写的 `'suite'`，现在从 `targetType` 取（**缺省仍是 `'suite'`**，P3 起的调用方都不带
  这个键）；`PUT` 里类型与 id **一起写合并后的值**而不是两个 `COALESCE`——后者能表达出「只换
  了类型、id 还指着旧那张表」这种悬空组合，而那正是校验刚挡掉的东西。
- **偏差③**：`POST /schedules/:id/run` 的响应改成按 `targetType` 判别的联合
  （`{targetType:'suite',suiteExecution}` / `{targetType:'ci_task',pipelineRun}`）。两条路径
  产出两种行、跳转目标也不同（套件报告 / run 详情页），硬塞成一个形状要么丢字段要么让前端
  猜。该路由同时开始接受 `Idempotency-Key`（只在 CI 分支有意义，套件分支忽略）。
- **偏差④**：CI 任务删除补引用扫描（409 + `?force=true`，照 `routes/suites.ts:259`）。8.7 没写
  这件事，但 `target_id` 无外键（030 的多态引用），悬空的调度会每拍记一行 failed。
- **偏差⑤**：`validateNotify` 在 suites / ciTasks 各留一份（不抽公共函数）。理由见 8.8。
- **偏差⑥**：串行的唤醒点有**四处**而不是 8.7 写的「终态顺手唤醒」一处，抽成
  `notifySerializedQueue`：complete、租约回收、`queued` 被直接取消、串行开关被关掉。
- **偏差⑦**：run 详情页多一个 `meta.blockedBy`（读时算出的关系），把「在等 #N」说出来。
- **偏差⑧**：调度的 `variables` 在 CI 目标下当 `parameters` 传（原文写的是置 null），
  界面上改称「触发参数」——同一条键形约束、同一句语义，见上面第一条。

**三个刻意的缺省**（两条接入路径都不带的东西，理由写在代码注释里）

1. **调度与 Webhook 都不发 `Idempotency-Key`**。调度侧的键形状会是 `(scheduleId, plannedAt)`，
   但「一个到期时刻只有一个实例能触发」已由 `next_run_at` 的行级认领保证（6.0），再加一层
   只是把同一个不变量说第二遍；更糟的是 `IdempotentReplayError` **不被 `failTrigger` 认作
   失败**，落到调度的 catch 里会被记成一次 `failed` 触发——一条本该读作「已跑」的证据。
   Webhook 侧同理：唯一可用的键来源是 nonce，而 nonce 已经在准入阶段挡掉重放了。
2. **Webhook 的 CI 分支不注入请求体**。请求体注入是流程独占（边界 7）。CI 任务确实有
   `parameters` 这个同形的袋子，但把外部 POST 的顶层标量灌进 Runner 的环境变量是另一件
   事——任务级 secret 已删（8.11 的 B 类），Runner 侧没有脱敏词表，那些值会原样进日志。
3. **CI 目标不带环境覆盖**。仓库里的脚本自己决定打哪个环境；`environment_id` 在这条路径上
   无意义，所以前端在 CI 目标下**不显示**那个选择器（留一个不起作用的下拉是在撒谎），服务端
   也不拿它做任何事。

**前端不做的两件事**：不恢复独立调度页（P3-11 删它的理由不变：配置入口属于它的目标），因此
交互 3.7 那张带「目标类型」列的调度列表与「两步选资源」的创建弹窗仍然不做——从资源里进来的
人已经回答了那一步。**不新建 Webhook 管理页**：`api.webhookTriggers` 至今零调用方，本批只把
`ci_task` 目标接进服务端能力。

### 8.8 分批交付（后端先行；P4.5-4 完成后即可手工起一个 Runner 验证协议闭环）

| 批次 | 内容 | 预估 |
|---|---|---|
| P4.5-1 | 迁移 036/037；`runner_tokens` 签发与吊销（复用 `ingestAuth.ts` 的 scrypt + 前缀索引形状）；`lib/runnerAuth.ts`；`POST /runner/register` + 子集校验 | ~3 天 **已实现** |
| P4.5-2 | 迁移 038；`ci_tasks` CRUD（`routes/ciTasks.ts`）；仓库凭据加密读写（`lib/crypto.ts`）；`lib/trigger.ts` 加 `triggerCiTaskRun` + 无在线 Runner 拒绝（`2004`）+ `sandbox_mode` 可满足性检查 | ~4 天 **已实现** |
| P4.5-3 | `POST /runner/claim` 长轮询（`SKIP LOCKED` + `LISTEN/NOTIFY`）；JobSpec 组装（凭据只在此出现）；`heartbeat` 租约续约 + cancel 下发；scheduler 里的租约回收器（advisory lock） | ~4 天 **已实现** |
| P4.5-4 | `logs` / `complete`；`pipeline_runs` 状态机与终态守卫；`execution_index` 归一（`kind='runner'`）；SSE 两个新事件变体 | ~3 天 **已实现** |
| P4.5-5 | **新仓 `apitest-runner`**：register/claim/heartbeat/logs/complete 客户端 + 进程档执行 + git clone（三种 `clone_method`）+ 日志按 offset 推送 + 退出码落盘补报 + secret 逐行脱敏 | ~5 天 **已实现** |
| P4.5-6 | Runner 侧报告解析（junit XML + allure `*-result.json`）→ `complete` 的 `cases[]` → `pipeline_run_cases` | ~2 天 **已实现** |
| P4.5-7 | 迁移 039 的 `artifacts` + `lib/objectStore.ts`（`fs` + `s3` 两驱动）+ `POST /runner/jobs/:id/artifacts` + Runner 侧直传 + 下载直链 | ~3 天 **已实现** |
| P4.5-8 | 迁移 039 的 `idempotency_keys` + `audit_logs` + `lib/idempotency.ts` / `lib/audit.ts`；接到 CI 触发与 Runner Token 签发两处 | ~2 天 **已实现** |
| P4.5-9 | **勾选执行（§8.3）**：树上勾选 + bulk-bar（照 `EndpointList.tsx` 的形状）+ 任务选择弹窗 + `case_filter` 贯通 + 平台侧 `not_run` 差集；SDK 加 `select()` / `--apitrack-case-keys` / `APITRACK_CASE_KEYS` 并发 PyPI patch 版本 | ~4 天 **已实现** |
| P4.5-10 | **容器档**：Runner 侧 `docker run` + 资源限额 + 出站白名单 + 缓存卷挂载；`sandbox_modes` 自报；docker-in-docker 检测 | ~4 天 **已实现** |
| P4.5-10b | **容器档 socket 通道**（2026-09-01 增补）：抽 `ContainerRuntime` 契约 + 结构化 `ContainerSpec`；`cli`（默认）与 `api`（Engine API over unix socket，含手写 attach 分帧）两实现；OOM 归因（`.State.OOMKilled`）；`APITRACK_RUNNER_DOCKER_TRANSPORT` | ~1.5 天 **已实现** |
| P4.5-11 | 前端四个页面（8.6）+ i18n（zh/en 扁平键）+ 执行记录页 kind 筛选加 `runner` + 趋势页开关语义扩成「含仓库执行」 | ~5 天 **已实现** |
| P4.5-12 | 调度与 Webhook 接 CI 任务（8.7）；**+ 任务终态通知**（2026-09-01 范围扩项：`ci_tasks.notify_config` + scheduler 事件订阅侧 `notifyPipelineResult`）；**+ 任务级串行开关**（`single_concurrency` 默认开，claim 守卫 + 终态 NOTIFY 唤醒，8.7）；`start.sh` 注释给出起 Runner 的命令（**不自动拉起**，那台机器通常不在本地，照 P2-8.6 的形状） | ~4 天 **已实现** |
| P4.5-15 | **任务编辑页与执行历史交互改版**（2026-09-01 第二轮验收反馈，范围与边界见 8.12）：编辑抽屉 → 独立编辑页（env 分区上移、高级项折叠、调度与通知面板随 P4.5-12 落进该页）；`GET /pipeline-runs?ciTaskId=` 列表接口 + 任务列表行内展开执行历史、直达 run 详情；run 详情页整份日志下载 | ~3 天 **已实现** |
| P4.5-13 | **报告视图自渲染**（边界 19，2026-09-01 改判增补）：迁移 040（`pipeline_run_cases` 加时间戳/host/thread）；`ReportCase` 协议加 4 可选字段 + allure 解析器取这些字段；Runner 自动打包 allure-results 为 `kind='report'` 产物直传（**零依赖手写 zip 写入器**，不引 archiver）；平台读路由（详情 / 日志 / cases / 附件下载）+ run 详情页（阶段进度 + 实时日志 + timeline gantt + suite 树 + case 详情，P4.5-11 的执行详情页一起落） | ~5 天 **已实现**（执行详情页之外的三个前端页仍属 P4.5-11） |
| P4.5-14 | **配置面收窄**（2026-09-01 验收反馈改判，范围见 8.11）：迁移 041；Git 来源移到任务、凭据改项目级命名池、删任务 secret / 报告格式 / 产物路径 / 默认任务；报告路径从命令行解析；仓库模式合并成一个五 tab 页 | ~3 天 **已实现** |

> 合计约 44 人日（含 P4.5-14）。压回 4 周的砍法与顺序见边界 18；**P4.5-9 不可砍**。

**实现状态**

- **P4.5-1 已实现**（2026-08-31）。落地内容与三处与本节文字的偏差，记下而不是悄悄改掉：
  - 迁移 `036_p45_runners.sql`（`runner_tokens` / `runners`）、`037_p45_ci_tasks.sql`
    （`ci_tasks` + `repositories` 的 `clone_method` / `clone_url` / `credential_encrypted` /
    `credential_updated_at`）。037 的 `clone_method` CHECK 单独用 DO 块加：
    `ADD COLUMN IF NOT EXISTS` 不带 CHECK 时无法表达「列已存在但约束还没加」这个中间状态。
  - `lib/runnerAuth.ts`：`apirunner_` 前缀 + scrypt `salt:digest` + 前缀部分索引，形状照抄
    `ingestAuth.ts`；多出的一层是**协议版本受理点**（`isSupportedProtocolVersion`），
    集中一处而不是四个接口各判一次。
  - `routes/runners.ts`：`POST /runner/register`（幂等于 `(runner_token_id, name)`，走
    迁移 036 的唯一索引 + `ON CONFLICT`）+ 标签子集校验（403）+ `sandbox_modes` 白名单 +
    协议版本拒绝（400）；`GET/POST /api/v1/system/runner-tokens`、
    `DELETE …/:tokenId`（软吊销）、`GET /api/v1/system/runners`、
    `PATCH …/:runnerId`（只允许 `online` ↔ `draining`）。
  - **偏差①**：`RUNNER_OFFLINE_AFTER_SECONDS = 90` 与 `WORKER_OFFLINE_AFTER_SECONDS = 30`
    刻意是两个常量。Runner 心跳跨公网走 HTTP 且掉线要判 `aborted`，把网络抖动读成
    「机器没了」的代价比 BullMQ worker 高得多。
  - **偏差②**：重注册把 `status` 拉回 `online`。保留 `draining` 会让一台被 drain 过的机器
    在重装升级后永远领不到任务，且面板上看不出原因。
  - **偏差③**：`register` 同时接受 camelCase 与 snake_case 字段名。协议是公开的且 JobSpec
    用 snake_case（8.2），一个只读过协议文档的第三方实现自然会用后者。
  - `mapRunnerToken` / `mapRunner` / `mapCiTask` 三个 mapper 一并落位（`ci_tasks` 的 CRUD
    是 P4.5-2，但列名 → camelCase 的边界只允许存在 `types.ts` 一份）。
  - 未做（属后续批次）：`claim` / `heartbeat` / `logs` / `complete`、`ci_tasks` CRUD 与触发、
    仓库凭据的写入路由、Runner 池前端页面。

- **P4.5-2 已实现**（2026-08-31）。落地内容与四处与本节文字的偏差，记下而不是悄悄改掉：
  - 迁移 `038_p45_pipeline_runs.sql`：`pipeline_runs`（含 claimable / lease 两个部分索引与
    任务内序号唯一索引）、`pipeline_run_logs`（`UNIQUE (run, byte_offset)` 续传去重）、
    `pipeline_run_cases`（`source` 只有 junit/allure，无 `sdk`）；`execution_index.kind`
    加 `'runner'` 照抄 035 的「按定义找约束」DO 块。写入方是 P4.5-4，本批只放宽 CHECK。
  - `routes/ciTasks.ts`：列表（分页 + 逐行解密出 `secretKeys`）/ 创建 / 详情 / 更新 / 删除
    / 触发（202）。secrets 是 patch（null 删、字符串写、缺省不动，与 environments 同款）；
    `is_default` 换默认 = 事务内先摘旧再戴新，并发双设撞部分唯一索引回 409/2003；
    `repositoryId` 创建后不可改（换仓库 = 新建任务）；`env`/`secrets` 键拒绝 `APITRACK_`
    前缀（三件套由平台注入）；缓存/报告/产物路径挡绝对路径与 `..`。
  - `routes/repositories.ts` 加 `PUT …/repository/credential`（只写不读）：`clone_method`
    三值、`ssh_key` 明文必须是含 `PRIVATE KEY` 的 PEM（挡「token 粘错框」）、切回 `none`
    即清凭据；`credential_updated_at` 只在凭据实际发生变化时刷新（只改 URL 不算换凭据）。
  - `lib/trigger.ts`：`NoCiRunnerError`（`failNoRunner` 形状复用，503 + 2004 + `data.label`）
    + `triggerCiTaskRun`。Runner 可用性与沙箱可满足性一次查询出两个计数（判据与 Runner
    池面板同一份：心跳新鲜度 90 秒 + 排除 draining；**只读 `runners`，不读 `workers`**，
    同标签下两类执行者互不相领）。排队行在事务内写入：锁任务行 + `MAX(run_number)+1`
    （`suiteReportName` 同款串行化）+ `pg_notify('pipeline_queued', label)` 随 commit 投递
    （监听者是 P4.5-3 的长轮询，现在没有也无害）。
  - **偏差①**：`lib/crypto.ts` 本批零改动——P4.5-1 时它已就位（数据源凭据在用），批次表
    写的「仓库凭据加密读写」实际落在 PUT 路由的写入与 `mapRepository.hasCredential` 的
    读出（明文永不回）。
  - **偏差②**：`triggerCiTaskRun` 顺带做了三条前置检查——存量任务 container 档缺 image、
    仓库没配 `clone_url`、`sdk_ingest_enabled` 开着但项目没有未吊销的 ingest token。
    依据是 8.2 约定 8「没有就在触发时报错而不是静默跳过」与验收门槛 4「触发时说清缺什么」；
    JobSpec 组装在 P4.5-3，那时再报就是一条 failed 的 run。
  - **偏差③**：`caseFilter` 的校验先行落在本批（P4.5-9 才贯通树侧）：key 去重、上限 500、
    **不校验树上存在性**——跨任务勾选明确支持（§8.3），脚本不认识的 key 由 `not_run`
    差集兜底（边界 16），触发时拦截会误伤。
  - **偏差④**：`Idempotency-Key` 是 P4.5-8 的通用设施，接入前触发双击会产出两条 run——
    这一点写进了触发路由的注释，不装作它已经防重。
  - 未做（属后续批次）：`claim` / `heartbeat` / `logs` / `complete` 与状态机推进
    （P4.5-3/4）、`execution_index` 归一写入（P4.5-4）、`pipeline-runs` 平台侧读路由与
    前端页面（P4.5-11 之前按需落）。

- **P4.5-3 已实现**（2026-08-31）。落地内容与三处与本节文字的偏差，记下而不是悄悄改掉：
  - `lib/pipelineNotify.ts`（新）：**一个进程一条** `LISTEN pipeline_queued` 连接 + 等待者
    按标签唤醒（NOTIFY 载荷是入队行的标签，`default` 入队不惊醒 `prod-dmz` 的轮询）——
    每个等待中的 claim 各占一条连接会把 Postgres 连接预算吃穿。监听挂掉时等待者最多
    睡满自己的 25 秒超时（监听是延迟优化不是正确性依赖）。
  - `POST /runner/claim`：立刻试一次认领 → 没有则在 NOTIFY 上等到 25 秒窗口耗尽回
    `204`。认领是 `FOR UPDATE SKIP LOCKED` 的 UPDATE（8.2 约定 1 的 SQL 原样），
    `sandbox_mode = ANY($modes)` 前置过滤；`capacity_available ≤ 0` 直接 204 不占连接；
    `draining` 403 退场（不是 204 空转）；组装失败把行放回 `queued` 再回 500，不留一条
    已认领却无人心跳的 run 等回收。`keepAliveTimeout` 加了防御下限（> 25s + 余量）。
  - `lib/jobSpec.ts`（新）：JobSpec 组装，凭据（仓库拉取凭据 + 任务 secrets 明文 +
    按 run 现签的 ingest token 明文）**全平台只在这里出现**。键名 snake_case（冻结协议
    8.2 是第三方实现者照抄的文档）；沙箱限额是平台级默认 + env 覆盖
    （`RUNNER_CPU/MEMORY/DISK_LIMIT`、`RUNNER_DENY_CIDRS`，迁移 037 没建那几列——限额
    属于「机器愿意给多少」不属于任务）；`APITRACK_URL` 取 `PUBLIC_BASE_URL` 或 Runner
    实际拨号的请求来源（SDK 对根地址 / 完整 `/ingest` 两种写法都归一）。
  - `POST /runner/jobs/:id/heartbeat`：续租（`now()+90s`，与离线阈值同一个数）+ 阶段
    推进（照迁移 038 的枚举校验）+ `log_bytes` 单调推进（GREATEST）+ `cancel:true`
    下发。终态 / 非本 Runner 持有一律 409——Runner 读作「job 不再是我的」。
  - `routes/pipelineRuns.ts`（新）：`POST …/pipeline-runs/:runId/cancel`。`queued` 直接
    终态 `canceled`；在途推 `cancelling` 等下一次心跳下发（约定 6 的两半都在了）。
  - `scheduler.ts`：租约回收器（15 秒一拍，advisory lock `8_013_401` 与 worker 的
    `8_013_301` 分键）——`lease_expires_at` 过期的在途 run 判 `aborted`（不是 `failed`，
    验收门槛 5），`cancelling` 过期同样判 `aborted`；最坏检测延迟 = 剩余租约 + 15 秒。
    进程职责从「三件事」变「四件事」。
  - **偏差①**：`APITRACK_TOKEN` 改为 **claim 时按 run 现签一张** ingest token（名字带
    任务与序号、可吊销；明文只进 JobSpec）。约定 8 写的「复用项目的 ingest_tokens，
    没有就在触发时报错」没有可实现形状——库里只存 scrypt 哈希，明文取不回来。P4.5-2
    据约定 8 做的触发前置检查随之撤销（代码里留了指向说明）。终态后由 `complete`
    （P4.5-4）顺手吊销，防行数无界增长。
  - **偏差②**：claim（JobSpec）与 heartbeat 的**响应**按 8.2 冻结协议输出 snake_case
    （`lease_expires_at`）；register 的 camelCase 是 P4.5-1 的已记录偏差，新协议接口跟
    协议文档走而不是跟着偏差走。请求侧两种拼法都收（与 register 同款）。
  - **偏差③**：`cancel` 平台侧路由提前到本批（8.2 REST 表里它混在 pipeline-runs 读路由
    一组，那些属 P4.5-4/11）——「取消只经心跳下发」需要有人把状态推到 `cancelling`，
    没有这个路由整条链路无法验收。
  - 触发参数 `parameters` 经 env 下发（合并顺序：任务 env ← 触发参数 ← 平台三件套，
    三件套最后压栈防同名覆盖）。
  - 未做（属后续批次）：`logs` / `complete` / 状态机与终态守卫 / `execution_index`
    归一 / SSE 事件（P4.5-4）、Runner 客户端与进程档执行（P4.5-5）、报告解析（P4.5-6）。

- **P4.5-4 已实现**（2026-08-31）。落地内容与三处与本节文字的偏差，记下而不是悄悄改掉：
  - `lib/pipelineRun.ts`（新）：日志接收（`appendPipelineRunLogs`）与终态落库
    （`completePipelineRun`）收在一个模块——claim / heartbeat 是「活着」的那半
    （P4.5-3，路由内联），这两个是「收尾」的那半。
  - `POST /runner/jobs/:id/logs`：断线重传靠 `UNIQUE (run, byte_offset)` +
    `ON CONFLICT DO NOTHING` 幂等收（边界 7）；`next_offset` 回**当前总长**
    （`log_bytes`，重算而不是「当前 + chunk 长」——DO NOTHING 的重传分支里两者会
    分叉）；offset 倒回/跳空 409（倒回会静默丢、跳空会造出永久缺口）；**终态后仍收**
    （Runner 杀进程树后残余输出还会流一小会儿，拒了只会丢尾部日志）；
    `byte_offset=0` 的第一段日志把 `claimed` 推进到 `running`（收到输出才是「真的
    在跑了」的硬证据，stage 可以停在 clone 而日志从 clone 就开始流）。
  - `POST /runner/jobs/:id/complete`：终态守卫照抄 `run.ts:497` 的形状
    （`WHERE id AND runner_id AND status IN ('claimed','running','cancelling')`），
    **`canceled` 额外要求当前是 `cancelling`**（取消只经心跳下发，约定 6——Runner
    没收到取消信号却自报 canceled 等于把失败静默抹成取消）；撞守卫的重发按「行还在且
    归这台 Runner」判幂等 ok（约定 5，报错会让 Runner 无限重试）。同一事务里做四件事：
    终态 UPDATE、`execution_index` 归一写入（kind='runner'，`UNIQUE (kind, detail_id)`
    双保险）、`cases[]` 批插 `pipeline_run_cases`（source 只有 junit/allure，行数上限
    20000）、吊销 claim 时现签的那张 ingest token。
  - **`execution_index` 归一**：`target_name` = 「任务名 #序号」（任务删除级联掉 run，
    索引行靠无 FK 快照活下来）；`started_at` 用 `claimed_at`（入队时刻是排队等待，
    认领才是开始执行）；`trigger_*` 三列从 run 行照抄。**偏差①**：`aborted` / `timed_out`
    在 execution_index 侧归一成 `failed`（015 的 CHECK 只有五个值），run 行保留原状态——
    改 CHECK 是一次口径变更，且 `aborted` 在 flow/suite 语境里不存在。
  - **SSE 两个新事件变体**（`lib/events.ts` + `stream.ts` 既有通道，不新建路由）：
    `pipeline`（状态变化：claim 发 `claimed`、首段日志发 `running`、cancel 发
    `cancelling`/`canceled`、complete 发终态、回收器发 `aborted`）与 `pipelineLog`
    （日志水位，**内容不进事件体**——前端按 `logBytes` 走 `GET …/logs?offset=` 拉增量，
    与「事件不带响应体」同一条纪律）。`executionStream.ts` 前端只关心 `execution`
    事件，新变体自然穿透不炸；`api.ts` 的 `ExecutionEvent` 类型补齐两个变体。
  - 租约回收器升级（`scheduler.ts`）：`aborted` 判定走 `abortPipelineRunAfterLease`
    （与 complete 同一份归一口径）——被回收的 run 永远等不到 `complete`，索引行必须
    在这里补，否则「执行记录页按 runner 筛」少了最需要被看见的那一类（机器没了）。
    终态事件在 **commit 之后**发（事务回滚时不该存在「已 aborted」的界面状态）。
  - `execution_index` 的 cancel 分派补 `runner` kind：推 `cancelling` 或（queued 时）
    直接终态，与 pipeline-runs 的 cancel 路由同一份 UPDATE——detail_id 就是 run id，
    复制语义而不是 302。
  - 前端（本批只动类型与清单）：`ExecutionRecords.tsx` 的 kind 筛选加 `runner`
    （验收门槛 15 的「能筛出来」）+ 行内 chip；**偏差②**：点行跳 `pipeline-runs/:id`
    推迟到 P4.5-11（那页还不存在，跳过去会落进 404 兜底路由）——落地前 runner 行
    不可点，深链指到 runner 行时摘掉 `?parent=` 参数。i18n 补
    `reports.kindRunner`（zh「CI 执行」/ en「CI run」）。
  - **偏差③**：`complete` 的 `ingest_run_id` 缝合用 `(project, ci_run_id = run id)`
    反查 `ingest_runs`（8.2 约定 8：SDK 拿 `APITRACK_CI_RUN_ID = job_id` 当幂等键的
    一部分报上来）——查到回填，查不到（没开 SDK 上报 / 脚本没跑 SDK）留空。
    ingest token 的吊销条件是「本项目无任何在途 run」而不是「只吊销这一张」：token
    行没有指向 run 的列，按 run 精确吊销要加列，不值得——按 run 一签的隔离靠
    「每张 token 只活一个 run 的生命周期」近似成立。
  - 未做（属后续批次）：Runner 客户端与进程档执行（P4.5-5）、报告解析在 Runner 侧
    产出 `cases[]`（P4.5-6；本批已能收能存）、`pipeline-runs` 读路由与前端四个页面
    （P4.5-11）、`logs` 的平台侧读接口 `GET …/pipeline-runs/:runId/logs?offset=`
    （P4.5-11，SSE 水位事件的消费方）。

- **P4.5-5 已实现**（2026-08-31）。**第四个仓库 `apitest-runner`**（Node.js ≥ 20、零
  运行时依赖——HTTP 用内置 fetch、进程控制用 `node:child_process`）落地，与本节文字
  的偏差记下而不是悄悄改掉：
  - 结构照 REPOSITORY_ARCHITECTURE 2.4 的形状裁剪到本批范围：`client.ts`（五接口
    客户端 + ApiError 的 transient/语义拒绝二分）、`registry.ts`（注册重试，400/401
    致命退出——协议版本被拒与 Token 被吊销重试无意义）、`claimer.ts`（长轮询循环 +
    容量槽位通知，403=draining 退场）、`executor.ts`（单 job 编排）+
    `executor/{process,git,cache,workspace,errors}.ts`、`streamer.ts`、`masker.ts`、
    `state.ts`（job 目录的 state.json + exit_code 文件，tmp+rename 原子写）、
    `recover.ts`（启动补报）。`uploader.ts` / `proxy/` 属 P4.5-7 与「明确不做」，
    未建。
  - **进程档**：`spawn` + `detached` + 负 pid 杀进程组（TERM → 5s → KILL 的梯子），
    超时杀树、取消杀树、停机超宽限杀树；`timeout_seconds` 覆盖**整个 job**（clone
    吃掉的时间算在内——挂死的 fetch 与挂死的 pytest 对槽位的占用没有区别）。
  - **git 三种 clone_method**：`none` 直拉；`ssh_key` 走 0600 临时 key +
    `GIT_SSH_COMMAND` + `accept-new` 一次性 known_hosts，finally 删；`https_token`
    走 GIT_ASKPASS（见偏差②）。不 `git clone` 而是 init + fetch + checkout：
    `clone --branch` 不接受 commit sha。
  - **日志流**：行缓冲（行是脱敏的原子单位——secret 跨 chunk 会漏）→ 逐行脱敏 →
    ≤256KB 按**码点**边界切块（byte_offset 是字节，但 chunk 是 TEXT 列，切在多字节
    字符中间那半截进不了 Postgres）→ offset 幂等发送，409/403/404 读作「服务端不再
    收」静默放弃。
  - **退出码落盘补报**：`state.json`（阶段/commit/日志水位/终态）+ `exit_code` 文件
    （子进程自然退出才写），启动时 `recoverJobs` 按「final_status 落盘 > exit_code
    推导 > aborted」三档补报后才开始 claim；complete 重试窗口（默认 5 分钟）耗尽则
    保留 state 等下次启动，workspace 立即删。
  - **secret 逐行脱敏**：任务 secrets 值 + 仓库凭据（https 的 token / ssh PEM body
    行）全进掩码面；<4 字符的值不替换（误伤大于风险）；complete 的 error 摘要也过
    掩码。
  - **偏差①**：`APITRACK_CASE_KEYS` 注入提前落在本批（§8.3 链路里「Runner 注入 env」
    这半边本来就只能在这里做）：`case_filter.case_keys` 逗号分隔注入脚本环境，
    P4.5-9 的 SDK 消费侧与这个形态对齐。
  - **偏差②**：https 凭据经 **GIT_ASKPASS** 注入，而不是嵌进 fetch URL——嵌 URL 会
    同时落进 `ps` 的 argv 与 `.git/config`（后者随 workspace 存活到任务结束），
    都在边界 11「key 只出现在 claim 响应体里」的缓解③射程内。凭据含 `:` 读作
    `user:password`（GitLab `oauth2:<token>`），否则整个当用户名（GitHub PAT）。
  - **偏差③**：缓存一并落地（8.5 进程档表里「缓存」行的一半，批次表没单列）：
    `cache_paths` 软链进 workspace（脚本写入即回写缓存），key = `key_files` 内容
    hash 挂 `ci_task_id` 名下；**key_files 为空时禁用缓存**而不是用常量 key——
    没有失效依据的缓存是永不失效的脏缓存。
  - **偏差④**：git 子命令接了 job 预算与取消检查（批次表的「进程档执行」拆开看
    包含它）：clone 各步骤之间检查 cancel/lostLease（fetch 是长命令，init 与它之间
    有空窗）；每条 git 命令带剩余预算的 timeoutMs。
  - **偏差⑤**：优雅停机两段式（SIGTERM → 停止领取 → 宽限内等在途 → 超宽限杀树按
    `aborted` 补报）；draining 时**不等宽限**直接等在途跑完（每个 spawn 都有超时，
    等待天然有界）——「在跑的任务跑完」是 draining 的语义本身。
  - 配置前缀 `APITRACK_RUNNER_*`（与注入用户脚本的 SDK 三件套 `APITRACK_*` 隔开两个
    命名空间）；sandbox 自报只有 `process`（P4.5-10 加 docker 探测）；claim 收到
    容器档 JobSpec 的防御分派直接 failed 并说明（claim 的 WHERE 挡在前面）。
  - **验收前增补（用户 2026-08-31 要求）**：本仓自带 `start.sh`（start / fg / stop /
    restart / status）——`.env` 只补缺不覆盖已导出变量、必填项前置校验、优先 dist
    退回 tsx、`stop` 按「收尾宽限 + 90s」等 SIGTERM 后再强杀（对齐 Runner 自身的
    优雅停机）、可选 `APITRACK_RUNNER_CA_BUNDLE` 注入 `NODE_EXTRA_CA_CERTS`
    （自签证书反代场景）；配套 `.env.example`。根 `start.sh` 的启动注释仍属 P4.5-12。
  - 未做（属后续批次）：报告解析 `cases[]`（P4.5-6）、产物上传（P4.5-7）、容器档与
    docker-in-docker 探测（P4.5-10）、`start.sh` 起 Runner 的注释（P4.5-12——现在
    手工起：`cd apitest-runner && ./start.sh`，或 `cp .env.example .env` 后直接
    `./start.sh`）。

- **P4.5-6 已实现**（2026-08-31）。Runner 侧报告解析（junit XML + allure
  `*-result.json`）→ `complete` 的 `cases[]` → `pipeline_run_cases`（服务端收口
  P4.5-4 已落，本批补齐生产侧），与本节文字的偏差记下而不是悄悄改掉：
  - `apitest-runner/src/report/` 五件：`xml.ts`（**手写**事件式 XML 扫描器——零
    运行时依赖是本仓的刻意约束，为报告解析破例不值；拒绝 DTD，XXE / 十亿笑声在
    Runner 侧挡掉，平台侧不解析 XML 是第一道；结束标签错位即抛错，半截文件不产
    假数据）、`glob.ts`（`*` / `?` / `**` 三种通配；字面路径直判 existsSync
    跟随软链，glob 逐段 readdir 不跟目录软链防环）、`limits.ts`（护栏数值逐一
    对着服务端 `completePipelineRun` 的收口：20000 行 / 512 名字 / int4
    duration）、`junit.ts` + `allure.ts`（映射器）、`parse.ts`（编排：路径展开 →
    逐文件解析 → message 脱敏 → 行数与载荷截断）。
  - `executor.ts`：report 阶段接入——只有脚本**自然退出**才解析（被取消 / 超时 /
    停机杀掉的会话写不出完整报告，pytest 在会话收尾才落 junit.xml）；脚本失败
    （退出码非 0）照样解析，失败恰恰是报告最有价值的时候；`collectReportCases`
    全程不抛，解析绝不改变 job 终态（best-effort 纪律）。
  - `state.json` 带 cases 落盘、`recover.ts` 补报带上：complete 重试窗口耗尽后
    重启补报的 run 不缺 case 计数——workspace 已删，无处重解析，落盘是唯一来源。
  - **偏差①**：服务端 `complete` 路由补了**路由级 bodyLimit**
    （`RUNNER_COMPLETE_MAX_BODY_BYTES`，默认 8MB，`.env.example` 已记）。P4.5-4
    落的「能收能存」在 Fastify 默认 1MB bodyLimit 下只兑现一半——
    MAX_REPORT_CASES=20000 行的真实报告轻松超 1MB，而 413 会被 Runner 的重试
    逻辑读成「已送达」。与 `/ingest` 的 `INGEST_MAX_BODY_BYTES` 同一条纪律。
  - **偏差②**：Runner 侧 cases 载荷预算 6MB、message 截 2000 字符（服务端收
    8000）——预算先于发送，触顶截断并记 job 日志；另配 413 降级（丢 cases 重发
    一次、终态优先），防部署侧把 bodyLimit 调低后 run 永远等不到终态。
  - **偏差③**：allure 的 `broken` / `unknown` 都归 `error`——不是 skipped：跳过是
    显式决定，中断是意外，两者的整改动作不同。suite 归属取 labels 的 `suite`
    标签、缺省退 `parentSuite`，不拼 allure 报告页的展示路径。
  - **偏差④**：报告解析的 message 过 Runner 侧 secret 脱敏再上报（与日志同一条
    纪律——失败摘要里可能带 echo 出来的凭据）；case 名 / suite 名 /
    guessed_case_key 是幂等去重键的一部分，不脱敏。
  - 未做（属后续批次）：产物上传（P4.5-7）、`pipeline-runs` 读路由与前端页面
    （P4.5-11——`GET …/pipeline-runs/:runId/cases` 还不存在，本批落进
    `pipeline_run_cases` 的数据暂时只能查库看）。

- **P4.5-7 已实现**（2026-08-31）。迁移 039 的 `artifacts` + `lib/objectStore.ts`
  （`fs` + `s3` 两驱动）+ `POST /runner/jobs/:id/artifacts` + Runner 侧直传 +
  下载直链，与本节文字的偏差记下而不是悄悄改掉：
  - 迁移文件名是 `039_p45_artifacts.sql` 而**不是** 8.1 写的 `039_p45_infra.sql`：
    8.1 把 artifacts / idempotency_keys / audit_logs 排进一个 039，但 P4.5-8 还没
    落地——迁移是 forward-only 的，现在把 039 整个建掉、幂等与审计就没有自己的文件
    可写。本批只建 `artifacts`（含 `artifacts_owner_idx` 部分索引），其余两张表
    留给 P4.5-8 的 `039b`。表结构逐字照抄 8.1。
  - `lib/objectStore.ts`：`fs` 驱动（一次性 HMAC token 绑 `artifact_id` + 30 分钟
    过期，上传 / 下载同一把密钥、独立于 `DATA_SOURCE_ENCRYPTION_KEY`，缺省派生自
    `JWT_SECRET`）与 `s3` 驱动（`@aws-sdk/client-s3` + `s3-request-presigner`
    **按需 `import()`**、不进启动路径，照 P2-7 边界 8 的形状；两个包已按 11.1 装进
    dependencies）。`presignPut` / `presignGet` 的形状照 8.4 的接口定义。
  - `routes/runners.ts` 加三条：申请（`POST /runner/jobs/:id/artifacts`，终态后仍
    收——Runner 的收尾顺序是「complete 先、产物后」，卡死在终态会丢最有价值的失败
    报告，与 logs 终态后仍收同一条纪律）；fs 直传落盘
    （`PUT /runner/artifacts/:id/upload`，`application/octet-stream` 专用 content-type
    parser、`TransformStreamCounter` 按**声明大小**断流、sha256 边收边算、超限删
    半截文件）；fs 下载直链（`GET /runner/artifacts/*/download`，通配路由——
    storage_key 形如 `<run_id>/<artifact_id>` 带斜杠，签名绑完整 key）。
  - Runner 侧 `src/uploader.ts`：artifact_paths 展开（复用 `report/glob.ts` 的
    glob 语义，字面目录递归到文件级，深度 8 / 64 文件 / 4GB 总量三道护栏）→
    逐文件申请 + 直传 + sha256。`client.ts` 加 `requestArtifactUpload` /
    `uploadArtifact`（直传**不带** `apirunner_` 头——presigned URL / 一次性 token
    本身就是凭据）。
  - **偏差①**：上传时机在 complete **之后**、job 目录删除**之前**。8.4 的链路图
    把 artifact 上传画在「用户脚本跑完」后，但终态必须优先（一个 200MB 报告传一半
    失败不该让 run 等终态）；取消 / 超时 / 丢租约的 run 不传（半截产物没有证据
    价值）。平台侧申请接口终态后仍收，两边对「complete 先、产物后」达成一致。
  - **偏差②**：`complete` 没报上去（重试窗口耗尽）时**不传产物**：workspace 立即
    删（恢复路径只需要 state.json 与 exit_code），产物随工作区一起消失——补报链路
    只补终态与 cases，不补产物。为产物做断点续传需要把 workspace 留到「确认传完」，
    与「workspace 立即删」的磁盘纪律冲突，取舍偏向后者。
  - **偏差③**：s3 驱动的 `checksum` 信任申请时 Runner 报的值（平台不读对象存储的
    字节流，自然没法自己算）；fs 驱动落盘时**重算** sha256 覆盖。两个驱动对
    「checksum 是谁算的」答案不同，但都满足「列表页能看到一个指纹」。
  - **偏差④**（顺手修的存量问题）：`report/glob.ts:65` 的块注释里有字面量
    `a/**/b`——`**/` 提前终止了注释，整份文件 parse 报错（P4.5-6 落地时该文件
    未过 `pnpm check`）。同款问题在 uploader 初稿里也出现过，两处一起改写。
    `lib/pipelineNotify.ts:31` 的 `client.release().catch()`（pg 类型返回 void）
    一并修复——它是 P4.5-3 的存量编译错误，挡着整个仓的 `pnpm check`。
  - `models/types.ts` 加 `Artifact` 类型与 `mapArtifact`（写侧本批落库、读侧列表
    路由属 P4.5-11，mapper 先行落位免得届时再动边界层）。
  - 未做（属后续批次）：`GET …/pipeline-runs/:runId/artifacts` 列表路由与产物
    tab 前端（P4.5-11——`presignGet` 直链的生成入口在那批接上；本批的下载端点
    已就位，手工拼 token 可验）；s3 驱动的 multipart 上传（>5GB 单文件走
    `uploadPart`，首版 1GB 上限内 PUT 够用）。
  - **s3 驱动本地验证补全**（2026-09-04，MinIO 实测通过）：`compose.yaml` 增加
    minio 服务（`minio_data` 卷）与一次性 `minio-init`（`mc mb --ignore-existing`
    自动建桶）；`start.sh` 增加「存在才 source `apitest-server/.env`」的加载层
    （此前三个进程只读 `process.env`，`.env` 文件从未被消费——占位值一进 env 即
    暴露 `crypto.ts` / `index.ts` 的「空串 ≠ 未配置」缺陷，修复为 `?.trim() ||`）。
    验证中补齐的链路缺陷见 `issue_fix/问题记录-P4.5S3产物直传三缺陷与env密钥漂移.md`
    与 `问题记录-P4.5容器档SDK回连与缓存引导.md`。

- **P4.5-8 已实现**（2026-09-01）。迁移 039 的 `idempotency_keys` + `audit_logs`
  （落在 `039b_p45_idempotency_audit.sql`，与 P4.5-7 预告的名字一致）+
  `lib/idempotency.ts` / `lib/audit.ts`；接到 CI 触发与 Runner Token 签发/吊销两处，
  与本节文字的偏差记下而不是悄悄改掉：
  - **幂等的抢占是原子 INSERT，不是「先查再插」**：`claimIdempotency` 用
    `INSERT … ON CONFLICT DO NOTHING` 抢占，抢到的请求在**同一事务**里做真正的触发
    并回填 run id（`fillIdempotencyResult`），触发失败 ROLLBACK 时占位键随事务消失
    ——幂等只承诺「成功的效果只发生一次」，失败的触发不占用键，同一键换参数重试
    是允许的。所有校验（400/404/2004）发生在抢占**之前**，也是同一条逻辑。
  - **撞键回放走异常通道**：`IdempotentReplayError` 携带首次的 run 行，路由层
    捕获后回 202 + `idempotentReplay: true`（不进 `failTrigger`——命中不是失败）。
    `result_id` 指向已删除 run 的悬空键按幂等失效处理（删键重试），正常路径
    到不了（项目级联同时删两张表）。
  - **审计接入的第三处**：批次表写「Runner Token 签发」一处，落地时吊销
    （`runner_token.revoke`）一并接上——它是安全敏感动作（吊销即时生效、台上机器
    下次心跳被拒），比签发更需要可追溯。共三个 action：`ci_task.trigger` /
    `runner_token.create` / `runner_token.revoke`。
  - `detail` 纪律的落地形状：CI 触发记 `caseFilterCount`（数量不是全量 key 列表，
    §8.3）与 `parameterKeys`（键名不是值）；token 签发/吊销只记名字与标签。
    `lib/audit.ts` 有 4KB 护栏——detail 超限按「疑似 payload 转储」截断记录。
  - **不带头 = 既有行为不变**（偏差④的承诺兑现）：不带 `Idempotency-Key` 的触发
    完全不走抢占分支，双击仍产出两条 run；前端接键是 P4.5-9 勾选执行链路的事。
  - 未做（属后续批次）：既有触发接口（套件/流程/批量）的 `Idempotency-Key` 追溯
    接入（边界 17 明确不做）；审计日志的查询路由与前端页面（无排期——先有数据，
    读取需求等第一个真实使用者出现再定形状）。

- **P4.5-13 已实现**（2026-09-01，边界 19 的改判增补批）。报告视图自渲染 +
  P4.5-11 的执行详情页一并落地，与本节文字的偏差记下而不是悄悄改掉：
  - 迁移 `040_p45_report_view.sql`：`pipeline_run_cases` 加 `started_at_ms` /
    `finished_at_ms`（BIGINT，allure 的 epoch 毫秒原样——不转 timestamptz：timeline
    是客户端算术不是 SQL 谓词，两次除乘舍入换不来查询能力）+ `host` / `thread`，
    全部可空（junit 路径与旧 Runner 升级窗口天然缺省）；时间轴排序索引
    `(pipeline_run_id, started_at_ms, case_name)`。
  - Runner 侧四件：`protocol.ts` 的 `ReportCase` 加 4 个可选字段（可选不是必填——
    升级窗口里服务端要能同时收两种形状）；`allure.ts` 取 start/stop/host/thread
    （`clampTimestamp`：垃圾值进 null 而不是 0——0 是 1970 年，假时间戳比缺时间戳
    更糟）；`report/zip.ts` **零依赖手写 zip 写入器**（STORE/DEFLATE 按条目选、
    CRC32 查表、UTF-8 名 bit 11、mtime 固定 0 保证同目录两次打包 checksum 相同——
    checksum 才是身份，时间戳进包只会让重打包不可比对；不引 archiver 是
    `report/xml.ts` 手写扫描器同一条纪律）；`reportBundle.ts` + executor 接线——
    `report_format='allure'` 且解析触到文件时，把 allure-results 目录**整体**打
    `allure-results.zip` 作为 `kind='report'` 产物在 complete 后直传（与
    artifact_paths 同窗口同 best-effort 纪律；4096 文件 / 1GB 两道闸）。
  - 服务端四件：`lib/zip.ts` 零依赖读取器（扫 central directory 而不是逐个 local
    header；zip 炸弹三道闸：4096 条目 / 单条 128MB / 总 512MB——**在读取层挡，
    不在渲染层挡**）；`lib/allureReport.ts` 归一视图（cases + steps 树 + parameters
    + containers 的 before/after + 附件名→类型清单；steps 深度 64 / 单 case 5000 步
    防手造深环；坏文件跳过计数进 `skippedFiles`，报告页顶部降级提示不静默）；
    `pipelineRun.ts` 的 complete 落 4 新列（收口同款：截断 + 垃圾值进 NULL）；
    `routes/pipelineRuns.ts` 从「只有 cancel」扩成六条读路由。
  - 读路由的三个口径决定：**日志增量 512KB 分片**（一次拉几 MB 会把 JSON 膨胀成
    浏览器一帧渲染不完的字符串，前端循环拉到追上水位）；**cases 不分页**（几万行
    内全量——分页会把 timeline 切成不是用户心智的形状，渲染侧自己消化）；
    **报告视图缓存 5 分钟**（产物不可变——zip 是终态后传的；缓存键是 artifact_id，
    s3 驱动下省掉的是逐请求拉对象 + 解析）。
  - **附件下载不走 presignGet**：直链 5 分钟短活罩不住报告页里一张 10 分钟后才点开
    的截图，且 zip 内文件没有自己的 artifacts 行——落的是一个按 run 归属鉴权的
    `GET …/attachments?name=` 路由，从同一个 zip 里按 basename 取，image 类型
    inline 渲染（截图直接看得见），`name` 拒绝路径语义。
  - 前端 `PipelineRunPage.tsx`（路由 `pipeline-runs/:runId`，`?tab=log|cases|report|
    artifacts`）：阶段进度四段 + SSE 实时日志（`pipelineLog` 水位事件驱动 offset
    增量拉取，offset 走 ref——effect 不因每次拉取重订阅而闭包读旧值；自动滚底只在
    用户本就在底部附近时滚，阅读中间内容不抢滚动条）+ cases 列表/timeline gantt
    切换（**全部行有时间戳才默认时间轴**——半张时间轴比没有更误导，junit 混 allure
    时自动降级列表；泳道按 thread，零宽 case 画最小 1px 线——跳过用例常常
    duration=0，画成 0 宽会从时间轴上消失）+ 报告 tab（suite 分组树 + steps 嵌套 +
    参数化 + 失败摘要/堆栈 + 附件 inline）+ 产物 tab（短活直链下载）。timeline 的
    bar 用语义色——通过/失败/跳过本来就是时间轴要回答的问题。
  - **ExecutionRecords 的 runner 行从「不可点」改为跳转**（两处：`openParent` 与
    `?parent=` 深链恢复），兑现验收门槛 15 欠着的后半句。
  - **偏差①**：批次表原估 5 天含 P4.5-11 的四页，本批只落了执行详情页这一页——
    任务列表 / 任务编辑抽屉 / Runner 池页仍是 P4.5-11 的欠账（8.6 表里其余三行）。
  - **偏差②**：categories.json 在 zip 里但 v1 视图没有 categories 分组（边界 19 的
    清单封顶把它列进了 case 详情，实际只用了 steps/attachments/parameters——
    categories 的「产品缺陷/测试缺陷」分类需要 UI 上先有归属入口才有意义，留到
    体验优化轮）。
  - 未做（属后续批次）：`lib/allureReport.ts` 的 containers（fixture before/after）
    解析了但前端还没渲染——v1 的 case 详情不展示 fixture 步骤，数据在、入口留；
    趋势视图（从 `pipeline_runs` 历史算，与 SuiteReports 的趋势页共用形状）；任务
    列表/编辑/Runner 池三个页面（P4.5-11 欠账）。

- **P4.5-9 已实现**（2026-09-01）。勾选执行三段贯通（树侧勾选 → 带 `case_filter` 触发 →
  平台侧 `not_run` 差集）+ SDK 消费侧，与本节文字的偏差记下而不是悄悄改掉：
  - **不需要新迁移**（边界 16 兑现）：`repo_test_cases.last_result` 的 `not_run` 早在
    迁移 035:102 的 CHECK 里，`pipeline_runs.case_filter`、`ci_tasks.is_default` 分别在
    038 / 037，触发侧的 `caseFilter` 校验在 P4.5-2（偏差③）、JobSpec 透传在 P4.5-3、
    Runner 的 `APITRACK_CASE_KEYS` 注入在 P4.5-5（偏差①）。本批只补了三处缺口。
  - **`not_run` 差集落在 `completePipelineRun`，不在 `/ingest`**：那边拿得到「报到了
    什么」却拿不到 `case_filter`（SDK 根本不知道平台勾了哪些 key），而 complete 里
    run 行的 `case_filter` 与反查出的 `ingest_run_id` 同时在手（`lib/pipelineRun.ts` 的
    `markCaseFilterNotRun`）。「报到了」的判据是 `last_ingest_run_id = 本次 ingest run`
    而**不是** `last_run_at` 有没有更新——被 skip 的用例刻意不动 `last_run_at`
    （`upsertCases` 的既有纪律），但它确实报到了，不该标 `not_run`。
  - **差集也在租约回收路径上算**（`abortPipelineRunAfterLease`）：一条被回收的 run
    永远等不到 `complete`，只在 complete 那边算的话，「机器没了」那次勾选会把上一轮的
    `passed` 一直留在树上——而那正是最需要看见「这次没跑」的场景。
  - **护栏：`last_run_at < run.created_at` 才标**。别的执行在这条 run 排队之后报过同一
    条用例时不动它。宁可少标一条（树上多留一天旧结论），不可把一条刚跑过的用例误标成
    没跑。`ingestRunId` 为 null（没开 SDK 上报 / 脚本没跑到 SDK）时全集都算差集：平台
    确实无从得知，`not_run` 正是这个事实的名字。
  - **`POST /ci-tasks/recommend` 而不是 GET**：勾选可到 500 个 key，塞查询串会撞 URL
    长度上限且 key 含 `::` 与路径分隔符。它是只读查询，所以不要 `write` 权限——viewer
    打开面板看得到推荐，只是按不动触发。「最近命中」的判据是
    `repo_test_cases.last_ingest_run_id → pipeline_runs.ingest_run_id`，**不翻
    `ingest_records`**：那里只有真发过 HTTP 的用例，一条纯断言用例会凭空落选。
  - **勾选集按 `case_key` 而不是行 id**：同一条用例可以挂在多个接口下、在树上出现多次
    （接口下的「用例数」是关系数），按行 id 存会让它被勾两次。换页 / 改筛选**不清空**
    勾选（那正是「搜 order 勾一批、再搜 user 勾一批」的跨任务勾选工作流），只有切项目
    才清（跨项目勾选明确不支持）。触发成功也不清——§8.3 支持一次勾选触发多个任务。
  - **幂等键在打开弹窗时生成一次**，不是每次点触发现生成——后者等于没防重（那正是
    P4.5-8 偏差④描述的接入前行为）。同一个弹窗里重试（第一次撞 2004、起了 Runner 再点）
    复用同一个键，因此不会产出两条 run。
  - **`RunStatus` 加第七个成员 `not_run`**（`ui.tsx`），不是在 `RepoCaseTree` 里本地
    绕过 `RunStatusTag`：状态词表是设计系统的单一出口。配色**不借用任何语义色**——中性
    `--ink-3` + 空心点。跟 `skip` 共用黄会让「脚本自己跳过」与「勾了没跑」在扫列表时
    分不开，而那正是这一态存在的理由。
  - **SDK 的 deselect 先摘后登记**（`plugin.py` 的 `pytest_collection_modifyitems`）：
    inventory 的语义就是「本次实际报到的集合」，被摘掉的用例若也登记进去，会带着本次
    `ingest_run` 的 id 落库、差集恒为空——勾了没跑的用例仍显示上一轮的 `passed`，也就是
    这一批要修的那个问题。摘除走 `config.hook.pytest_deselected(items=…)` 而不是静默改
    `items`：终端摘要的 "N deselected" 与自家「记非全量」都挂在这一个通知上。
  - **一条 key 都没匹配上时仍然一条都不跑**，只多一条 warning。回落成全量跑会让平台
    收到「全都报到了」的上报、差集为空，于是一次 key 失配（勾的是别的仓库 / 别的 ref）
    被显示成一次成功。
  - **`select()` 住在 `selection.py`**，不是 `select.py`：`__init__.py` 会把 `select`
    这个名字绑成函数，与子模块同名就会复刻 `case.py` 那个已经炸过一次的遮蔽陷阱。
    优先级 `select() > --apitrack-case-keys > APITRACK_CASE_KEYS`（越靠近「这一次运行的
    具体意图」的来源越优先）；空串读作「没有选择」而不是「一条都不跑」——一个误设成
    `APITRACK_CASE_KEYS=` 的变量不该让整轮测试静默跑成零条。
  - **偏差①**：`case_key_of()` 从 `describe()` / `_enter()` 里抽了出来（三处消费者：
    inventory 登记、执行阶段 contextvar、勾选 deselect）。各写一遍 override 逻辑会让带
    `@case(key=…)` 的用例出现「树上是覆盖后的 key、筛选却按 nodeid 比」这种只在部分
    用例上复现的失配。
  - **偏差②**：批次表只写了「树上勾选」，实际未归位用例分组也能勾（它们是真实的仓库
    用例，只是没打到本项目登记的接口——「没归位」不影响它按 key 被筛选执行）。那张表
    不给全选框：它是截断显示的（只取前 100 条），全选会造出一个与眼前不符的集合。
  - **偏差③**：接口行给了三态勾选框（勾上 = 它下面全部用例，收起时也能整组勾）。
    §8.3 只写了「树行勾选」，但「按接口跑一遍」是这个页面上最短的那条路径。
  - **偏差④**：SDK patch 版本号已在 `pyproject.toml` 抬到 `0.1.1`，**尚未打 tag 发布**
    ——发布要打 `v0.1.1` 走 Trusted Publishing 流水线，那是一次人工动作。
  - 未做（属后续批次）：CI 任务列表 / 编辑抽屉 / Runner 池三个页面（P4.5-11 欠账，
    本批的任务选择只是弹窗里的一个 Select）；执行记录页按 `case_filter IS NOT NULL`
    筛「勾选来的那些」（§8.3 提到的读法，等 P4.5-11 的 kind 筛选一起做）。

- **P4.5-10 已实现**（2026-09-01）。容器档全部落在 Runner 仓（`apitest-runner`），
  服务端零改动——`sandbox` 的 JobSpec 字段、claim 的 `sandbox_mode = ANY($modes)`
  过滤、register 的 `sandbox_modes` 白名单在 P4.5-1/2/3 就位，本批只是让 Runner
  兑现「container」这个承诺。与本节文字的偏差记下而不是悄悄改掉：
  - `executor/container.ts` 五件：`probeDocker`（`docker version --format
    {{.Server.Version}}` 只认 Server 段——CLI 在、daemon 没起时不自报 container）、
    `runningInsideContainer`（`/.dockerenv` + `/proc/1/cgroup` 双判据）、
    `validateLimits`（cpu/memory/disk 正则——JobSpec 来自网络，畸形值报 failed 而
    不是透传给 docker）、`ContainerNetwork`（job 专属 bridge + deny CIDR 落
    `DOCKER-USER`，finally 里逐条摘 + 删网络）、`buildDockerRunArgs` 纯函数 +
    `runContainer`（杀梯子 `docker stop -t 5` → escalator `docker kill`；容器名
    `apitrack-job-<id 前 8>`，日志流走 docker CLI 的 stdout 管道）。
  - **与 docker 的通道首版是 CLI 子进程**（用户确认）。三个理由：iptables 的
    `DOCKER-USER` 只能走宿主 CLI（socket 路线消不掉全部子进程）；零运行时依赖是本仓
    纪律（socket 要么引 dockerode 要么手写 attach 分帧）；CLI 是 Docker 的公开契约而
    attach 分帧是实现细节。切换缝留在 `APITRACK_RUNNER_DOCKER` 配置后面（`podman`
    机器改一个变量即兼容）。**P4.5-10b 增补了 socket 通道**（用户 2026-09-01：
    「可以增加 socket 通道」），三条理由里第一条依然成立（iptables 没被消掉）、第二条
    以手写分帧 + 不引 dockerode 的方式绕过、第三条降级为「cli 仍是默认」。
  - **clone 恒在宿主跑**（8.5 的表没写 clone 在哪跑）：沙箱要关的是用户脚本，
    clone 是 Runner 的职责——git 二进制、凭据临时件、预算检查在两档共用同一条
    `spawnFn` 路径；state.json / exit_code / deploy_key 因此**不进**容器，这正是
    文件系统隔离要护的东西（script.sh 单独一条 `:ro` 挂载）。
  - **缓存身份两档同源**：容器档不重算 key，从 `prepareCache` 挂好的软链
    `readlinkSync` 反解宿主缓存目录，再以挂卷达到同一「写入即回写」——挂点 =
    容器内 workspace 挂点 + 同一相对路径，pytest 之类对 CWD 相对路径的假设不破。
    `APITRACK_RUNNER_CONTAINER_CACHE=no` 可关（软链在容器内不成立，这就是不能
    复用进程档挂法的全部原因）。
  - **deny 列表降级必须被看见**：iptables 不存在（mac 开发机）或没权限时继续跑，
    但降级写进 job 日志（`outbound deny NOT enforced`）——静默失去网络策略等于
    把容器档卖成一个兑现不了的承诺。桥名从 network Id 推（`br-<id 前 12>`，
    daemon 的稳定规则），拿不到 Id 时同样记日志降级。
  - **dind 检测给了豁免口**（8.5 原文「检测到就在注册时不上报 container」）：
    `APITRACK_RUNNER_ALLOW_DIND=yes` 让确认过隔离语义的部署显式豁免——原文没有
    这个出口，「挂 docker.sock 的 K8s sidecar 部署」会永远领不到容器任务且面板
    看不出为什么。
  - 终态映射零新增：`runContainer` 产出与 `spawnDetached` 同构的 `ProcResult`
    （docker run 的退出码即容器主进程退出码；被我们杀的读 `killedBy`），executor
    的终态判定表一行不改。停机杀在途容器靠 `process.ts` 开放出的
    `registerInflightKill` / `unregisterInflightKill`（`killInflight` 名单语义不变，
    容器档的用户进程同样被计入优雅停机）。
  - `spec.sandbox.image` 为空在 script 起手报 failed（P4.5-2 的触发前置检查挡了
    存量任务，这里挡 JobSpec 组装竞态）；防御分派从「container 明确失败」改为
    正常分派（P4.5-5 落地时的占位注释随之兑现）。
  - 未做（属后续批次/明确不做）：`--storage-opt size=` 依赖镜像的 storage driver
    支持 `overlay2`（个别发行版默认 driver 不支持时会启动失败，错误信息里带
    docker 原话，可读）；`isolated` 档位与镜像预热（边界 15 明确不做）；s3 驱动
    multipart（P4.5-7 已记）。`spec.sandbox.network` 取 `?? []`——协议字段是
    必发项，防御式缺省不产生第二协议形状。

- **P4.5-10b 已实现**（2026-09-01，用户「可以增加 socket 通道」）。容器档从「一条
  CLI 通道」变成「两条通道 + 一个通道无关的契约」，仍是 Runner 仓单侧改动，服务端与
  协议零改动（`JobSpec.sandbox` 一个字段不动——通道是**部署侧**的事，不是任务配置）。
  - **接缝形状**：`executor/container/runtime.ts` 定义结构化的 `ContainerSpec`
    （name/network/image/entrypoint/command/workdir/binds/env/limits/stopTimeout）与
    `ContainerRuntime` 接口（`probe` / `run` / `createNetwork` / `networkId` /
    `removeNetwork`）；`container/cli.ts` 与 `container/api.ts` 各自实现；
    `executor/container.ts` 收成 facade + `createContainerRuntime(config)`。
    **中间表示刻意不是 argv 数组**：让 api 通道去反解 `--volume h:c:ro` 等于把 CLI
    语法当成内部协议，改一个挂载点要同时改两处解析。
  - **`ProcResult` 加一格 `oomKilled: boolean | null`**（容器档专有，进程档不产出）。
    这是两条通道**唯一的能力差异**，也是加 socket 通道的唯一硬理由：内存超限被 daemon
    杀与被别处 SIGKILL 在退出码上都是 137，归因只能来自 daemon。api 通道读
    `.State.OOMKilled` 给确定答案；cli 通道在 `--rm` 下没有 inspect 窗口，只能给
    `null`。**`null` 不当 false 用**——把未知说成「不是 OOM」会让用户去调一个没问题
    的内存限额；executor 在 `null` + 137 时只提示可能性并指出换 api 通道能定论。
  - **api 通道刻意不开 `AutoRemove`**：那是 `--rm` 的等价物，会把 inspect 窗口一起
    拿掉，等于放弃这条通道唯一的能力增量。回收由 `run()` 的 finally 显式
    `DELETE ?v=1&force=1` 做。
  - **attach 分帧自己写**（`demux`，约 40 行）：非 TTY 的 attach 流是多路复用的
    （`[type,0,0,0,size(BE32)]` + 负载），帧会跨 TCP 包切断。多字节字符可能被 daemon
    切在帧边界上，所以跨帧保留一个待解码尾巴（`incompleteTailLength`）——否则日志里
    会出现替换字符，而日志是要过 secret 逐行脱敏的，坏字节会破坏行边界。
  - **次序不能变**：create → attach → start → wait → inspect → rm。先 start 再 attach
    会丢掉容器开头几行输出（CLI 帮我们排过这一步，自己做就要自己记住）。
  - **零运行时依赖守住了**：用 `node:http` 的 `socketPath` 直连 Engine API（钉住
    `v1.41`），不引 dockerode。`package.json` 仍无 dependencies。
  - **镜像 pull 要自己做**：CLI 会在镜像不在本地时自动拉，API 不会——create 收到 404
    时走一次 `POST /images/create` 再重试 create。
  - **iptables 仍是两条通道共用的 shell 依赖**（`container/network.ts`）：宿主
    netfilter 在 Engine API 里没有对应物，所以 socket 通道**没有**让容器档摆脱子进程。
    P4.5-10 的第一条理由依然成立，这一批只是不再用它否决整条通道。
  - **DinD 检测对两条通道一视同仁**，不因为「socket 通得」就放宽：容器里能摸到 socket
    通常正是因为宿主把它挂进来了，那时候起的容器是 Runner 的兄弟。通道是「怎么连
    daemon」，DinD 是「隔离是否成立」，两件事不能互相抵消。
  - **探测走配置选定的那条通道**（`resolveSandboxModes` 改异步）：探测 cli 通、实际
    跑 api 不通，等于自报了一个跑不了的档位，可满足性检查（边界 3 的同构物）就瞎了。
    注册日志带上 transport，否则运维分不出「CLI 没装」与「socket 没权限」。
  - 新增两个环境变量：`APITRACK_RUNNER_DOCKER_TRANSPORT`（`cli` 默认 / `api`，非法值
    静默回落 cli——这一格配错不该让整台 Runner 起不来）、`APITRACK_RUNNER_DOCKER_SOCKET`
    （默认 `/var/run/docker.sock`）。
  - **明确不做**：remote daemon（`DOCKER_HOST=tcp://` + TLS 客户端证书）。除了要多一套
    证书加载与 `tls.connect`，它会直接破坏 workspace bind-mount 的前提——宿主路径在
    远端 daemon 上不存在。`cli` 仍是默认通道，理由不变：日志里那行完整的 `docker run …`
    用户能复制粘贴复现，这是自托管软件的运维资产，api 通道没有等价物。

- **P4.5-11 已实现**（2026-09-01）。8.6 欠着的三个前端页面 + 两处口径改造落地，
  与本节文字的偏差记下而不是悄悄改掉：
  - **CI 任务列表**（`ci-tasks`，新 `CiTaskList.tsx`）：顶部 Runner 池读数
    （在线/槽位/在途/空闲/排队）+ 任务表（默认/停用 chip、沙箱、分区、ref、报告格式、
    超时）+ 行内 `[▶执行][历史][编辑][删除]`。「执行」不带 `case_filter`（全量），
    幂等键**当场生成**——这是一次新意图，与勾选弹窗「打开时固定一个键」刻意不同
    （那边撞 2004 后起完 Runner 再点是同一次意图）。「历史」跳执行记录页并预置
    `?type=parent&kind=runner&keyword=<任务名>`，不新建一个「任务历史」页：那份数据
    就是 `execution_index`，再开一页等于第二个入口讲同一件事。
  - **任务编辑抽屉**（新 `CiTaskDrawer.tsx`）而不是 8.6 表里写的 `ci-tasks/:taskId`
    路由（**偏差①**）：任务配置是一张长表单但没有子状态、也不需要被分享成链接——能
    分享的是它的执行，那才有独立路由（与数据源编辑器同款取舍）。代码来源只读（仓库
    地址 + 拉取方式两行事实 + 只可改 `ref`），沙箱档切到 `process` 时提示语从
    `.form-note` 换成 `.form-error` 并写成**信任声明**而不是「轻量模式」（边界 15 的
    原话）；secret 行是 patch 语义（留空=保持原值，删行=显式发 `null`）；报告格式的
    说明句写明 junit/allure **不回写用例树**（边界 13），只有 SDK 上报回写。
  - **Runner 池**（新 `RunnerPoolPanel.tsx`）落在**系统设置的第三个 tab** 而不是
    8.6 表里写的独立路由 `/system/runners`（**偏差②**）：`/system` 在这个前端里从来
    不是一棵子路由树，而是 `GlobalApp page="system"` 的一个值；更重要的是 8.6 自己
    要求「与执行器面板挨着放并写明区别」——同一页的相邻 tab 是「挨着」最直接的形状，
    两条独立路由做不到。面板含注册 Token 签发（部署命令一键复制、明文只出现一次）、
    Runner 三态（在线/下线中/离线——`draining` 不能显示成「在线」，那会让人以为下线
    没生效）、`draining` ↔ `online` 切换。
  - **趋势页开关语义扩成「含仓库执行」**（边界 2）：查询参数从 `includeIngest` 改名
    `includeRepo`，`sampleKinds()` 打开时是 `('flow','suite','ingest','runner')`。
    **不给第二个复选框**——那两者对用户是同一件事。这是一次**改名而不是加参数**：项目
    从未上线，没有历史调用方要兼容（数据兼容性约定）。
  - **执行记录页补「只看勾选来的」**（§8.3 提到的读法）：`?caseFilter=1`，服务端判据是
    `EXISTS (SELECT 1 FROM pipeline_runs WHERE id = execution_index.detail_id AND
    case_filter IS NOT NULL)`。用 EXISTS 而不是 join：`execution_index` 上没有这个事实，
    而 join 会让别的 kind 的行因为匹配不上 `pipeline_runs` 整批消失。复选框只在
    `kind=runner` 下出现（对别的 kind 这个条件恒为假）。
  - **新增一条服务端路由**（8.6 没写，**偏差③**）：`GET /api/v1/system/runner-pool`，
    **任何登录用户可读**。8.6 只说了任务列表顶部要显示池状态，但 `GET /system/runners`
    是系统管理员专属且带 hostname/token 名/版本——直接用它会让非管理员在自己的 CI 任务
    页上吃一个 403。这条与 `/system/runner-labels` 对 `/system/workers` 的关系完全同构：
    只回标签与数字，够画顶部那一行，不泄露机器信息。`queued` 是**跨项目的全局数**
    （认领扫描按标签取全平台最早的那条），文案上说明了这一点。合计 `online` 从 runner
    行算而不是把标签行求和——一台声明两个标签的机器在两行里各算一次，求和会把「在线
    3 台」报成 6 台。
  - **导航新增「仓库模式」分组**（8.6 的「CI 任务在导航上属于仓库模式分组」）：仓库用例
    从「编排与回归」组**移出**、与 CI 任务并列。P4 时把它放在编排组是因为它与流程/套件
    回答同一个问题；CI 任务出现后，「测试代码不在平台里」有了看结果与管执行两个页面，
    且共享同一个前提（本项目绑定的那个仓库），混在编排组里会让「为什么这两页要求先绑
    仓库、另外两页不要求」变成每次都要重新解释的问题。
  - **看板的「CI 任务数」接真值**（此前是硬写的「未启用」占位）：`dashboard.ts` 加一条
    `ci_tasks` 分组子选（与调度数同款口径，含停用的）。**覆盖率一个字不改**（P4 边界 2
    / P4.5 边界 2）——这里只是数任务，不进任何比率。
  - 顺手修掉 P4.5-13 落地时留下的四处前端问题（**它们是缺陷，记在 `issue_fix/`**）：
    `Tip content=` 应为 `text=`（两处静默不渲染）、`Empty` 缺必填 `title`（五处）、
    `status status-${x}` 应为 `data-status`（设计系统是属性选择器）、CSS 里
    `var(--radius)` / `var(--rule)` 两个从未定义的 token。
  - 未做（属后续批次）：调度与 Webhook 接 CI 任务（P4.5-12，「资源类型」第三项与
    `ci_task` 目标）；审计日志的查询页（无排期，等第一个真实使用者）；`ci-tasks` 页的
    「上次执行」列——`ci_tasks` 上没有这一列，`execution_index` 只在终态写行，要它就得
    加一条按任务分组的 `MAX(created_at)` 子选，等有人问再加比现在猜一个形状好。

- **P4.5-12 已实现**（2026-09-01）。8.7 的两个预留接入点接上，外加本轮确认的两个范围扩项
  （任务终态通知、任务级串行）。落地内容与本节文字的八处偏差，记下而不是悄悄改掉：
  - 迁移 `042_p45_schedule_webhook_ci.sql`：两个 `target_type` CHECK 放宽
    （`schedules` → `('suite','ci_task')`、`webhook_triggers` → `('flow','suite','ci_task')`，
    DO 块先 `DROP CONSTRAINT IF EXISTS` 再按名字判存在后 ADD——两个都是 030 里的**列级
    匿名** CHECK，Postgres 自动名 `<表>_<列>_check` 是确定性的；038 那个要按定义内容找的是
    **表级**多列 CHECK，两种情况不要混）、`schedule_runs.pipeline_run_id`、
    `ci_tasks.notify_config`、`ci_tasks.single_concurrency`。
  - **调度分派**（`lib/schedule.ts`）：`fire()` 的守卫从 `!== "suite"` 改成白名单判断，
    分出 `fireSuite` / `fireCiTask` 两个函数——两条都只是「选哪个 trigger 函数」，认领、
    快进、漏跑、park 一行没动。CI 侧走 `triggerCiTaskRun`（P3 边界 5 的单一触发路径），
    `variables` 当 `parameters` 传。
  - **Webhook 分派**（`routes/webhookTriggers.ts`）：原来的 `if flow / else suite` 落空写法
    改成三分支**显式**分派 + 末尾 400。那种写法下一个未知的 `target_type` 会被静默当套件跑
    一遍，而 CHECK 之外的值只可能来自有人手改过行。`validateTarget` 的表名从二元三目改成
    `TARGET_TABLES` 常量表（`schedules` 路由也加了同款一张），HMAC / 时间窗 / nonce 一处未改。
  - **偏差①：`schedule_runs` 多一列 `pipeline_run_id`**（理由见 8.7 的偏差表）：
    `pipeline_runs` 的 index 行只在终态才写，触发那一刻它不存在。
  - **偏差②：调度目标类型进了请求体与列表过滤**；**偏差③：`POST /schedules/:id/run` 的
    响应改成判别式联合**（`{targetType:'suite',suiteExecution}` / `{targetType:'ci_task',
    pipelineRun}`），该路由同时开始接受 `Idempotency-Key`（只在 CI 分支有意义）；
    **偏差④：CI 任务删除补了引用扫描**（409 + `?force=true`，照 `routes/suites.ts`）。
    三条的完整理由都写在 8.7 的偏差表里。
  - **通知（范围扩项）**：`ci_tasks.notify_config` 与套件那一列**形状逐字相同**，所以
    `SuiteNotifyConfig` / `normalizeSuiteNotify` / `dispatchAlert` / 证据行四处全部复用；
    新增的只有 `lib/alerts.ts` 的 `notifyPipelineResult`（默认模版 + 取事实的那条查询）与
    `scheduler.ts` 订阅里的一个分支。**挂在事件上而不是在 complete 里调**：`pipeline` 终态
    事件本来就在两条路径上发（`completePipelineRun` 与租约回收器），挂事件等于两条自动都
    覆盖。终态口径：`canceled` 不通知，`aborted` / `timed_out` 归一成失败文案通知。
    渠道删除的引用扫描与悬空 id 摘除同步扩到 `ci_tasks`（`routes/notificationChannels.ts`，
    两张表只差表名，改成按字面量数组循环而不是抄第二遍 SQL）。
    **偏差⑤：`validateNotify` 刻意保留两份**（suites / ciTasks 各一份）——它读同一张表、用
    同一个归一函数，但错误文案的字段前缀属于各自的请求体契约；抽出去要么把前缀写死、要么
    多一个只为拼字符串的参数。真正不能有两份的归一与投递已经是一份。
  - **任务级串行（范围扩项）**：`single_concurrency` 默认 **true**。守卫落在 **claim 侧**
    （`routes/runners.ts` 的认领 SQL 加 `NOT EXISTS 同任务更早在途`，走迁移 038 的
    `pipeline_runs_task_number_idx`；`FOR UPDATE` 因为多了 join 而必须写成 `FOR UPDATE OF pr`），
    所以「谁先跑」由 `run_number` 决定而不是认领竞速，触发路径一行不改——**排队而不是拒绝**
    正是用户要的语义（研发的流水线在等结果，一个 409 会让它当成失败）。
    **偏差⑥：唤醒点比 8.7 写的多两处**。8.7 只说了「终态顺手唤醒」，实际有四个出口需要它，
    抽成 `lib/pipelineRun.ts` 的 `notifySerializedQueue`：`completePipelineRun`（事务内，随
    COMMIT 投递）、租约回收（同款）、**`queued` 被直接取消**（`routes/pipelineRuns.ts` 的
    cancel 不走 complete）、**串行开关被关掉**（`PUT /ci-tasks/:id`——那一刻被挡住的 run 立刻
    可领）。漏掉后两处的表现是「要等到下一个 25 秒轮询窗口才动」，不是错但看着像卡住。
    该函数**不按 `single_concurrency` 过滤**：关开关那一刻列已经是 false，而对从不串行的
    任务多发一次通知只是一次注定 204 的提前醒。
  - **偏差⑦：run 详情页多一个 `meta.blockedBy`**（读时算出的关系，不进 `PipelineRun`）：
    被串行挡住的排队 run 要说清「在等 #N」。不说的话，它与「分区没有在线 Runner」在界面上
    长得一模一样，而后者要人去起一台机器。
  - **偏差⑧：调度的 `variables` 在 CI 目标下当 `parameters` 传**（8.7 原文写的是置 null）。
    两者的键形约束是同一条、语义也是同一句「这次触发带什么」，为它在 `schedules` 上加第二列
    只会让「我该填哪个框」变成新问题。界面上这一栏在 CI 目标下改称**触发参数**，提示语点明
    「值会原样进日志」——任务级 secret 已删（8.11 的 B 类）。
  - **前端**：`SuiteSchedules.tsx` 泛化成 `ResourceSchedules.tsx`（入参 `targetType` +
    `targetId`），套件详情页与仓库任务列表共用；任务行内多一个日历按钮开抽屉；任务抽屉补
    通知面板（形状与套件那块相同）与串行开关。i18n zh/en 各补 `schedules.hintCiTask` /
    `schedules.parameters*` / `ciTasks.notify.*` / `ciTasks.singleConcurrency*` /
    `ciTasks.deleteReferenced*` / `pipelineRun.blockedBy` / `webhooks.targetCiTask`。
  - `start.sh` 补起 Runner 的注释（**不自动拉起**，照 P2-8.6 的形状）：与 worker 的区别
    （直连 Redis+Postgres vs 只出站 HTTPS）、`cp .env.example .env` 后 `./start.sh`、
    注册 Token 在系统设置里签发、本机临时前台起一台的一行命令。
  - 未做（属后续批次）：**Webhook 管理页面**——`api.webhookTriggers` 至今零调用方，整个
    Webhook 只有后端与 i18n 文案，本批只把 `ci_task` 目标接进服务端能力，没有为它新建界面
    （P3 时就没建；等有第一个真实使用者）。任务级串行的**跨任务**排队（不同任务共享同一份
    测试数据时也要串）：那需要「资源锁」这个新概念，不在本批。`evaluateAlertEvent` 仍
    **不看** `kind='runner'` 的索引行——把仓库执行掺进项目级成功率是一次统计口径变更
    （P4.5 边界 2 明确不动）。

### 8.9 验收门槛

1. **零入站**：Runner 那台机器只放开出站 443，全链路（注册→领取→心跳→日志→完成）跑通；
   平台侧没有任何一处向 Runner 发起连接（抓包或代码审查任选其一为证）。
2. **认领互斥**：10 台 Runner 同时长轮询一条 queued run，只有一台拿到，其余立刻拿到 `204`
   而不是阻塞在锁上。
3. **分区防御**：一台只声明 `labels=['default']` 的 Runner **领不到** `runner_label='prod-dmz'`
   的 run；拿 `labels=['default']` 的 token 注册时声明 `['prod-dmz']` 被拒。
4. **沙箱不匹配前置拒绝**：任务配容器档但在线 Runner 都只支持进程档时，**触发时**就返回
   `2004` 并说清缺什么，而不是产出一条 `failed` 的 run。
5. **租约回收**：Runner 进程 `kill -9` 后 90 秒内那条 run 变 `aborted`（不是永久 `running`，
   也不是 `failed`）；重启 Runner 后读落盘退出码补报的那一条**不**被判 `aborted`。
6. **取消**：`running` 中取消 → 状态先 `cancelling`、下一次心跳后 Runner 杀掉整个进程树、
   终态 `canceled`；`queued` 中取消直接终态。取消后已完成阶段与已收到的日志**仍在**。
7. **日志续传**：执行中断网 10 秒再恢复，日志**不丢不重**（`byte_offset` 唯一约束生效），
   前端 SSE 自动重连并从正确 offset 续拉。
8. **超时杀进程树**：脚本里 `sleep 9999 &` 起一个后台进程，任务超时后它**也**没了，
   Runner 槽位立刻可用。
9. **凭据不外泄**：`credential` 只出现在 claim 响应体里；`GET /ci-tasks/:id`、
   `GET /pipeline-runs/:id`、日志、`audit_logs.detail` 五处全部搜不到它；Runner 侧那个
   临时 key 文件在任务结束后不存在。
10. **secret 脱敏**：`echo $MY_TOKEN` 在平台侧日志里显示为掩码；同时**明确记下**
    `echo $MY_TOKEN | base64` 挡不住（边界 12 已声明不承诺）。
11. **报告三路径**：同一次 run 同时开 SDK 上报与 junit 解析——树上 `last_result` 只被 SDK
    改动，`pipeline_run_cases` 有 junit 那份，两者数字不一致时界面上说得清哪个是哪个。
12. **产物直传**：一个 50MB 的产物上传与下载全程不经过 API 进程（`fs` 与 `s3` 两个驱动各
    验一次）。
13. **勾选执行**：树上勾 3 条 → 触发 → 脚本只跑这 3 条 → 树上这 3 条刷新；把脚本改成
    **无视** `APITRACK_CASE_KEYS` 全量跑，结论仍正确（差集为空，不标 `not_run`）；
    再把脚本改成只跑 2 条，第 3 条标 `not_run` 而**不是** `failed`。
14. **幂等**：同一个 `Idempotency-Key` 触发三次，只产生一条 `pipeline_runs`，后两次返回
    第一次那条的 id。
15. **归一与口径**：执行记录页能按 `runner` 筛出来并点进 `pipeline-runs/:id`；
    `reports/trend` 默认**不**含它，打开「含仓库执行」开关后同时含 `ingest` 与 `runner`；
    `/dashboard` 的覆盖率数字**保持不变**（沿用 P4 边界 2）。
16. **协议版本**：一个自报 `protocol_version='0.9'` 的 Runner 被明确拒绝并给出可读原因，
    而不是在 claim 之后才炸。
17. **报告视图（P4.5-13）**：一个 `report_format='allure'` 的任务（含 steps 与截图附件的
    pytest 仓库）跑完后：`pipeline_run_cases` 的时间戳四列有值；run 详情页 timeline 能看到
    按 thread 分泳道的并行执行；报告 tab 能展开看到 steps 树与参数化；截图附件点开能看
    （inline 渲染，不是下载一个 octet-stream）；同一个 zip 被 `unzip -l` 验证过结构。
    junit 任务的 run 详情页打开**不报错**（报告 tab 显示空态而不是 404）。
18. **任务级串行（P4.5-12，8.7）**：串行开着的任务连触三次 → 三条全部受理（202，不报错）、
    `run_number` 连续；同一时刻至多一条非终态 run 在跑，其余 `queued`；第一条终态后第二条
    **立刻**被认领（不等 Runner 下一轮长轮询超时——比较两条的 `finished_at` 与
    `claimed_at` 间隔）；被挡住的排队 run 详情页显示「等待 #N 终态后开始」。关掉开关后
    同一任务两条 run 能并行。取消（`canceled`）也释放排队——它是终态。
19. **CI 调度（P4.5-12）**：给任务配「每分钟」cron → 到点自动产生 run
    （`trigger_source='scheduled'`、refName 是调度名，执行记录页可筛）；`schedule_runs` 有
    `triggered` 留痕且 `pipeline_run_id` 指向那条 run（点开直达 run 详情页）；调度器停机跨过
    宽限期后记 `skipped` **不补跑**；删任务时先 409 列出它的调度、`?force=true` 才连带删。
    调度触发的 run **不带** `environmentId`（CI 没有这个概念，编辑抽屉里也不显示那个下拉），
    但**带** `variables` 作为任务 `parameters`（偏差⑧）。
20. **CI 通知（P4.5-12）**：任务只开 `onFailure` + 配渠道 → 失败、`aborted`、`timed_out` 的
    终态各投一条（`aborted`/`timed_out` 文案归一成失败口径），成功不投；开 `onSuccess` 后
    成功也投；`canceled` 永不投（用户动作不是执行结果）。自定义模版的占位符
    （`taskName` / `runNumber` / `commitSha` / `duration`）替换正确；通知投递证据行在
    渠道投递记录里可查（`rule_id` 为空，与套件通知同款）。
21. **编辑页与执行历史（P4.5-15，8.12）**：`/repo/tasks/new` 只填必填四项（名称 / Git 地址
    + ref / steps / Runner 标签）即可保存——高级折叠区不展开、不填；保存后回列表。列表行
    展开显示该任务最近 run，点某条进 `/pipeline-runs/:runId`，URL 刷新/粘贴回来仍在同一
    位置；编辑页刷新不丢已填内容（任务行回读，新建页除外——它是新表单）。日志 tab 的
    「下载日志」得到的 txt 字节数 = `run.log_bytes`（完整性判据）。

### 8.10 明确不做

- **Spec 2.10.2(a) 的 `isolated`（Job per build / K8s Job）**与 2.10.2(b) 那一整套冷启动
  优化（预烤镜像 / 镜像预热 / venv hash 缓存的完整形态）。留 `isolation_mode` 字段位，
  首版只接受 `shared`。见边界 15。
- **零侵入 proxy 覆盖率采集**（Spec 2.10.2(g) 的第二条路径）。SDK 上报已经能拿到
  case ↔ endpoint 的精确映射，proxy 路径换来的是「不装 SDK 也有覆盖率」，代价是镜像内预置
  CA + `HTTP_PROXY` 注入 + 一个 MITM 代理组件。它是独立一件事，且与本阶段任何一处都不耦合。
- **allure 静态站点托管**、`allure generate`、**vendor allure 官方 SPA**。仍然不做
  （2026-09-01 改判后的准确边界，见边界 19）：平台**自存原始 allure-results 文件、
  自渲染**报告视图，不跑 allure-cli、不喂它产的静态站、不拿它的 app.js 拼数据。
- **P10 14.1（原 P6 10.1）的执行历史归档（分区表）与大响应体截断**。本阶段只提前对象存储抽象这一层，
  见边界 14。
- **既有触发接口（套件 / 流程 / 批量）追溯支持 `Idempotency-Key`**。设施是通用的，但接线
  只做 CI 触发，见边界 17。
- **Runner 自动升级 / 版本分发**。自托管的东西由部署者升级；平台只做 N 与 N-1 双支持并在
  面板上显示版本落后。
- **项目级并发上限**（Spec 2.10.2(f)）。首版并发度就是「在线 Runner 的槽位之和」；一个项目
  占满整个池这件事在自托管场景下（一个池通常就服务一个网段的少数项目）还不是问题，
  真出现时再加一列比现在猜一个默认值好。任务级串行（`single_concurrency`，8.7）回答的是
  「同一任务的两次执行不互相踩数据」，与本条说的项目级聚合上限是两个问题，后者仍不做。
- **`workers` 表与 `runners` 表合并**。见核心模型第三条。

### 8.11 P4.5-14 配置面收窄（2026-09-01 验收反馈，范围与边界已确认）

**问题**

P4.5-11 把 8.6 的表逐格实现了，但那张表是照「一个 CI 系统该有什么配置」写的，不是照
「这个平台的用户在什么时刻知道什么」写的。验收时用户的原话是「我自己设计的我都懵了」
——这不是缺功能，是**配置项比决策多**。十条反馈归成四类，逐条给落点；每一条都是**减**
而不是加，唯一新增的表是把已有的一列升级成的凭据池。

**A 类 · 顺序反了（反馈 2、4、5）**

`repositories.clone_url` / `clone_method` / `credential_encrypted` 挂在**仓库**行上，而
仓库行只能由**第一次上报**创建（边界 18 的绑定模型）。于是配置顺序是「先跑一次 CI 上报
→ 才有仓库行 → 才能填拉取地址 → 才能建任务跑 CI」，而用户来这里的目的正是「我还没有
CI，让平台帮我跑」。第一步就锁死。

- **Git 地址移到 `ci_tasks` 上**（用户选定「任务级 Git 地址」）。创建任务时填地址 + 选
  凭据，不需要任何已存在的上报。仓库行仍然由上报创建、仍然是用例树与 `/ingest` 准入的
  归属者——**两者从此不再互为前提**：任务回答「从哪拉、怎么跑」，仓库行回答「树是谁的」。
  一次任务跑完后 SDK 上报会把仓库行建出来，那时两边的 git 地址天然一致（同一个仓库），
  不一致也不需要平台裁决——`/ingest` 的准入判据一个字不改。
- **拉取凭据升级成项目级命名池 `git_credentials`**（用户选定）。它不是新概念，是把
  `repositories.credential_encrypted` 这一列搬到自己的表上并给它一个名字：一个项目通常
  只有一两把 key（「公司 GitLab 只读 token」），多个任务共用；换 token 只改一处。
  `clone_method` 随凭据走（`https_token` / `ssh_key`），**任务表单里不再出现「拉取方式」
  这个词**——它是凭据的属性，不是任务的选择。公开仓库不选凭据即可（原 `none` 档的语义
  由「不引用任何凭据」表达，少一个枚举值）。
- **凭据管理进仓库模式的 tab，与上报 Token 并列**（用户选定「并入凭证管理 tab」）。
  两块都是凭据，但服务对象不同，标题上写清：上报 Token 给 SDK（`/ingest` 用），Git 凭据
  给 Runner（clone 用）。原「接入指引」页的三步说明（装包 / 两个环境变量 / 原样跑
  pytest）并入这一页的上报 Token 那一块——它本来就是在讲那个 token 怎么用。

**B 类 · 配置项超过决策（反馈 6、7、9、10）**

- **删掉任务级 secret**（用户选定「直接删掉，只留明文环境变量」）。`secrets_encrypted`
  一并删列。代价必须记下而不是当成零成本：**Runner 侧的日志脱敏字典随之空掉**（边界 12
  的原文逐行替换失去输入源），敏感值写进 `env` 就会原样出现在日志里。这是用户在
  「少一层配置」与「平台替我遮日志」之间的显式取舍；`masker.ts` 的机制保留（clone 凭据
  仍走它），只是不再有任务级词表喂它。
- **删掉「报告格式」下拉，永远按 allure**（用户选定）。`report_format` / `report_paths`
  两列删掉，**报告目录从 `steps` 里解析** `--alluredir[=| ]<dir>`（也认
  `ALLURE_RESULTS_DIR=`）；解析得到就在表单上只读回显「报告目录：allure-results」，
  解析不到就当场提示「命令里没看到 `--alluredir`，跑完不会有报告」——**提示而不是拒绝**
  保存：用户可能在 `pytest.ini` 里配了 `addopts`，平台看不见那份文件，为它拦住保存是拿
  一条猜测去否决事实。junit 解析器（`report/junit.ts`）**代码保留但不再有入口**：删掉它
  等于为一次口径变更去动一个能跑的解析器，而它一行也不碍事。
- **删掉「产物路径」**。`artifact_paths` 列删。allure-results 的打包上传是平台自己的行为
  （P4.5-13 边界 19 的报告层，与这一列从来无关），删掉之后报告照旧；用户想额外收文件
  这件事，等有人真的提出来再说——现在它只是一个没人填的框。
- **删掉「默认任务」**（用户：「这个我理解可以在上报的时候处理吧」——落地成更简单的一条）。
  `is_default` 列与那条部分唯一索引一起删。勾选执行的兜底改成**单任务自动选、多任务让
  用户选**（用户选定）：`POST /ci-tasks/recommend` 保留「最近成功上报过这些 case_key 的
  任务」这一条真判据，去掉「其次默认任务」那一档——「项目里只有一个任务」这件事前端数一下
  就知道，不需要一列去声明。

**C 类 · 信息架构（反馈 1）**

- **仓库模式合并成一个页面、五个 tab**：任务 / 用例树 / 上报记录 / 未匹配诊断 / 凭据。
  导航从两项（仓库用例、CI 任务）收成一项。理由是这五块共享同一个前提（「测试代码在
  用户的仓库里」），而 P4.5-11 把它们劈成两个导航项之后，「为什么 CI 任务要先绑仓库」
  变成了每次都要重新解释的问题——A 类改完这个前提也消失了，正好一起收。
  路由前缀改 `repo`（`/projects/:pid/repo`、`/repo/tasks`、`/repo/runs`、
  `/repo/unmatched`、`/repo/credentials`），真实路由而不是 `?tab=`（RepoShell 的原理由
  不变：这些地址会被贴进排查群里）。`/pipeline-runs/:id` 保持独立路由不动。

**D 类 · 编辑体验（反馈 3、8）**

- **命令行输入接 Monaco**（用户：「是否可以支持 shell 语法识别，类似于校验脚本那样」）。
  复用 `ScriptCodeEditor.tsx` 的 Monaco 边界，`language="shell"`——只要语法高亮，
  **不做补全**：脚本节点那边的补全喂的是平台自己的 `ctx` 契约（`lib/scriptContract.ts`），
  shell 命令没有等价物，硬做只能补一堆猜的 pytest 参数。
- **进程档的工作目录已经是一次性的，反馈 8 的担心不成立**——但要写进 UI。
  `executor/workspace.ts` 的 `prepareJobDir` 是 `<data>/jobs/<job_id>/workspace`，
  job_id 是 UUID，`finally` 里整目录删除；两档共用同一份目录语义（容器档 bind-mount
  同一个目录）。所以不存在「多次执行共用一个目录导致报告污染」。**唯一真的共享物是依赖
  缓存**（`cache_paths` 软链到 `<data>/cache/<ci_task_id>/<key>/…`），那是有意为之且按
  任务 + key 文件 hash 分桶。任务抽屉的进程档提示语补一句说明这个区别，而不是改代码。

**明确不做（本批）**

- 不动 `/ingest` 的准入判据、不动 `repositories` 的绑定与解绑语义、不动用例树的归属。
- 不为「一个项目多个仓库」重新定义用例树。任务级 git 地址允许两个任务指向不同仓库，但
  **用例树仍然只有一棵**（`repo_test_cases` 按 `(project_id, case_key)` 唯一）。这是已知
  的松耦合：真出现「一个项目跑两个仓库的用例」时，那棵树会混着两个仓库的用例——届时按
  `repository_id` 分组是一次独立的信息架构改动，不混进本批。
- 不追溯迁移历史数据。项目从未上线（AGENTS.md 的数据兼容性约定），删列就是删列。

**实现状态（2026-09-01，P4.5-14 已落地）**

逐项核对（2026-09-02 复核，A/B/C/D 四类全部在盘上）：

- **A 类（顺序反了）**：迁移 `041_p45_task_config_narrowing.sql`——`git_credentials` 表
  （项目级命名池，`UNIQUE (project_id, name)`，`method` 只有 `https_token` / `ssh_key`
  没有 `none`）+ `ci_tasks.git_url` / `git_credential_id`（`ON DELETE RESTRICT` + 部分索引）
  + 删 `repository_id`（任务不再随仓库解绑级联消失）。路由 `routes/gitCredentials.ts`
  （列表带 `task_count` 分组子选；删除遇 23503 翻成 409 并列出引用任务名；重名 409/2003）；
  `routes/ciTasks.ts` 的 TASK_SELECT left join 凭据（名字/方式随任务返回），创建校验凭据
  归属，**刻意不校验与 `repositories.git_url` 一致**。Runner 侧 `executor/git.ts` 照
  `spec.repo{clone_url, clone_method, credential}` 走 GIT_ASKPASS / 0600 临时 key 文件。
- **B 类（配置项超过决策）**：四列全删（`secrets_encrypted` / `report_format` /
  `report_paths` / `artifact_paths` / `is_default` + 部分唯一索引）。`lib/jobSpec.ts` 的
  `secrets` 固定空数组、`artifact_paths` 固定空数组（协议字段保留，Runner 兼容）；
  `report` 从 `steps` 里 `parseAllureDir`（`lib/allureDir.ts`，认 `--alluredir[=| ]<dir>`
  与 `ALLURE_RESULTS_DIR`），恒为 `allure` 或 `none`；junit 解析器（Runner
  `report/junit.ts`）代码保留无入口。`ci-tasks/recommend` 只剩「最近成功上报」一档
  （无默认任务兜底）；前端 `RepoCaseTree.tsx` 的勾选执行兜底是「单任务自动预选、多任务
  用户选」。Runner `executor.ts` 的脱敏词表只剩 clone 凭据（`spec.secrets` 恒空，注释
  已写明取舍）。
- **C 类（信息架构）**：`RepoShell.tsx` 五标签页头（任务 / 用例树 / 上报记录 / 未匹配
  诊断 / 凭据），`main.tsx` 路由 `repo` / `repo/tasks/new|:taskId` / `repo/tree` /
  `repo/runs` / `repo/unmatched` / `repo/credentials`；原「接入指引」页撤销，三步说明
  与上报 Token 并进 `RepoCredentials.tsx`（同页另一块是 Git 凭据池）。
- **D 类（编辑体验）**：D3 命令行 Monaco + shell 高亮落在 `CiTaskEditor.tsx`（363 行
  注释，不做补全）——**载体是 P4.5-15 的独立编辑页**，两批在这一条上先后落地同一个
  组件；D8 工作目录说明即 `ciTasks.workspaceNote`（一次性目录 + 缓存分桶），渲染于
  编辑页高级折叠区（`CiTaskEditor.tsx`）。
- 与 P4.5-15 的关系：8.12 在本批之后，其「8 个分区 + 220px Monaco」「抽屉 → 独立页」
  都以本批收窄后的配置面为前提；两批无重复实现，D3/D8 的最终落点随 8.12 从（已删除的）
  抽屉迁入 `CiTaskEditor.tsx`。

### 8.12 P4.5-15 任务编辑页与执行历史交互改版（2026-09-01 第二轮验收反馈，范围已确认）

P4.5-14 之后用户又提了五点。前四点是**交互层的改判**（一处是真正的方向反转：抽屉 →
独立页），第五点（调度 + 通知）并进 P4.5-12 的范围（见 8.7 的改写），本节只记前四点。

**① 任务编辑抽屉 → 独立编辑页（改判）**

P4.5-11 当时的理由是「任务配置是一张长表单但它没有子状态，也不需要被分享成一条链接
（能分享的是它的执行）」——两个前提现在都塌了：

- P4.5-14 之后的表单有 **8 个分区 + 220px 的 Monaco 编辑器**，760px 抽屉里一屏看不到
  两屏的事，「一下要输入很多信息」是验收原话。P4.5-12 的调度与通知面板还要再进来两块，
  抽屉彻底盛不下。
- 「没有子状态」不再成立：调度面板有自己的列表态（增删改调度行），通知面板有渠道选择。
- 项目里已有整页编辑器的先例（`EndpointWorkspace` / `DataSourceDetail` / `SuiteWorkspace`），
  独立页不是新形态。

落地：

- 路由 `/projects/:pid/repo/tasks/new` 与 `/projects/:pid/repo/tasks/:taskId`（真实路由，
  可刷新可分享；`CiTaskDrawer.tsx` 删除，新组件 `CiTaskEditor.tsx`）。
- 保存回列表页；「保存并执行」直达 run 详情页（现状语义保留）。
- **分区顺序重排**（用户第 1 点：env 要在前面）：名称 → 代码来源（git 地址/凭据/ref）→
  **环境变量**（写 shell 的前置输入，先配再写才顺）→ 执行步骤（Monaco）→ 高级折叠区
  （运行时档位/Runner 标签/镜像、**串行执行开关**（`single_concurrency`，默认开，8.7）、
  缓存、报告上报开关、超时与启用——默认值开箱即跑，折叠区收起时不填也能保存）→
  调度面板 → 通知面板（后两块随 P4.5-12 落地）。
- 任务列表的行点击 / 编辑按钮从开抽屉改成 `navigate` 到编辑页。

**② 任务 → 执行历史：行内展开，不再绕全局报告列表**

现状是「历史」按钮跳 `reports?kind=runner&keyword=任务名`——跨两页、靠关键字模糊匹配
（任务改名就搜不到）。落地：

- 后端补 `GET /api/v1/projects/:id/pipeline-runs?ciTaskId=&page=&pageSize=`（此前**没有**
  run 列表接口，详情只能按 id 点进；筛选用 `params` 数组模式照 `dashboard.ts`）。
- 任务列表行内展开：展开时按 `ciTaskId` 拉最近几条 run（#序号 / 状态 / 触发源 / 耗时 /
  开始时间），点某条**同页 SPA 跳转**直达 `/pipeline-runs/:runId`——用户确认过不做新开
  tab，与现在点「执行」后的跳转同款形状。
- 全局报告页保留「跨任务统一视角」这一个用途（从侧边栏进）；`openHistory` 的
  keyword 跳转删除。

**③ 日志：实时与历史都在 run 详情页，补整份下载**

现状已经支持（Runner 合流采集 stdout/stderr 按 offset 上报，run 详情页默认 tab 就是
log，SSE 水位事件驱动增量拉；终态后同一位置看全量）——用户不知道，入口可见性问题。
落地：log tab 头部加「下载日志」按钮，后端加
`GET /pipeline-runs/:runId/logs/download`（text/plain + attachment，一次 join 全部
chunk；日志几 MB 可接受，读路径与现有 logs 接口同一条）。

**④ 定时任务与通知**：见 8.7 的范围扩写（P4.5-12 批次），本批不重复记录。

**明确不做（本批）**

- 不改 Runner 协议与日志上报格式（下载是平台侧读路径的补全）。
- 不做日志的关键字过滤 / 高亮 / 级别折叠——P10 的大响应体口径变更再议，本轮只补下载。
- 任务列表不内嵌迷你日志预览：要看日志点进 run 详情页，那里才是日志的完整视图。

**实现状态（2026-09-01，P4.5-15 已落地）**

- **① 独立编辑页**：`CiTaskDrawer.tsx` 删除，新组件 `CiTaskEditor.tsx`；路由
  `/projects/:pid/repo/tasks/new` 与 `/:taskId`（`main.tsx`）。分区顺序照 8.12：基本信息 →
  代码来源 → 环境变量（`KeyValueEditor`，上移）→ 执行步骤（Monaco）→ **高级折叠区**
  （`<details>` 复用 panel chrome，默认收起：沙箱档 / Runner 标签 / 镜像 / 缓存 /
  报告上报 / 超时 / 串行 / 启用——默认值开箱即跑）→ `ResourceSchedules` 调度面板 →
  通知面板（两块从 P4.5-12 的临时抽屉搬进来，组件未重写）。保存回列表页；「保存并执行」
  直达 run 详情页。
- **② 行内展开历史**：后端 `GET /api/v1/projects/:id/pipeline-runs?ciTaskId=&page=&pageSize=`
  （`routes/pipelineRuns.ts`，params 数组模式照 `dashboard.ts`；`ciTaskId` 必填且先验任务
  归属——查错项目回 404 而不是空列表）。任务列表行首加展开箭头，展开拉最近 5 条
  （#序号 / 状态 / 触发源 / 耗时 / 开始时间），点某条同页 SPA 跳 run 详情页；
  `openHistory` 的 keyword 跳转已删，调度/通知从行内按钮移进编辑页。
- **③ 日志下载**：`GET .../pipeline-runs/:runId/logs/download`（`text/plain; charset=utf-8`
  + `attachment`，文件名 `run-<N>.log`，一次 join 全部 chunk——读路径与增量接口同一条，
  只是独立路由而不是 `?download=true`：envelope JSON 与裸文本流的消费形状不同，合一个
  handler 只会互相背约束）。log tab 头部加下载按钮（`<a href>` 直连，不经 axios）。
- **`enabled` 勾选的结论（本轮验收问题「这个勾选是干什么的」）**：它有**三处真实作用**——
  `triggerCiTaskRun` 拒绝触发（`lib/trigger.ts`）、勾选执行的推荐查询排除停用任务
  （`ci-tasks/recommend` 的 `JOIN ci_tasks t AND t.enabled`）、列表页禁用「执行」按钮与
  「已停用」chip。语义定位是**封存而不是删除**：删除会级联掉全部执行历史（迁移 038 刻意
  如此），停用只拒绝新触发、历史与通知都保留——删除确认框里「要留历史就停用」指的就是它。
  **保留**，但从 limits 分区挪进高级折叠区（8.12 的分区重排顺带完成），并补
  `ciTasks.enabledHint` 把上面这句话在界面上说清。
- **凭据空池的就地创建（2026-09-02 验收补充）**：新建任务遇到空凭据池时，提示文案旁常驻
  「新建凭据」按钮，弹 `GitCredentialModal`（从 `RepoCredentials` 抽出的共享组件，两处
  同一张表单）就地创建——跳去凭据页会丢掉已填的任务草稿，弹窗不丢；存完自动刷新凭据池并
  选中新凭据（下一步就是选它，不让用户把刚回答的问题再答一遍）。
- **新建页的调度入口（2026-09-02 验收补充）**：调度行需要已存在的任务 id 作目标，新建页
  于是挂同形状的占位面板：点「新建调度」先把当前表单**静默保存**（必填校验与「保存」同
  一条），路由原地 replace 成编辑页（同组件同位置，表单状态不丢），`ResourceSchedules`
  带 `autoOpenCreate` 挂载并自动打开新建抽屉——用户不需要再点一次。


### 8.13 报告体验改版：合并视图 + 总报告列表 + 免登录分享（2026-09-02 验收反馈，五项）

用户对仓库执行报告的验收反馈五项。核心口径变化：**报告列表从「只有套件」扩成总报告列表**
（套件 + 仓库执行），**run 详情页的报告视图是唯一报告视图**（用例 tab 撤销，信息并入），
**分享是报告的固有能力**（免登录只读链接）。

**① 仓库执行详情页的面包屑（缺陷，另记 `issue_fix/问题记录-仓库执行详情页面包屑.md`）**

`pipeline-runs/:runId` 独立路由不在 `repo/*` 之下，靠 `SECTION_ALIASES` 归组点亮侧边栏；
但 ProjectShell 的 detail 页判定漏了它——面包屑停在不可点的「仓库模式」标题上，进了执行
详情回不去任务列表。修法：`pipelineRunOpen` 进 detail 判定，面包屑长出
`{项目}/仓库模式（可点回 /repo）/#序号`（run 号经 `setDetailTitle` 通道上推）。

**② ③ 报告视图合并（撤销用例 tab）**

- run 详情页三 tab：日志 / 报告 / 产物（`?tab=cases` 旧链接落回默认，不硬跳）。
- 报告 tab = 合并视图 `PipelineReportBody`（详情页与分享页共用一个渲染）：
  - **概要读数**：通过率 / 用例总数 / 通过 / 失败 / 跳过 / 耗时 / 排队（「总和信息」；
    计数以 run 行上的服务端重算值为准，减法只有一份）；
  - **timeline gantt**（原 cases tab 的能力并入：全部行有时间戳才画，junit/旧 Runner
    自动缺席）；
  - **allure 用例明细**：标题（name）+ 完整名（fullName）+ **注释**（`description`，
    pytest docstring 落这里——解析器本轮新收的字段）+ 参数化 + **前置/后置 fixture**
    （container 的 before/after 按 children 归位到 case——pytest 用户的报告里 fixture
    是「执行了什么」的主要事实）+ 步骤树（步骤耗时）+ **步骤日志**（文本类附件就地展开
    读，图片缩略图，其余下载链接）+ 失败详情 + 附件；分组行带「x/y 通过」读数；
  - **降级**：没有 allure 包（junit / 格式 none）时回 `pipeline_run_cases` 纯列表——
    合并视图不把 junit 任务挤成空白页。
- 任务列表行内展开历史补计数列（项数 / 通过 / 失败，与执行记录页父执行列表同列）。

**④ 仓库执行进总报告列表**

- `GET /suite-reports` 扩成两源 UNION（`suite_executions` + `pipeline_runs`），列名归一
  （`kind` 区分、`target_name` 统一），外层统一过滤排序分页；runner 状态按 execution_index
  同一口径归一（claimed/cancelling→running，aborted/timed_out→failed）。
- 前端报告列表：来源筛选（全部 / 套件 / 仓库执行）+ 类型 chip + 计数列（项数 / 通过 /
  失败）+ 状态筛选补排队/执行中/已取消；runner 行点击跳 run 详情页。
- 语义边界：runner 的报告名是「任务名 #序号」（任务删除级联掉 run，那行随之消失——与
  套件快照不同，迁移 038 既定语义）；「用例 tab 被合并」不适用于报告列表，它本来就没
  有 tab。

**⑤ 报告分享（免登录只读）**

- 迁移 043：`report_shares`（target_type 'suite'|'runner' + target_id 多态无 FK + 192-bit
  base64url token + **部分唯一索引**「一个目标同时只有一条有效分享」；撤销 = UPDATE
  revoked_at，索引立刻放行下一条）。
- 项目内路由 `POST/GET/DELETE /projects/:id/report-shares`（write 权限创建/撤销，读走
  viewer）；公开路由 `GET /public/report-shares/:token`（不走 JWT，与 Webhook 公开路由
  同款位置）回**与站内同一份拼装**的报告视图（`lib/reportPayload.ts`：套件报告与仓库
  执行报告的装载从路由里抽出来，两处共用——两份 SQL 的那天就是「分享出去的与站内数字
  对不上」的那天）+ 公开附件路由（步骤日志/截图免登录可读）。
- 前端：`ShareReportButton`（未分享 = 一个按钮；已分享 = 链接框 + 复制 + 取消分享，
  进页面先查现状，不让人以为每次点击换链接）挂在套件报告详情与 run 详情页头；
  `/share/reports/:token` 公开路由在 `Protected` 之外，极简外壳（无侧边栏、无导航、
  无写入口），套件报告公开态关掉成员证据抽屉（那要按用户鉴权）。

**明确不做（本批）**

- 分享页不做实时日志 / SSE：分享的是**报告**（终态读数 + 用例明细 + 附件），进行中的
  run 分享出去看到的也是当时快照。
- 不给分享链接加过期时间 / 密码：第一版只有「撤销」一个开关；有效期是运营需求，等真实
  使用反馈再加，不预造配置面。
- allure `descriptionHtml` 不渲染（Markdown 渲染器不进平台，边界 19）；`description`
  按 pre-wrap 纯文本展示。
- 报告列表不做跨项目聚合：`project_id` 作用域不变（RBAC 的最小单位）。

**实现状态（2026-09-02，五项全部落地）**

- 后端：`lib/allureReport.ts`（description + fixture 归位）、`lib/reportPayload.ts`
  （套件/仓库执行报告装载 + 报告视图缓存与附件读取，从 `routes/pipelineRuns.ts` 迁入）、
  `routes/reports.ts`（两源 UNION + source 筛选）、迁移 043 + `routes/reportShares.ts`
  + `index.ts` 注册、`models/types.ts`（ReportShare mapper）。
- 前端：`ProjectShell`（面包屑）、`PipelineRunPage`（三 tab + 合并视图 + 分享）、
  `SuiteReports`（总报告列表 + 公开态）、`CiTaskList`（历史计数列）、`ShareReportButton`
  / `ShareReportPage`（新组件）、`main.tsx` 公开路由、`api.ts` / `i18n.ts` / 
  `design-system.css` 配套。
- 缺陷记录：`issue_fix/问题记录-仓库执行详情页面包屑.md`（①的缺陷档案）。


### 8.14 报告与任务列表可读性改版（2026-09-02 验收反馈第二批，十项）

同一天的第二批反馈，全部落在**读**这一侧：报告与任务列表的信息已经在页面上，但读不出来。
八项是体验改造，两项是缺陷（③ 与 ⑦ 的后端根因），后者另记 `issue_fix/`。

**① 时间轴可读性**（`PipelineRunPage.TimelineGantt`）

三件事：**刻度落在整齐的时间边界上**（`niceStep` 从 100ms…10min 的候选表里挑「≥ 目标间隔
的最小整齐值」，超出候选表按 10 分钟向上取整——退回 `span` 会让图只剩首尾两个标签）并配
**同位置的背景网格线**；**空档显式画出来**（扫全部区间求真空段，≥ 跨度 4% 的画成虚线边界
的灰带并标注时长——原先「最右边孤零零一块、中间大片留白」看不出中间是空的还是没画）；
**泳道按最早开始时间排序**（原先是服务端返回顺序）。刻度尺 / 网格层 / 泳道用同一个
`--lane-label` + `--tick-gutter` 对齐，`formatClock` 固定 24 小时制——图上写 `16:22:44`、
读数里写 `4:22:44 PM` 就没法互相对照。

**② 概要行结构化**：`.pipeline-summary` 的纯文本混排换成 `.pipeline-facts` 的**带标签事实
格**（状态 / 阶段 / 提交 / 触发 / 结果，竖线分隔）；计数从一句拼接文本换成四个 chip，失败
数用 `chip-fail`（语义色的本义用法）。排队原因与 `run.error` 移到 `.pipeline-notes` 整行——
它们是整句，挤进事实格读不完。

**③ 报告列表按文件收缩**：分组行（parentSuite › suite = 目录 › 文件）可折叠，默认**只展开
有失败的分组**；搜索/筛选时默认全展开（结果藏在收起的分组里等于没搜到）；「全部展开/收起」
一个按钮两态。分组读数补失败数标红——收起状态下就能定位到文件。

**④ 列表显示 case 的 title 而不是函数名**：`caseTitle` 的回落链是
`@allure.title` → docstring 首行（+ 参数化后缀，两条参数化用例的 docstring 相同，不带后缀
分不出是哪条）→ 函数名。函数名不丢，退成副标题（`caseSubName`）——「去仓库里搜哪个函数」
需要的正是它。判据是「`name` 去掉参数后缀后是否等于 nodeid 的函数名段」，因为 allure 在
没有 title 时把 `name` 填成函数名。

**⑤ 展开区不再撑爆页面**：`.report-case-detail[data-scroll]` 限高 62vh 自滚动（只在内容确实
长时套：步骤 > 12 / 有堆栈 / 有日志附件 / 多个附件），表格因此永远还在视口里；步骤树的
caret 从**装饰**变成真按钮（`StepNode` 自持 open 状态，整行可点、键盘可达）——原先一个 100
次迭代的循环步骤永远全展开。

**⑥ 报告内搜索 + 状态筛选**：命中面是标题、nodeid 与分组名（= 文件路径）；状态筛选四值
（全部/失败/通过/跳过），`failed` 收 broken/unknown/interrupted——它们都是「没通过」。
allure 表与 junit 降级列表同一套控件与口径，右侧常驻「命中 x / 共 y」。

**⑦ 任务列表主任务补状态与规模**：新增「最近执行」列（最近一条 run 的状态 + 可点 #序号 +
执行总次数）。`activeRun` 只在有在途 run 时存在，所以跑完的任务收起来后既没有状态也没有
规模。服务端同一条查询多带一段 LATERAL（`lastRun` / `runTotal`），不额外请求。

**⑧ 任务列表补搜索**：`GET /ci-tasks` 加 `keyword`（`ILIKE` 命中名称 / 描述 / Git 地址），
前端 300ms 防抖 + 改词回第一页 + 空态给「清空筛选」。就地过滤只筛得到当前页，而「我那条
任务在第几页」正是要搜索的原因。

**⑩ 步骤日志展示**：allure-pytest 的 `log` / `stdout` / `stderr` 捕获挂在**测试级**附件上，
原先混在「附件」清单里、还要点一下 `<details>` 才展开。现在拆成「执行日志」块并默认展开
（`AttachmentView` 的 `defaultOpen`），步骤级的同名附件同样默认展开；截图等其余附件保持
点开。**并补一条缺席解释**：报告包里一个附件都没有时，页面直接说明原因是任务命令带了
`--allure-no-capture`（当前 e2e 任务的命令正是如此）——不说的话它读起来就是「平台没收集
日志」。

**⑪ 失败状态列上色**：状态列从纯文本换成设计系统的 `Status` 原语（点 + 词）。颜色说结论
（`reportRunStatus`：broken/unknown/interrupted 都是失败色），**词仍用 allure 的原词**
（错误 / 中断 / 未知）说为什么。junit 降级列表同款。

**明确不做（本批）**

- 用例表不做虚拟化：按文件收缩之后，一屏渲染量由展开的分组决定；真正需要虚拟化的门槛是
  单文件上千条用例，那时先要的是分页而不是虚拟滚动。
- 时间轴不做缩放 / 刷选：空档标注 + 整齐刻度已经回答了「哪段慢、哪段空」；缩放要引入一套
  手势与状态，等真实使用反馈。
- 不改 `pipeline_run_cases` 的存储形状：标题、docstring、附件名都在 allure 包里，报告视图
  按需解析（边界 19：不 vendor allure 的展示层，也不把它的字段抄进平台表）。
- 步骤日志不落库、不进 SSE：它是报告包内的文件，走既有的附件路由按需读。

**实现状态（2026-09-02，十项全部落地）**

- 后端：`routes/ciTasks.ts`（列表 keyword + 第二段 LATERAL + 列表专属 SELECT）、
  `models/types.ts`（`CiTask.lastRun` / `runTotal` + mapper）。
- 前端：`PipelineRunPage.tsx`（事实格概要 / 时间轴重画 / 分组折叠 / 标题优先 / 搜索筛选 /
  步骤可折叠 / 执行日志块）、`CiTaskList.tsx`（搜索 + 最近执行列）、`design-system.css`
  （`.pipeline-facts` / `.timeline*` 重写 / `.report-grid-cases` / `.col-lastrun` /
  `.chip-fail`；删 `.pipeline-summary`、`.timeline-wrap`）、`api.ts` / `i18n.ts` 配套
  （双语各 +18 键、删 1 键）。
- 分享页（`ShareReportPage`）自动同步：报告主体仍是 `PipelineReportBody` 一份渲染。
- 缺陷记录：`issue_fix/问题记录-报告与任务列表可读性.md`（③ 的分组折叠属体验改造，其中
  两项是真缺陷：任务列表 LATERAL 列被 `TASK_SELECT` 的投影吞掉导致 `activeRun` 从未出现、
  步骤树 caret 只是装饰点不动）。

### 8.17 验收反馈：通道可选 / 通知链接 / 上报记录列 / 用例树×任务报告（2026-09-03）

第四批（当日第二批）反馈七项：三项缺陷（① 接口列表性能、② 容器档 `--storage-opt`
兼容、⑤ 分享页成员证据）归
`issue_fix/问题记录-验收20260903-接口列表性能与容器兼容.md`；四项功能调整记在这里。

**③ 容器档通道（命令模式 / Socket 模式）可选**：通道本来就是 Runner 的部署项
（`APITRACK_RUNNER_DOCKER_TRANSPORT=cli|api`，选的是「这台机器怎么连它本地 daemon」，
不是任务属性），这一轮补齐「选得见」的三块：Runner 注册自报 `docker_transport`
（迁移 046，只在容器档可用时报，空串 = 没自报）；Runner 池面板的沙箱列显示
「container · 命令模式（docker run）/ Socket 模式（Engine API）」；签发 Token 的表单
加通道选择，部署命令带上对应的 export 行——选择发生在部署那一刻，注册回来即自报
同一个词。任务配置不参与（任务的 sandbox 只选档位 process/container，通道对任务
不可见）。

**④ 通知模版支持报告链接**：套件与 CI 任务两套模版（默认模版与自定义模版同款）新增
`{{reportUrl}}` 占位符——套件指向报告详情页、CI 指向 run 详情页。通知由调度器进程
投递（没有请求上下文），根地址取 `PUBLIC_BASE_URL`（与 JobSpec 的 `APITRACK_URL`、
产物直链同一条纪律）；未配置时渲染为站内相对路径（.env.example 与两处模版提示写明）。
默认模版各加一行「链接 / 详情」。

**⑥ 上报记录明细删三列**：展开 run 后的请求明细表删「状态码 / 耗时 / 状态」——这张表
回答「哪条用例的哪个请求打到了哪条路径」，执行结论属于仓库侧的报告视图，在这里是
噪声（用户确认）。

**⑦ 用例树 × 任务报告**：树上的用例行从「SDK 请求桩的推导」升级为「最新任务报告的
结论」。匹配键 = nodeid 去掉参数化后缀（SDK 的 case_key 这么来，allure 的
`guessed_case_key` 就是 nodeid；迁移 047 的表达式索引吃这个正则）——**读时关联
（LATERAL），绝不回写**（边界 13 的「B/C 不回写树」保持：junit 的 `classname::name`
对不上就显示没有报告，不产生数据变更）。落点：

- 树行：新增「最近任务」列（任务名 #序号，替代删除的「请求数」列，用户确认删除）；
  状态与「最近执行」优先读 `lastReport`（一次 run 的多条参数化行折成一条：有
  failed/error 即失败、否则有 skipped 即跳过、否则通过），没有匹配报告行时回退
  `lastResult` / `lastRunAt`（原 SDK 口径）。未归位分组同款。
- 用例抽屉（点用例行）新增三块：**最新任务报告**（任务/序号/状态/耗时/失败信息，
  树上状态列的出处）；**用例内步骤**（报告包里的 allure 步骤树，复用 run 详情页的
  `StepTree`；junit-only 没有包，写明原因）；**请求序列**（那次 run 的 SDK 上报按
  seq 排序，从哪个接口下点开就高亮打到该接口的请求行——`.report-step-hit` 左缘
  accent 选中态——回答「该接口所在的步骤」）。
- 服务端：`GET /repo-cases`（树）、`/repo-cases/unplaced`、`/repo-cases/:caseId`
  三处接同一段 `LATEST_REPORT_LATERAL`（单一正则出处，与迁移 047 逐字相同）；单用例
  路由另带报告包步骤树（`reportPayload` 的同一个装载器与缓存）与请求序列（上限 200）。

**实现状态（2026-09-03，落地）**：迁移 046（runners.docker_transport）与 047
（pipeline_run_cases 归一 key 表达式索引）；服务端 `runners.ts`（注册收
docker_transport）、`alerts.ts`（reportUrl + 默认模版行）、`ingest.ts`（三路由的
LATERAL + latestReport 拼装）、`reportShares.ts`（公开证据三端点，见 issue_fix ⑤）；
Runner 侧 `registry.ts`/`client.ts` 自报通道、`executor/container/{runtime,cli,api}.ts`
的 storage-opt 降级（见 issue_fix ②）；前端 `RunnerPoolPanel.tsx`（通道选择 + 池显示）、
`SuiteWorkspace.tsx`/`CiTaskEditor.tsx` 的模版提示文案、`IngestRuns.tsx`（删列）、
`RepoCaseTree.tsx`（列替换 + 抽屉改版）、`EndpointList.tsx`（见 issue_fix ①）、
`SuiteReports/SuiteRunDrawer/FlowRunDrawer/NestedStepList/ShareReportPage`（shareToken
贯通，见 issue_fix ⑤）、i18n 两语言。`pnpm check` / 构建与手工验收按惯例留给用户。

### 8.18 P4.5 验收结论（2026-09-03）

**用户验收通过**（P4.5-1 ~ P4.5-15 全量，含 8.9 验收门槛 21 项、8.13 ~ 8.17 的
报告体验改版 / 分享 / 可读性 / 幂等口径 / 树×报告 / 通道可选 / 通知链接等验收后增量）。
验收期间发现的缺陷已全部修复并归档至 `issue_fix/`（索引见 `issue_fix/README.md`），
其中同日落地并复验的关键项：产物直传全链路（五缺陷叠加）、`/ingest` 迁移 045/048
约束形态与按 commit 折行（049 三列键失守）、树×报告匹配键形态（allure fullName
逆变换）、勾选执行键形不匹配致全量跑、容器档取消不杀容器（含心跳间隔 30s → 5s）、
容器档 `--storage-opt` 兼容降级、接口列表 254KB 拉取、分享页成员证据三端点、
SDK xdist 多进程重复上报。P4.5 至此收口，进入 P5（平台作为 MCP Server 对外暴露，见 9.0）。

### 8.17 验收 2026-09-03 第二批（一缺陷一口径两交互）

**① 树×报告匹配键形态缺陷**：allure-pytest 的 `fullName` 是 `pkg.Mod#test`（点号 + `#`），
不是 nodeid 的 `path/to.py::test`——迁移 047「guessed_case_key 就是 nodeid」的假设不成立，
读时关联永远匹配不上。修法两侧且**绝不回写**：Runner 侧 `normalizeFullName` 把带 `#` 的
fullName 逆变换回 nodeid 形态（新上报直接命中 047 索引）；服务端 `LATEST_REPORT_LATERAL`
加历史行兼容分支（`LIKE '%#%'` 门 + 同一个逆变换，读时做）。junit 的 `classname::name`
best-effort 语义不变。

**② 通过率口径（用户改口径）**：= **passed / (passed + failed)**，跳过不进分母——被
skip 的用例没有给出结论。error（allure broken/unknown）已算失败：Runner 映射、
`completePipelineRun` 计数、树侧 LATERAL 判定三层一致，本轮未再动。落点三处：run 详情
页 `judgedCount`、报告列表 UNION 两侧 `pass_rate`（守卫条件同步改，全 skip 读 null）、
趋势/汇总/dashboard 原本就是这个口径。

**③ 任务编辑页保存体验（对齐套件编辑）**：表单快照 canonical 对比出 dirty；nav guard
离开确认；标题旁 `chip-warn`「未保存 · ⌘S 保存」；`Cmd/Ctrl+S` 保存（拦浏览器对话框）；
保存成功与「新建调度」静默保存后快照刷新使 dirty 失效（后者原地路由切换另需显式清
guard）。`RepoPageHead.title` 放宽为 `ReactNode`。

**④ 任务列表在途展示**：名字列删掉在途标签（状态词 + #序号）；「最近执行」列优先显示
在途 run（并行多条 hover 说全 + 执行总次数），无在途回落最近结论。

缺陷细节归 `issue_fix/问题记录-P4.5验收20260903第二批.md`。

### 8.16 上报幂等口径变更：按 commit 折行（2026-09-03）

用户改口径：同一 commit 的每次执行都新增一行 `ingest_runs` 不可接受（实测一个 commit
报 8 次、`ingest_records` 翻 8 倍，长期会肿胀）。快照语义以 commit 为单位——同 commit
的重复执行不改变快照内容，只更新「最近什么时候跑的、结果是什么」。

**口径**：`/ingest` 幂等键折成 `(repository, commit)`——插入侧 `ci_run_id` 按 `''`
参与冲突判定，同 commit 任意上报（不管来自哪次 CI 执行）都命中同一行；列保留
「最近一次上报的 CI 来源」。新列 `ci_execution_count` 记该 commit 在 CI 上的执行
次数（run id 变了才 +1；同一执行的重试/重投不推；SDK 直跑不推——数执行不数调用）。

**缝合链路调整**：`completePipelineRun` / `abortPipelineRunAfterLease` 对
`pipeline_runs.ingest_run_id` 的反查从 `ci_run_id = run.id` 改为
`(project, commit_sha)`——折行后同一 ingest 行被同 commit 的多条 run 共享；
`markCaseFilterNotRun` 的 `last_ingest_run_id` 判据语义不变（所有上报推同一行）。
`APITRACK_CI_RUN_ID` 仍注入用户脚本（SDK 需要它报执行来源），但不再是幂等键。

**实现（迁移 045）**：旧行就地合并——留最早那行（diff 定局），`execution_index`
行先删同组多余再改指保留行（防撞 `UNIQUE(kind, detail_id)`），
`repo_test_cases.last_ingest_run_id`、`repo_case_endpoints` 的 run 引用折到保留行，
其余行删除（`ingest_records` 的 CASCADE 收回翻倍数据：350 → 69 行）。本机 dev 库
16 行折成 4 行，计数按最新快照回填。

**前端**：`IngestRuns.tsx` 原 `ciRunId` 展示位改为「执行 N 次」
（`repoCases.ciExecutionCount`），i18n 两语言。缺陷记录归
`issue_fix/问题记录-P4.5报告体验验收第三批.md` ⑥（含改口径前后的完整推理）。

### 8.15 报告体验验收第三批（2026-09-02，七项）

第三批反馈：四项缺陷（① 日志/附件一直「正在加载」、③ 失败计数对不上、④ 产物大小全
0 B）、三项交互调整（② case 明细改抽屉、⑤ 报告默认全收起、⑦ 最近执行列后移），加一项
疑问（⑥ 上报幂等口径，初判为符合设计；2026-09-03 用户改口径，处置移至 8.16）。缺陷细节
归 `issue_fix/问题记录-P4.5报告体验验收第三批.md`，这里只记交互决策。

**② case 明细从下拉展开改为抽屉**：报告用例表与 junit 降级列表的行点击不再展开内嵌
`detail-row`，改为 antd `Drawer`（760/640 宽，标题 = case title，`extra` 放 `Status`）。
展开行会把后面的行推走、收起后滚动位置回不来；抽屉体自滚动，列表保持原位。原
`data-scroll` 限高方案（8.14 ⑤）随之删除——抽屉体就是那个滚动容器。

**⑤ 报告进入时全部分组收起**：8.14 ③ 的「有失败的分组默认展开」撤销——失败数在收起
行上已有红字读数，展开哪个文件由人决定；搜索/筛选时仍默认全展开（结果藏在收起的分组
里等于没搜）。

**⑦ 任务列表列序**：「最近执行」列从名字列后移到「执行分区 / 超时」之后——配置列读
完了再读结论。

**⑥ 上报幂等口径**：初判为符合设计（幂等键 `(repository, commit, ci_run_id)`，
commit 只去重同一次 CI run 的重投）。2026-09-03 用户改口径（同 commit 不该每次都
入库、数据会肿胀），改为按 commit 折行——见 8.16。

**实现状态（2026-09-02，落地）**

- 缺陷侧（见 issue_fix 记录）：`allureReport.ts` 附件引用改带 `source`（zip 内实体名）；
  迁移 044 `pipeline_run_cases.external_id` + 唯一键加宽，`completePipelineRun` 计数把
  `error` 归入失败；`runners.ts` 产物上传落库读 `guard.bytesWritten`；前端
  `AttachmentView` 去掉丢弃在途响应的 `alive` 旗子、`loadAttachment` useCallback 固定
  身份（详情页与分享页两处）。
- 交互侧：`PipelineRunPage.tsx`（抽屉 / 默认收起）、`CiTaskList.tsx`（列序）、
  `design-system.css`（删 `data-scroll` 规则）、`api.ts`（`AllureReportAttachment`）。
- Runner：`report/allure.ts` 上报 `external_id`（结果文件 uuid）。
- 本机 dev 库已把现存 artifacts 行的 `size_bytes` 按磁盘文件回填（一次性数据修正，代码
  不含迁移逻辑）。


---

## 九、P5 — MCP: 平台对外暴露（Server 模式，4 周，范围与边界见 9.0）

### 9.0 P5 范围与边界（2026-09-03 确认，2026-09-04 扩界：兼容姿态 / 工具面 43 个 / 边界 3 动作分级 / scope 三值）

**问题**

P0–P4.5 把「接口 / 用例 / 流程 / 套件 / 报告」这套资产做完了，但**创建它们的唯一途径是人在
界面上点**。三个后果：

1. **已有接口文档进不来第二次**。首次可以走 OpenAPI 导入（`lib/importers.ts`），但「文档改了
   一个字段」之后没有增量通道——人得自己找到那条接口再改一遍。
2. **外部工具无法驱动平台**。团队已经有需求管理、代码仓库、AI 工具链，它们全都知道「这次改
   了哪个接口」，却没有办法把这件事说给平台听。
3. **AI 只能在平台外面看着**。想让模型读一次执行证据再写一段校验脚本，模型手上既没有响应体，
   也没有平台的 `ctx.*` 契约——它写出来的代码在这里跑不起来。

P5 要的是**把平台自身能力暴露成 MCP 工具，让平台之外的 AI / 工具直接驱动它**。

**核心模型**

**平台是 MCP Server（工具提供方），不是 MCP Client。一条无状态 `POST /mcp` 端点，
`apimcp_` Token 鉴权，Token 带 `read` / `write` / `execute` 三种 scope；读工具照搬既有
mapper 出数，写工具复用既有校验后落库，执行工具只跑已保存的命名资产；不可逆动作（delete）
走 MCP 协议原生的 MRTR 确认回合；执行证据在读取时重新脱敏。**

三条与既有实现的关系必须一开始就说清，否则会写出第二套并行机制：

- **不做「平台当 Client 去调外部 MCP Server」**。那是**相反方向**：注册外部 Server、发现工具、
  在流程节点里调它（交互文档 3.10 主体、原 9.1 的 `mcp_servers` 表、5.0 的「MCP 工具节点」）。
  它与本阶段共享名字「MCP」但不共享任何一行代码：本阶段是被调方，那个是调用方。**本阶段
  范围内不实现，`mcp_servers` 表不建**——留在 P10 之后按需排期。原 9.1 把两个方向的表写在一起
  是文档缺陷，本节纠正。
- **不新建审计表**。原 9.1 的 `mcp_tool_calls(id, flow_execution_id, …)` 那个
  `flow_execution_id` 只在「平台当 Client」时有值可填（调用发生在流程节点内）；外部 agent 调
  进来时没有任何 flow execution。审计走 P4.5-8 已有的 `audit_logs`（迁移 039b）——它已经有
  `(project_id, user_id, action, target_type, target_id, detail, ip)`、4KB 转储护栏与
  fire-and-forget 包装（`lib/audit.ts:46,67`），且 `detail` 绝不放 secret 的纪律已经立好。
- **不引入 session / 状态**。MCP 规范 `2026-07-28` GA 版已把协议核心改成无状态：移除协议级
  session、移除 GET 流端点，每条消息是一次自包含 POST。这与现有无状态 Fastify + pg 完全同构
  ——不需要 session 表、不需要粘性会话、不需要 Redis。**这是本阶段范围能压缩到一张表的
  根本原因。**

**已确认的边界决策（16 项）**

1. **三种 scope，不是三个端点（2026-09-04 扩界）**：Token 上带 `scope TEXT[]`
   （`read` / `write` / `execute`），一条 `/mcp` 端点按 scope 决定 `tools/list` 回哪些工具、
   `tools/call` 放不放行。不给写/执行工具单开路径——路径分裂之后「同一个 Token 在两条路径上
   权限不同」将成为可能，而 scope 在 Token 上是单一事实。签发默认只给 `read`，`write` 与
   `execute` 必须显式勾选。
2. **写与执行工具每次调用都重跑 `canAccess`，不信 Token 自带的权限**。Token 记 `created_by`；
   每次写/执行调用都用那个 user 重跑一遍 `lib/rbac.ts:7` 的 `canAccess(user, projectId,
   true)`。签发者被降成 `viewer` 或被移出项目后，他的 Token 立刻写不动——**权限的事实在
   `user_project_roles`，Token 只是一把钥匙，不是一份权限快照**。这一条同时决定了 Token 不存
   角色副本：存了就会与那张表分叉。
3. **动作分级取代一刀切（2026-09-04 重写；原版把 execute 与 delete 整类排除，理由是「agent
   没有『看到后果再决定』的能力」——MRTR 之后这个前提不成立，确认是协议回合而不是入参）**：
   - **可逆写**（全部资产的 `create_*` / `update_*`）：`write` scope 直接执行、全审计，幂等键
     沿用（`(project, method, url)`、`(endpoint, name)`、`(project, name)`、`(resource,
     cron, target)`）。
   - **不可逆写**（全部 `delete_*`）：`write` scope + **MRTR 确认回合**（9.4.1）——
     `scanUsage`（`environments.ts:48`）的依赖清单就是确认内容，服务端返回 `resultType:
     "input_required"`，客户端把问题转述给人、人确认后带 `inputResponses` 重试原调用才执行。
     **`force` 不再是入参**：agent 照 409 提示「自动补 force=true」的路径从根上消失——不确认
     就删不掉。
   - **执行**（`run_endpoint` / `run_case` / `run_flow` / `trigger_suite_run` /
     `trigger_ci_task_run`）：独立 `execute` scope + 在途去重（同目标已有排队/在途 run 时直接
     返回那个 run id，不排第二个）+ 审计。**只跑已保存的命名资产、不接受任何 overrides**——
     「执行已保存资产」与「凭空构造请求」（内联 method/url/body 的自由执行）是两件事，后者
     仍然不给。
   - 触发生效后目标自己的 `notify_config` 照常发通知：与人手点「运行」、与 cron 触发同源，
     那是人配的规则在说话。
4. **写工具拒绝字面量 secret，只接受 `{{变量}}` 引用**。`auth`、`headers`、`body` 里出现疑似
   凭据的字面量（`Authorization` 头有值、字段名命中 `token|secret|password|key`）一律返回
   工具错误并指向「先在环境里建一个 secret，再用 `{{name}}` 引用」。理由是**对话记录会留在
   平台之外**：agent 平台自己会存 transcript，模型厂商也可能存。让凭据字面量流经工具入参，
   等于把 secret 抄进一份平台管不着的日志。这一条与 4.6 的「secret 永不离开服务端」同向。
   CI 任务的仓库凭据同理且更严：**只引用既有凭据条目，永不经工具入参创建或传递**。
5. **执行证据在读取时重新脱敏，`store_plaintext` 对 MCP 不生效**。执行记录的脱敏发生在
   **写入时**（`lib/run.ts:244-246`）；项目开了 `store_plaintext`（迁移 019）之后库里存的就是
   真凭据。那个开关当初的理由写在迁移注释里——「让内部团队读到签名请求携带的确切凭据」，
   **内部人读，不是外部 agent 平台读，更不是云端模型读**。所以 MCP 读执行证据时一律用该执行
   环境**当前的** secret 值重跑 `sanitizeValue` / `sanitizeHeaders`。
6. **脱敏无从进行时不返回 body**。`executions.environment_id` 是 `ON DELETE SET NULL`
   （迁移 002），环境被删后只剩 `environment_name` 快照——此时**无从得知要遮哪些字符串**。
   这种情况返回 `bodyOmitted: "环境已删除，无法按当时的 secret 脱敏"` 而不是原文：失败要朝
   安全那边倒。`store_plaintext` 项目的历史行同理（写入时就没遮过，环境还在就能重算，环境
   没了就不给）。
7. **工具入参是裸 JSON Schema，校验走已装的 `ajv`**。SDK 文档默认用 zod 写 `inputSchema`，
   但后端契约明令不引入校验库（`server-contract`）。SDK 导出 `fromJsonSchema` 且自带 ajv
   校验器，因此工具声明写 JSON Schema、校验用 P1-1 已装的 `ajv`——零新校验库。业务级校验
   仍复用路由里那套手写 `validate()`（见边界 8）。
8. **写工具必须复用路由的校验函数，因此要把它们提到 `lib/`**。`routes/endpoints.ts:63` 与
   `routes/cases.ts:28` 的 `validate()` 现在是模块内私有的。**这是本阶段唯一一笔真实重构成本，
   躲不掉**：校验逻辑有两份就等于两套语义，MCP 建出来的接口能过 MCP 的校验却存不进 REST 的
   形状。提取时不改行为、不改签名（仍返回 message string 而不是抛错），只挪位置。读工具反过来
   ——各自写 SQL，共用 `models/types.ts` 的 mapper（契约第 6 条认定的共享边界），
   **不重构现有 20 余条读路由**。
9. **契约工具是工具集里最重要的一个**。`get_script_contract` 返回 `lib/scriptContract.ts` 的
   `SCRIPT_CTX_SCHEMAS`（现在给 Monaco 做补全用，`routes/scripts.ts:109` 已有一条 REST 孪生
   路由）。没有它，模型会写出 `expect(res.body).toHaveLength(3)` 这种在平台里根本跑不起来的
   代码——**平台的脚本不是裸 JS，是一套 `ctx.*` 契约**。这份数据已经是机器可读的，直接复用。
10. **契约工具必须明说「脚本型断言已废弃」**。`Assertion` 类型上还留着 `script?: ScriptRef`
    字段（`models/types.ts:137`），而读取时会**静默过滤** `type === 'script'` 的项
    （`models/types.ts:1292`，P2-2.1 废弃）。模型看到那个字段会很自然地往里写，然后得到
    「保存成功、刷新就没了」。所以契约里写明：校验脚本只能进 `responseScripts`。
11. **端点路径 `/mcp`，不带 `/api/v1` 前缀**。与 `/ingest`（`routes/ingest.ts:149`）、
    `/runner/*`（`routes/runners.ts:159`）同款：那个前缀是给**平台自己前端**的版本化 REST
    面用的，而 MCP 的版本协商在协议层（`MCP-Protocol-Version` 头），再叠一层 `/api/v1`
    等于两套版本号指同一件事。
12. **`project_settings.mcp_enabled` 默认 `false`，关掉时端点对该项目 404**。不是「藏起前端
    入口」而是**服务端真的不服务**：一个默认开着的写入通道是安全默认值的反面。开关是项目级
    而不是全局，与 `store_plaintext`（迁移 019）同款——同一套部署里，一个项目愿意接 AI、
    另一个不愿意，是正常状态。
13. **只审计写入、执行与拒绝，不审计读取**。一次对话会产生 3~10 次读调用，那个量级的读日志
    是噪音，还会把 `audit_logs` 冲成一张日志表。要复盘的是「谁改了什么」「谁触发了什么」「谁
    被拒了」；delete 的 MRTR 确认回合同样落审计（确认即决策）。Token 的「还有人在用吗」由行上
    的 `last_used_at` 回答（照 `lib/ingestAuth.ts:77`：**不进业务事务**，业务回滚了不该让
    「用过」这件事消失）。
14. **Token 哈希存储，不加密**（照搬 P4 边界 17 的推理）：只需比对就该哈希，scrypt +
    `salt:digest` 格式与 `users.password_hash` / `ingest_tokens` / `runner_tokens` 一致。
    `token_prefix` 存明文前 8 位供列表辨认与候选集收窄（scrypt 是刻意昂贵的，全表比对会让
    鉴权耗时随 Token 总数线性增长）。吊销是软删留 `revoked_at`，且**部分索引排除吊销行**
    使吊销即时生效。三处实现（`ingestAuth.ts` / `runnerAuth.ts`）已经一模一样，本阶段是第
    三次照抄——**不抽第四层公共封装**，三份 40 行的具体实现比一层参数化抽象更好读。
15. **写工具是幂等的第一等公民，但不建幂等表**。`create_endpoint` 用
    `(project_id, method, url)` 判重后走「更新还是跳过」（复用 `endpoints/import` 的
    `conflictStrategy`，`routes/endpoints.ts:524`），而不是每次调用都插一行新接口。理由很具体：
    **模型会重试**——网络抖动、上下文截断、用户重述一遍需求，都会让同一个意图被调两次。
    不复用 `idempotency_keys`（迁移 039b）：那张表要求客户端自己带 `Idempotency-Key`，而
    模型不会带；按业务键判重不需要客户端配合。
16. **不做「AI 生成断言 / AI 根因分析 / AI 趋势洞察」**。原 9.2 把这三项列为「可选 / 后置」。
    本阶段的定位纠正了它们的归属：**平台不调模型，模型调平台**。这三件事在新模型下是
    「外部 agent 用只读工具读完数据后自己生成」，平台侧不需要任何新代码，也不需要配 LLM
    凭据。真正需要平台侧支持的只有一件——把这些数据用工具暴露出去，那正是 9.4 在做的事。

### 9.1 数据库迁移: 050_p5_mcp.sql

一张表加一列。原 9.1 计划的两张表按边界 1（`mcp_servers` 是反方向，不建）与边界 13
（审计复用 `audit_logs`，不建 `mcp_tool_calls`）撤销。

```sql
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,                -- scrypt，salt:digest（边界 14）
  token_prefix TEXT NOT NULL,              -- 明文前 8 位，辨认与候选集收窄用
  scope TEXT[] NOT NULL DEFAULT '{read}',  -- 'read' / 'write' / 'execute'（边界 1）
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,   -- 写权限的活体判据（边界 2）
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 部分索引：吊销行被条件排除，因此吊销即时生效（边界 14）
CREATE INDEX IF NOT EXISTS mcp_tokens_prefix_idx
  ON mcp_tokens (token_prefix) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_tokens_project_idx ON mcp_tokens (project_id);

ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS mcp_enabled BOOLEAN NOT NULL DEFAULT false;
```

`scope TEXT[]` 而不是 boolean 列：`ingest_runs.scope`（迁移 035）与 `workers.labels`
（迁移 027）已经是这个先例——当初留的「将来加 scope 不改表」这次兑现了：`execute` 在表结构
零改动的情况下加了进来，将来加第四种同样不需要动表。

`created_by` 是 `ON DELETE SET NULL`：用户被删后 Token 行还在（吊销记录要活过被引用方），
但边界 2 的活体判据取不到人——此时**写调用一律拒绝**，只保留 `read`。这不是降级容错，
是唯一正确的答案：没有人为这次写入负责。

**`mapMcpToken`**（`models/types.ts`，契约第 6 条）：返回 `id / name / tokenPrefix / scope /
createdBy / lastUsedAt / revokedAt / createdAt`，**永不返回 `token_hash`**。明文只在签发响应里
出现一次。

**`project_settings` 的行可能不存在**：那张表只在项目设置被 PATCH 过一次时才有行
（`routes/projects.ts:97` 的 upsert），所以 `mcp_enabled` 的读取必须按「无行 = false」处理
——照 `lib/run.ts:119` 读 `store_plaintext` 的写法（`Boolean(rows[0]?.…)`）。把开关接进那条
PATCH 时，新列要用 `COALESCE(EXCLUDED.mcp_enabled, project_settings.mcp_enabled)`
（与同一语句里 `store_plaintext` 同款），否则只改默认环境的一次 PATCH 会把开关顺手清成
`false`。

### 9.2 传输与端点

**协议版本**：MCP `2026-07-28`（GA，2026-07-28 发布）。该版本把协议核心改成无状态——移除协议级
session、移除 GET 流端点、每条消息是一次自包含 POST，且 `Mcp-Method` / `Mcp-Name` 头随请求携带
（网关可按头路由，不必解 body）。**这正是本阶段不需要任何状态设施的原因**（9.0「不引入
session / 状态」）。

**SDK**：`@modelcontextprotocol/server` v2 + `@modelcontextprotocol/node`。

**对 2025 老客户端的姿态（2026-09-04 定）**：`createMcpHandler` 默认 `legacy: 'stateless'`——
2025 系流量（`initialize` 握手、`Mcp-Session-Id`、无 per-request `_meta`）由**同一个工厂**每请求
新建实例无状态地服务，平台侧零 session 设施；老客户端的 `GET`（独立 SSE 流）与 `DELETE`（终止
会话）按规范答 405，纯工具型 server 不需要服务端主动推送。四道闸门在 SDK handler 之前做完，
兼容腿同样被罩住。对照智能体平台 `mcp-proxy`（`智能体平台-第三方接入接口文档.md` 第 3 节）：

| 智能体平台接入方式 | 协议年代 | `/mcp` 支持 |
| --- | --- | --- |
| `STREAMABLE_HTTP`（rmcp-soddygo 1.5.0） | 2025-06-18 Streamable HTTP | **支持**——默认兼容腿，零状态 |
| `SSE`（rmcp 0.10，传统 SSE + POST） | 2024-11-05 老传输 | **不支持**——SDK v2 明确「never serves the HTTP+SSE transport」，冻结版在 `@modelcontextprotocol/server-legacy/sse` 且已定 v3 移除；平台侧用 `STREAMABLE_HTTP` 方式注册 |

**新规范里用与不用的**：用 **MRTR**（delete 确认回合，9.4.1）与 `ttlMs` / `cacheScope`
（工具清单缓存提示，SDK 自动携带）。不用 Tasks 扩展（无长任务）、`subscriptions/listen`
（不做推送）、sampling / roots / logging（已废弃且从未需要）、OAuth（见下）。

**挂载方式（必须照这个写）**：

```ts
// routes/mcp.ts
const handler = createMcpHandler(() => buildMcpServer(/* 每请求一个实例 */));
const node = toNodeHandler(handler);

app.all("/mcp", async (request, reply) => {
  /* 鉴权在 Fastify 侧做完，身份挂在 raw request 上传给工具（SDK 读作 ctx.http.authInfo）。 */
  const identity = await authenticateMcp(request.headers.authorization);
  if (!identity) return failMcpUnauthorized(reply);
  /* Fastify 已经解过 JSON body，必须把它作为第三个参数传进去——否则适配器会去
     重读一个已经被消费掉的流。 */
  return node(Object.assign(request.raw, { auth: identity }), reply.raw, request.body);
});
```

三条不能改的细节：

- **不用 SDK 的 `createMcpFastifyApp`**。那个工厂返回一个**新的** Fastify 实例（自带 DNS
  rebinding 防护），而 `buildApp()` 已经有一个实例了。两个实例意味着两个端口或一层反代。
  DNS rebinding 防护改为单独注册 SDK 导出的 host / origin 校验中间件。
- **`request.body` 必须作为第三个参数传入**（见上面注释）。这是 Fastify 适配唯一的坑。
- **工厂每请求执行一次**，工具注册在工厂内部、不注册在共享实例上。无状态模型的直接后果，
  也正好与「一个请求一份鉴权身份」对齐。

**响应形态**：`responseMode` 不写死，用默认——单条 JSON 响应，只在工具发进度通知时升级为 SSE。
本阶段的工具全部是「查一次库 / 写一次库 / 入一次队就返回」，没有长任务（delete 的 MRTR
`input_required` 也是普通 JSON 结果，不是流），所以实际上永远是单条 JSON。

**OAuth 不做**。规范里 authorization 是 `OPTIONAL`，完整实现要 OAuth 2.1 + PKCE + 资源元数据
+ 客户端注册（`RFC 9728` / `RFC 8707` / `RFC 7591`），那是给「任意第三方客户端接入公网 MCP
服务」准备的。本阶段的消费方是**内网里一台受控的 agent 平台**，Bearer Token 足够，且与
`/ingest`、`/runner/*` 的接入方式一致（同一套运维心智）。真要上公网再补 —— 那时补的是
授权服务器发现与 scope 挑战，不需要动工具层。

### 9.3 鉴权与 scope

**`lib/mcpAuth.ts`**：`issueMcpToken()` / `authenticateMcp(header)`，逐字照抄
`lib/ingestAuth.ts:29-80` 的结构，只改前缀（`apimcp_`）与表名。第三次照抄，不抽公共层
（边界 14）。

`authenticateMcp` 返回：

```ts
type McpIdentity = {
  tokenId: string;
  projectId: string;
  scope: ("read" | "write" | "execute")[];
  createdBy?: string;   // 边界 2 的活体判据入口
};
```

**四道闸门，顺序固定**（任一不过就拒，且拒绝理由必须可区分——它们的修法完全不同）：

| # | 检查 | 不过时 | 为什么这个顺序 |
| --- | --- | --- | --- |
| 1 | Token 有效（前缀取候选 + scrypt 比对 + 未吊销） | 401 | 最便宜的判据先做 |
| 2 | `project_settings.mcp_enabled` | 404 | 关掉时端点**不存在**，不泄露「这个项目有 MCP 但关了」 |
| 3 | 工具在 `tools/list` 的可见集内（按 scope） | `-32601` | 只读 Token 看不见写/执行工具，调用它等于调一个不存在的方法 |
| 4 | 写与执行工具：`canAccess(createdBy, projectId, true)` | 403 | 最贵的判据（一次 SQL）放最后 |

第 4 道每次写/执行调用都跑，不缓存（边界 2）。`created_by` 为 NULL（签发者已被删）时直接判不过。

**`tools/list` 按 scope 裁剪，不是「列出来再拒」**。只读 Token 的 `tools/list` 里根本没有
`create_endpoint`——模型看不见的工具不会去调，也就不会把一轮对话浪费在一次注定 403 的尝试上。
这比返回完整清单再逐个拒绝更省 token，也更少误导。

**签发接口**（项目级，`requireProjectAccess(write=true)`）：

```
GET    /api/v1/projects/:id/mcp/tokens            列表（永不含明文）
POST   /api/v1/projects/:id/mcp/tokens            签发，明文只在这次响应里出现
DELETE /api/v1/projects/:id/mcp/tokens/:tokenId   吊销（软删）
GET    /api/v1/projects/:id/mcp/tools             工具清单（前端展示用，非 MCP 协议面）
```

签发与吊销写 `audit_logs`（`mcp_token.create` / `mcp_token.revoke`，`detail` 记 name 与 scope
——**名字与 scope 不是凭据**，明文与哈希都不进）。签发 `write` scope 的那次审计尤其重要：
它是「这个项目从哪一刻起允许外部写入」的唯一凭证。

### 9.4 工具清单

命名用 `snake_case` 动宾结构（MCP 生态惯例，也与 `Mcp-Name` 头的路由用途一致）。
每个工具的 `description` 里写清**它不能做什么**——模型读 description 决定调不调，
写清边界比写清能力更能减少无效调用。2026-09-04 扩界后共 43 个（读 21 / 写 17 / 执行 5），
到此封顶：清单越长模型选工具越不准，之后要加先砍。**2026-09-06 上限 43 → 44**（用户
决策，验收反馈：agent 建完接口需要顺手补 `{{baseUrl}}` 一类普通变量）——`upsert_environment`
进来，只动普通变量、secret 无通路；「先砍再加」仍是对下一次扩界的要求。两条形状纪律：
① 列表工具每行必须带交叉引用 id（`list_cases` 行带 `endpointId`、`list_runs` 行带资源
id）——没有 id，AI 把两跳连不起来，「快」就无从谈起；② `description` 写清「不能做什么」
从建议升级为**硬要求**（P5-5b 验收项）。

**只读工具（`read` scope，21 个）**

| 工具 | 复用 | 说明 |
| --- | --- | --- |
| `list_endpoints` | `endpoints.ts:134` | 支持 `keyword` / `method`，分页 |
| `get_endpoint` | `endpoints.ts:193` | 完整定义 |
| `list_cases` | `cases.ts:140` | 返回 `TestCaseSummary`（**不含** request / assertions，理由见 `types.ts:212`），行带 `endpointId` |
| `get_case` | `cases.ts:177` | 完整定义，含 assertions / responseScripts |
| `get_execution` | `endpoints.ts:486` | **读时重新脱敏**（9.5） |
| `list_executions` | `endpoints.ts:494` | 支持 `caseId` / `endpointId` / `status` / `since` 过滤，行带 `endpointId` / `caseId` |
| `get_script_contract` | `scriptContract.ts` | **工具集里最重要的一个**（边界 9、10） |
| `list_scripts` | `scripts.ts:114` | 公共脚本清单（按 `kind` 过滤） |
| `list_environments` | `environments.ts` | **只回 `secretKeys`（名字），不回值**——契约第 7 条 |
| `list_flows` | `flows.ts:208` | 返回 `nodeCount` 而不是 `nodes` |
| `get_flow` | `flows.ts:240` | 完整 DAG |
| `get_project_overview` | 看板聚合 SQL（P0 起已在算） | 接口/用例/环境/流程/套件/CI 任务计数、覆盖率、最近通过率、最近失败 top N——「项目现状」是 AI 的第一问，一次调用代替几十跳分页遍历 |
| `list_suites` | 套件列表路由 | `keyword` 过滤，分页 |
| `get_suite` | 套件详情路由 + `ResourceSchedules` | 完整定义，**含其调度**（省一个 `list_schedules` 工具） |
| `list_ci_tasks` | P4.5-11 列表 | `keyword` 过滤，LATERAL 最近执行随行 |
| `get_ci_task` | P4.5-11 详情 | 完整定义（代码来源只读、secret patch 语义照界面），**含其调度与最近 run 概要** |
| `list_runs` | `GET /pipeline-runs?ciTaskId=` 同款 SQL（套件侧用套件执行历史） | `kind`（suite / ci）+ 资源 id 过滤，状态/耗时随行 |
| `get_run_report` | 报告拼装层（`lib/reportPayload.ts`，总报告列表两源 UNION 同款） | 概要读数（状态/阶段/提交/触发/结果 + 计数）+ 用例清单（失败优先） |
| `get_run_case` | 报告明细抽屉同源数据（`pipeline_run_cases` / allure 归一） | 失败明细：断言逐条、错误信息、日志摘录，64KB 截断 |
| `get_run_logs` | 日志下载路由的读取版 | `tail` 参数（默认 200 行）**尾部优先** + 64KB 上限 |
| `list_repo_cases` | 仓库用例树 | `keyword` 过滤，行带 system → 接口 → 用例 路径 |

**写工具（`write` scope，18 个）**

| 工具 | 复用 | 幂等键 |
| --- | --- | --- |
| `create_endpoint` | 提取后的 `validateEndpoint()` + `endpoints.ts:223` | `(project, method, url)`，`conflictStrategy` 决定更新还是跳过（边界 15） |
| `update_endpoint` | `endpoints.ts:235` | 按 id，天然幂等 |
| `create_case` | 提取后的 `validateCase()` + `cases.ts:205` | `(endpoint, name)` |
| `update_case` | `cases.ts:263` | 按 id。**校验脚本只能进 `responseScripts`**（边界 10） |
| `upsert_flow` | `flows.ts:289` + `flows.ts:577` 的 `plan` | 建 DAG 前先跑一次 `plan` 校验拓扑，环/孤儿节点在写库前就被拒 |
| `upsert_environment`（2026-09-06 增补，上限 43→44） | `environments.ts` 的 `cleanVariables` 同款归一 | `(project, name)`，大小写不敏感（REST 判重同口径）。**只动普通变量**：secrets 无参数位（入参出现即拒），凭据名变量被 `rejectCredentialNamedVariables` 指名拒绝；runnerLabel / defaultHeaders 仍 UI-only |
| `create_suite` / `update_suite` / `delete_suite` | 套件 CRUD 路由 | `(project, name)`；delete 走 9.4.1 确认 |
| `create_schedule` / `update_schedule` / `delete_schedule` | `ResourceSchedules` 同款路由 | `(resource, cron, target)`；delete 走 9.4.1 |
| `create_alert_rule` / `update_alert_rule` / `delete_alert_rule` | P3 告警规则路由 | `(project, name)`；delete 走 9.4.1 |
| `create_ci_task` / `update_ci_task` / `delete_ci_task` | P4.5-11 任务路由 | `(repo, name)`；**仓库凭据只引用既有条目**（边界 4）；delete 走 9.4.1 |

**执行工具（`execute` scope，5 个）**

| 工具 | 复用 | 说明 |
| --- | --- | --- |
| `run_endpoint` | 单接口调试入口（`lib/run.ts` 的 `executeRequest`） | 只按已保存定义执行，**不接受 overrides**；不去重（调试本来就会连点） |
| `run_case` | 用例执行入队路径 | 同上；产物是一条 `executions` 行（`get_execution` 可读回） |
| `run_flow` | `performFlowRun` 入队路径 | 在途去重：同流程有排队/在途 run 时返回那个 run id |
| `trigger_suite_run` | `lib/trigger.ts` 的 `triggerSuite`（P3-4 统一触发路径） | 在途去重同上 |
| `trigger_ci_task_run` | `triggerCiTaskRun`（P4.5-12） | 在途去重同上——任务级串行本来就排队，返回排队中那个 run id |

#### 9.4.1 删除确认语义（MRTR）

全部 `delete_*` 工具两段式：

1. **第一段返回 `resultType: "input_required"`**：内容 = `scanUsage` 的依赖清单（哪些调度在
   引用、多少用例挂在下面）+ 后果摘要。客户端（agent 平台）把它转述给人——这就是聊天里的
   「确认删除吗」。
2. **确认后带 `inputResponses` 重试原调用**，服务端这才执行删除（等价于 REST 面的
   `force=true` 路径）。**`force` 不是工具入参**——agent 无法单方面替人答：确认是协议回合，
   取决于客户端是否把问题交给人。

旧客户端（2025 系）走 SDK 的 elicitation 桥接（`legacyInputRequiredShim`）；客户端没有
elicitation 能力时 delete **降级为拒绝**并提示走 UI——降级而不是开洞。智能体平台是否真的
转述 elicitation / MRTR 是 P5-3 实测项；不转述则 delete 在聊天里不可用，可逆写与执行不受
影响。

**明确不提供的工具，只剩三类**（写进 `get_script_contract` 的说明里，模型问起来能自己读到）：

- **任意构造请求的执行**（内联 method / url / body 的自由执行）：执行只作用于已保存的命名
  资产（边界 3）。
- **secret / 凭据的创建与明文传递**：secret 只能人在界面上录（契约第 7 条）；CI 凭据只引用
  既有条目（边界 4）。**环境的普通变量自 2026-09-06 起可经 `upsert_environment` 管理**
  ——secret 的通路仍然一条都没有；凭据名字的普通变量也被写入侧拒绝。
- `create_mcp_token`：不给自我提权的工具。

**工具错误用 MCP 的错误通道，不套业务信封**。`success()` / `fail()` 那套信封（契约第 1 条）
是给 REST 面用的；MCP 有自己的 JSON-RPC 错误与 `isError` 结果形态，把业务信封嵌进去会让
`code: 0` 与 JSON-RPC 的 `result` 两层语义打架。**契约第 1 条在 `/mcp` 这条路径上不适用**
——这是本阶段唯一一处刻意的信封例外，理由是协议层已经规定了错误形状。业务错误码
（1001 / 2001 / …）仍然出现在**错误消息文本里**，便于排查时与 REST 面对照。

### 9.5 脱敏纪律（本阶段最锋利的一条）

`get_execution` 与 `list_executions` 要返回执行证据，而执行证据是平台里**最容易带出真凭据**的
数据。既有脱敏发生在**写入时**（`lib/run.ts:244-246`），所以库里存的东西不能直接转发。

**`lib/mcpRedact.ts`** 的判定顺序（2026-09-06 修订：NULL 拆成两支）：

```
1. 取 executions.environment_id
   ├─ 有值 → 读该环境当前 secrets → sanitizeHeaders + sanitizeValue 重跑 → 返回
             （回值带 masking: "environment"）
   └─ 为 NULL
        ├─ environment_name 快照有值（环境已删，迁移 002 的 SET NULL）
        │    └─ 不返回 body / headers，返回 bodyOmitted 说明（边界 6 原样保留：
        │       当时的 secret 值已随环境删除，无从重遮）
        └─ 快照也无值（这次执行本就没带环境）
             └─ 按项目全部环境当前 secrets 的并集重跑脱敏后返回
                （回值带 masking: "project"）
2. store_plaintext 不参与判定（边界 5）
```

**为什么拆（2026-09-06，用户验收反馈）**：原实现把「没带环境」与「环境已删」一起
整体不给，堵死了 agent 的校验闭环——`run_case` → `get_execution` 读响应体 → 对照
真实返回写断言，是写工具面存在的核心理由。修订后没带环境的执行按**并集**遮蔽返回：
声明过的 secret 仍不进对话记录（并集是平台手里最宽的声明集，遮得只多不少），没声明
任何 secret 的项目等于按原文返回。请求侧另有 P5-5a 写入守卫兜底（字面量凭据在
create/update 时就被拒），这条通路不新增写入面。环境已删的一支维持整体不给：那不是
「没声明」，是「声明过但值已消失」，遮蔽从定义上就不可复现。

三条推论：

- **`store_plaintext` 项目的历史行也走同一条路**。写入时没遮过，但只要执行的环境还在就
  能按当前 secret 重算；环境被删了就不给。这个开关的受众是内部人读界面，不是外部
  agent 读工具。
- **脱敏用「当前」secret 而不是「当时」的**。当时的值没有留存（正是因为不该留存）。用当前值
  会漏遮已经轮换掉的旧凭据——但旧凭据已经失效，而漏遮**在用**的凭据才是真损失。取舍明确。
- **`request_snapshot` 与 `response_headers` 同样重跑**，不只是 body。`Authorization` 头在
  `SENSITIVE_HEADERS` 里（`lib/sanitize.ts:1`）会被无条件遮掉，但环境 secret 拼进自定义头
  （`X-Sign`、`X-Token`）只能靠 `secretValues` 比对。

**响应体大小上限**。`executions.response_body` 没有长度约束（P10 的「大响应体截断」还没做，
见 10.1）。工具返回值要截断到 **64KB** 并标 `truncated: true`：一个 5MB 的响应体会直接
撑爆模型上下文，而模型要的只是结构。截断点按 UTF-8 字节而不是字符，与 `lib/notify.ts` 的
`truncateBytes` 同款——按字符截会在多字节边界上切出半个字，模型读到的是乱码。

**`list_executions` 不返回响应体**。列表只回 `id / status / statusCode / durationMs /
createdAt` 与来源标识，body 留给 `get_execution` 按 id 取。理由与 `TestCaseSummary` 不含
request 完全一致（`types.ts:212`）：一页 20 条执行、每条几十 KB 的 body，一次调用就把模型的
上下文预算烧光，而模型此刻要的只是「哪一条失败了」。

**任务与报告读取同红线（2026-09-04 扩界）**：`get_run_logs` / `get_run_case` 返回的日志与
步骤输出，用该 CI 任务环境变量的当前值重跑脱敏（仓库凭据加密存储、只注入不出明文，不进遮蔽
集）；日志**尾部优先**（`tail` 默认 200 行）+ 64KB 上限——整份日志动辄几 MB，模型要的是报错
段，不是全量流水。`get_run_report` / `get_run_case` 的报告数据走与站内 / 分享页同一份拼装
（`lib/reportPayload.ts`），不产生第二套口径。

### 9.6 前端入口（最小，一个页面）

交互文档 3.10 已定的边界照旧——**前端只提供管理入口，不做对话式创建 UI**：

- 位置：项目层「接口资产」组下新增 `MCP` 导航项，路由 `/projects/:projectId/mcp`。
  不进「系统管理」：Token 是项目级的，而系统管理页是平台级（`GlobalApp.tsx:198` 那三个 tab
  全是平台设施）。
- 内容：启停开关（`mcp_enabled`）、端点地址（带复制按钮，复用 `CopyButton.tsx`）、
  Token 列表（名字 / 前缀 / scope / 最后使用 / 吊销）、签发弹窗（名字 + scope 三勾选：read
  默认，write / execute 显式）、工具清单只读表（名字 / 说明 / 需要的 scope）。
- 明文 Token 只在签发后的弹窗里出现一次，照 4.6 的 secret 展示纪律（`RepoCredentials.tsx`
  是现成的同款实现，直接照抄交互）。
- 签发 `write` 或 `execute` scope 时弹窗里必须写明边界 2 的含义：**这把钥匙的写/执行权限
  跟着签发人走，签发人被降权它就立刻写不动了**。不写清的话，「为什么我的 Token 突然写不
  进去」会变成一个查不到原因的问题。

加导航项要同时改三处（`ProjectShell.tsx`）：`PAGES` 常量（12 行，`ProjectPage` 类型由它派生）、
`NAV_ICONS` 记录（24 行，`Record<ProjectPage, LucideIcon>` 是全量的，漏一个就编译不过）、
以及 `nav` 分组数组（90 行）。页标题走 `t("mcp.title")`，不需要进 `pageTitle` 那串 kebab 特例
——`mcp` 没有连字符。

### 9.7 实施顺序（P5-1 … P5-6）

按依赖排，每一步都能独立验证：

| 步 | 内容 | 产出 |
| --- | --- | --- |
| P5-1 | 迁移 050 + `mapMcpToken` + `lib/mcpAuth.ts`（scope 三值） | **已实现**（2026-09-05：`mcp_tokens` 表 + 部分索引、`project_settings.mcp_enabled`（含 9.1 点名的 COALESCE 护住）、`McpScope`/`McpToken`/`mapMcpToken`、`lib/mcpAuth.ts`（`apimcp_` 前缀 + scope/createdBy 透传）、`routes/mcpTokens.ts` 列表/签发/吊销 + `mcp_token.create`/`revoke` 审计、settings GET/PUT 接 `mcpEnabled`；`GET …/mcp/tools` 留给 P5-4 与工具一起落，`/mcp` 端点在 P5-3） |
| P5-2 | 校验函数提取到 `lib/`（边界 8），**不改行为** | **已实现**（2026-09-06：新 `lib/validate.ts` —— `validateEndpoint` / `validateCase` + `EndpointInput` / `CaseInput` 类型，函数体从 `routes/endpoints.ts:63` / `routes/cases.ts:28` 原样搬移，签名与 `partial` 语义零改动；两条路由改 import 并删就地副本；顺手补 P5-1 漏登记的 `AUDIT_ACTIONS` 两值 `mcp_token.create` / `mcp_token.revoke`（`mcpTokens.ts` 已在用，`pnpm check` 因此红）。`pnpm check` / `pnpm build` 均过，REST 面行为不变） |
| P5-3 | `/mcp` 端点 + SDK 挂载（默认 `legacy: 'stateless'`）+ 四道闸门 + `tools/list` 按 scope 裁剪 | **已实现**（2026-09-06：装 `@modelcontextprotocol/server` + `@modelcontextprotocol/node` 2.0.0。`routes/mcp.ts` 按 9.2 三条细节挂载——`createMcpHandler`（`legacy: 'stateless'` 显式写出）+ `toNodeHandler` + Fastify 已解析 body 作第三参 + 身份挂 raw request（SDK 读作 `ctx.authInfo`）；四道闸门全在 SDK handler 之前、兼容腿同被罩住——401（RFC 6750 带 `WWW-Authenticate`）/ 404（回 Fastify 默认 404 体，与未知路由同形）/ `-32601`（in-band HTTP 200，与「工具不存在」不可区分）/ 403（按 `createdBy` 重跑 `canAccess`，签发人被删一律拒）。`lib/mcpServer.ts`：工具注册表（`McpToolDefinition` + 裸 JSON Schema + `fromJsonSchema` 自带 vendored ajv，边界 7 零新校验库）+ `buildMcpServer` 工厂**注册时**按 scope 裁剪（P5-3 清单为空，工具自 P5-4a 起登记，43 封顶）。DNS rebinding 防护用 SDK 纯校验函数 `validateHostHeader`/`validateOriginHeader`（不用 node 包的 raw 写回中间件，避免与 Fastify 接管流程打架）：Host 白名单 = localhost 三件套 + `PUBLIC_BASE_URL` 主机名 + `MCP_ALLOWED_HOSTS`（`*` 逃生门，默认不开），Origin 白名单刻意为空（/mcp 调用方是服务端 agent，带 Origin 的只有 rebinding）。拒绝审计 `mcp.call_rejected`（边界 13，只落第 3/4 道闸门：第 1 道无可归属身份、第 2 道是通道关闭）。`pnpm check` 过；**两条实测待用户在智能体平台侧执行**（STREAMABLE_HTTP 真接一次、确认 elicitation/MRTR 转述与按会话注入凭据——9.8 L3 选型输入） |
| P5-4a | 核心资产读：原 11 工具 + `get_project_overview` + `list_executions` 补 `since` + `lib/mcpRedact.ts` | **已实现**（2026-09-06：`lib/mcpToolsReadCore.ts` 12 工具——`list_endpoints`（keyword/method/分页，行带 caseCount）/ `get_endpoint` / `list_cases`（TestCaseSummary，行带 endpointId）/ `get_case` / `get_execution`（读时脱敏）/ `list_executions`（caseId/endpointId/status/since 过滤，行带来源 id，**不回 body**）/ `get_script_contract`（`SCRIPT_CTX_SCHEMAS` + 五条运行时规则：脚本断言已废弃、secret 只走 `{ secret: "NAME" }`、三类不提供的工具）/ `list_scripts`（kind/keyword/分页）/ `list_environments`（只回 secretKeys）/ `list_flows`（nodeCount 不带 nodes）/ `get_flow` / `get_project_overview`（六类计数 + 覆盖率 + 最近 100 条已判执行的通过率 + 失败 top 10，失败行只带定位字段，错误详情走 get_execution 的读时脱敏）。`lib/mcpRedact.ts` 落 9.5 判定顺序：环境在→按**当前** secret 重跑 sanitizeHeaders/sanitizeValue（request/responseHeaders/responseBody/error/四类证据数组全覆盖）+ responseBody 64KB 按字节截断；环境没了（SET NULL 或没带环境）→ 证据字段整体不给，回 bodyOmitted 说明；store_plaintext 不参与判定。共用件 `lib/mcpToolResult.ts`：回值双通道（structuredContent + content 文本块，MCP 规范对结构化结果的兼容建议）、错误走 `isError` + 消息文本带业务码（1001/2001，不套 REST 信封）。`pnpm check` 过） |
| P5-4b | 任务与报告读：套件 / CI 任务 / run / 报告 / 日志 / 仓库用例 9 工具 | **已实现**（2026-09-06：`lib/mcpToolsReadTasks.ts` 9 工具——`list_suites`（keyword/分页，DISTINCT ON 最近一次运行随行）/ `get_suite`（完整定义 + 其全部调度，schedules.ts 同款双 LEFT JOIN，省一个 list_schedules）/ `list_ci_tasks`（keyword/分页，两段 LATERAL 在途 + 最近 run 与 REST 列表同一份 SQL）/ `get_ci_task`（完整定义 + 调度 + runTotal/lastRun；**env 只回 envKeys 不回值**——9.5 把 env 值当日志遮蔽素材，不该从另一个工具流出，凭据本身加密存储只回引用）/ `list_runs`（kind=ci 走 pipeline_runs、kind=suite 走 suite_executions，行带资源 id；套件行不带 member_snapshot）/ `get_run_report`（`lib/reportPayload.ts` 同一份拼装：套件走 loadSuiteReport（成员行去掉 input/output 快照，证据经 httpExecutionId 走 get_execution 读时脱敏）、ci 走 loadRunnerReport（**不带 allure 全量视图**，cases 失败优先、只带定位字段，明细是 get_run_case 的事））/ `get_run_case`（pipeline_run_cases + allure 步骤树/trace/参数，按 CI 任务 env 当前值脱敏：message 64KB、trace 8KB、步骤树超 32KB 整体不给并注明）/ `get_run_logs`（tail 默认 200 行 + 64KB **尾部优先**（从切点前进到整行边界）、CI env 值脱敏、totalBytes 与 truncatedAtHead 随行）/ `list_repo_cases`（扁平行带 repositoryId + endpoint 路径，keyword 跨用例与接口字段，unplacedCaseTotal 单独给数防「上报 36 条树上 31 条」被当 bug）。遮蔽集 = CI 任务 env 当前值，**< 8 字符不进遮蔽集**（`TEST_ENV=stg` 这类短配置值遮掉会把日志打成 `***`，短串不携带值得保护的熵）。另落 P5-1 预留的 `GET …/mcp/tools`（mcpTokens.ts，读 `MCP_TOOLS` 注册表单一事实，名字/说明/scope，前端展示用非协议面）。`pnpm check` 过；**实测待用户在智能体平台侧执行**（tools/list 可见集、get_execution 脱敏与截断、日志尾部优先） |
| P5-5a | 核心写：endpoint / case / flow 5 工具 + 幂等 + 字面量 secret 拒绝 + 写审计 | **已实现**（2026-09-06：`lib/mcpToolsWriteCore.ts` 5 工具——`create_endpoint`（幂等键 `(project, method, url)`，`conflictStrategy: update\|skip` 与 import 语义逐字同款）/ `update_endpoint`（PATCH 语义，body/bodyText/defaultEnvironmentId 三态：缺省不动、null 清空、有值写入）/ `create_case`（幂等键 `(endpoint, name)`，冻结 request 快照 + 生命周期脚本同事务，`persistCaseLifecycleScripts` 复用）/ `update_case`（部分更新，`FOR UPDATE` 归属先于脚本写入）/ `upsert_flow`（幂等键 `(project, name)`，写库前跑 `validateFlowGraph` 拓扑校验 + `resourcesBelong` + `checkFlowReferences` 跨流程环检测，节点树经 `persistFlowScripts` 归一）。**字面量 secret 拒绝** `lib/mcpSecretGuard.ts`（边界 4）：headers/queryParams 命中 `authorization\|cookie\|x-api-key` 且值非 `{{var}}` 引用、auth 字段（token/username/password/value）非引用、body 对象键命中 `token\|secret\|password\|apikey\|credential` 正则且值非引用——一律拒绝并指向「环境里建 secret，用 `{{name}}` 引用」；`Bearer {{auth}}`（前缀+引用）放行；判据刻意宽于脱敏的 `SENSITIVE_HEADERS`，宁可误伤可改名字段。校验全部复用 P5-2 提取的 `lib/validate.ts`；每个写落 `mcp_tool.write` 审计（detail 只带目标 id 与 outcome，不带 payload）。`pnpm check` 过；**实测待用户在智能体平台侧执行**（幂等键 8、secret 拒绝 9 两条门槛） |
| P5-5b | 全量 CRUD（套件 / 调度 / 告警 / CI 任务 12 工具）+ MRTR 删除确认（9.4.1）+ execute 5 工具 + 在途去重 | **已实现**（2026-09-06：先按边界 8 把四个路由文件的私有校验原样提取到 `lib/validateSuite.ts` / `validateSchedule.ts` / `validateAlertRule.ts` / `validateCiTask.ts`（函数体逐字搬移，REST 路由改 import），再落三块——① `lib/mcpToolsWriteCrud.ts` 12 工具：套件（幂等 `(project, name)`，selection/execution/notify 整块替换）、调度（幂等 `(target, cron, targetType)`，软上限 50，`computeNextRunAt` 认领锚点跟配置走，PUT 对合并后的 targetType+targetId 判归属）、告警规则（幂等 `(project, name)`，窗口约束对合并后配置判：事件型无窗口、窗口型必带）、CI 任务（幂等 `(repo, name)`，`mergeDraft` 草稿合并 + `assertCredentialOwned` 凭据只引用既有条目 + 关串行补 `notifySerializedQueue` 唤醒）；② **MRTR 删除确认**：`mcpToolResult.ts` 的 `mrtrGate`（三态：无回应=首问、accept+confirm=true=确认、decline/cancel/形状不对=拒绝并指 UI——降级不开洞）+ `mrtrRequired`（`inputRequired.elicit` 表单式 boolean 确认，message = scanUsage 依赖清单 + 后果摘要；`force` 不是入参）；四个 delete_* 全走两段式，套件/CI 连带删引用的 schedules/webhook_triggers（事务），CI 的 message 先报 pipeline_runs 级联数并给「保历史请禁用」的替代；SDK 的 `legacy: 'stateless'` 兼容腿自动桥接 2025 系；③ `lib/mcpToolsExecute.ts` 5 工具（execute scope）：`run_endpoint`（复用导出的 `queueEndpointRun`，环境链显式→接口默认→项目默认，**不去重**——调试连点是正常用法）/ `run_case`（冻结快照整行入队，**不接受 overrides**，产物一条 executions 行）/ `run_flow`（`triggerFlowRun` 已存定义路径，`variableOverrides` 触发语义与调度/Webhook 同一套合并规则；在途去重：`flow_executions` 有 queued/running 时返回那个 id）/ `trigger_suite_run`（同款去重 `suite_executions`）/ `trigger_ci_task_run`（去重集 = pipeline_runs 四态 queued/claimed/running/cancelling；`triggeredBy` = Token 签发人，`IdempotentReplayError` 回首次 run 不算失败）。触发上下文与 REST 手动路径一致（不传 trigger），「谁经哪把钥匙触发」由 `mcp_tool.execute` 审计行回答。工具总数 **21 读 + 5 + 12 + 5 = 43**，到位封顶。`pnpm check` 过；**实测待用户在智能体平台侧执行**（门槛 10 确认回合、11 在途去重、12 execute 触发通知+审计） |
| P5-5c | `upsert_environment`（普通变量，上限 43→44）+ 无环境执行证据放行（9.5 修订，见当节） | **已实现**（2026-09-06，用户验收反馈两项：① agent 建完接口需要顺手补 `{{baseUrl}}` 一类普通变量 → `mcpToolsWriteCore.ts` 增 `upsert_environment`：幂等键 `(project, name)` 大小写不敏感（REST 判重同口径），`variables` 整块替换（REST PATCH 同语义，description 提醒先 `list_environments` 读再合并），`cleanVariables` 同款归一（trim 键/丢空键/值必须字符串），**secrets 无参数位**（入参出现 `secrets` 键即拒并指 UI），凭据名变量（token/secret/password/apiKey/credential 正则）被 `mcpSecretGuard.rejectCredentialNamedVariables` 指名拒绝（明文变量所有工具可读，不是放敏感值的通道），runnerLabel/defaultHeaders 用列默认值保持 UI-only；写审计同款。② 同日早些时候的 9.5 修订（无环境执行按项目 secret 并集脱敏后返回）记录在 9.5 节内。工具总数 **44（21 读 + 18 写 + 5 执行）**。`pnpm check` 过；实测待用户在智能体平台侧执行） |
| P5-6 | 前端 MCP 管理页 + i18n 两语言（签发弹窗三勾选） | **已实现**（2026-09-06：`McpPage.tsx` 独立页（路由 `/projects/:projectId/mcp`，导航入「接口资产」组、`PAGES`/`NAV_ICONS`/nav 三处齐改、`Bot` 图标）——页头启停开关（`check-field` 与环境页明文开关同款；store 增 `mcpEnabled` + `updateMcpEnabled`，settings PUT 只带要改的字段——`storePlaintext` 缺省由服务端 COALESCE 保留，`defaultEnvironmentId` 恒随行当前值防清空）+ 服务与端点面板（`/mcp` 根地址 code-block + CopyButton + STREAMABLE_HTTP 注册与浏览器视角说明）+ Token 面板（名字 / 前缀 / scope chip / 最后使用 / 签发时间 / 吊销 `Modal.confirm`）+ 工具清单只读表（segmented 按 scope 过滤带计数，read→write→execute 排序，description 给模型读的原文不翻译）。**签发弹窗两段式**：表单段（名字 + scope 三勾选——read 勾死 disabled、write / execute 显式，勾中即现边界 2 的「权限跟着签发人走」警示）；明文段无 X、无遮罩关闭，唯一出口「我已保存，关闭」。`api.ts` 落 `McpScope`/`McpToken`/`McpToolSummary` + 四接口（列表 / 签发 / 吊销 / 工具清单），`ProjectSettings` 补 `mcpEnabled`；i18n 两语言 `mcp.*` 全套。`pnpm check` 过；验收门槛「签发 / 吊销 / 开关可用」待用户实测 |

**P5-2 必须在 P5-5a 之前独立成一步**：它是纯重构，混进写工具那一步之后，一旦 REST 面出现
回归就分不清是提取带来的还是新工具带来的。

**验收门槛（12 项）**

1. 只读 Token 的 `tools/list` 里没有写工具与执行工具，调用写工具得 `-32601` 而不是 403。
2. `mcp_enabled=false` 时 `/mcp` 对该项目 404，且响应体不透露「这个项目存在 MCP 配置」。
3. 签发者被降为 `viewer` 后，同一个 Token 的读工具照常、写工具立刻 403。
4. 吊销一个 Token 后，下一次调用即时失败（部分索引生效，无缓存窗口）。
5. `get_execution` 对 `store_plaintext=true` 项目的记录仍然返回脱敏后的值。
6. 环境已删除的执行记录，`get_execution` 不返回 body，只返回说明字段。
7. 5MB 响应体的执行记录，工具返回值被截断到 64KB 且带 `truncated: true`。
8. `create_endpoint` 用同一 `(method, url)` 调两次，库里只有一条接口。
9. 写工具入参里带 `Authorization: Bearer sk-xxx` 字面量时被拒，错误消息指向「用 `{{变量}}`」。
10. `delete_suite` 未确认时库里无变化；带 `inputResponses` 确认重试后删除生效，且 `audit_logs`
    有一行。
11. 同一 CI 任务已有排队/在途 run 时，`trigger_ci_task_run` 返回那个 run id，库里不出现第二个。
12. 签发了 `execute` 的 Token 触发套件后，套件自己的 `notify_config` 通知正常发出、
    `audit_logs` 有触发行。

### 9.8 后置：站内助手（人物 + 聊天 + 新手教程）

> **已立项为 P9（2026-09-04）**：范围、边界与批次见 `DEVELOPMENT_PLAN_P6-P10.md` 十三章。
> 上游能力核对（`智能体平台-第三方接入接口文档.md`）与 L3 定案（proposal-first）以
> 该文件为准；本节保留为方向性说明。

**本阶段不做**。2026-09-03 讨论确认的方向与前置：

**方向**：聊天窗**不在平台内实现 agent**（不管 session / token / function call）。链路是
「浏览器 → 平台助手代理（只转发 SSE）→ 外部 agent 平台 → 平台 `/mcp`（本阶段的产出）→ 库」。
平台在这条链里出现两次，身份不同：一次是哑管道，一次是工具提供方。

**为什么代理层不能省**（浏览器直连外部 agent 平台的三个后果）：agent 平台的 Key 会落到前端
bundle；`canAccess` 断链（`viewer` 可以让 AI 替他写）；审计断链（「谁让 AI 建了这个接口」
答不出来）。转发用 `routes/stream.ts:43` 那套已经跑通的 `reply.hijack()` SSE 写法。

**聊天窗的身份绑定（L3，三选一，2026-09-04 更新）**：P5 扩界后工具面已含写与执行（9.4），
聊天链路的凭据形态决定「用户授权」是否落在真人身上。三个候选**都建立在同一个 43 工具面上，
选型不反过来改工具**：

1. **助手代理直传用户 JWT**：`/mcp` 加一条 JWT 鉴权分支（与 `apimcp_` 并列），`canAccess`
   每次落在聊天用户身上。前提：智能体平台能按会话转发凭据。
2. **每会话短时 `apimcp_` Token**：代理在会话开始时签发（`created_by` = 聊天用户、短过期、
   会话结束即吊销）——复用 P5-1 的全部 Token 机制，viewer 聊天自动写不动，审计落在真人。
   前提同上。
3. **proposal-first（原案）**：MCP 只读 + 用户 JWT 走 REST 落库。不依赖平台的任何透传能力；
   `ResponseScriptEditor.tsx:20` 的受控组件形态（`{ scripts, onChange }`）就是草稿落点，
   不新增任何写库路径。

选 1 还是 2 取决于 P5-3 实测「智能体平台能否按会话注入凭据」；都不行则退 3。**硬约束：L3
未定之前，站内助手不得挂在一把共享 write / execute Token 上**——那会让「用户授权」变成审计
里查不到人的一句话（`canAccess` 断链 + 审计断链，正是上段三个后果之二、之三）。

**本地意图不走 agent**：主题 / 语言 / 导航是前端本地指令（`routes/system.ts:21` 的
`preferences` 是 JSONB 合并，加键零迁移）。绕一圈外部 agent 再回来纯属浪费，而且**agent 平台
挂掉时这些仍要可用**。所以聊天窗分两层：本地指令集 + 自然语言通道。

**人物**：`hand-drawn-character-creator.html` 的算法可用但需降级——它是 three.js + WebGL
（CDN importmap，第 67-69 行）+ 每部件一张 canvas 贴 3D 平面 + 常驻 rAF（呼吸/眨眼/跟鼠标/跳）。
直接搬会与 DAG 画布和 Monaco 抢帧，且正面违反 Quiet Console 第 4 条（全应用只允许一个环境
动画）与 Banned 列表（CDN webfont）。**可搬的是 76-584 行那 500 行纯 Canvas 2D**
（three.js 从 588 行才开始）：哈希种子 → 物种/五官/配色的确定性生成完整保留，改画单张 2D
canvas，动画只留眨眼并遵守 `prefers-reduced-motion`。两个产品决定：**种子用 `users.id` 而不是
`name`**（改名不该等于换人，同名不该长得一样）；`nightmare` 物种 12% 概率（629 行：长角、
锯齿嘴、空洞眼）需显式决策是否保留。

**新手教程**：要覆盖 `main.tsx:78-117` 的 20 余条路由，而其中编排 / 套件 / 仓库模式的页面结构
仍在动。现在写一步一 selector 的 tour 等于每次布局调整都重写。若要提前埋，只埋数据驱动骨架
（`{ route, selector, i18nKey }` 的 JSON + `preferences.onboarding` 记完成状态），内容等页面
定型再填。

**前置条件（本阶段之外，尚未规划）**：

1. **用户注册**——平台现在**没有注册路由与注册页**，只有 `routes/auth.ts:8` 的 login，
   `Login.tsx:14` 还硬编码 `admin@local.test`。「注册时按名字生成人物」这个触发点目前不存在。
   开放注册还是邀请制、谁分配项目角色、种子管理员怎么来，都是未决问题。
2. **用户权限与站内通知**——聊天窗要能说「这条规则会给谁发通知」，而通知现在只有外发渠道
   （`lib/notify.ts` 的企微/钉钉/Slack/Webhook），没有站内收件箱。
3. **外部 agent 平台的四项能力**（不满足则方案退化）：能配置连接任意外部 MCP Server（不满足
   则整个方案作废，平台得自己做 function calling）；HTTP API 支持流式（不满足则体验退化成
   整段返回，架构不变）；能接受外部传入的会话 id（不满足则平台自存 transcript 每次全量重发）；
   **能转述 elicitation / MRTR**（不满足则 delete 在聊天里不可用，降级提示走 UI——9.4.1）
   **与按会话注入凭据**（不满足则 L3 退 proposal-first）。后两项均为 P5-3 实测项。

**助手代理落地时才需要的两样东西**（本阶段不建）：`project_settings` 上的 agent 平台地址 +
API Key（Key 走 `lib/crypto.ts:19` 的 AES-GCM，与 Webhook 密钥同款——那把 Key 要拿出明文去
调上游，所以是加密而不是哈希，与 MCP Token 的取舍正好相反），以及 `conversation_id → project`
的归属映射一行。**对话正文不落库**：transcript 在 agent 平台那边，平台再存一份等于把同一批
可能含业务数据的文本抄成两份。

### 9.9 P5 验收结论（2026-09-06）

**用户验收通过**（P5-1 ~ P5-6 全量：Token 签发 / 吊销 / 前端管理页、`/mcp` 端点与四道闸门、
21 读 + 18 写 + 5 执行共 44 个工具，含 9.7 验收门槛十二项）。验收实测经智能体平台执行，
覆盖核心调用链（接口与流程创建、执行证据读取、环境与 CI 日志查询）。验收期间发现并当日
裁决 / 修复的三项：

1. **无环境执行的证据整体不给**（堵死「run → 读响应 → 写断言」闭环）→ 9.5 边界修订：
   `environment_id` 为 NULL 拆两支——没带环境的按项目全部环境当前 secret **并集**脱敏后
   返回（没声明 secret 的项目等于原文），环境已删的仍整体不给；
2. **MCP 创建的接口在流程编辑器显示为裸 id**（store 不感知带外写入 + 接口来源 Select 无
   兜底）→ `issue_fix/问题记录-MCP创建接口流程内显示为id.md`，前端两处修复；同轮核查
   CI 日志（`get_run_logs`）无同类问题；
3. **环境变量无工具通路** → 上限 **43 → 44**（用户决策），增补 `upsert_environment`
   （P5-5c，普通变量整块替换；secret 无参数位，凭据名变量拒绝，runnerLabel / defaultHeaders
   仍 UI-only）。

**后续持续测试**：用户将继续使用工具面，期间发现的缺陷照常走 `issue_fix/`（不改 9.x
边界；涉及边界再议再记）。9.7 各行遗留的「实测待用户在智能体平台侧执行」事项随本结论关闭，
后续问题以 issue_fix 记录为准。

---

## 十四、P10 — 性能、插件、版本（3 周，已并入扩编文档）

> **本章已于 2026-09-05 整章移入 `DEVELOPMENT_PLAN_P6-P10.md` 十四章**（内容原样未改）。
> 范围（14.1 性能优化 / 14.2 插件机制 / 14.3 版本历史）、顺延背景与口径说明见该文件。

---

## 十一、依赖安装清单

### 11.1 后端新增依赖


| 阶段 | 依赖                  | 用途             |
| ------ | ----------------------- | ------------------ |
| P0   | —                    | 当前无新增       |
| P1   | `bullmq` **已装**     | 任务队列         |
| P1   | `ioredis` **已装**    | Redis 客户端     |
| P1   | `ajv` **已装**        | JSON Schema 断言（P1-1 收尾） |
| P1   | `zod`                 | 请求校验         |
| P1   | `@fastify/rate-limit` | 频率限制         |
| P2   | `@fastify/websocket`  | 日志流           |
| P2-7 | `mysql2` **已装**     | MySQL 驱动       |
| P2-7 | `mssql` + `@types/mssql` **已装** | SQL Server 驱动（包不自带类型声明） |
| P2-7 | `oracledb` + `@types/oracledb` **已装** | Oracle 驱动，thin 模式（包不自带类型声明） |
| P2-7 | `mongodb` **已装**    | MongoDB 驱动     |
| P3   | `cron-parser` **已装**（bullmq 传递依赖，显式提为直接依赖） | Cron 解析与下次执行时间 |
| P4.5 | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | 产物对象存储（MinIO/S3）；按需 `import()`，不进启动路径 |
| P5   | `@modelcontextprotocol/server` v2 | MCP Server（协议 `2026-07-28`，无状态） |
| P5   | `@modelcontextprotocol/node`      | `toNodeHandler` + host/origin 校验中间件 |
| ~~P5~~ | ~~`@fastify/swagger`~~          | **撤销**：原为「OpenAPI 文档生成」，与本阶段的 MCP 暴露无关；平台自身的 OpenAPI 输出没有需求方（前端读 `api.ts`，外部工具读 MCP 工具清单） |

> 说明: P1-3 的执行进度推送用 **SSE**(`reply.hijack()` + `text/event-stream`)实现,
> 未引入 `@fastify/websocket`——单向推送不需要双工通道。
>
> P2-7 的 Redis 操作驱动复用 P1 已装的 `ioredis`，零新依赖。四个新驱动在
> `lib/adapters/index.ts` 按需 `import()`，不进启动路径（见 5.0.10 边界决策 8）。
> `mssql` / `oracledb` 必须配套装 `@types/*`：`tsx` 不做类型检查，缺声明只会在
> `pnpm check` / `pnpm build` 时才暴露。

### 11.2 前端新增依赖


| 阶段 | 依赖                   | 用途          |
| ------ | ------------------------ | --------------- |
| P0   | `react-router-dom` v6  | 路由          |
| P0   | `zustand`              | 状态管理      |
| P0   | `react-i18next`        | 多语言        |
| P1   | `@xyflow/react`        | DAG 画布      |
| P1   | `@monaco-editor/react` | 代码编辑器    |
| P1   | `ajv` **已装**          | JSON Schema 断言（P1-1 收尾） |
| ~~P3~~ | ~~`@ant-design/charts`~~ | **撤销**：趋势图手写 SVG，理由见 6.0 边界 12 |
| ~~P5~~ | ~~`@uiw/react-md-editor`~~ | **撤销**：Markdown 渲染器不进平台是 P4.5 报告侧已立的口径（8.13 边界 19——allure `descriptionHtml` 按 pre-wrap 纯文本展示）；没有消费方要求它出现在 P5，一个 Markdown 编辑器没有理由为一章不需要它的阶段复活 |
| P7 | `exceljs` | `.xlsx` 固定模板解析（+计划导出的升级路径）；后端按需 `import()`，不进启动路径。P6/P8/P9/P10 零新增依赖——详见 `DEVELOPMENT_PLAN_P6-P10.md` 15.1 |

> 说明: 脚本断言沙箱**定案用 `node:vm`**（零依赖），不再引入 `isolated-vm`——原生
> 依赖要编译且版本对齐成本高，而 worker 进程隔离已是第一道边界，`node:vm` 只需
> 挡掉明显路径（见 4.0.1）。

---

## 十二、里程碑 & 交付标准

### 12.1 里程碑


| 里程碑 | 阶段    | 交付物                   | 验收标准                                         |
| -------- | --------- | -------------------------- | -------------------------------------------------- |
| M0     | P0 重构 | 模块化代码 + 路由 + 测试 | 现有功能全部通过测试                             |
| M1     | P1      | Flow 编排 + 测试用例     | 可创建 DAG 并执行, 结果可查                      |
| M2     | P2      | 数据源 + 流程节点补全 + 套件 + Mock | 数据源可连可跑命名 SQL；流程支持脚本/条件/数据库节点与并行；可批量执行 + 模拟响应 |
| M3     | P3      | 套件调度 + Webhook 触发 + 套件执行报告 + 告警 + 趋势 | 定时执行（漏跑不补但留痕）+ HMAC 触发 + 报告名 `套件名_日期` 且带触发源与耗时 + 失败通知 + 趋势图 |
| M4     | P4      | 仓库用例上报 + `apitrack-sdk` | 既有 pytest 仓库「装包 + 两个环境变量 + 原样跑」即可让用例挂上覆盖树；范围级对账不误删 |
| M5     | P4.5    | 自研 Runner + CI 任务 + 勾选执行 + 调度通知 | 自托管 Runner 只出站 443 即可拉代码执行；日志实时可看、可取消、掉线判 `aborted`；树上勾选可触发；任务可定时跑、终态可通知、同任务串行不踩数据 |
| M6     | P5      | 平台 MCP Server 对外暴露 | 外部 AI/工具经 `/mcp` 可读全部资产（接口/用例/流程/套件/CI 任务/报告/日志）与脚本契约，可写全部资产（删除走 MRTR 确认），可触发已保存资产执行；read/write/execute 三 scope 分离，执行证据读时脱敏 |
| M8     | P6      | 注册 + 成员与角色 + 三级权限 + 审计可读 | 邀请码注册即入项目；viewer 界面无写入口；成员变更可审计（`DEVELOPMENT_PLAN_P6-P10.md` 十章） |
| M9     | P7      | 文本用例库 + XMind/Excel 导入 + 绑定 + 测试计划 | 300 条 XMind 导入正确；自动化覆盖率可读；计划可标结果可导出（同文件十一章） |
| M10    | P8      | 口径收口 + 失败归因 + 全局/项目统计 + 下钻 | 四处通过率一致；归因分布与覆盖率同屏；图表 hover/下钻可用；零图表库（同文件十二章） |
| M11    | P9      | 站内助手 + 站内通知 + 教程 | 代理对话可用且 Key 不出服务端；proposal-first 闭环；通知小红点 + 弹窗（同文件十三章） |
| M7     | P10     | 性能 + 插件（原 P6 顺延）              | 支持 1000+ 并发执行（同文件十四章）             |

### 12.2 交付标准

- 后端: 所有 API 有集成测试, 覆盖率 > 80%
- 前端: 核心页面有组件测试, 无控制台错误
- 文档: 每个模块有 API 文档 + 使用说明
- 性能: 单接口执行 < 100ms 开销, 100 并发无崩溃
