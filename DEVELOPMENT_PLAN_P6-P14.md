# P6–P14 阶段规划 — 用户权限 / 测试管理 / 数据统计 / 站内助手 / 性能·版本 / 资产归属 / 个人中心·用户级 MCP / 个人中心并入助手卡片·功能文档 / 权限申请审批

> 版本: v1.9（2026-09-04 确认范围与边界；2026-09-05 P10 并入；2026-09-07 P6-1~P6-5
> 实现状态 + P6 暂记验收通过 + 13.6 后置增补「项目可见性两层 + 权限申请审批流」；
> 2026-09-07 P11 立项——资产归属（列级 + 审计级），见十六章；2026-09-09 P7-1~P7-7
> 实现状态 + P7 验收通过——含验收期四轮反馈的口径修订与范围收缩，见十一章；
> 2026-09-09 P8 启动前核对——迁移编号顺延（P8 054 / P9 055 / P11 056，053 已被
> P7 状态评审占用；**2026-09-11 复核：P8 实占 054–056，P9 → 057（+ 收件口径变更的
> 追加迁移 057b）、P11 → 058**）与 P8-8 聚合子查询表数勘误（七张）；批次顺序与指标清单经现场
> 核对不变，见 12.6 末注；同日第二轮范围增补——看板 Top 10 反向榜、资产面四读数、
> TopN 扩六维（+流程/仓库用例）、进入项目默认页改数据统计，见边界 19–22；
> 2026-09-10 P8-1~P8-8 全部实现 + **P8 暂记验收通过**——含验收期多轮反馈修复
> 与 P8-8 两刀性能收口，见十二章 12.6 末尾实现状态；2026-09-11 **P9 范围修订**
> （用户确认，尚未实现）——账号操作并入助手（本地通道）、助手代理 provider 化
> （多 provider + 加密 Key + JSON 导入，adapter 契约 + 注册表，v1 仅 agent-vendor、
> 只接 agent 平台不接裸 LLM）、迁移顺延 057、新增 13.6 agent 方接入要求与
> 对接契约（P11 同步顺延 058），见十三章 13.0 修订与 13.4 重排；
> 2026-09-14 **P9-4 落地后范围修订**（用户四条反馈）——助手默认开启去项目闸门
> （迁移 058）、用户级 agent 凭据 + 上游通用协议化（P9-4b，迁移 059；P11 → **060**）、
> 会话 topic 自动标题，见 13.0 的 2026-09-14 修订块与 13.4.4/13.4.5 实现记录；
> 2026-09-14 **P12 立项**——个人中心 + 用户级 MCP Token（token 归人、绑定归项目、
> scope 放绑定上、工具面 projectId 参数化、read 补活体复查；全局层 /me 页集齐
> 改密 / 通知查看全部 / MCP Token / agent 凭据挂点——P9-4b 悬置的「个人信息界面
> 另行规划」在此兑现），见十八章；
> 2026-09-16 **P13 立项**——新手教程（P9-7「教程骨架 + 主线 5 步 + 双 i18n」自 P9
> 移出，P9 收窄为人物 + 聊天 + 站内通知），见十九章；
> 2026-09-21 **P13 改题（用户确认）**——原「新手教程」整项**砍除**，P13 改为
> ① `/me` 个人中心五 tab 整体并入站内助手抽屉、删 `/me` 路由 + 删基本信息改密表单；
> ② 助手卡片空态问候改 `HI, {{用户名}}`；③ 新增应用内 `/docs` 功能说明文档
> （头像旁 `_blank` 入口、左目录 + 右正文、双 i18n）。主体纯前端，见十九章；
> 2026-09-21 **P13-1 二轮反馈（用户走查）**——三项：① 个人中心删「通知」分区，通知
> 回到助手抽屉自己的 `notifications` 视图（bell-item 列表样式）；② MCP Token 去卡片、
> 平铺成 Token / 绑定两张表，且 me 视图顶部返回键与 tab 条不随正文滚动消失；
> ③ **新增「MCP 绑定许可申请」**（成员申请角色上限之外的 write / execute 档位、
> 通知 project_admin、批准行即授权）——这项**带后端与迁移**（迁移 070 + 五条 REST +
> `/mcp` 第 5 道闸门放宽），故 P13 不再是「零后端、零迁移」；见 19.0b 与 19.5；
> 2026-09-16 **P14 立项**——项目可见性两层 + 权限申请审批流（13.7 后置增补
> 转正排期），见二十章；
> 2026-09-18 **P10 范围修订（用户确认）**——**14.2 插件机制整项砍除**（三个候选窄
> 缺口——第三方 MCP 工具运行时加载 / 自定义通知渠道 / 自定义报告渲染器——用户明确
> 全部不要，理由与等价能力核对见 14.2）；**14.1 性能拆三批**：P10-1 大响应体口径
> 变更 + 转存对象存储（迁移 065）/ P10-2 执行历史归档分区表（迁移 066）/ P10-3
> 查询缓存补齐（零迁移）；**14.3 版本历史展开为三批**：P10-4 统一版本模型 + 资产接入
> （迁移 067）/ P10-5 读侧版本列表 + **改动内容 diff 展示** + 回滚（零迁移）/
> P10-6 执行结果回放（边界待确认），见十四章；④ **新增 P10-7 前端列表首屏闪空态修复**
> （零迁移、纯前端，根因与影响面见 14.5）；⑤ **新增 P10-8 顶层操作区不随内容滚动**
> （零迁移、纯前端、改动面较大，分三步铺开，见 14.6）；**八批实施顺序见 14.4**（迁移线
> 串行 065 → 066 → 067，零迁移批次并行收口；前端线 P10-7 → P10-8 内部串行）；
> 2026-09-19 **P10-1 已实现**（迁移 065 落地：`executions.response_body_object_key` +
> `response_body_storage_driver`、`project_settings.offload_large_response` 默认开；口径
> 三条拍板与实现要点见 14.1 实现状态，下一步为 P10-2 分区表 066）；
> 2026-09-20 **P10-2 已实现**（迁移 066：`executions` 转**按季**范围分区，主键改
> `(id, created_at)`、两条入向外键拆除；归档 = DETACH + 改名保留，自动维护永不 DROP；
> 对象只在真正 DROP 时同步删除；`EXECUTION_RETENTION_MONTHS` 默认 0 = 归档关闭；新增
> `GET/DELETE /api/v1/system/execution-partitions`。六条拍板与代价见 14.1 实现状态，
> 下一步为 P10-4 版本模型 067）；
> 2026-09-19 **P10-8 已实现**（纯前端、零迁移）：三步铺完——统一载体 `PageToolbar` +
> 后续「上下两张同宽卡片」形态（上卡固定 head/操作/搜索/筛选，下卡 `list-scroll` /
> `table-scroll` 卡内滚动、表头吸附），覆盖列表页 / tab 页 / repo 页 / 详情页 / 工作台 /
> 全局层；碰撞收口重算了 `.spec-tree` / `.workbench-side` / `.history-rail` 等既有 sticky
> 偏移与写死视口高度。落点清单见 14.6 实现状态。残留小尾：过高 `filter-bar` 小屏限高、
> `.flow-canvas` 族若日后进卡片模型再算。未跑 build/preview，目视验收由用户完成）
> 归属: 本文件是 `DEVELOPMENT_PLAN.md` 的阶段扩编。四个新阶段插在 P5（MCP）之后、
> 原 P6（性能/插件/版本，**已顺延为 P10，插件机制 2026-09-18 砍除**）之前；**P10 全章于 2026-09-05 自主计划
> 十四章并入本文件**；**P11 于 2026-09-07 立项并入本文件十六章；P12 于 2026-09-14
> 立项并入本文件十八章；P13 于 2026-09-16 立项（P9-7 教程移出）并入本文件
> 十九章；P14 于 2026-09-16 立项（13.7 后置增补转正）并入本文件二十章**。
> 主文档只保留
> 编号变更与指针，完整范围、边界、迁移、路由、批次与验收门槛以本文件为准。
>
> 排序依据（2026-09-04 用户确认）：
> - **用户与权限必须第一**——现在全平台只有一个硬编码账号（`lib/auth.ts:20-25` 是唯一
>   的 `INSERT INTO users`）。「指派给谁」「谁做的归因」「助手用谁的身份」在一个用户的
>   系统里全是空话；主计划 9.8 也早已把用户注册列为站内助手的前置 1。
> - **测试管理在统计之前**——统计要画「用例数 / 覆盖率」趋势，而测试管理会引入第三类
>   用例（文本用例）与第三个覆盖口径（自动化覆盖率）。反过来做，P8 的口径当场过期。
> - **助手最后**——依赖 P5 的工具面、P6 的用户与通知、页面结构在 P7/P8 之后才定型
>   （教程的 selector 不能对着还在动的页面写）。
>
> 章节映射（本文件 → 主计划）：P6 = 十、P7 = 十一、P8 = 十二、P9 = 十三、
> P10 = 十四、P11 = 十六、P12 = 十八、P13 = 十九、P14 = 二十。主计划原「十、P6 性能/插件/版本」已顺延为 P10（**2026-09-18 插件机制砍除，现为「性能/版本」**），并于
> 2026-09-05 连章并入本文件（主计划原位只留指针）；P11 同款，主计划只留指针
> （见 16.5 之后的同步记录）。

---

## 十、P6 — 用户与权限（注册 / 成员 / 角色落地，约 3 周）

### 10.0 P6 范围与边界（2026-09-04 确认）

**问题**

平台只有一种身份：每次启动种子的 `admin@local.test`（`lib/auth.ts:20-25`，密码写死
`admin123`，`Login.tsx:14` 还替用户预填好了）。由此缺了一整层产品能力：

1. **没有第二个账号的创建路径**——无注册路由、无建号接口、无 CLI，加人只能手写 SQL。
2. **成员与角色是死的**——`user_project_roles` 的唯一写入是建项目时给创建者插一行
   （`projects.ts:39`）；「把某个人加进项目 / 改他的角色」没有 API、没有页面。
3. **三级角色只判了两级**——`rbac.ts:11` 唯一的区别是 `role !== "viewer"`，
   `project_admin` 与 `developer` 在代码里完全等价。
4. **前端不知道自己是谁**——`/auth/me` 只回 `isSystemAdmin`（`auth.ts:18`），前端因此
   无法按角色隐藏任何东西；viewer 看到与 developer 完全相同的界面，点按钮才被 403。
   401 也没有统一处理（`api.ts:2061` 只有 request 拦截器），token 失效只能靠刷新页面。
5. **`users.status='disabled'` 有判定端、没有写入端**——判定在 `auth.ts:9` 与
   `lib/auth.ts:29`（每请求查库，所以禁用天然即时生效），但没有开关能把它置上去。

**核心模型**

**身份在 `users`，角色在 `user_project_roles`，两级判据（平台 `is_system_admin` /
项目三级角色）不变、补第三级执行。进人走两条通道：邀请码注册 + 管理员建号；
不做开放注册、不引 SMTP。前端按角色隐藏入口而不是禁用。**

**边界决策（12 项）**

1. **注册两条通道，不做开放自助注册**。内部测试平台，开放注册意味着任何拿到 URL 的
   人都能造账号进看板。① 邀请码：系统管理员签发 `apiinv_` 前缀的一次性码（可预设
   「进哪个项目、什么角色」），受邀人开 `/register?invite=` 自设密码；**链接带外传递**
   （企微/钉钉），与 Runner 部署命令、上报 Token 同一种交付方式。② 管理员建号：当场
   显示初始密码**仅一次**（照 `RepoCredentials.tsx` 的明文只出现一次纪律），并置
   `must_change_password` 强制首登改密。
2. **不引 SMTP，不推翻「Email 不做」**（P3 已定，`notify.ts:10`）。邀请链接由签发人
   自己转达。注册不预填邮箱验证——内网平台，邮箱归属由管理员目视判断。
3. **邀请码是第五次照抄 Token 形状**（`users.password_hash` / `ingest_tokens` /
   `runner_tokens` / P5 的 `mcp_tokens`）：scrypt `salt:digest`、明文前 8 位做候选集
   收窄、部分索引排除已用码。**照旧不抽公共层**——五份 40 行的具体实现仍然好过一层
   参数化抽象；这不是懒惰，是「吊销/过期/单次使用」的差异会在抽象层漏出来。差异点：
   邀请码默认 7 天过期、单次使用（`consumed_at` + `consumed_user_id`）。
4. **`project_admin` 与 `developer` 真正分开**：新增 `requireProjectAdmin` 守卫（系统
   管理员短路），只挂三类路由——成员管理、项目设置写（默认环境 / `store_plaintext` /
   将来的 `mcp_enabled`）、项目删除。**不改 `canAccess` 的签名**——80+ 处调用点零
   回归；「项目管理员多管什么」从一开始就限定在「管人与管项目级配置」，资源 CRUD
   （接口/用例/流程/套件）developer 照旧可写。
5. **`GET /projects/:id` 的返回加 `myRole`**（admin / developer / viewer / system_admin），
   项目列表 `queryProjectMetrics` 同步带出。**不给 `/auth/me` 加全部项目角色映射**——
   用户在 50 个项目里时那是一坨没人整体消费的数据；前端消费的始终是「当前项目我的
   角色」，`projectStore` 已经预取项目详情，零额外请求。
6. **前端按角色隐藏入口，不做禁用态**（沿用 `GlobalApp.tsx:223-232`「一个你永远打不开
   的 tab 只是杂物」的既定策略）。viewer 隐藏：新建/编辑/删除/执行按钮、导入入口、
   批量操作条。developer 额外隐藏：成员管理入口。**只藏入口不藏路由**——后端守卫是
   权限的单一事实，URL 直达时后端照拒。
7. **JWT 补过期：`expiresIn` 默认 7 天**（`JWT_EXPIRES_IN` 环境变量），登录响应带
   `expiresAt`。**不做 refresh token 轮换**——`currentUser()` 每请求查库，改密/禁用
   天然即时生效；refresh 解决的是「无状态 token 撤销难」，这里不是那个问题。改密时
   在 payload 里带 `pwdEpoch`（`users.pwd_epoch` 自增），校验时不等即 401——旧 token
   全部失效不需要黑名单表。
8. **axios 补响应拦截器**：401 → 清 token 跳登录（带 `returnTo`）；403 → 顶部
   `message` 提示无权限（不跳转——用户可能只是在编辑一个刚被降权的页面，跳走会丢
   上下文）。
9. **只做禁用、不做删除用户**。`projects.owner_id` 是全库唯一没写 `ON DELETE` 的
   users 外键（`001:20`，硬删直接被 FK 挡）；且执行历史、审计、归因都要活过被引用方
   （与 `endpoint_name` 快照同一条纪律——历史要能回答「谁做的」）。禁用即时生效
   （既有判定端就位），角色行保留。
10. **成员变更全进审计**：`AUDIT_ACTIONS` 从 3 个动作扩到 12 个（user.create /
    user.disable / user.enable / user.reset_password / member.upsert / member.remove /
    invite.create / invite.revoke / invite.consume / project.role...），`detail` 只放
    email 与角色，**绝不含密码或邀请码明文**（`lib/audit.ts:6-9` 纪律）。
11. **审计从「只写不读」变「可读」**：系统管理新增「审计日志」只读 tab（系统管理员），
    项目设置页给「最近 50 条项目级操作」。这是本阶段最便宜的功能——表在写、写入点
    现成，缺一条 SELECT 和一张表；没有它，「谁把谁加进来的」永远答不出来。
12. **站内通知不在本阶段**——用户已定（2026-09-04）：通知中心（铃铛小红点 + 弹窗）
    归 **P9 站内助手**。因此 P6/P7 的成员变更、计划指派**不触发任何站内通知**，
    P9 落地通知生产端时回补。

### 10.1 数据库迁移：051_p6_users.sql

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pwd_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',           -- 给签发人自己看的备注（给谁/为什么）
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = 不预分配项目
  role TEXT CHECK (role IN ('project_admin','developer','viewer')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_prefix_idx ON invitations (token_prefix) WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE user_project_roles
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

`role` 允许 NULL（不预分配项目）；注册成功时仅当 `project_id` 非空才写
`user_project_roles`。`must_change_password` 同样覆盖管理员建号与重置密码两条路径。

### 10.2 后端新 API

```
POST   /api/v1/auth/register                  公开；{invite, name, password}；消费邀请码
GET    /api/v1/system/users                   系统管理员；列表 + keyword
POST   /api/v1/system/users                   系统管理员；建号，初始密码只在本次响应出现
PATCH  /api/v1/system/users/:userId           系统管理员；name / status / is_system_admin
POST   /api/v1/system/users/:userId/reset-password   系统管理员；新密码只出现一次 + 强制改密
GET    /api/v1/system/invitations             系统管理员
POST   /api/v1/system/invitations             系统管理员；签发，明文码只出现一次
POST   /api/v1/system/invitations/:id/revoke  系统管理员
GET    /api/v1/projects/:id/members           项目读权限（viewer 可看，知道找谁要权限）
POST   /api/v1/projects/:id/members           requireProjectAdmin；{userId, role}
PATCH  /api/v1/projects/:id/members/:userId   requireProjectAdmin；改角色
DELETE /api/v1/projects/:id/members/:userId   requireProjectAdmin；移除
GET    /api/v1/system/audit-logs              系统管理员；分页 + action/project 筛选
GET    /api/v1/projects/:id/audit-logs        requireProjectAdmin；最近 50 条
```

`GET /projects/:id` 与项目列表响应新增 `myRole`。守卫放行但不挡只读：`myRole` 对
`is_system_admin` 回 `system_admin`。

### 10.3 前端

- **系统管理新增两个 tab**（`GlobalApp.tsx:198` 的 `SystemTab` 联合与 `:233` 的数组）：
  「用户」（列表 / 建号 / 禁用 / 重置密码 / 邀请码）与「审计日志」——非管理员不渲染
  tab（不是禁用）。
- **项目层新增导航项「成员与权限」**：`ProjectShell.tsx` 的 `PAGES` / `NAV_ICONS` /
  nav 分组（`:12` / `:24` / `:90`）三处同改，落「通用」组；`main.tsx` 加路由
  `/projects/:projectId/members`。页面 = 成员表（角色下拉就地改）+ 添加成员（搜索
  平台用户 → 选角色）+ 最近审计 50 条。
- **注册页** `/register`（`Protected` 之外，与分享页同层）；`Login.tsx` 删掉
  `admin@local.test` 预填、加「使用邀请码注册」链接。
- **`useMyRole()` hook**（读 `projectStore` 的 `myRole`）+ 全站 viewer 入口隐藏走查。
- **`api.ts` 响应拦截器**（401 / 403，见边界 8）。
- **强制改密页**：登录后发现 `mustChangePassword` 则只放行 `/change-password`。

### 10.4 实施顺序（P6-1 … P6-5）

| 步 | 内容 | 产出 |
| --- | --- | --- |
| P6-1 | 迁移 051 + `requireProjectAdmin` + `myRole` 下发 — **已实现**（2026-09-07） | `pnpm check` 过，既有路由零回归 |
| P6-2 | 用户 CRUD / 禁用 / 重置密码 / 审计动作与读接口 — **已实现**（2026-09-07） | 系统管理两 tab 可用 |
| P6-3 | 邀请码签发/消费 + `/register` + 强制改密 — **已实现**（2026-09-07） | 第二个账号能进来 |
| P6-4 | 成员 CRUD + 前端成员页 + `useMyRole` 隐藏走查 — **已实现**（2026-09-07） | viewer/developer/admin 三级界面分叉 |
| P6-5 | JWT 过期 + pwdEpoch + 401/403 拦截器 — **已实现**（2026-09-07） | 改密后旧 token 立即失效 |

> **P6-1 实现状态（2026-09-07）**：迁移 051 落地（users 三列 + `invitations` +
> `user_project_roles.granted_by/granted_at`）；`rbac.ts` 重构出 `myRoleInProject` 单点
> 角色查询，`requireProjectAccess` 返回值增 `myRole`（签名兼容，80+ 调用点零改动），
> 新增 `requireProjectAdmin` 并即挂两类既有路由（项目设置 PUT / 项目删除 DELETE，
> 边界 4 的第三类「成员管理」待 P6-4 建路由时挂）；`myRole` 随 `GET /projects/:id`
> 与项目列表（`queryProjectMetrics`，dashboard 聚合同步受益）下发。**一处词汇决策**：
> `myRole` 用 DB 值 `project_admin`（计划原文写的是「admin」），与成员 CRUD 的 role
> 词汇、DB CHECK 保持同一套，避免前端再长一层映射；`system_admin` 照计划短路。
>
> **P6-2 实现状态（2026-09-07）**：后端 `routes/systemUsers.ts`——`GET/POST
> /system/users`（列表 keyword/分页 + 建号：初始密码 18 字节 base64url 只在响应出现
> 一次、`must_change_password` 置位）、`PATCH /system/users/:userId`（name / status /
> isSystemAdmin，partial）、`POST …/reset-password`（同明文纪律 + 强制改密）、
> `GET /system/audit-logs`（分页 + action/project 筛选，LEFT JOIN email/name 快照）、
> `GET /projects/:id/audit-logs`（`requireProjectAdmin`，最近 50 条——P6-4 成员页
> 消费）。`AUDIT_ACTIONS` 扩到 17 动作（新增 user.create / disable / enable /
> update_role / reset_password，detail 只放 email 与前后角色）；`models/types.ts`
> 增 `ManagedUser` / `AuditLog` 与两个映射（哈希列不进管理查询）。**两处护栏**：
> ① 不能禁用自己 / 不能摘自己的管理员旗 / 最后一个启用的系统管理员不能被降
> （409，用户面的「最后一个 project_admin」纪律）；② 重置密码**不动 pwd_epoch**
> ——那是 P6-5 的 JWT 失效机制，提前动会引入本批未实现的第二个判定端。前端
> `GlobalApp.tsx` 的 `SystemTab` 增「用户」「审计日志」两 tab（非管理员不渲染），
> `UsersPanel`（建号弹窗 + 初始密码 code-block + 禁用/启用确认 + 管理员旗就地开关
> + 重置密码）与 `AuditLogsPanel`（action 筛选候选取自当前页出现过的动作、detail
> 键值行渲染）落地，i18n 中英双语补齐，`.audit-detail` 进 design-system.css。
>
> **P6-3 实现状态（2026-09-07）**：邀请码通道与强制改密全套落地。后端：新
> `lib/inviteAuth.ts`（第五次照抄 Token 形状：scrypt `salt:digest`、`apiinv_` 明文、
> 前缀收窄候选、**不抽公共层**；差异点 = 7 天过期 + 单次使用）、`routes/invitations.ts`
> （GET/POST `/system/invitations` + `POST …/:id/revoke`，全 `requireSystemAdmin`；
> 签发明文码只在响应出现一次，audit 三动作 invite.create/revoke/consume、明文码绝不
> 进 detail）；`routes/auth.ts` 增公开 `POST /auth/register`（**事务 + 带条件
> UPDATE 原子消费**，并发双注册只有一个赢；过期 410 / 吊销 403 / 无效 401 / 已用
> 409 分路报错；预分配角色行 `granted_by` 落签发人）与 `POST /auth/change-password`
> （旧密码必验、清 `must_change_password`；**不动 pwd_epoch**——P6-5 的机制，提前
> 动 = 无判定端的字段变更）；login 响应带 `mustChangePassword` + 写 `last_login_at`；
> **`/auth/me` 同步带旗**（登录响应里的旗活不过一次刷新，读时从库里来，否则强制改密
> 闸刷新即绕过）。前端：`Register.tsx`（Protected 之外，`?invite=` 预填、注册即登录、
> 服务端分路 message 直接透传）、`ChangePassword.tsx` + `main.tsx` 的 `PasswordGate`
> （`mustChangePassword` 为 true 时除改密页一律弹回；改密页自身在闸外，hydrate 从
> me() 恢复旗）、`Login.tsx` **删掉 admin@local.test / admin123 预填** + 「使用邀请码
> 注册」链接（`.login-card .form-note a` 用 accent）；`UsersPanel` 增邀请码区块
> （签发一行：备注 + 预分配项目/角色（role 必须配项目，后端 400 前端禁按钮）+ 明文
> 注册链接 code-block 只出现一次 + 列表（待使用/已使用/已吊销/已过期四态、被谁消费
> 展示 email）+ 吊销确认）；authStore 增 `register`/`clearMustChangePassword`。
> **一处词汇决策**：email 由注册人自报——计划 10.2 的 body 清单
> `{invite, name, password}` 没有 email，但 `users.email NOT NULL UNIQUE` 且登录按
> email 找行，没有 email 的账号登录不了；归属由签发人带外转交时目视判断（边界 2
> 的原话），冲突 409 而不是枚举既有账号。
>
> **P6-4 实现状态（2026-09-07）**：成员 CRUD + 成员页 + 全站角色分叉落地。**零迁移**
> ——051 的 `user_project_roles.granted_by/granted_at` 已就位。后端：新 `routes/members.ts`
> 四条路由——`GET /projects/:id/members`（`requireProjectAccess` 读，viewer 可看；
> JOIN users 读时快照 + 排序 project_admin→developer→viewer→email）、`POST`
> （requireProjectAdmin，**upsert 语义**：ON CONFLICT 改角色，同一张码加两次不 409
> ——审计动作叫 member.upsert 的原因）、`PATCH …/:userId`、`DELETE`；外加一条计划
> API 清单之外的**候选搜索** `GET …/members/candidates?keyword=`（requireProjectAdmin、
> 只回 id/email/name 三列、只 active、只非成员、上限 20——「搜索平台用户」选择器的
> 数据源；不放宽 `/system/users`，那是全量管理面）。「最后一个 project_admin」闸
> （门槛 8）：降级与移除先数其他 project_admin，数到 0 → 409/2003；POST 改角色同过
> 此闸。审计 `AUDIT_ACTIONS` 增 member.upsert / member.remove（detail 只放 email 与
> 前后角色）。前端：`api.ts` 增 ProjectMember/MemberCandidate 与五个成员 API +
> Project/ProjectMetric 带 `myRole`；`projectStore` 存 `myRole`（null = 未加载，
> 一律按无权限处理）；`hooks/useMyRole.ts` 三个判定（useMyRole / useCanWrite /
> useCanManageProject——**三档不是两档**：developer 能建接口但看不到成员管理）；
> `Members.tsx` 成员页（角色下拉就地改 + 添加成员防抖候选搜索 + 最近审计 50 条复用
> `AuditLogsPanel` 提出的 `AuditDetail`；管理面只对 project_admin 渲染，页面对
> viewer/developer 可读）；导航「成员与权限」落通用组 + `/members` 路由 + i18n 双语。
> **全站隐藏走查**（边界 6「只藏入口不做禁用态、只藏入口不藏路由」）：viewer 藏——
> 接口列表（新建/导入/勾选列/批量条/行内运行·复制·编辑·删除）、工作台（发送/保存/
> 另存用例/复制/删除/⌘S/用例框行内操作/重跑/同步 tab）、环境（新建/编辑/删除/复制
> + 抽屉保存）、公共脚本、流程（列表与画布加节点/运行/保存/节点抽屉调试与删除——
> 抽出共享 `NodeDrawerActions`）、套件（新建/运行/编辑/删除/保存/⌘S/取消他人运行）、
> 数据源（含 SQL 定义与测试连接）、Mock、CI 任务（新建/触发/编辑/删除/保存并触发/
> 凭据就地创建）、告警渠道与规则、MCP Token 签发吊销、仓库用例树勾选执行、凭据页、
> 报告分享创建/撤销、run 取消、调度面板全量入口。**developer 额外收敛到项目管理员**
> （P6-1 已改后端守卫、本批补 UI）：默认环境选择器、明文记录开关、MCP 开关（项目
> 设置写）。编辑器本体（表单/画布）对 viewer 保留——本地草稿存不回去，路由不藏。
>
> **P6-5 实现状态（2026-09-07）**：JWT 过期 + pwdEpoch + 401/403 拦截器全套落地。
> **零迁移**——051 的 `pwd_epoch` 列已就位，`JWT_EXPIRES_IN` 是 env-only。后端：
> `@fastify/jwt` 注册时挂全局 `sign.expiresIn`（`JWT_EXPIRES_IN` 默认 7d；只影响 auth
> 路由的 jwtSign，产物直传的一次性 token 是 objectStore 自己的 HMAC、不走这里）；
> `FastifyJWT` 类型加可选 `pwdEpoch`；新 `lib/auth.ts#signSessionToken` 单点（login /
> register / change-password 三处共用，`expiresAt` 直接从签出的 token 解 `exp`——
> 不自己再解析一遍时长字符串，两处来源迟早漂移）；`currentUser` 的 SELECT 带
> `pwd_epoch`、**不等即 401**——判定端单一（它是全库唯一的 jwtVerify 点，rbac /
> stream 全部经它），改一处全部路由生效。login 的旗查询并进主 SELECT（P6-5 起签
> token 要带 epoch，不再值得单独发一次查询）。**两处自增收口**：`change-password`
> 与管理员 `reset-password` 都 `pwd_epoch = pwd_epoch + 1`（P6-3 / P6-2「提前动 =
> 无判定端的字段变更」的临时取舍就此结束）；改密响应**换发带新 epoch 的 token**——
> 当前会话凭它无缝续命、其他设备上的旧会话全部下线，而不是把刚改完密的人踢去
> 再登一次。前端：`api.ts` 补响应拦截器——401 清 token 带 `returnTo` 硬跳登录
> （硬导航连内存 store 一起重置；不反向 import authStore——会与它 import api 成环）；
> 403 顶部 `message` 提示无权限、**不跳转**（3 秒一条，防一页并发 403 弹五条叠着的
> toast）。**公开页前缀对两个分支都豁免**：`/login`、`/register`（那里的 401/403 是
> 「凭据不对 / 邀请码无效或被吊销」的领域语义，页面有自己的分路报错——重定向会把
> 错误抹掉，全局 toast 又词不达意）与 `/share/*`（公开落地页，匿名访客不该被一枚
> 过期 token 从公开报告页踢去登录）——401 只清不跳，403 不弹全局 toast。
> `authStore` 的 `clearMustChangePassword` 被 `renewSession` 取代（换发
> token 落地 + 清旗一体）；i18n 补 `errors.forbidden` 双语。**一处兼容决策**：缺
> `pwdEpoch` claim 的存量 token 按 0 对齐（`pwd_epoch` 列缺省也是 0）——部署
> P6-5 不强制存量会话全员重登；失效语义只对「之后的改密 / 重置」生效。
>
> **P6 验收结论（2026-09-07，暂记通过）**：P6-1 ~ P6-5 五个批次（迁移与守卫 / 用户
> CRUD 与审计 / 邀请码与强制改密 / 成员管理与角色分叉 / JWT 过期与改密失效）用户
> 验收暂记通过。后续使用中暴露的问题按 `issue_fix/` 流程记录处理（缺陷不入本计划，
> 见主计划 Plan Tracking 纪律）。

### 10.5 验收门槛

1. viewer 看不到任何新建/执行按钮；绕过 UI 直接 POST 得 403。
2. developer 能建接口但不能进成员管理；project_admin 能改角色、能删项目。
3. 被降级的用户下一个请求立即按新角色判定（无缓存窗口）。
4. 禁用用户的 token 下一次请求 401（判定端即时生效）。
5. 邀请码单次使用；过期/吊销的码注册得明确报错而不是 500。
6. 改密后旧 token 全部失效（pwdEpoch），新 token 7 天过期。
7. 管理员建号/重置的初始密码只在响应里出现一次；首登强制改密。
8. 最后一个 project_admin 不能被移除/降级（409 + 提示），防止项目无人能管。
9. 成员与角色的每次变更在审计日志可查到操作人、时间、前后角色。

---

## 十一、P7 — 测试管理（文本用例 + 导入 + 双视图 + 测试计划，约 5 周）

### 11.0 P7 范围与边界（2026-09-04 确认）

**问题**

平台有两种**自动化**用例资产：接口用例（`test_cases`，平台托管、可执行）与仓库用例
（`repo_test_cases`，代码在用户仓库、CI/Runner 执行）。但**测试设计这一层是空的**：
QA 用 XMind/Excel 写的功能用例（目录树 / 标题 / 前置 / 步骤 / 预期）只活在平台外面。
三个直接后果：

1. 「这个模块设计了哪些用例」在平台上无处安放，新人接手只能去翻群文件。
2. 覆盖率只有「接口有没有用例」（`dashboard.ts:139`），**没有「设计的用例里多少已
   自动化」**——这才是 QA 汇报时真正被问的那个数。
3. 一次回归的手工执行结果（通过/失败/阻塞 + 缺陷单）记在个人 Excel 里，平台看不见。

**核心模型**

**文本用例是第三类用例资产：一棵人工维护的模块树，叶子是「用例」（title / 前置 /
步骤 / 预期），它自己不含请求定义、平台不执行它；通过「绑定」（N:N）指向自动化资产
（接口用例 / 流程 / 仓库用例），从而读出自动化状态。测试计划 = 一批文本用例的一次
手工执行记录：结果只来自人工标记；绑定资产的最近自动化结果只读展示、不触发。**

用例的三层词汇（写进 i18n 与用户手册，不再混用）：

| 层 | 平台词 | 表 | 谁执行 |
| --- | --- | --- | --- |
| 设计 | 文本用例 | `spec_cases`（新） | 无人——只被绑定 |
| 自动化（平台托管） | 接口用例 | `test_cases` | 平台 worker |
| 自动化（仓库） | 仓库用例 | `repo_test_cases` | CI 任务 / Runner |

 **边界决策（17 项）**

1. **文本用例是独立的第三类资产，不复用 `test_cases`**。后者 `endpoint_id NOT NULL` +
   `request_snapshot JSONB NOT NULL`（`007:9-24`）——文本用例两者皆无，硬塞要么放宽
   约束要么造空壳行，都会污染接口用例的全部既有查询与覆盖口径。
2. **目录树真存储（`parent_id` + 物化 `path`）**。这与 P4「目录不做树的一层」
   （`035:88-90`）**不冲突**：那说的是仓库用例的文件路径不该层级化（代码组织的副产
   品）；这里的树是用户手工组织的**测试设计结构本身**，XMind 导入的就是它。`path`
   物化（`/模块A/子模块/` 前缀匹配）使「模块及全部子级的用例」一条索引查询，不递归
   CTE。树深上限 6，模块名同层可重（身份是 path，不是名字）。
3. **XMind 只解析 `content.json`**（XMind 8+ / Zen 格式，zip 内单文件 JSON）。旧版
   `content.xml` 不支持——遇到时返回 1001 并提示「请用 XMind 8 及以上重新保存」。
   解析用服务端 `lib/zip.ts`（零依赖、三道 zip 炸弹闸，`zip.ts:16-22`）+ `JSON.parse`，
   **不引依赖**。
4. **层级映射默认「叶子即用例」**：叶子节点的祖先链 = 目录路径；可选按标记前缀识别
   （`tc:` / `用例:` 开头的节点视为用例，其子树按约定拆字段）。两种模式在预览页可选、
   有即时预览，**不做自动猜测**。XMind 的 notes → 描述、labels → tags、priority
   marker → priority。
5. **Excel 固定模板，不做列映射**（用户 2026-09-04 确认）。平台提供模板下载；列固定
   为：`目录路径 | 用例编号 | 用例标题 | 前置条件 | 步骤 | 预期结果 | 优先级 | 标签`。
   解析走后端 `exceljs`（**按需 `import()`，不进启动路径**——照 `lib/adapters/index.ts`
   与 `@aws-sdk` 的先例）。Excel 的复杂度（合并单元格 / sharedStrings / 内联串 / 日期
   序列号）远超 junit XML，手写最小读取器在模板是「平台发的契约」这个前提下仍会踩
   WPS/Numbers 另存出的边角，不值。
6. **`.xlsx` 与 `.xmind` 都走 `application/octet-stream` 原始流上传**（文件名与来源放
   query）。照 Runner 产物直传的既有写法（`runners.ts:140` 的 content-type parser +
   路由级 `bodyLimit` 8MB），**不引 `@fastify/multipart`**——两个文件类型、没有多文件
   场景，multipart 的解析边界/临时文件全是新增面。注意 parser 要在本路由插件内注册
   （Fastify 插件封装作用域，runners 那份不跨作用域）。
7. **导入两阶段：preview → commit**。preview 上传文件、解析、返回归一化树 + 逐条
    判定（新增 / 已存在未变 / 已存在有变）+ 冲突摘要；commit 提交用户确认后的归一化
    JSON（前端持有，不落暂存表）。判重键：优先「用例编号」（`item_key`，如
    `TC-001`）；无编号时回落 `(path, title)` 哈希——**改标题会变成新用例**，预览页明
    说这一条。单次上限 2000 条。
    **2026-09-07 增补**：手工路径的编号已改为服务端自增（`TC-` + 项目内最大序号 + 1，
    三位补零；POST 生成、PATCH 不可改，见 11.2）。P7-4/5 落地时导入判重的「用例编号」
    语义需与自增序列对齐：文件带的编号与已生成的 `TC-###` 撞键时按「已存在有变」
    处理而不是落库冲突，无编号行也改走服务端取号。
8. **绑定是 N:N、多态目标**：一条文本用例可绑多条自动化资产（主流程 + 异常各一条
   很常见），一条自动化资产也可被多条文本用例引用。目标四类：`endpoint`（接口）/
   `case`（接口用例）/ `flow`（流程）/ `repo_case`（仓库用例）。
9. **仓库用例按 `(project_id, case_key)` 绑定，不按行 id**。仓库用例行会被对账标
   `removed`、同 key 重新出现时是同一行还是新行取决于上报序列——`case_key` 才是
   身份（`035:76-77`）。绑定行 `ON DELETE CASCADE` 挂文本用例侧；目标侧读时校验，
   悬空显示「目标已删除」。
10. **绑定接口（`endpoint`）是合法目标**——「这个接口该被测什么但还没自动化」本身
    是有用信息；这产生「设计了但没自动化」与「自动化了」之间的中间态，正好喂
    覆盖口径。
11. **新增第三个覆盖口径：自动化覆盖率 = 有 ≥1 个绑定（`endpoint` 不算自动化）的
    active 文本用例 / 全部 active 文本用例**。与接口覆盖率（接口有无用例）、仓库
    覆盖率（形状去重）**并列展示、互不合并**——三个口径回答三个问题，页面上各配
    一句话说明，避免「覆盖率」一词裸奔。
12. **测试计划只记手工结果**（用户 2026-09-04 确认）：`passed / failed / blocked /
    skipped / 未执行` + 备注 + 缺陷链接（纯文本 URL，不做缺陷系统）。**绑定资产的
    最近一次自动化结果作为只读参考列展示**（状态 + 时间 + 深链），不参与计划通过率、
    不自动回写。
13. **「按绑定触发自动化」整体后置**（用户 2026-09-04 确认：「代价可能有点大，放到
    待办不着急实现，后面有人提需求再说」）。记录设计取向以防将来跑偏：**不发明第三
    条执行路径**——触发时复用既有两个扇出器（平台侧绑定 → 生成 manual 套件或临时
    入队；仓库侧绑定 → `triggerCiTask({caseKeys})`），计划只记 `generated_suite_id`
    供跳回。
14. **计划通过率口径对齐平台标准**：`passed/(passed+failed)`，`blocked / skipped /
    未执行` 不进分母（8.17 ② 同款）；进度 = 已标记 / 总数。
15. **不做 XMind 导出回写**——回写要处理「平台改了、源文件也改了」的合并冲突，那是
    另一个产品；分享用平台链接或计划导出（CSV 起步）。
 16. **不做用例评审流 / 版本历史**。状态就 `draft / active / deprecated` 三值；「谁改
    的」走 `updated_at` + 审计，逐版本 diff 与回滚归 P10 14.3（与本节「接口变更追踪」
    是同一件事的两个面，分两处做会长出两套版本模型）。
 17. **编辑链路不支持多人协同**（2026-09-08 用户确认备注）。脑图 / 列表 / 抽屉的每次
     编辑都是一次独立的 HTTP 请求/响应（REST 最小字段提交 + 服务端真值回填），没有实
     时推送、没有 OT/CRDT、没有行级锁。多人并发的既定限制：① 字段级 last-write-wins
     ——`steps` 是整数组替换，两个并发编辑以后落库者为准，静默覆盖先落库的；② 闲置
     端不感知远端改动，只有自己的操作（revision 重取）或换筛选/视图才会刷新；
     ③ ⌘Z 撤销栈是客户端本地的，多人交叉操作时撤销语义不成立。产品假设：文本用例
     以单作者、低频提交为主。将来若要支持多人，演进顺序是先补行版本乐观锁
     （If-Match 前置条件 → 冲突可见化）再考虑按项目 SSE 变更广播（平台已有 SSE 通
     道），不上字符级协同。前端同步标注：脑图画布左上提示条（`specCases.mindmapHint`）
     尾部注明「未接入 OT 算法，不支持多人协同」（2026-09-08 用户要求）。

### 11.1 数据库迁移：052_p7_spec_cases.sql（四张表）

```sql
CREATE TABLE IF NOT EXISTS spec_modules (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES spec_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,                      -- 物化：'/模块A/子模块/'；根节点 path = '/'
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS spec_modules_parent_idx ON spec_modules (parent_id);

CREATE TABLE IF NOT EXISTS spec_cases (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES spec_modules(id) ON DELETE CASCADE,
  item_key TEXT,                           -- 用例编号（TC-001）；NULL = 无编号（回落 path+title 哈希）
  title TEXT NOT NULL,
  preconditions TEXT NOT NULL DEFAULT '',
  steps JSONB NOT NULL DEFAULT '[]',       -- [{ step, expected }]
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','deprecated')),
  source TEXT,                             -- 'xmind' | 'excel' | 'manual'
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, item_key)
);
CREATE INDEX IF NOT EXISTS spec_cases_module_idx ON spec_cases (project_id, module_id);
CREATE INDEX IF NOT EXISTS spec_cases_status_idx ON spec_cases (project_id, status);

CREATE TABLE IF NOT EXISTS spec_case_links (
  id UUID PRIMARY KEY,
  spec_case_id UUID NOT NULL REFERENCES spec_cases(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('endpoint','case','flow','repo_case')),
  target_id UUID NOT NULL,                 -- repo_case 目标额外存 case_key 快照（边界 9）
  target_key TEXT,                         -- 仅 repo_case：(project 内的 case_key)
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spec_case_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS test_plans (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  owner UUID REFERENCES users(id) ON DELETE SET NULL,
  started_on DATE,
  due_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_plan_items (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  spec_case_id UUID REFERENCES spec_cases(id) ON DELETE CASCADE,
  title_snapshot TEXT NOT NULL,            -- 计划是历史：用例改名后旧计划仍读得通
  module_path_snapshot TEXT NOT NULL,
  assignee UUID REFERENCES users(id) ON DELETE SET NULL,
  result TEXT CHECK (result IN ('passed','failed','blocked','skipped')),  -- NULL = 未执行
  note TEXT NOT NULL DEFAULT '',
  defect_url TEXT,
  executed_at TIMESTAMPTZ,
  UNIQUE (plan_id, spec_case_id)
);
CREATE INDEX IF NOT EXISTS test_plan_items_assignee_idx ON test_plan_items (assignee) WHERE result IS NULL;
```

### 11.2 后端新 API

```
GET    /api/v1/projects/:id/spec-modules            树全量（模块 + 每模块用例计数）
POST   /api/v1/projects/:id/spec-modules            建模块
PATCH  /api/v1/projects/:id/spec-modules/:moduleId  改名/移动（子树 path 批量重算）
DELETE /api/v1/projects/:id/spec-modules/:moduleId  扫引用，有用例则 409（force 语义同环境）
GET    /api/v1/projects/:id/spec-cases              服务端分页 + path/keyword/priority/status/绑定态筛选
POST   /api/v1/projects/:id/spec-cases              手工建（写权限；item_key 服务端按项目内 TC- 序列自增——2026-09-07 反馈，请求不传编号，UNIQUE 兜底并发取号重试）
GET    /api/v1/projects/:id/spec-cases/:caseId      详情（含绑定 + 最近自动化结果读时关联）
PATCH  /api/v1/projects/:id/spec-cases/:caseId      （item_key 不可改——自增编号是系统身份，只读）
DELETE /api/v1/projects/:id/spec-cases/:caseId
POST   /api/v1/projects/:id/spec-cases/:caseId/links     绑定 {targetType, targetId}
DELETE /api/v1/projects/:id/spec-cases/:caseId/links/:linkId
POST   /api/v1/projects/:id/spec-cases/import/preview   octet-stream 上传 → 解析 + 判定，不落库
POST   /api/v1/projects/:id/spec-cases/import           提交归一化 JSON（上限 2000 条）
GET    /api/v1/projects/:id/spec-cases/import/template  模板下载（P7-5；?format=xmind|excel，
                                                        缺省 excel；XMind 模板 2026-09-08 增补）
POST   /api/v1/projects/:id/spec-cases/export           用例导出（P7-5 增补；body: format +
                                                        caseIds?（勾选集优先，上限 2000）或
                                                        列表同套筛选；POST 因勾选集 uuid 放不进
                                                        query string；viewer 可导，纯读语义）
GET    /api/v1/projects/:id/test-plans              列表 + 状态/owner 筛选 + 进度汇总
POST   /api/v1/projects/:id/test-plans              建（可带初始 specCaseIds，title 快照）
GET    /api/v1/projects/:id/test-plans/:planId      详情（项 + 只读自动化参考列）
PATCH  /api/v1/projects/:id/test-plans/:planId
POST   /api/v1/projects/:id/test-plans/:planId/items        加项
DELETE /api/v1/projects/:id/test-plans/:planId/items/:itemId
PATCH  /api/v1/projects/:id/test-plans/:planId/items/:itemId  标结果/指派/备注/缺陷链接
GET    /api/v1/projects/:id/test-plans/:planId/export       CSV（UTF-8 BOM，Excel 直开）
```

`GET /spec-cases/:caseId` 的「最近自动化结果」读时关联：按绑定目标分别查
`executions`（case/flow，取 `case_id`/`flow_execution_id` 最新一条）、`repo_test_cases.
last_result`（P4 已有列，`035:102`）。**绝不回写**（照迁移 047 树×任务报告的纪律）。

### 11.3 前端

- **导航新增「测试管理」分组**（编排与回归之前）：两个导航项——「用例库」
  （`/spec-cases`）与「测试计划」（`/test-plans`）。`ProjectShell.tsx` 三处同改 +
  `main.tsx` 路由 + `pageTitle` kebab 特例补两行。
- **用例库**：单一页面 = 筛选栏 + **树/列表视图切换**（`?view=tree|list` 进 URL）。
  - 树视图：目录树（复用/泛化 `StepTree`——`PipelineRunPage.tsx:956` 已是可复用递归
    树，`RepoCaseTree.tsx:11` 在用）+ 展开态 + 勾选（勾选集给批量条：加入计划 /
    移动模块 / 批量改优先级 / 删除）。**不是思维导图画布**——XMind 的价值在层级与
    字段拆解，可编辑脑图画布（自由布局、拖拽改父、就地改字）是另一个量级的产品，
    且 `@xyflow/react` 的自由画布与「树」的约束布局是两种东西。
  - 列表视图：`.grid` 扁平表 + 服务端分页（20/50/100）+ 目录路径列。
  - 两个视图**共享同一份筛选与勾选状态**（切换视图不丢勾选——「选中后建计划」的
    主路径跨视图）。
- **用例详情抽屉**：字段编辑 + 步骤表（行内两列：步骤/预期）+ **绑定区**（按
  target_type 分四小节，各配一个选择器：接口选择器复用 `SuiteMemberPicker` 的接口
  分组数据源、用例选择器复用其用例分组、流程平铺、仓库用例复用 `RepoCaseTree` 的
  行数据源）。
- **导入向导**（Modal 三步）：上传（`.xmind` / `.xlsx` 二选一 + 模板下载）→ 预览
  （树形勾选 + 逐条三态 + 冲突摘要 + XMind 层级映射模式选择）→ 提交（结果
  `message` 汇总新增/更新/跳过）。
- **测试计划**：列表（名称 / 状态 / 进度条 / owner / 截止）+ 详情页（按模块分组
  的项表：结果下拉就地标 + 指派 + 备注 + 缺陷链接；**自动化参考列**只读，含深链；
  顶部进度与通过率 `Readout`）。导出 CSV 走 `GET .../export`。

### 11.4 实施顺序（P7-1 … P7-7）

| 步 | 内容 | 产出 |
| --- | --- | --- |
| P7-1 | 迁移 052 + 模块树 CRUD（含移动的 path 重算） — **已实现**（2026-09-07） | 树能建能改 |
| P7-2 | 用例 CRUD + 列表分页筛选 + 详情抽屉 — **已实现**（2026-09-07；同日晚反馈：编号改服务端 TC- 自增、抽屉去编号框、优先级/状态/标签同行） | 手工建用例可用 |
| P7-3 | 树视图 + 视图切换 + 勾选批量条（移动模块 / 批量优先级 / 批量改状态（2026-09-08 补）/ 删除；「加入计划」待 P7-7）；脑图目录级「加载更多」局部加载（2026-09-08，单目录大数据按 50/批递进取） — **已实现**（2026-09-07，批量改状态/局部加载 2026-09-08） | 双视图 + 跨视图勾选 |
| P7-4 | XMind 解析（`lib/zip.ts` + content.json）+ preview/commit — **已实现**（2026-09-08；兼容旧版 content.xml，见下方实现状态） | 一份真实 XMind 导入成功 |
| P7-5 | Excel 固定模板解析（exceljs 按需导入）+ 模板下载 — **已实现**（2026-09-08，同轮增补 XMind / Excel 导出，见下方实现状态） | 模板往返（下载→填→导入）闭环 |
| P7-6 | 绑定（四类目标 + 读时关联最近结果）+ 覆盖口径（树面板目录改名 2026-09-07、目录删除 2026-09-08 反馈提前落地，移动/调序仍在此步） — **已实现**（2026-09-08，见下方实现状态） | 绑定与「自动化覆盖率」可见 |
| P7-7 | 测试计划全套 + CSV 导出 + i18n 双语 + 批量条补「加入计划」入口 — **已实现**（2026-09-09，见下方实现状态） | 计划建/标/看进度可用 |

> **批次交换（2026-09-07 用户确认）**：原 P7-6「树视图」提前为 P7-3，原 P7-3「绑定 +
> 覆盖口径」顺延为 P7-6。理由：P7-2 的列表切片验收反馈「结构只有一列路径文本 +
> 一个下拉，太抽象」——树是导航主体，越晚落地，中间几批（绑定 / 导入）都在抽象
> 视图里验收；而树视图技术上只依赖 P7-1 的树接口（已就位），不依赖绑定与导入。
> 批量条的「加入计划」依赖测试计划，已随 P7-7 落地（见 P7-7 实现状态）。

> **P7-1 实现状态（2026-09-07）**：迁移 052 五张表一次建齐（P7-2…P7-7 不再需要
> 新迁移）；`routes/specModules.ts` 四个接口 + `mapSpecModule`。实现期落定的口径：
>
> - **没有「根节点」行**——顶层模块 `parent_id NULL`、`path = '/'+name+'/'`，树接口
>   返回森林由前端挂接。计划 SQL 注释「根节点 path = '/'」读作 path 计算的虚拟
>   前缀；真建根行就得给先于 P7 存在的项目补数据或惰性创建，都是新增面。
> - **同层同名 = 同 path**，先查后插回 409 + 2003（同层**不同分支**可重名，身份是
>   path——计划边界 2 的「同层可重」按此解释，与 UNIQUE (project_id, path) 自洽）。
>   新冲突码不用 environments 漂移的 1002，对齐 dataSources/auth 的 2003。
> - **前缀匹配一律 `starts_with()` 而非 `LIKE '…%'`**——模块名可含 `%`/`_`，它们是
>   LIKE 的元字符；starts_with 语义就是字面前缀。
> - **移动/改名是一条 UPDATE**：`newPrefix || substring(path, oldLen+1)` 整棵子树换
>   前缀，根行的 name/parent_id/position 用 CASE 认领。目的地前缀必须整块为空
>   （排除自家子树行），否则 409；不能移进自家子树（含自身）→ 400；移动才做深度
>   校验（子树最深行 + 新父深度 ≤ 6），纯改名不动深度。名字含 `/` 直接 400（path
>   与 Excel 目录路径共用它做分隔符）。
> - **PATCH parentId 三态**：缺省 = 不动；`null` = 移到顶层（COALESCE 表达不了
>   「置空」）；uuid = 移过去，不存在/跨项目回 400 + 1001（body 引用照 suites
>   先例，404 只留给 URL 资源本身）。
> - **删除 = 子树有任一用例则 409 + 清单（caseCount/moduleCount），`?force=true`
>   才级联**；空的子模块结构直接随根级联，不算破坏性操作。计划项随用例 CASCADE
>   消散（快照纪律保「读得通」，不拦删除）。
> - 树接口的 caseCount 是**直属**计数、含全部状态（导航口径）；自动化覆盖率只用
>   active，是 P7-3 的事。
>
> `pnpm check` / `pnpm migrate` / 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-2 实现状态（2026-09-07）**：`routes/specCases.ts` 五条接口（列表分页筛选 /
> 手工建 / 详情 / PATCH / DELETE）+ `mapSpecCase`；前端「用例库」页（导航新增
> 「测试管理」分组、路由 `/spec-cases`）+ 详情抽屉。零迁移。实现期落定的口径：
>
> - **列表行带 steps 全量**（`SELECT c.*`）：详情抽屉直接吃列表行，不再发一次详情
>   请求；`GET /spec-cases/:caseId` 详情接口建好留给 P7-3（绑定清单 + 最近自动化
>   结果的读时关联要挂上去，抽屉届时改为按需取详情）。
> - **`automation` 筛选从第一天与覆盖口径对齐**（边界 11）：有 ≥1 条**非 endpoint**
>   绑定才算已自动化——接口绑定表达「该测什么」，不算自动化进度；列表行另带
>   `linkCount`（全部绑定计数）。P7-2 没有绑定的写端，两者恒为 0 / 全 no；**筛选
>   控件也不进 P7-2 的 UI**（一个永远筛不出东西的过滤器是谎言），P7-3 接 UI 时
>   后端零改动。验收 6（筛选与覆盖率一致）因此天然成立。
> - **行序** `m.path, COALESCE(item_key,''), title, created_at DESC`——path 字典序
>   即深度优先序，P7-6 树视图落地后两视图共用同一序，切换视图同一批用例不换位。
> - **itemKey**：POST 判重 409 + 2003（UNIQUE 兜底并发；NULL 不参与唯一，无编号
>   用例不限条数）；PATCH 三态——缺省不动 / 值替换 / 空串清空（清空 = 无编号）。
> - **DELETE 无 409/force**：绑定行与计划项都 ON DELETE CASCADE 随用例消散
>   （P7-1 的纪律——计划项靠快照「读得通」，不拦内容删除）；确认框文案如实说明。
> - **步骤归一两端各持一份**：两列全空的行丢弃（行内表格极易留空行）；服务端
>   `String()` 兜底而非信任 JSON 形状（校验只拦 null 与显式非串值，`{}`/数组不该
>   把接口打成 500）。
> - **模块选择器内联「新建模块」**（父模块 + 名称，深度与 `/` 校验走 P7-1 后端）：
>   P7-2 的产出是「手工建用例可用」，而新项目一个模块都没有时用例无处可挂——
>   给最小创建入口让流程从零可用；树管理面改名（2026-09-07）与删除（2026-09-08）
>   已按反馈提前落地，移动/调序仍在 P7-6。筛选里
>   选中的模块同时充当新建用例的默认所属模块。
> - **状态色表**：active→pass、draft→skip、deprecated→canceled（Members「账号
>   active」的先例），废弃行另加 `data-removed` 整行减淡；优先级是 chip 不是色。
> - **词汇统一为「模块」**（2026-09-07 用户反馈）：列表列原写「目录路径」、抽屉里
>   叫「所属模块」，同一概念两个名字——列头改「模块路径」（值仍是 path 形态
>   `需求A/接口A1`）；筛选「按模块筛选」、入口「新建模块」本就一致。计划 11.3 的
>   「目录路径列」与 11.0 边界 5 的 Excel 模板列名**读作「模块路径」**，P7-5 落
>   模板时按此对齐。
> - **筛选全进 URL**（keyword/path/priority/status/page/pageSize，执行记录页同款）；
>   `?view=tree|list` 留给 P7-6。viewer：新建/编辑/删除入口不渲染，抽屉只读
>   （输入 disabled、无尾随空行）；路由不藏，后端守卫是单一事实。
>
> `pnpm check` / `pnpm migrate` / 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-3 实现状态（2026-09-07，批次交换后的树视图）**：`SpecCases.tsx` 重写为双视图
> 单页（默认树）+ 后端列表 `moduleId` 筛选与两条批量路由。实现期落定的口径：
>
> - **默认树视图**（`?view=tree|list` 进 URL，缺省 tree——树是导航主体，列表是全库
>   keyword 检索与批量核对的辅助视图）。视图切换是筛选栏右侧的 segmented 控件。
> - **表内树照 RepoCaseTree 的形状**（刻意不是思维导图画布——计划 11.3 边界）：
>   模块行（caret + Folder + 名字，悬停给全 path——同层不同分支可重名，身份是
>   path）+ 展开懒载**直属**用例（`moduleId` 精确筛，不含子级：前缀筛会把同一条
>   用例在父子两处各显示一次）。单模块懒载上限 100，超出显示截断说明——验收 11
>   的「2000 条不卡」读作「永不全量拉用例」。
> - **勾选集按用例 id、跨视图共享**：换页/改筛选/切视图都不清空（「树里勾一批、
>   列表搜另一批再勾」是跨模块整理的正常路径，RepoCaseTree 同款纪律）；清空时机
>   = 批量条上的 × 或批量动作落地；切项目必清。模块行的勾选框盖**已载入**的直属
>   用例（三态 indeterminate），截断边界看得见。
> - **批量条三动作**：移动模块 / 改优先级 / 删除。后端 `POST /spec-cases/
>   batch-update`（moduleId / priority 部分应用，单资源 PATCH 的校验语义逐字复用）
>   与 `batch-delete`（endpoints 批删同款：事务 + FOR UPDATE 归属预检，部分命中
>   400 拒绝）；上限 500 条（模块懒载每模块 100，跨模块勾选合法超过 endpoints
>   批删的 100，照 100 卡会把合法流当错误拦下）。「加入计划」已随 P7-7 落地。
> - **树视图里筛选的语义**：关键字/优先级/状态只作用于已展开模块内的用例（页头
>   form-note 明说），全库搜索切列表视图；切进树视图清掉模块路径筛选——树本身
>   就是模块导航，带着它进树等于只看一棵树。
> - **脏数据防线**：模块懒载请求带代数（gen），筛选/数据版本变了作废在途响应——
>   先到的旧 keyword 结果写进新视图是树视图最容易出的错。任何一次落库（单条建/
>   改/删、批量）推进 revision，列表 / 模块计数 / 树缓存三处读数统一重取。
> - **viewer**：勾选列 / 批量条 / 行内操作不渲染；空占位 td 保留（grid-fixed +
>   colgroup 少一格整行列宽错位，RepoCaseTree 的教训）；抽屉只读照旧。
>
> **P7-3 修订（2026-09-07 第二轮用户反馈，树视图重做为经典左右分栏）**：首版
> 「表内树」（模块行展开混在用例表里，RepoCaseTree 形状）验收反馈「层级与数据
> 挤在一起、还是抽象」——重做为**左侧常驻模块树 + 右侧专注用例表**：
>
> - 视图切换只剩**脑图（分栏，默认）/ 列表（全宽平表，全局检索用）**两个选项；
>   `?view=tree|list` 语义不变。
> - 点目录 = 右表筛到该目录**含子级**（path 前缀筛，与树节点计数同一口径——
>   子树计数 = 直属 caseCount 求和，客户端算）；再点一次或点「全部用例」回全库。
> - 树是纯导航（森林一次全量、展开纯折叠），用例永远走右表的服务端分页——
>   首版的「单模块懒载 + 截断说明 + 代数作废」机制整体撤销（不再需要）。
> - 树面板带「新建模块」入口（`ModuleCreateModal` 抽成共享组件，抽屉里的
>   内联创建同一套）；建完即选中并展开到它。
> - 同轮抽屉改版：宽度 640px → **页面 70%**；步骤区块从散框 kv-row 改成
>   带边框的两列表（`.steps-table`：raised 表头 + 行间分隔线 + 静息无边框输入，
>   与全站 .grid 同视觉）。
> - **第三轮（同日）落定**：建模块的入口收敛为左侧树面板**单一入口**（抽屉里的
>   内联按钮删除——录用例的地方不混结构管理）；步骤表三处视觉修正——表头列名
>   补 `var(--s3)` 缩进与输入框**内文字**对齐并升 12px/ink-2、序号钉 21px 行高
>   与首行基线对齐、自动长高补 border-box 的上下边框差（否则长文本必出滚动条）；
>   前置条件与步骤区间距 20→32px。
> - **第四轮（同日，视图与容器）**：① 树面板改**通贯式侧边栏**——sticky +
>   `height: calc(100dvh - 150px)` 钉满可视高度（原 max-height 收缩：少模块时
>   缩成矮框与右侧顶不齐；940px 以下退回 max-height 220px 横条）；② 删除
>   tree/list 平表切换（分栏即列表视图）；③ 「脑图」标签从分栏身上摘下——
>   它就是分栏列表，不是脑图；④ 新增 **XMind 脑图视图**（`?view=mindmap`，
>   SpecMindMap 组件）。
> - **第五轮（同日，脑图解析口径修正）**：脑图**不解析模块树**——树面板在两个
>   视图里都常驻不动，切换只换右半。脑图解析**当前目录下的用例**：root = 树里
>   点中的目录（缺省「全部用例」）→ 该目录（path 前缀筛，与右表同口径）的用例 →
>   每条用例展开 前置 / 步骤 / 预期 三级（`tc:` XMind 用例约定）。
> - **第六轮（同日，脑图交互重做）**：脑图画布跑在 **@xyflow/react** 上（流程画布
>   同一个库，零新增依赖——手写 SVG 画布的编辑/展开交互均不符预期，公共库的
>   平移缩放/选中/键盘体系直接继承）。交互按 XMind 惯例：**单击选中、双击就地
>   编辑（Enter/Tab 提交、Esc 取消、失焦提交）、⊕/⊖ 折叠用例、Tab 加子级
>   （根→用例、用例→步骤、步骤→预期）、Enter 加同级**；编辑直接落库（整份
>   PATCH，与抽屉保存同一形状），落库推 revision 统一重取；新建用例在「全部
>   用例」根上被拦（后端要求 moduleId，提示先点选目录）；一次拉 100 条、超出
>   节点给截断说明。viewer：双击用例开只读抽屉，无编辑/建节点。
> - **第七轮（同日，脑图四缺陷）**：① 「建完即编辑」加**创建代数门**——步骤
>   节点 id 是位置 id，插入位置的旧图同名节点曾让 pendingEdit 在旧数据上开
>   输入框、视觉等于新节点顶掉用例；现在必须等创建时刻的那次响应真正提交。
>   ② 每个节点带**形状徽记**（目录/用例/前置/步骤/预期小 chip）——位置不再
>   是形状的唯一线索。③ 抽屉改吃**意图**（`"new" | 用例 id`）：挂载时按 id
>   现拉 `GET /spec-cases/:caseId`，列表/脑图行快照不进抽屉（脑图就地编辑后
>   行对象是旧的，切视图打开曾展示旧内容）。④ 换目录时 data 归零回加载态
>   ——不清空时 React Flow 按节点 id 淂合新旧两代节点、渲染重叠；fitView 改
>   为数据真正换代后触发。
> - **第八轮（同日，⑮~⑱ 复测仍有残余）**：落库改**最小提交**（只 PATCH 改动
>   字段）+ 响应**即时合入**本地视图（连按 Tab 不再互相覆盖），代数门机制整
>   体删除；抽屉 onClose/onSaved 提稳定身份、关闭即清 item、回填改
>   useLayoutEffect；编辑态悬空兜底。详见 `issue_fix/` ⑲~㉒。
> - **第九轮（同日，白屏 + 目录层设计）**：① Tab 加步骤**画布空白**——React
>   Flow 受控节点按引用判等，nodes 引用一换内部 measured/handleBounds 整
>   重置（节点回 visibility:hidden、连线消失），乐观合入连续换引用时
>   ResizeObserver 追不上、节点永久卡死；修法：节点把 store 里的 measured
>   随身带回 + nodes 按 [graph, selectedId, edit] memo + 新节点焦点逐帧重试
>   （新建节点挂载瞬间未测量态里 focus() 静默失败）。② 用户心智模型是
>   XMind 全景——**第五轮「模块树不进图」的决策被推翻**：目录层进图（root
>   → 目录子树 → 直属用例 → 前置/步骤/预期，目录带子树计数、默认展开），
>   键位按种类落点（Tab：目录→建用例/用例→步骤/步骤→预期；Enter：
>   目录→同级目录/用例→同模块用例/步骤→后续步骤），空槽画「＋ 前置/＋ 步
>   骤」占位节点（点击即建），目录建后就地命名（改名走 updateSpecModule
>   最小提交；顺带修掉该 UPDATE 的 substring 重载 500——$6 需显式 ::int）。
>   详见 `issue_fix/` ㉓㉔。
> - **第十轮（同日，删除键位）**：选中节点 **Delete/Backspace** 删除（Mac 两
>   键等同）：用例 Modal 确认后删（与列表同话术）；目录先普通删，子树含用
>   例时 409 + 计数二次确认才 force；前置/步骤/预期是字段编辑直接落库（最
>   小提交 + 即时合入），确认只给资源级删除。详见 `issue_fix/` ㉕。
> - **第十一轮（同日，右键菜单 + 撤销 + 节点内容 + 状态口径）**：① **右键菜
>   单**按节点种类生成条目（建目录/用例/步骤/预期、添加标签 Modal、标记优
>   先级 P0~P3、删除），与键位同一套路由；② 删除**去掉全部确认**，改为
>   **⌘Z 撤销 / ⇧⌘Z 重做**兜底（past/future 双栈，目录删除先抓子树+用例
>   快照、撤销整树重建）；③ 节点内容重排：编号不进节点、**标签 chip 长在
>   原编号位**、**优先级徽章**（线框分层不上色）；④ 状态口径改
>   **未评审/已评审/废弃**（迁移 053：draft→unreviewed、active→reviewed，
>   默认 unreviewed）。详见 `issue_fix/` ㉖~㉘。
> - **第十二轮（同日，视口与命名）**：① 加前置/步骤后输入框「折叠在一
>   起」——根因是**每次数据换代整图 fitView**，树一大 zoom 缩到 ~0.45、
>   编辑中的输入框成细线；改为整图框定只在「空→有数据」（首次/换目录），
>   增量换代保持视口、操作节点出界才平移（㉙）。② 导航「用例库」→「文
>   本用例库」（㉚）。
>
> `pnpm check` / `pnpm migrate` / 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-4 实现状态（2026-09-08）**：`lib/xmind.ts`（zip → 两代格式解析 + 层级
> 映射归一）+ `routes/specImport.ts`（preview / commit 两阶段，octet-stream
> 直传照 Runner 产物写法）+ 前端「导入 XMind」三步向导（`SpecImportModal`）。
> 零迁移、零新依赖。实现期落定的口径：
>
> - **两代格式都解析**（用户 2026-09-08 要求「兼容新旧版本，支持 2025-06
>   之后的即可」）：新格式 `content.json`（Zen / XMind 2020+）是主线
>   （`JSON.parse`）；旧格式 `content.xml`（XMind 8）按边界 3 原本要拒，
>   改为用 lib 内的**极简只读 XML 读取器**兼容（元素/属性/文本/CDATA +
>   预定义与数字实体；注释/PI/DOCTYPE 跳过，ns 前缀按名忽略），解析失败
>   如实 1001。语料实测（用户给的 `~/Desktop/work/case` 54 份真实文件）：
>   **54/54 解析通过**（含 2 份旧格式），marker 模式共 1969 条 tc、
>   pc/步骤/预期拆解、priority 标记（`priority-1`→P0 … ≥4→P3）、
>   `tc-pN：` 前缀优先级、深度截断全部符合预期。
> - **文件不落存储**（用户问的「S3 or 本地」：**都不是**）：preview 是内存
>   解析（8MB content-length 预检 + 流上限 + `zip.ts` 三道炸弹闸），commit
>   收归一化 JSON——按边界 7「前端持有、不落暂存表」，导入链路不经过对象
>   存储（fs/s3 抽象只服务 Runner 产物）。将来要留源文件存档，走
>   `objectStore` 另起批次。
> - **层级映射只保留 `tc:` 标记一种**（2026-09-08 用户收窄：原计划的「叶子即
>   用例」解析出来的全是碎片——预期结果、步骤说明都被当成独立用例，「出来
>   也是乱的」，**删除**；无 tc 约定的文件解析为 0 条，预览页说明原因）。
>   识别 `tc：`/`用例：`/`tc-pN：`/`tc-pN-类别：` 前缀（`-` 分段链整体捕获，
>   首段 `pN`→优先级、其余段是用例类别、**并入标签**而不是丢弃——`project X
>   测试用例（SC系统）.xmind` 的 `tc-p0-功能测试：` 形态 155 条曾整文件识别
>   不出，扩完后识别正常）；子树按约定拆字段——`pc：`/`前置：` 子节点→前置
>   （多个换行拼接）、其余子节点→步骤、步骤的子节点→预期（换行拼接）；
>   notes→前置、labels→标签、marker 优先于前缀、缺省 P2。语料口径：
>   54/54 文件 marker 模式共 1969 条 tc。
> - **导入根目录**（2026-09-08 用户要求）：上传步可选一个既有模块，preview
>   带 `rootModuleId`（uuid，校验项目归属，引用 400+1001）——整份文件挂到
>   该模块下（`/选中目录/文件根/…/`），不选则按文件自身结构（缺省即原行为，
>   退化语义干净）。深度截断按**最终路径**算（选中根目录占层），`pathClamped`
>   逐条可见。
> - **模块路径**：根节点标题为顶层模块（「祖先链=目录路径」直读；空标题退
>   sheet 名、再退文件名），模块名 `/`→全角`／`、换行压空格、树深 >6 截断
>   并逐条标记 `pathClamped`（预览里看得见，否则「目录少一层」读作丢数据）。
> - **判定四态**：计划的三态之外补第四态「**文件内重复**」（同 (路径,标题)
>   或同编号的后续行）——不标它就会二次落库。判重键编号优先、(路径,标题)
>   回落；「未变/有变」比较 title/前置/步骤/优先级/标签/模块路径六面。
> - **超 2000 条不拒绝预览**：只标记 `exceededLimit`（提交禁用 + 提示拆分
>   文件分批导）；commit 硬拒 2000。
> - **commit 一个事务**：模块按前缀逐层补建（`ON CONFLICT` 兜并发导入）→
>   判重在事务里**重跑**（不信客户端的预览结论）→ 取号基数一次算好（无编号
>   行统一走服务端 TC- 序列——2026-09-07 增补；并发撞号 23505 整单回滚
>   409+2003 提示重试）→ 逐条 insert / update；更新不动
>   status/source/item_key（编号是系统身份、生命周期归平台）。响应带
>   created/updated/skipped/duplicate/modulesCreated。
> - **前端向导**（计划 11.3 三步）：上传（点击/拖放 + 可选导入根目录，
>   白名单 .xmind，.xlsx 留给 P7-5）→ 预览（计数 chip + 分组树勾选 + 逐条
>   展开看前置/步骤/预期拆解；默认勾「新增+有变」）→ 结果读数；落地推
>   revision 统一刷新右表/模块计数/树缓存。preview 走写权限（viewer 不该
>   能向平台投喂任意文件解析）。
>
> `pnpm check` / `pnpm migrate`（无新迁移）/ 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-5 实现状态（2026-09-08）**：`lib/excel.ts`（exceljs **按需 `import()`**，
> NodeNext 下 CJS 互操作实测走 `.default.Workbook`）+ `routes/specImport.ts` 扩
> `.xlsx` preview 与模板下载路由 + 前端向导双格式。**同轮增补（2026-09-08
> 用户要求）**：XMind / Excel **导出**——`lib/xmindWriter.ts`（content.json
> 生成 + `lib/zipWriter.ts` 零依赖写入器，Runner 写入器的服务端副本）与
> `buildExcelExport`（与模板同一生成器），路由挂 `GET /spec-cases/export/:format`
> （specCases.ts，筛选与列表逐字同套）。实现期落定的口径：
>
> - **模板八列**：`模块路径 | 用例编号 | 用例标题 | 前置条件 | 步骤 | 预期结果 |
>   优先级 | 标签`（列名「模块路径」对齐 P7-2 词汇统一；计划原文「目录路径」
>   读作它）。解析按表头名映射不依赖列位（前 10 行内找「用例标题」定表头，
>   多 sheet 取第一个带合法表头的），多余列容忍、缺「用例标题」拒。
> - **一行一步骤**：同一用例的多行靠「用例编号」或「(模块路径, 标题)」归组；
>   编号/路径/标题三格全空 = 续行（合并单元格天然落进这个语义）。前置/优先级/
>   标签取组内首个非空值。**行级错误指名行号整份拒**（缺模块路径 / 缺标题 /
>   优先级非 P0–P3，最多列 5 条）——模板是平台契约，静默吞行会让往返失义。
>   选中导入根目录**不豁免**模块路径列（不做隐式挂载魔法）。
> - **深度截断按最终路径算**（选中根目录占层），`pathClamped` 逐条可见——与
>   XMind 路径同一条纪律；标签分隔符 `,`/`，`/`、`/`;`；行数护栏 20000。
> - **导出即模板**：Excel 导出与模板同一生成器、同八列（一行一步骤、每行自带
>   全部字段，Excel 里筛序不依赖上下行；无步骤用例占一行）；**按 1 级目录分
>   sheet**（2026-09-08 用户要求，与 XMind 导出同构——每个 top 模块一张表；
>   sheet 名做 Excel 合法化：≤31 字符、`:\?*[]` 清洗、`~N` 去重），模块路径列
>   仍写全路径——分 sheet 只是组织形态，回导按列还原不读 sheet 名，一张表里
>   跨模块的行也照常解析；**解析侧多 sheet 整本收**（每张带表头的表都解析，
>   「填写说明」sheet 无表头天然不参与；多表文件的行级错误带 sheet 名）。编号
>   原样带出，回导按编号判重，无编号行回导时服务端重新取号——**Excel 往返
>   闭环**（多 sheet 回导已验证逐字段精确还原）。
> - **XMind 导出以回导闭环为硬约束**：新格式 content.json；每个 top 模块一个
>   sheet（root.title = 模块名，import 侧 rootSegment 直读——模块路径原样往返）；
>   用例 = `tc：` 前缀节点 + `priority-1..4` marker（P0..P3 逆映射）+ labels（标签）
>   + **单个 `pc：` 子节点（前置，多条按行折行成一个分支）** + 子节点（步骤）/ 孙节点（预期按行
>   拆开，import join("\n") 还原）。前置条件**写 pc 子节点不写 notes**（第二轮
>   反馈：notes 是角标点开才见，子节点才是脑图的形状）；notes 只保留在模板里
>   作导入约定演示。**编号不导出**：XMind 两代格式都没有编号位，回导按
>   (路径, 标题) 判重——与语料工作流一致；要带编号的往返用 Excel。
> - **导出范围＝勾选集优先**（2026-09-08 第二轮反馈）：勾选非空 = 精确导这批
>   （树/列表跨视图勾选集，归属预检同批量条，上限 2000 对齐导入；uuid 放不进
>   query string，路由是 POST）；空 = 按当前筛选（与列表逐字同套：keyword /
>   path / moduleId / priority / status / automation），全量命中集不分页，
>   viewer 可导（纯读）。**导出边界**：只导平台真值快照，**不做回写合并**
>   （11.6 边界的另一半仍然不做）。zip 写入器 mtime 固定 0——字段内容才是身份，
>   同批用例两次导出 checksum 相同。
> - **前端**：向导双格式（accept `.xmind,.xlsx`，提示按已选文件切换，上传步两枚
>   模板按钮——**Excel 模板与 XMind 模板**（`?format=` 区分，XMind 模板
>   2026-09-08 用户增补：`buildXmindTemplate` 把 tc：/用例：/tc-pN：/pc：/备注→
>   前置/无预期步骤/多行预期/priority 标记/标签各约定演示一遍，根节点备注带
>   约定速查——导入侧只读 tc 节点的 notes，根备注是给人看的），commit source
>   按扩展名定）；用例库 topbar 新增「导出」下拉（XMind / Excel 两项，文件名
>   `用例库-YYYYMMDD.ext`），**悬停提示落到具体范围三态**——勾选集（跨视图，
>   「将导出勾选的 N 条」）> 点中的目录（含子级）>「全部用例」（modulePath 为
>   空即树顶「全部用例」节点，2026-09-08 反馈修正口径：不存在「未选目录」态）
>   + 命中条数（直接用右表 total，列表与导出同一套筛选参数；antd Tooltip 包
>   按钮、span 作 Dropdown 触发子元素——Tooltip 与 Dropdown 叠同一子元素会互相
>   吞事件）；Blob 下载统一走 `lib/download.ts`（路由要 Bearer 头，裸 `<a>`
>   触发不了认证）。
>
> `pnpm check` / `pnpm migrate`（无新迁移）/ 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-6 实现状态（2026-09-08）**：`routes/specCases.ts` 绑定读写端两条路由 +
> 详情接口带 `links[]`（读时关联）、`mapSpecCaseLink`；树接口与 dashboard 各补
> 覆盖口径读数；前端抽屉绑定区 + 四类目标选择器 + 自动化筛选/覆盖率。**零迁移**
> （`spec_case_links` 在 052 已建齐）。实现期落定的口径：
>
> - **读时关联一条 SQL**（`LINK_READ_SQL`）：绑定行按 target_type 各查各的
>   「最近一次」——case 查 `executions`（source='test_case' 的最新终态）、
>   flow 查 `flow_executions`（flows.ts latestRuns 同款 ORDER BY created_at
>   DESC LIMIT 1）、repo_case 走 ingest.ts 的 LATEST_REPORT_LATERAL 同一把
>   匹配尺（报告状态优先，没报告行退 `repo_test_cases.last_result`——树视图
>   lastReport/lastResult 同款优先级）、endpoint 无执行语义恒空。四类互斥
>   拼在一条 CASE 里，不做四条往返。**绝不回写**（迁移 047 同一条纪律）。
>   结果三列（status/at/runId）以 'status|at|runId' 竖线拼串出列、拆回三段
>   ——CASE 子查询只能产一个标量，三个列要把子查询写三遍。
> - **repo_case 按 case_key 绑定**（边界 9）：POST 传当前行 id，服务端取
>   case_key 存 `target_key`；**同 key 重现时旧绑定就地换行 id**（UNIQUE 拦
>   不住同 key 换 id 的重复绑定——身份是 key），语义与「重复绑定」合并。
>   removed 行也允许绑（绑定是对 key 的，对账状态读时显示「目标已失效」）。
> - **写端只有建与删**：重复绑定 409 + 2003（模块同层同名同一套冲突码）；
>   DELETE 无引用扫描——目标侧（接口/用例/流程/仓库用例）从不因被绑定而拦删
>   （绑定不构成对目标的生命周期约束）。POST 的 RETURNING 带目标名：前端就地
>   合入这一条，不整抽屉重拉（重拉会吃掉正在编辑的表单草稿，㉑ 同款纪律）。
> - **覆盖口径（边界 11）三处同表达式**：有 ≥1 条**非 endpoint** 绑定的
>   **已评审**（迁移 053 前 active）用例 / 全部已评审用例——树接口带
>   `activeCount`/`automatedCount`（直属口径，子树求和归前端）、列表行带
>   `automated`（与 automation 筛选同一表达式，不限定状态——deprecated 的
>   绑定事实照实读）、dashboard 带 `specCaseTotal`/`specAutomatedCount`/
>   `automationRate`（项目行 + 全局汇总 + 项目表格列，跨项目先合分子分母再除）。
>   分母只数已评审是边界 11「active 文本用例」在 053 改名后的直读。列表筛选
>   「已自动化」不限定状态（筛选是过滤不是比率），两处口径在已评审用例上取值
>   一致（验收 6）。
> - **树面板覆盖率读数**：面板顶部一块（百分比 + 分子/分母 + 一句口径说明，
>   边界 11「三个口径各配一句话说明」）；0 条已评审显示「—」（「还没有用例」
>   与「0% 覆盖」是两个事实，dashboard passRate 同款纪律）。
>   **automation 筛选透传脑图**（2026-09-08 反馈修）：列表与脑图共用筛选语境，
>   SpecMindMap 的取数/筛选态/目录局部加载开关/乐观追加守卫全链路带
>   automation——此前只在列表生效，脑图仍读全量。
> - **抽屉绑定区**：只读行 = 类型 chip + 目标名（repo_case 悬停显 case_key）+
>   最近结果（Status 原语上语义色）+ 最近执行时间；目标删了显示「目标已删除」、
>   repo_case 对账标 removed 显示「目标已失效」（验收 7：悬空不消失、不报错）；
>   endpoint 绑定行标注「不算自动化」（边界 10 的中间态：设计了但没自动化）。
>   viewer 只读（无添加/删除按钮）。**新建用例不显示绑定区**——绑定挂在已存在
>   的用例上，先保存拿 id。
> - **绑定行点击跳转（2026-09-10 用户反馈落地）**：目标名变 `cell-link` 可点，
>   四类目标复用现成深链各跳各的详情页——endpoint → 接口工作台、case →
>   宿主接口工作台 `?case=`（`LINK_READ_SQL` 补 `target_endpoint_id` 读时
>   列，mapper/前端类型同步加 `targetEndpointId`）、flow → 画布、repo_case →
>   有报告出处跳 `pipeline-runs/:runId`（树上「最近任务」同款取舍）、无报告
>   跳树页 `?keyword=case_key`。不可跳的行（目标已删 / case 宿主接口已删 /
>   repo_case removed）名字仍是纯文本——不给一条点了 404 的链接。
> - **绑定选择器四 tab**：接口（endpointsPaged 分页）/ 接口用例（projectCases
>   按接口分组，SuiteMemberPicker 同款）/ 流程（平铺）/ 仓库用例（repoCases
>   拍平，默认只回 active 行）。**点行即绑定**（逐条 POST、逐条反馈——绑定是
>   轻动作，不用「勾一批再确定」）；已绑定行置灰「已绑定」（同一目标两条绑定
>   没有语义，后端 409 兜底）。组件独立成 `SpecLinkPicker.tsx`（2026-09-08
>   反馈拆出）：抽屉与**脑图右键菜单**（用例节点「绑定自动化…」，打开前现拉
>   详情取 existing）两个入口共用，留在 SpecCases.tsx 会构成循环 import。
>   弹窗 760px + colgroup 定死三列（名称 47% / 元信息 45% / 动作 8%）+
>   行内省略号收缩、**悬停 Tip 吐完整信息**（名称 + method/url / case_key）——
>   长标题不再盖掉后面一列。
> - **移动/调序（P7-6 补齐，2026-09-08 第二轮反馈改纯拖拽）**：后端 P7-1 的
>   PATCH 已支持（parentId 三态 + position），本轮接 UI 时先落了「上移/下移/
>   移动」三枚悬停钮——264px 树面板放不下（每行悬停 4~5 枚按钮基本没法看），
>   同日反馈后**改为原生 HTML5 拖拽**，三枚方向/移动钮与移动弹窗全部删除，行上
>   只剩改名 + 删除。落点语义：目标行**上/下边缘 8px** = 插到该行同级前/后
>   （跨目录时先 PATCH parentId 过去），**中部** = 移进该目录，「全部用例」行 =
>   移到顶层。调序走新增的 `POST /spec-modules/reorder`（一次写平该层 position，
>   服务端校验 moduleIds 恰好等于当前直属集合——过期即 400 拒绝重拖）；移入/
>   顶层走 PATCH parentId（后端一条 UPDATE 换整棵子树 path 前缀）。落点指示只
>   用 accent：边缘 2px 插入线（同级行对齐）+ 中部 selected 底（与点中目录同一
>   视觉 = 「进这个目录」）；dragover 每秒数十次，区段状态（dropZone）只在变化
>   时写 state 防整树重渲染。移进自家子树前端先拦（后端也 400）。**两视图同级
>   排序统一 (position, name)**：树视图 buildSpecModuleTree 与脑图视图
>   childrenByParent 同一把尺，调序后两视图同级不换位。移动落地后右表筛选若在
>   被移动子树里回「全部用例」（子目录新 path 要拼两个模块的 path，拼错的筛选
>   比回全部更糟）。拖拽可发现性：面板里一句 11px 常驻提示（canWrite 才显示）。
>   **双击目录 = 展开/收起子目录**（第四轮反馈，两轮收口：先是「双击强制选中 +
>   守卫窗口 400→550ms」——没用，守卫只能拦双击的**第二击**，第一击落在窗口外
>   照样走进「已选中 → 取消」的开关分支，双击照样弹回「全部用例」；根因是
>   **「再点取消」语义与双击的第一击天然冲突**，窗口调多宽都治不了。终版：
>   单击只有选中语义，取消走树顶「全部用例」根行，守卫整个删除；重复点同一
>   目录是同值 setState，右表不重取。叶子目录双击忽略）。
>
> `pnpm check` / `pnpm migrate`（无新迁移）/ 服务重启按 AGENTS.md 留给用户执行。
>
> **P7-7 实现状态（2026-09-09）**：`routes/testPlans.ts` 全套接口（列表 / 建 /
> 详情 / 改 / 删 / 加项 / 标项 / 删项 / CSV 导出）+ `mapTestPlan` /
> `mapTestPlanItem`；前端 `TestPlans.tsx`（列表 + 详情独立路由
> `/test-plans/:planId`）+ 批量条第五动作「加入计划」。**零迁移**（五张表在
> 052 已建齐）。实现期落定的口径：
>
> - **汇总一条 SQL**（`PLAN_SUMMARY_SELECT`）：五个结果计数出自同一个分组
>   子查询挂在计划行上（dashboard 同款纪律），以 `p|f|b|s|total` 拼串出列、
>   路由层拆回——五列 COALESCE 要写五遍，拼串一遍带出（LINK_READ_SQL 同一
>   手法）。进度 = 已标记/total，口径只在服务端产这一个地方（边界 14）；total 0
>   前端显示「—」。~~通过率 = passed/(passed+failed)~~ **2026-09-09 第三轮反馈
>   改为 passed/total**（边界 14 的 passRate 口径修订：分母是全部计划项，未执行
>   也算未通过——执行中的计划没标完就是没通过完，与平台执行类 passRate 的
>   终态分母不是一个语义；dashboard/报告的 passRate 不随之改）。
> - **POST 建计划可带初始 specCaseIds**（上限 500，批量条同款）：归属预检 +
>   事务，部分命中 400 整批拒绝（不建半份计划）；批插 id 用 `gen_random_uuid()`
>   （PG13+ 内置，迁移 011 已有先例）。**加项的重复语义**：同一批里已在计划的
>   项 `ON CONFLICT (plan_id, spec_case_id) DO NOTHING` 静默跳过、其余照常
>   插入、返回真实插入数——「把 20 条加进计划、3 条已在里面」读作 17 进 3 跳，
>   一次 409 拒整批会把正常操作变错误（与绑定的重复 409 不同：那是单条动作，
>   这里是批量幂等）。
> - **标结果清 executed_at 绑死**：给非空 result = `now()`；显式 null（清回
>   未执行）= 连带清执行时间——不留「未执行但有执行时间」的脏态；不带 result
>   的请求（指派/备注）不动它。closed 不锁项编辑（状态只是标签，关计划后补
>   备注是真实场景——不发明 UI 拦不住的约束）。
> - **详情自动化参考列**：只读参考取**该用例全部非 endpoint 绑定目标的最近一次
>   终态**（case/flow 与 LINK_READ_SQL 同一把尺，repo_case 退 `last_result`
>   推导值、无时间悬空排末位——报告行判型要 GROUP BY pipeline_run_cases，
>   逐项展开太重），LATERAL 按 at DESC 取一条；**绝不回写**、不参与通过率
>   （边界 12）。项行另带 item_key / 用例现状态活数据：用例删了两者缺席，
>   快照仍在、行读「用例已删除」（验收 8 的读法）。
> - **CSV 导出 viewer 可导**（纯读，P7-5 用例导出同款）：UTF-8 BOM + RFC 4180
>   转义（引号/逗号/换行）；列头用英文机器词汇（module_path/item_key/…），
>   结果列出原始值（passed/failed/…）——CSV 是给 Excel 与脚本消费的机器格式，
>   本地化留给打开它的人（验收 12：Excel 双击直开中文不乱码）。
> - **owner / assignee 用户校验**：active 用户即可，**不做成员资格校验**——
>   执行人未必是项目成员（跨项目借人是真实场景），访问由标结果的人自己的
>   账号权限把关。owner 缺省当前提交人；计划没有 owner 没有语义（null = 400）。
> - **DELETE 计划无 409/force**：不存在别的表引用计划（项 CASCADE 是本表
>   自己的语义），确认框文案如实说明「已标记的结果一并删除」。**11.2 清单外
>   补的 DELETE**（列表页没有删除不完整，2026-09-09 实现期决定）。
> - **前端**：详情独立路由（照 SuiteReportPage 先例——可收藏转发，面包屑经
>   `setDetailTitle` 报真实计划名）；项表**不分页**（通读「哪些没跑」不该翻页，
>   套件成员明细同一纪律），按 module_path_snapshot 分组（picker-group 组头
>   复用）；行内 Select 就地标结果 + 备注弹窗（note + 缺陷链接纯文本 URL）；
>   就地合行不整页重拉（㉑ 同款纪律——正在编辑的备注不丢）。进度条是手写
>   `.plan-track/.plan-fill` 原语：accent 只标进度（语义色留给结果列），
>   「跑了一半」不是 pass、「被阻塞」不是 fail。日期字段用原生
>   `<input type="date">`（自定义 .input 皮肤）——计划周期只有天粒度，
>   antd DatePicker 的面板与国际化是多余新增面。
> - **批量条「加入计划」**（SpecCases）：Modal 内 segmented 二选一——加入既有
>   open 计划（选项带项数）或就地新建（名称 + 截止，勾选集作初始项）；选项只列
>   open（closed 是历史档案，往里加项没有语义）；落地清勾选（批量动作同纪律）。
>   勾选上限 500 与其他批量动作一致。
> - **导航**：「测试管理」组第二项「测试计划」（CalendarCheck 图标）+
>   `main.tsx` 两条路由 + pageTitle kebab 特例 + `test-plans/:planId` 的 detail
>   面包屑分叉。i18n 双语全套（testPlans 命名空间 + specCases 计划选择器词条）。
>
> **P7-7 计划详情第一轮反馈（2026-09-09，四项交互调整 + 一项缺陷）**：
> - **目录分组可收起/展开**：组头整行点击切换，折叠件与用例库左树同款
>   （.tree-caret + Folder + 计数）；收起父目录**连带隐藏子目录组**（路径
>   前缀判定，树语义——组间不嵌套渲染但折叠行为与树一致）；默认全开
>   （通读「哪些没跑」是主任务），收起是会话内状态，不进 URL、不持久化
>   （左树同款取舍）。
> - **用例行点开只读**：标识格点击开 `SpecCaseDrawer` 新增的 readOnly 视角
>   ——字段全灰、绑定区只读、页脚只剩关闭、模块给路径文本（不渲染
>   TreeSelect，模块树是调用方上下文，计划页没有）；计划是历史记录，
>   从这里改库用例会把「快照读数」与「现值编辑」搅在一个入口，要改去用例库。
>   抽屉随批导出复用（modules/onSaved 转可选）。
> - **结果下拉着色**：选项与已选态都用 Status 原语（resultOptionView 与只读
>   态同一张色表）——同一结果在标记、只读、表头计数三处同色（语义色是
>   保留词的纪律落到第五个落点）。
> - **结果表头悬停计数**：Tip 竖排五态 Status 行（通过/失败/阻塞/跳过/未执行
>   + 数量），计数来自计划 summary，不加查询；Tip 的 text 放宽为 ReactNode。
> - （缺陷：自动化参考列对无自动化行的 `specCases.links.result_null` 键名
>   显示，修法与取证见 `issue_fix/问题记录-P7计划详情result_null.md`。）
>
> **P7-7 计划详情第二轮反馈（2026-09-09）**：
> - **自动化参考列整列删除**（用户明确不需要）：前端列 + 表头/colSpan +
>   i18n 两键、后端详情的读时关联 LATERAL 查询、`TestPlanItem.automation`
>   字段（api.ts 与 models/types.ts）全链路移除——**范围收缩**：11.5 原记的
>   「详情自动化参考列」条目作废（当天它的两个缺陷——LATERAL 括号错位 500 与
>   String(null) 键名显示——都长在这条查询里，删列即除根，两条 issue_fix
>   记录已追记）；`specCases.links.result_*` 词条仍被用例库绑定表使用，保留。
> - （缺陷：标结果/移项后头部计数不推进 + 编辑弹窗改名清零进度，就地合行
>   漏算 summary；修法与取证见 `issue_fix/问题记录-P7计划详情summary不推进.md`。）
>
> **P7-7 计划详情第三轮反馈（2026-09-09）**：
> - **通过率口径改为 passed/total**（用户定口径）：分母从「终态项数
>   (passed+failed)」改为「计划全部项数」，未执行/阻塞/跳过都算未通过——
>   `passRateOf` 一处改（列表列与详情 Readout 共用），total 0 仍显示「—」；
>   hint 文案（i18n zh/en）与后端注释同步。dashboard / 套件报告 / 趋势页的
>   passRate 是执行类口径（终态分母），不随之改。
> - **Readout 两处修正**：通过率恒绿（`tone="pass"`——分母是全部项的口径下
>   不满 100 就红会逼着进行中的计划立刻喊失败，达标线是人的判断不是数字
>   属性）；「N 条未执行」格的值位原放 blocked+skipped 算式（答非所问、0 时
>   读作歧义数字），改为四态计数行（Status 原语：色点 + passed/failed/
>   blocked/skipped 数）——未执行数本身已在标签里。
>
> **P7-7 计划详情第四轮反馈（2026-09-09）**：
> - **归档/重开提为 topbar 常驻按钮**（原先是页脚一行 linkish 文本，没人看
>   得到）：Archive 图标 + 悬停说明（归档 = 转只读档案，reopen 反向）；
>   页脚 linkish 开关删除。
> - **四态计数行加文本**：`通过 2 失败 0 阻塞 0 跳过 0`（纯色点+数字要人
>   猜），词汇与结果下拉同一套。
> - （缺陷：编辑弹窗回填后截止时间消失——pg DATE 列解析成 Date 对象、
>   `String()` 产出 date input 不认的形状；修法与取证见
>   `issue_fix/问题记录-P7计划日期时区错位.md`。）
>
> `pnpm check`（前后端各余一处 P7-4/5 未提交代码的既有报错，与本批无关）/
> `pnpm migrate`（无新迁移）/ 服务重启按 AGENTS.md 留给用户执行。

> **P7 验收结论（2026-09-09，通过）**：P7-1 ~ P7-7 七个批次（四表迁移 /
> 用例 CRUD 与双视图 / XMind+Excel 导入 / 导出 / 绑定与覆盖口径 / 测试计划）
> 用户验收通过。验收期（2026-09-07 ~ 09-09）计划详情四轮反馈的交互调整
> （目录折叠 / 只读抽屉 / 结果着色与悬停计数 / 归档按钮 / 通过率口径改
> passed/total / 四态计数行带文本）与五个缺陷（详情 500、result_null 键名、
> summary 不推进、DATE 时区错位、Babel 注释笔误）均已修复，记录见
> `issue_fix/` 各「P7*」文件。**范围收缩**：计划详情自动化参考列整列移除
> （2026-09-09 第二轮反馈，验收门槛 10 作废）；通过率口径改为 passed/total
> （第三轮反馈，门槛 9 同步修订如下）。后续使用中暴露的问题照常走
> `issue_fix/` 流程。

1. 一份 300 条用例的真实 XMind：模块层级与源文件一致、`tc:`/`pc:` 字段拆解正确、
   标记与备注进对应字段。
2. 同一份 XMind 导入两次：第二次预览显示「已存在未变」为主，无重复行。
3. 无编号用例改标题再导入：预览明确提示「将创建新用例」（判重键回落语义可预期）。
4. Excel 模板下载→填写→导入闭环；目录路径用 `/` 分隔多级。
5. 上传超过 8MB / 非白名单扩展名 / zip 炸弹：明确报错，不是 500 或静默。
6. 绑定一条接口用例后，用例列表「已自动化」筛选与项目自动化覆盖率读数一致。
7. 仓库用例被对账标 removed 后，绑定显示「目标已失效」而不是消失或报错。
8. 勾选（跨树/列表视图）→ 创建计划 → 计划项带 title/module 快照；此后改用例标题，
   旧计划显示快照。
9. 计划通过率 = passed/total（2026-09-09 第三轮反馈修订口径：分母为计划全部项，
   未执行算未通过；原「passed/(passed+failed)、blocked/skipped/未执行不进分母」
   废弃）；标结果后头部计数与悬停计数即时推进。
10. ~~计划详情的「自动化参考列」与被绑定资产的实际最近结果一致，且点击可跳转。~~
    （2026-09-09 第二轮反馈：该列整列移除，门槛作废。）
11. 树视图 2000 条用例不卡（模块计数聚合在服务端，不前端全量拉用例）。
12. CSV 导出用 Excel 打开中文不乱码（UTF-8 BOM）。

### 11.6 后置（记录取向，不排期）

- **按绑定触发自动化**（用户 2026-09-04：待办，有人提需求再做）：取向见边界 13——
  复用套件 / CI 两条既有扇出器，计划只记 `generated_suite_id`。
- 用例评审流（草稿→评审→生效的状态机 + 通知）。
- 逐版本 diff 与回滚 → P10 14.3 一并做。
- XMind 导出回写（**导出已随 P7-5 落地**——2026-09-08 用户要求提前，见 P7-5
  实现状态；这里剩下的「回写」指把用户改过的 .xmind 合并回平台，含冲突处理，
  仍然不做）。

---

## 十二、P8 — 数据统计（全局/项目趋势 + 失败归因 + 下钻，约 4 周）

### 12.0 P8 范围与边界（2026-09-04 确认）

**问题**

平台有三处统计、各说各话，且只有「当下」没有「变化」：dashboard 是项目卡片 + 四个
比率（读时聚合）；trend 是单项目 24h/7d/30d（`reports.ts:153`，样本 `execution_index`）；
summary 是 24h 失败分布（`reports.ts:204`）。具体缺口：

1. **没有全局（跨项目）趋势**——trend 挂在 `requireProjectAccess` 下（`reports.ts:154`），
   单项目作用域是 RBAC 最小单位（既有明确决策）；总报告列表的 UNION SQL 两侧写死
   `project_id = $1`（`reports.ts:288,307`）。
2. **失败归因为零**——现在只有读时四分类（assertion/script/timeout/request，
   `reports.ts:230-243`），只覆盖 `executions`；CI 用例失败（`pipeline_run_cases.message`）、
   上报失败、套件父级失败完全不参与。「这周失败里多少是环境问题」答不出来。
3. **无新增趋势**——资产（接口/用例/流程）只有当前总量，没有「本周新增多少」。
4. **无下钻**——趋势图无 hover、无点击（交互文档 6.2d 早已预留 canonical URL 表但从未
   接线；`executions/by-index/:indexId` 统一入口也未实现）。

**既有缺陷（本阶段 P8-1 一并收口，缺陷本身记 `issue_fix/`）**

| # | 缺陷 | 锚点 |
| --- | --- | --- |
| ① | 通过率三处口径分叉：`success/total`（skipped 进分母）与 `success/(s+f+skipped)` 两种旧算法仍在跑 | `lib/reportPayload.ts:22-23`（报告详情 + 分享页）、`lib/alerts.ts:334`（通知模版）；`issue_fix/问题记录-P4.5验收20260903第二批.md:53-60` 列了三个落点、漏了这两处 |
| ② | 单步调试自指索引行污染趋势样本——列表排除了（`executionIndex.ts:23` 的 `detail_id <> id`），趋势与汇总没排除 | 写入在 `flows.ts:84-88`；漏过滤在 `reports.ts:176,216` |
| ③ | `includeRepo` 只作用于 summary 第一段（总量读 `execution_index`），失败分布两段读 `executions`（无 ingest/runner 数据）——打开开关后总量变、分布纹丝不动 | `reports.ts:59-66` vs `:221-243` |

**核心模型**

**先把口径收口到一个模块（`lib/metrics.ts`），再叠加全局维度、下钻能力与人工归因。
归因是用户填的一等数据（不是从 error 文本推定的读时分类）；自动归因经 MCP 由外部
agent 写回。图表继续手写 SVG，提成可复用组件并补 hover/刻度/下钻。**

**边界决策（23 项；19–22 为 2026-09-09 第二轮增补，23 为同日第三轮；16/17 同日
第四轮修订）**

1. **P8-1 是纯收口步，先于一切新图表**（照 P5-2「重构独立成步」的先例）：三处口径
   全改 `passed/(passed+failed)`；趋势/汇总补 `detail_id <> id`；`includeRepo` 的一致性
   在新归因统计上直接做对（旧 summary 的②③段随新页替换退役）。独立成步的理由：
   口径修复与新增代码混在一批，数字变了分不清是「修对了」还是「新 bug」。
2. **口径三件事收敛到 `lib/metrics.ts`**：通过率公式、失败样本集（status 过滤 +
   自指排除 + `includeRepo` 语义）、资产新增口径。导出 **SQL 片段常量**（不是函数），
   嵌进各处 SQL——`PASS_RATE_SQL = "(CASE WHEN (passed + failed) > 0 THEN ROUND(passed::numeric*100/(passed+failed),1) END)"` 这类字符串常量比参数化抽象好读，这是
   SQL 拼接纪律（只有代码片段可拼接）允许的形态。
3. **失败归因是人工标注的落库数据**，与读时四分类并存、分层展示：读时分类是
   「失败长什么样」（客观、粗筛），归因是「为什么失败」（判断、可统计）。归因对象
   是失败的最小可读单元，三类目标（PK 都是 UUID，多态一表）：
   - `executions`（接口用例/流程步骤的 HTTP 失败）
   - `pipeline_run_cases`（CI 用例失败，status IN ('failed','error')）
   - `execution_steps`（套件/流程的非 HTTP 步骤失败）
4. **不在父级（run/suite execution）上归因**——一次 run 挂 20 条用例可能三个原因，
   父级打一个标签会把统计做假。但**批量归因是一等交互**（一次 CI 挂一片同因失败太
   常见）：报告页支持勾选多条失败一次打标。
5. **归因分类法平台级一份、7 类固定、项目不可改**（用户 2026-09-04 确认）：
   产品缺陷 / 用例缺陷 / 环境问题 / 数据问题 / 不稳定（flaky）/ 外部依赖 / 其他。
   归因统计的价值在跨项目可比（「全平台 40% 失败是环境问题」），项目各自定义会让
   全局饼图无法聚合。项目特有原因写进 `note` 自由文本。**升级判据**：某项目 60%
   归因落在「其他」且 note 内容重复时，再议项目级扩展。
6. **一条失败只有一个归因**：`UNIQUE (target_type, target_id)`。重打标 = UPDATE。
   保留 `created_at`/`updated_at`/`created_by`，不做归因历史版本。
7. **未归因不入库（没有行 = 未归因）**，因此「归因覆盖率」是可推动的指标。**任何
   归因占比图必须同屏显示归因覆盖率**——一张「40% 环境问题」的饼图在只归因了 10%
   失败时没有意义。这是本阶段最重要的展示纪律。
8. **自动归因走 MCP，平台不写一行 LLM 代码**（用户 2026-09-04 确认；P5 边界 16 的
   自然延伸——平台不调模型，模型调平台）：新增两个 MCP 工具
   `list_unattributed_failures`（读，带证据摘要）与 `set_failure_attribution`（写，
   复用 REST 同一套校验）。外部 agent 读证据 → 自行判断 → 写回，`created_by` 落
   `mcp_token.created_by`（**真人判据照旧**，P5 边界 2）。来源标 `source: 'mcp' | 'human'`，
   统计页可按来源筛——回答「这个分类是 AI 打的还是人打的」。**不建审核队列**：agent
   归因视为事实、可被人覆盖；审核流是没人会清理的债务。
9. **归因入口两处**：报告详情页失败行（CI 用例行、套件成员行）与执行记录列表的
   失败行——点击开小抽屉：分类单选 + note + 证据摘要（状态码/断言失败项/error 原文
   只读展示）。成功/取消的行不出现归因入口。
10. **全局统计走新接口 `/api/v1/stats/*`**，不改旧项目级接口的形状——旧的挂在
    `requireProjectAccess` 下（权限是它的形状的一部分）；全局接口自己 `currentUser()`
    + 可见项目集。**旧接口保留**（趋势页在用），新页面上线后前端切换，旧路由退役
    列入收尾批次。
11. **可见项目集在 SQL 里过滤**：非系统管理员追加
    `EXISTS (SELECT 1 FROM user_project_roles upr WHERE upr.project_id = ei.project_id
    AND upr.user_id = $n)`——照 `dashboard.ts:29-32` 的写法，**不做**「Node 里查项目
    列表再 `IN ($1…$50)`」（项目多时占位符爆炸）。
12. **时间粒度扩到 `1h/24h/7d/30d/90d` + 自定义 from/to**（上限 180 天）。桶粒度由
    服务端按跨度定：≤48h 小时桶、≤60d 天桶、更长周桶；跨度与桶仍是**代码常量**插
    SQL（请求值绝不进 interval 字符串）。
13. **下钻用 URL query，不新增路由**（交互 6.2d 的约定表）：
    - 趋势折线某桶 → `/projects/:pid/reports?status=failed&from=<bucket>&to=<bucket+1>`
    - 归因饼图某片 → 报告列表 + `attribution=<category>` 筛选
    - 榜单行 → 资产/报告详情深链
    - **列表接口补 `from`/`to` 参数**是下钻的前置（现在执行记录与报告列表都没有
      时间窗参数）——本阶段交付。
    - 交互 6.2d 表里预留的 `/executions/by-index/:indexId` 统一执行入口**一并实现**
      （按来源重定向到三个既有详情路由），统计侧从此不感知来源路由。
14. **图表继续手写 SVG**（用户 2026-09-04 确认）：把 `Trends.tsx` 的三个私有函数提
    成 `components/charts/` 可复用组件 + 从 `TimelineGantt` 抽共享的
    `niceStep`/网格/hover 交互。**hover 的标准做法**（参考项目见 12.6）：在图上盖一层
    透明 `<rect>`（`pointer-events: all`）捕 `onMouseMove`，用 `offsetX / plotWidth`
    反查最近数据桶索引——**不要逐 path 命中**（用户得精确指到 1.5px 宽的线上）；
    读数条**常驻高度**（照 `PipelineRunPage.tsx:682-689` 的 timeline-hover 模式，条件
    渲染会把下面的表格顶一次）；tooltip 用 HTML 绝对定位而不是 SVG `<text>`
    （非整数缩放下 SVG 文本发虚，`Trends.tsx:30-32` 的既有结论）。
15. **不做图表缩放/刷选/图例交互**——时间窗由顶部时间选择器控制，两套控制会打架；
    图例只读（色块 + 名称）。
16. **统计页不实时，但也不让页面干转**（2026-09-09 第四轮修订）：进入拉一次 + 手动
    刷新按钮。不接 SSE——统计是聚合读，接事件流意味着每个终态重算聚合，把读页变
    订阅端。两条体验防线：
    - **服务端短 TTL 内存缓存（30s）**：全局聚合按「可见项目集哈希 + 窗口参数」缓存
      30 秒，可见集相同的用户共享同一份；`/stats/*` 是聚合读、本就声明容忍 30s 陈旧。
      第二个人进页面读缓存毫秒级返回。只在进程内存（Map），不进 Redis、不落表——
      重启重建，这是边界 17「不建汇总表」的轻量版姿态，缓存失效逻辑只有 TTL 一条。
    - **分段渲染，禁止全页转圈**：三段式页面的每段（Readout 行 / 趋势区 / 归因与
      榜单区）是独立请求，各自到达各自渲染，页面骨架立即出现。「打开页面一直在转」
      的根因往往不是单条 SQL 慢，而是前端等齐全部数据才首屏——最慢的段不许阻塞
      最快的段。
17. **性能预算分级（2026-09-09 第四轮修订，撤销原「90 天 < 1.5s」单档判据）**：
    1.5s 是**显式深挖的容忍上限**，不是日常打开的预算。三档：
    - Readout 行，缓存命中 < 300ms（未命中按下一档计）；
    - **默认窗口 30d，全部段 < 800ms**——**默认窗口是 30d 不是 90d**：90d/180d 是
      用户显式切换的深挖场景，不拿最坏情况当默认体验；
    - 90d/180d 深挖 < 1.5s，**这一档超了才触发汇总表立项**。
    读时实时 SQL 是既定姿态，`execution_index` 上 `(project_id, created_at DESC)`
    索引在（迁移 015/030），边界 23 再补 `(created_at)` 单列索引——30d 窗口走索引
    + 分位数已限 30d（边界 23），800ms 是索引扫描可达的预算不是祈祷。物化视图
    （何时刷新/刷新失败/口径变更重建三个新问题）与冷数据归档（P10 14.1）的取舍
    不变，判据写死，不靠感觉。
 18. **看板扩展为「当下 + 变化」**：既有四个比率旁加 7 天 delta（**用百分点 pp 而不是
    百分比**——「从 80% 到 82%」是 +2pp 不是 +2.5%）与 30 天 sparkline；**全局层不再
    多开一个统计页**——看板就是全局统计页（加 sparkline 与 delta 后），项目层「趋势
    分析」扩成「数据统计」（三段式，见 12.5）。
 19. **看板项目表几百度量级不做长表滚动**（2026-09-09 用户确认）：全局层数百项目时
    「一表全量平铺」没有读数价值，改**两个形态分层**——
    - **Top 10 榜**（默认）：按「接口覆盖率 / 文本用例自动化覆盖率 / 通过率 / 失败量」
      四个**可切换的指标列**取最差的 10 个项目（反向榜——看板是找问题的页，不是发奖状
      的页），指标列即下钻入口（点覆盖率列 → 进该项目的对应统计段）。
    - **全量检索**（按需）：关键字搜索沿用既有 `keyword`（`queryProjectMetrics` 已
      支持，卡片墙同款语义），命中多少展示多少。
    - 不做服务端分页翻页器——翻页找「哪个项目差」翻不出来；不引入新参数。
 20. **看板读数补齐领导视角的资产面**（2026-09-09 用户确认）：`/stats/overview` 的
    readout 区在既有执行面（执行量/通过率/失败量/归因覆盖率）之外补**资产面四读数**——
    全局接口总量（加 sparkline）、**全局接口覆盖率**（有用例接口/全部接口）、**全局文本
    用例自动化覆盖率**（非 endpoint 绑定已评审用例/全部已评审用例，P7 口径的全局聚合
    ——`queryProjectMetrics` 的 `spec_automated/spec_total` 子查询已有，SUM 后相除）、
    文本用例总量。**低读数的下钻路径**：点接口覆盖率 → 项目表 Top 10（coverage 列）；
    点自动化覆盖率 → Top 10（automation 列）——「哪个项目拉低的」由 Top 10 反向榜
    回答，不需要新页面。
 21. **失败 TopN 补「流程 + 仓库用例」两维**（2026-09-09 用户确认）：既有失败分布只有
    「按接口」一维（`reports.ts` 的 `endpoint_name` 分组，仅叶 executions）。P8 的
    TopN 四维（接口/用例/CI 任务/套件）**扩成六维**：+ **按流程**（`execution_index`
    的 `kind='flow'` 行按 `target_name` 分组，失败次数）+ **按仓库用例**
    （`repo_test_cases.last_result='failed'` 全窗期计数——注意它是**最新一次**状态，
    窗口内失败次数应取 `pipeline_run_cases` 按 `guessed_case_key` 归并的 failed 行
    计数，`last_result` 只当最近态参考）。六维统一进 `stats/failures` 的 `topN`
    参数，默认接口维。
 22. **进入项目默认页改「数据统计」**（2026-09-09 用户确认）：`main.tsx:110` 的
    index `Navigate to="endpoints"` 改指 `trends`，`ProjectShell.tsx:74/77` 的兜底
    段同步（`segments[2] ?? "trends"`、`SECTION_ALIASES ?? "trends"`）；`overview`
    的重定向（`main.tsx:111`）维持指 `endpoints` 不动——它是「概览」语义，改指
    统计会把它变成第二个统计入口。P8-6 与「数据统计」页改造同批落地（页面没改
    前先改默认页会把用户送进半成品三段式）。
 23. **慢 SQL 先行防线（2026-09-09 第三轮增补，P8-4 起生效）**：`/stats/*` 的全局
     窗口查询天然没有项目前缀，既有索引全是 `(project_id, created_at)` 前缀形态——
     **没有索引就等于 Seq Scan**。三层防线，成本递增：
     - **索引先行（P8-2 迁移顺带）**：`execution_index/executions/pipeline_runs`
       各补一条 `(created_at DESC)` 单列索引（见 12.1）；纯读加速、写放大一行一次
       B-tree 插入。**P8-4 每条接口上线前必须 EXPLAIN (ANALYZE, BUFFERS) 过一遍**，
       抓到 Seq Scan / 非预期 Buffer 增长即补索引或改写查询，不带着已知扫表上线。
     - **查询自身纪律**：窗口上限 180 天写死校验（超了 400，不静默截断）；仓库用例
       失败维先按 `pipeline_runs.created_at` 收敛 run 集再 join `pipeline_run_cases`
       （绝不反着来）；`byType` 读时归类（jsonb 逐行展开）**留在项目级页面，不抬到
       全局**——它是所有统计查询里单行成本最高的一条；分位数 `percentile_cont`
       只在 ≤30d 窗口提供（90d 档位不返回分位，退化列给 null——数据库侧排序成本
       随窗口线性涨，砍它是零 UX 损失的省法）。
     - **超时护栏（服务端）**：`/stats/*` 路由组统一挂 `statement_timeout = 5s`
       （per-route 级，会话内 SET LOCAL，不污染连接池全局）；超时返回 503 + 明确
       错误码（「统计窗口过大，请缩小时间范围」），**绝不挂起等数据库慢慢算**。
       前端对 503 显示空态 + 缩窗建议，不白屏。5s 而不是 1.5s：1.5s 是 P8-1 门槛里
       90d 出图的**性能验收线**，超它触发边界 17 的汇总表立项判据；5s 是**故障线**——
       超过它意味着已经有东西在挤占连接池，先失败先止损。
     - **验收时带 `pg_stat_statements` 复核**：P8-4/P8-8 验收时取 Top 10 语句
       （mean_exec_time 排序），统计类语句必须全部走 Index Scan；这条同时覆盖
       12.7 门槛 8 的 1.5s 判据取证。

### 12.1 数据库迁移：054_p8_attribution.sql

```sql
CREATE TABLE IF NOT EXISTS failure_categories (
  code TEXT PRIMARY KEY,                   -- 'product_bug' / 'test_defect' / 'env' / 'data'
                                           -- / 'flaky' / 'dependency' / 'other'
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO failure_categories (code, name, position) VALUES
  ('product_bug', '产品缺陷', 1),
  ('test_defect', '用例缺陷', 2),
  ('env', '环境问题', 3),
  ('data', '数据问题', 4),
  ('flaky', '不稳定', 5),
  ('dependency', '外部依赖', 6),
  ('other', '其他', 7)
ON CONFLICT (code) DO NOTHING;             -- 种子是字典数据，幂等

CREATE TABLE IF NOT EXISTS failure_attributions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('execution','pipeline_run_case','execution_step')),
  target_id UUID NOT NULL,                 -- 多态、无 FK（三类目标删除语义各异，悬空=未归因，读时排除）
  category TEXT NOT NULL REFERENCES failure_categories(code),
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','mcp')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS failure_attributions_project_idx
  ON failure_attributions (project_id, category);
CREATE INDEX IF NOT EXISTS failure_attributions_created_idx
  ON failure_attributions (created_at DESC);
```

`created_at` 冗余记归因时间（非失败时间）——按时间看「归因行为」用；「按失败发生时间
的分布」join 目标表的 `created_at`。

**同迁移附带的索引（全局窗口扫表的先行防线，边界 23）**：

```sql
-- 全局统计窗口的无项目前缀查询：既有 (project_id, created_at) 前缀用不上
CREATE INDEX IF NOT EXISTS execution_index_created_at_idx ON execution_index (created_at DESC);
-- 失败 TopN 接口维 / Flaky / MTTR 的全局序列查询（executions 同款理由）
CREATE INDEX IF NOT EXISTS executions_created_at_idx ON executions (created_at DESC);
-- 仓库用例失败维：90 天窗口先收敛 run 集，再 join cases
CREATE INDEX IF NOT EXISTS pipeline_runs_created_at_idx ON pipeline_runs (created_at DESC);
-- 归因「按失败发生时间」的分布：join 目标 created_at 的索引侧已由上面三条覆盖
```

> 这四条是**纯读加速索引**，与 P8-8 的「子查询 WHERE 下推」互补：P8-8 治的是
> `queryProjectMetrics` 的七表全表聚合，这里治的是 `/stats/*` 的时间窗扫描。写放大
> 代价评估：`executions` 与 `execution_index` 每终态写一行，两条单列索引各多一次
> B-tree 插入，可接受；`pipeline_runs` 频率低一个量级，无感。

### 12.2 后端新 API

```
# 归因（项目级，REST）
GET    /api/v1/projects/:id/failure-categories          登录即可读（字典）
POST   /api/v1/projects/:id/failure-attribution         {targetType, targetId, category, note}（写权限）
DELETE /api/v1/projects/:id/failure-attribution?targetType=&targetId=   清除归因
POST   /api/v1/projects/:id/failure-attribution/batch   批量：[{targetType, targetId}] + 同一 category/note

# 全局统计（新路由组，无项目前缀）
GET    /api/v1/stats/overview?days=30            全局读数（执行量/通过率/失败量/归因覆盖率/各资产总量 + 资产面四读数：接口总量/接口覆盖率/文本用例自动化覆盖率/文本用例总量，边界 20）+ 7 天 delta
GET    /api/v1/stats/trend?metric=&days=&projectIds=   execution_trend（量/通过率/分位）| asset_trend（新增）
GET    /api/v1/stats/failures?days=&projectIds=&topN=  失败归因分布（含未归因）+ 失败 TopN（六维，边界 21：接口/用例/CI 任务/套件/流程/仓库用例）
GET    /api/v1/stats/flaky?days=&projectIds=     不稳定用例榜（见 Flaky 判定）
GET    /api/v1/stats/coverage?days=              三个覆盖率口径的 30 天序列
GET    /api/v1/stats/projects?days=&metric=&order=asc&limit=10   项目对比（Top 10 反向榜或关键字命中全量，边界 19；metric 取 coverage/automation/passRate/failed）

# 既有接口的增量
GET    /api/v1/projects/:id/executions           补 from/to 时间窗参数（下钻前置）
GET    /api/v1/projects/:id/suite-reports        补 from/to + attribution 筛选
GET    /api/v1/projects/:id/executions/by-index/:indexId   统一执行入口（按来源重定向）

# MCP 工具（挂 P5 工具面，read + write scope）
list_unattributed_failures（读，分页，带证据摘要）
set_failure_attribution（写，复用上面 REST 的校验）
```

### 12.3 新增指标清单（按「能回答什么问题」筛）

| 指标 | 回答 | 来源 |
| --- | --- | --- |
| 失败归因分布 + 覆盖率 | 失败都是什么原因、还有多少没归因 | 新表 |
| 通过率/失败量趋势（全局 + 可按项目筛） | 整体质量在变好还是变坏 | `execution_index` |
| 资产新增趋势（接口/接口用例/流程/套件/文本用例/仓库用例） | 平台在长吗 | 各表 `created_at`（`removed` 的仓库用例仍计入——衡量的是「新增行为」不是存量） |
| Flaky 用例榜 | 哪些用例一会儿绿一会儿红 | `executions` 按 `case_id` 序列翻转计数 + `repo_test_cases` 的 SDK 上报序列 |
| 失败 TopN（接口/用例/CI 任务/套件/流程/仓库用例六维，边界 21） | 先修哪个 | 扩展既有 `reports.ts:221`（只有按 endpoint 一维）；流程维走 `execution_index` kind='flow' 的 `target_name`，仓库用例维走 `pipeline_run_cases` 按 `guessed_case_key` 归并 |
| 排队时长趋势 | 要不要加 worker/Runner | `started_at - created_at`（报告列表已在算 `queue_ms`） |
| 触发源分布（manual/scheduled/webhook/ci） | 自动化真的在自动跑吗 | `execution_index.trigger_source`（零成本） |
| 三个覆盖率口径序列 | 测试的底座在变大吗 | 接口覆盖（dashboard 口径）/ 仓库覆盖（形状去重）/ 自动化覆盖（P7 口径） |
| MTTR（失败→首次转绿） | 失败有人跟吗 | 同 Flaky 的序列查询 |
| 首次通过率 | 新用例质量 | 同上 |
| 计划进度 / 通过率 | 这轮回归到哪了 | P7 的 `test_plan_items` |
| 全局资产面四读数（接口总量/接口覆盖率/文本用例自动化覆盖率/文本用例总量，边界 20） | 家底有多厚、自动化推进到哪了 | `queryProjectMetrics` 子查询 SUM 复用（spec_automated/spec_total 已有） |
| 项目 Top 10 反向榜（四个指标列可切换，边界 19） | 哪个项目拉低了全局读数 | `/stats/projects?metric=&order=asc&limit=10` |
| **不做**：人员效能统计 | — | 容易沦为 KPI 工具、扭曲归因行为 |

Flaky 判定（写死在 `lib/metrics.ts`，与通过率同处口径库）：窗口 30 天内同一
`case_id`（或仓库 `case_key`）≥6 次执行、状态翻转 ≥3 次、passed 与 failed 各 ≥2 次。

### 12.4 前端

- **项目层**：「趋势分析」页（`trends`）改名「数据统计」（路由保留 `trends` 不换——
  深链不断，导航文案改）。三段式：`Readout` 行（执行量/通过率/失败量/归因覆盖率
  + delta）→ 趋势区（折线 + 堆叠柱）→ 归因与榜单区（环形 + TopN 表 + Flaky 榜，
  TopN 六维 tab：接口/用例/CI 任务/套件/流程/仓库用例）。顶部筛选：时间窗 /
  includeRepo / 触发源。**默认窗口 30d（边界 17）**；三段独立请求、各自到达各自
  渲染，页面骨架立即出现，最慢的段不阻塞最快的段（边界 16）。
- **全局层**：数据看板（`/dashboard`）按边界 18 扩展——比率卡 + sparkline + delta，
  **readout 区补资产面四读数**（边界 20：接口总量 + sparkline、全局接口覆盖率、
  全局文本用例自动化覆盖率、文本用例总量；低读数点击下钻 Top 10 对应列）；
  **项目表改 Top 10 反向榜 + 关键字检索两形态**（边界 19：指标列可切换
  coverage/automation/passRate/failed，默认按所选指标升序取最差 10 个；归因覆盖率
  作为列保留）；不加第二个统计页。
- **默认落地页**：进入项目从「接口管理」改「数据统计」（边界 22：`main.tsx:110`
  index 重定向 + `ProjectShell` 兜底段同步；与 P8-6 同批）。
- **`components/charts/`**：`LineChart`（多 series、null 断线）、`StackedBars`、
  `Donut`、`Sparkline`、共享 `niceStep` 与 hover 层（透明 rect + 常驻读数条 +
  HTML tooltip）。`Trends.tsx` 与 `TimelineGantt` 改为消费这套——三份画图逻辑收敛成
  一份。
- **下钻**：图表 `onClick` 按 12.2 的 URL 表跳转；时间窗/筛选进 URL（1.2.1 服务端
  检索铁律）。Top 10 榜行点击 → 进项目（默认落在统计页，与边界 22 闭环）。

### 12.5 手写 SVG 的参考项目（用户问的「悬浮折线统计」）

按可读源码程度排序，**只参考交互模式，不搬代码**：

1. **uPlot**（leeoniya/uPlot）——光标实现是「透明 overlay + 最近点吸附 + 十字线 +
   图例读数」的教科书，`cursor.ts` 单文件可读；它 ~50KB 的体积与零依赖证明这条路
   不需要库。
2. **react-sparklines**（borisyankov/react-sparklines）——sparkline 的最简范本
   （数百行）；我们的 `Sparkline` 组件照这个复杂度做。
3. **visx**（airbnb/visx）的 `@visx/tooltip` + `@visx/axis`——「SVG 定位 + HTML
   tooltip（portal 到 SVG 外，避免被 overflow 裁剪）」「ticks 的 nice 算法」两件事
   的标准解法；只看这两个包，不引整个 visx。
4. **Recharts** 的 `Tooltip` + `ActiveDot` 源码——「active 点放大 + 竖直参考线」的
   常规做法，React 实现与我们技术栈同构。
5. **Grafana timeseries 面板**（行为参考，源码太重）——十字线、最近点高亮、常驻
   读数框的交互行为即 12.4 hover 层的目标形态。
6. **站内已有范本**：`PipelineRunPage.tsx` 的 `TimelineGantt`（刻度 + 网格 + 常驻
   hover 读数）与 `Trends.tsx`（null 断线、HTML 轴标签）——组件就基于它们抽象。

### 12.6 实施顺序（P8-1 … P8-8）

| 步 | 内容 | 产出 |
| --- | --- | --- |
| P8-1 | 口径收口（三处通过率 + 自指排除 + includeRepo 一致性），纯重构 — **已实现**（2026-09-09，见下方实现状态） | 既有页面数字一致；缺陷记 issue_fix |
| P8-2 | 迁移 054 + 分类字典 + 归因 REST（单条/批量/清除）+ **归因类型管理（系统设置 tab，用户增补）** — **已实现**（2026-09-09，见下方实现状态） | 归因可打可查 |
| P8-3 | 归因前端入口（报告页失败行 + 执行记录失败行 + 批量抽屉）— **已实现（2026-09-09，范围按用户收窄：入口只在报告侧，见下方实现状态）** | 人工归因闭环 |
| P8-4 | `/stats/*` 六条接口 + 可见项目集过滤 + 列表接口 from/to + **慢 SQL 防线落地（边界 23：索引先行 + EXPLAIN 复核 + statement_timeout 5s + byType 不抬全局/分位限 30d）+ 30s TTL 内存缓存（边界 16）** — **已实现**（2026-09-09，见下方实现状态） | 全局数据可取且不拖垮库 |
| P8-5 | `components/charts/` 抽象 + hover/刻度 + Trends/TimelineGantt 接入 — **已实现**（2026-09-10，见下方实现状态） | 一套图表底座 |
| P8-6 | 项目层「数据统计」三段式 + 看板扩展（sparkline/delta + 资产面四读数 + Top 10 反向榜/检索，边界 19/20）+ 下钻接线 + **进入项目默认页改 trends（边界 22，`main.tsx:110` + `ProjectShell` 兜底段）** — **已实现**（2026-09-10，见下方实现状态） | 页面可用 |
| P8-7 | MCP 两个归因工具 + `source` 筛选 + by-index 统一入口 + **TopN 六维（边界 21：流程/仓库用例两维随 `stats/failures` 扩参）** + i18n — **已实现（2026-09-10，见下方实现状态）** | agent 归因闭环 |
| P8-8 | **读时聚合性能收口**（2026-09-08 用户记录，定级 P8）：`/api/v1/projects` 实测 817ms、`/api/v1/dashboard` 373ms——两接口共用 `queryProjectMetrics`（`routes/dashboard.ts:21`），聚合子查询**每次调用全表聚合**（P7 后已是**七张表**：endpoints/environments/executions/test_cases/schedules/ci_tasks/**spec_cases**——P7-6 在同一下挂点追加了文本用例/自动化覆盖子查询，慢查询的账按现状记），项目数与执行量增长会线性放大。方向：可见项目集先收敛（子查询带 WHERE 下推）/ 索引复核 / 仍慢再议预聚合表 — **已实现**（2026-09-11，两刀：第一刀 2026-09-10 拆轻 + 第二刀子查询下推，见下方实现状态） | 看板与项目列表 < 200ms |

> **P8 范围增补（2026-09-09 第二轮，用户三条反馈，边界 19–22）**：① 看板项目表在
> 几百项目量级下改 Top 10 反向榜 + 关键字检索两形态，不做分页长表；② 看板 readout
> 补资产面四读数（全局接口总量/接口覆盖率/文本用例自动化覆盖率/文本用例总量），
> 低读数经 Top 10 反向榜下钻到「哪个项目拉低的」；③ 失败 TopN 扩六维（+ 流程 +
> 仓库用例），进入项目默认页改「数据统计」。均落入 P8-6/P8-7 批次，顺序不变。

> **P8 启动前核对（2026-09-09，P7 验收后）**：实施顺序 P8-1…P8-8 维持不变，依据
> 现场核对——① 排序理由仍成立（12.3 资产新增趋势含文本用例 `spec_cases`，P7 口径
> 已定型；排序依据「测试管理在统计之前」原样兑现）；② P8-1 的三处缺陷锚点仍在
> 现场（`reportPayload.ts` 的 `se.total` 分母 / `alerts.ts:334` 的含 skipped 分母 /
> `reports.ts` 趋势与汇总均未排 `detail_id <> id`，`executionIndex.ts:23` 列表侧已排除）；
> ③ 12.2 的 `by-index` 统一入口、列表 from/to 均未实现，前置仍成立；④ 归因三目标
> 表名核对无误（`executions` / `pipeline_run_cases` / `execution_steps`）。两处变更：
> 迁移编号顺延（P8 已用到 **056**——054 归因 / 055 P8-2 索引修复 / 056 归因 bug
> 链接，**P9 057 / P11 058**——053 已被 P7 的 `053_p7_spec_case_status_review.sql`
> 占用）；P8-8 子查询表数六→七（P7-6 追加了 spec_cases 子查询）。**不新增数据**：归因分类字典 7 类由迁移种子自带
> （`ON CONFLICT DO NOTHING`），无需预置任何数据；样本数据继续用 dev 库既有执行
> 历史即可。
> **2026-09-09 第三轮（性能边界 23）**：`/stats/*` 全局窗口查询踩索引空缺（既有索引
> 全是 `(project_id, created_at)` 前缀形态，无项目过滤即 Seq Scan）——三层防线
> 写入边界 23（索引先行 / 查询纪律 + statement_timeout 5s / pg_stat_statements
> 复核），索引随迁移 054 落地，P8-4 批次起生效。
> **第四轮（同日，性能预算修订，边界 16/17）**：原「90 天 < 1.5s」单档判据撤销——
> 1.5s 是显式深挖的容忍上限不是日常预算（「打开页面一直在转」的体感不可接受）。
> 改三档：Readout 缓存命中 < 300ms / 默认窗口 30d 全段 < 800ms / 90d–180d 深挖
> < 1.5s（仅此档触发汇总表立项）。配套：`/stats/*` 服务端 30s TTL 内存缓存
> （边界 16，可见项目集哈希键）；三段式页面分段渲染不互相等待；**趋势页默认窗口
> 从 24h 改 30d**（原 24h/7d/30d 三档保留为可选项）。
>
> **P8-1 实现状态（2026-09-09）**：口径三件事收敛到新 `lib/metrics.ts`（边界 2 的
> 原定形态——SQL 片段常量 + TS 同款，不是参数化函数）：`PASS_RATE_SQL(prefix)`
> 嵌 SELECT 列表（表别名调用方传）、`passRateOf(passed, failed)` 供事件计数在手
> 的 Node 场景、`NOT_SELF_DEBUG`（`detail_id <> id`）、`sampleKinds(includeRepo)`
> （自 reports.ts 迁入，readIncludeRepo 留在原处——它只服务本文件两条路由）。
> 五个落点全部收敛：① `reportPayload.ts` 报告详情/分享页从 `success/total` 改
> `PASS_RATE_SQL`（全 skip 报告从 0% 变 null「没有结论」，与列表一致）；②
> `alerts.ts` 套件通知分母去掉 skipped 改 `passRateOf`；③ `reports.ts` 报告列表
> UNION 两侧手写 CASE 收编 `PASS_RATE_SQL`（runner 侧 `passed_count` 列名差异
> 用 replace 收编）；④ 趋势桶 passRate 换 `passRateOf`（语义本等价——status
> 过滤已挡非定局行，换同一实现防漂移）；⑤ summary 的 passRate 同款（原本就对）。
> 自指排除补齐（缺陷②）：trend 的 LEFT JOIN ON 与 summary 的 WHERE 各嵌
> `NOT_SELF_DEBUG`，单步调试的一次性父索引不再进趋势/汇总样本（列表侧
> executionIndex.ts 的既有口径）。**includeRepo 一致性（缺陷③）判定为数据源
> 错位非 SQL 漏改**：byEndpoint/byType 读叶子 executions，ingest/runner 失败不在
> 那张表里——按边界 1 留给 P8-4 `/stats/*` 直接做对，summary 注释已写明防止
> 误修。零迁移（纯代码重构）。缺陷明细记
> `issue_fix/问题记录-P8-1口径收口三缺陷.md`。`pnpm check` 编译通过；服务重启
> 与页面验收按 AGENTS.md 留给用户。

> **P8-2 实现状态（2026-09-09）**：迁移 `054_p8_attribution.sql` 落地——`failure_categories`
> 字典（种子七类，`ON CONFLICT DO NOTHING` 幂等）+ `failure_attributions`（UNIQUE
> (target_type, target_id)、source CHECK('human','mcp')、`ON DELETE CASCADE` 项目）
> + 边界 23 的四条 `(created_at DESC)` 单列索引（execution_index / executions /
> pipeline_runs——三条即计划写死的那份；`failure_attributions_created_idx` 计划已有）。
> 归因 REST 四条（`routes/attributions.ts`）：`GET /projects/:id/failure-categories`
> （登录即可、只回 active）、`POST /failure-attribution`（INSERT ON CONFLICT DO
> UPDATE——重打标是覆盖不是先删后插）、`POST /failure-attribution/batch`（上限 100、
> 逐条校验「本项目且是失败」、同一事务整批 upsert、混入非失败即整批拒）、
> `DELETE /failure-attribution?targetType=&targetId=`（清归因）。目标校验三张表
> `executions`（status='failed'）/ `pipeline_run_cases`（经 pipeline_runs 归属 +
> status IN ('failed','error')）/ `execution_steps`（经 execution_index 归属 +
> status='failed'）——给成功行打归因被 404 拒绝。**用户增补：归因类型的增删改**
> （系统设置「归因类型」tab，`routes/failureCategories.ts` + 前端
> `FailureCategoriesPanel.tsx`，系统管理员）：`GET/POST/PATCH/DELETE
> /system/failure-categories`——code 建后不可改（统计与 MCP 的稳定标识）、
> 停用≠删除（打标选项消失、历史照常显示）、删除有引用时 409 + 归因计数、
> `?force=true` 连带删归因行（回未归因，不偷偷挂去其他分类）。审计动作
> `failure_attribution.set/clear` 与 `failure_category.create/update/delete` 落
> `lib/audit.ts`（detail 只带分类码与目标类型，note 自由文本不进）。前端
> `api.ts` 类型与八条方法 + `FailureCategoriesPanel`（挂 SystemPage 第六个 tab）+
> i18n 两语言。`pnpm check` 前后端均只剩 P7 遗留的两处既有错误（excel.ts:305 /
> specImport.ts:182 / SpecImportModal.tsx:174——P7 批次带入，与本批无关）；服务
> 重启与页面验收按 AGENTS.md 留给用户。P8-3（归因前端入口——报告页失败行 + 执行
> 记录失败行 + 批量抽屉）是下一个批次，本批不碰报告页。

> **P8-3 实现状态（2026-09-09）**：范围按用户收窄——**入口只做报告侧**（报告列表 +
> 报告详情），执行记录失败行入口不做（原 12.0 边界 9 的第二处，用户明确排除）；批量
> 归因保留（边界 4 的一等交互）。目标推导对齐三类叶子目标：套件失败成员有
> `httpExecutionId` → `execution` 目标（接口用例的 HTTP 失败，执行记录侧将来读同一行），
> 否则 → `execution_step`（流程成员等非 HTTP 失败）；CI 用例行 → `pipeline_run_case`。
> 落点：
> - **报告列表**（`reports.ts`）：每行新增归因聚合 `attribution: {failed, attributed,
>   categories[]}`（分类名随行带出，读侧不依赖字典请求）——单查询 UNION 两源目标
>   （套件失败成员 + run 的 failed/error 用例）LEFT JOIN `failure_attributions` 聚合，
>   只对当前页的行取（O(页) 不是 O(全量)）。
> - **随行归因**：`loadSuiteReport` 成员查询与 `pipeline-runs/:runId/cases`、
>   `loadRunnerReport` 的 cases 查询各 LEFT JOIN 归因 + 分类名（`attributionOf` 进
>   `models/types.ts`，`ExecutionStep`/`PipelineRunCase` 加可选 `attribution`）——
>   分享页（免登录）与 viewer 同样读得到，只是没有打标入口。
> - **前端**：新组件 `AttributionDrawer.tsx`（分类单选手写 radio + note + 归因对象
>   清单 + 证据消息节选 + 单条清除；单条预填、批量不预填；>100 目标客户端分块提交
>   ——服务端单批上限 100）。入口三处共用它：报告列表行（见下）、套件详情失败成员行、
>   仓库报告用例行。allure 视图行 ↔ DB 用例行按 `name|start|stop` 复合键匹配（视图
>   `uid` 读的是 `parsed.uid` 而 allure 结果文件标识字段叫 `uuid`，靠 name 兜底，不能
>   当 `external_id` 用——匹配键的推导写在 `viewCaseKey` 注释里）；junit 降级列表的行
>   就是 DB 行。批量：三张表失败行可勾选 + 表头「全选失败」+ 批量按钮。
> - **验收反馈一轮（2026-09-09，同日三项）**：① **报告列表行直接可归因**——归因格
>   （a/f + 分类 chip / 未归因 N）整格是按钮，点击按报告类型拉失败目标清单（套件 =
>   报告详情的失败成员、仓库 = cases 的 failed/error 行）开同一抽屉：单条失败走单条
>   模式（预填 + 可清除），多条走批量；落库后重拉列表。② 报告列表删 名称/通过/失败
>   三列，列宽重排（固定列 ~800px：触发 168 / 通过率 78 / 总数 60 / 耗时 78 / 状态
>   96 / 归因 168 / 时刻 158，报告名吃剩余宽度并兜底读 targetName）。③ **通过的展示
>   无需归因**——列表无失败行为空单元格；三张表（成员/用例）归因列整列只在有失败时
>   出现，非失败行空单元格（不再渲染「—」）。
> i18n 双语（`attribution.*` 29 键）+ CSS（`report-col-attribution`、`chip-action`、
> 抽屉 radio/清单/证据样式）。`pnpm check`/`pnpm build` 前后端通过；服务重启与页面
> 验收按 AGENTS.md 留给用户。执行记录失败行入口维持不做（用户收窄），P8-7 的 MCP
> 工具与统计页（P8-4/6）不受影响。
> **验收反馈二轮（同日三项）**：① **报告列表加归因类型多选筛选**——`GET /suite-reports`
> 补 `attribution=code,code`（服务端过滤，COUNT 与分页共用一份 WHERE；相关子查询逐
> 报告 EXISTS，目标推导与聚合同口径），`__unattributed__` 伪值筛「存在未归因失败的
> 报告」（分类 code 以小写字母开头，双下划线前缀不撞车）；前端选项 = active 字典 +
> 「未归因」。② 归因列多分类叠行 → 单行化：`a/f` + 最多一个分类 chip（104px 截断
> ellipsis）+ `+N` 概括其余，完整分布进 title。③ **仓库执行详情的上级按入口区分**：
> 报告列表行点击带 `?from=suite-reports` → 面包屑/侧栏归「报告列表」（query 是唯一
> 事实源，刷新/分享保持归属）；仓库模式内入口（CI 任务/用例树/调度）不带参数、维持
> 仓库归属——`ProjectShell` 的 `suiteReportOpen` 改按真实路由段判定。
> **验收反馈三轮（同日两项）**：① 归因格 `+N` 的完整分布改 **hover 面板**（`Tip`
> 原语 / antd Tooltip 100ms；原生 title 延迟一秒且样式不可控）——覆盖率 + 逐分类
> 计数 + 打标提示。② **归因绑定 bug 链接**：迁移 `056_p8_attribution_bug_url.sql`
> （`bug_url TEXT NOT NULL DEFAULT ''`，空串 = 未绑定，与 note 同款空值不建档）；
> REST 单条/批量收 `bugUrl`（非空必须 http(s)，伪协议入口拒掉），审计 detail 非空
> 时带上；`FailureAttribution`/`FailureAttributionLite` 与三处随行 JOIN 增列；抽屉
> 加「Bug 链接」输入（客户端同规则校验，非法禁存），行内 chip 旁出外链小图标
> （chip 是按钮，链接为兄弟节点，点击不触发打标）。P8-7 的 MCP 归因工具届时同参数
> 透传。
> **验收反馈四轮（同日三项，抽屉形态统一）**：① 仓库归因弹窗出现裸键
> `attribution.batchNoteHint`——该键此前漏定义、上轮已补（用户测试早于修复落地）；
> 同时它原先在备注与 Bug 链接下各渲染一份，收敛为一处。② 「设置了 bug 绑定在哪条
> 用例」不透明——批量目标清单改为**逐行带当前归因**（分类 chip + bug 外链图标，
> 全量展示不截断、自滚动），bug 会落到哪几条提交前可见；提示文案改为「应用到清单
> 里的每一条失败；不同 bug 请进报告逐条归因」。③ 单条与多条弹窗形态割裂（单条
> 预填+证据，多条空表单+截断清单）——**统一**：`AttributionTarget` 携带当前归因，
> 预填规则改为「全批同一分类才预选（单条恒成立、清一色批量也成立；note/bugUrl
> 进一步要求逐字一致）」，`existing` prop 撤销、预填从目标清单推导；清除按钮与
> 停用分类的禁用项随之改读清单。
> **验收反馈五轮**：用户确认「跳转回报告列表」是自己批量把 bug 链接设成了平台地址，
> 功能保留；套件侧无需新增实现——bug 图标与绑定为套件/仓库共用（图标只取决于该条
> 归因绑没绑链接，套件归因绑上即出现）。可用性改进：图标从通用外链换成 bug 形态
> （lucide `Bug`），hover 由 `Tip` 提示「跳转 Bug：地址」（原先只有原生 title 裸
> URL，看不出它是什么）。

> **P8-4 实现状态（2026-09-09）**：新路由组 `routes/stats.ts`（`index.ts` 注册），
> 六条接口全量落地——`overview`（执行面四读数 + 触发源分布 + 资产面四读数 + 各资产
> 总量 + 7 天 delta，delta 比率用 pp）、`trend`（execution_trend 量/通过率/耗时与
> 排队分位；asset_trend 六类资产日增序列，repo_test_cases 含 removed——「新增行为」
> 口径；days ≤ 2 小时桶、否则天桶）、`failures`（归因分布含未归因 + TopN **四维**
> endpoint/case/ci_task/suite——边界 21 的流程/仓库用例两维按计划留给 P8-7 扩参）、
> `flaky`（两腿：executions 按 case_id 序列 + ingest_records 按 run 归并的 SDK 序列，
> 推断规则与 ingest.ts 的 deriveResult 同一条；同一批查询顺带 MTTR「失败→首次转绿」
> 与窗口内首跑通过率）、`coverage`（三口径日序列——接口覆盖/仓库覆盖（形状去重，
> `coverageShapeKey` 在 TS 侧算，等价关系不复制进 SQL）/自动化覆盖；每点是截至当天
> 的存量快照）、`projects`（Top 10 反向榜：coverage/automation/passRate/failed 四指标
> 列可切换、order 默认 asc、归因覆盖率作为列保留；keyword 传了返回命中全量）。
> **可见项目集过滤**：`resolveScope`——系统管理员不传 projectIds 即全量；非管理员
> 永远被 `user_project_roles` 兜底；显式请求不可见项目（含不存在 id）403 不静默剔除
> （门槛 6）。**30s TTL 缓存（边界 16）**：进程内 Map，键 = 路由 + 可见集哈希
> （排序后 sha1）+ 窗口参数，可见集相同的用户共享；失效只有 TTL 一条。**statement_timeout
> 5s（边界 23）**：每请求 `BEGIN + SET LOCAL`，超时（57014）→ 503 + **新错误码 2005**
> （前端 P8-6 按码渲染「统计窗口过大，请缩小时间范围」空态）；SET LOCAL 随事务还原
> 不污染连接池。**查询纪律**：days 整数 1..180（超了 400 不静默截断）；分位数只在
> ≤30d 窗口返回（90d/180d 退化列给 null）；byType 不抬全局（留在项目级 summary）；
> 仓库序列先按 run 集收敛再取 records；窗口起点/天数/LIMIT 全走 `$n` 占位符，请求值
> 不进 SQL 文本。**失败目标母查询** `failureTargetsSql` 三处共用（overview 覆盖率 /
> failures 分布 / projects 归因列），目标推导与 P8-3 报告列表同一口径——P8-1 遗留的
> includeRepo 数据源错位按边界 1 由本批做对：stats 的失败读数走 execution_index /
> pipeline_runs / execution_steps 的正确来源，不再挂在叶子 executions 一棵树上。
> Flaky 阈值写死 `lib/metrics.ts` 的 `FLAKY` 常量（与通过率同处口径库，响应里随行
> 带出 `thresholds`）。**列表接口 from/to**（下钻前置）：`GET …/executions`
> （endpoints.ts，子句复用既有 `executions.` 前缀限定）与 `GET …/suite-reports`
> （reports.ts，UNION 视图外层一份过滤盖两源）各补 `from`/`to`，ISO 解析失败 400。
> **EXPLAIN (ANALYZE, BUFFERS) 逐条复核过**（dev 库：executions 15.4 万行）：窗口
> 扫描走 054 的 `execution_index_created_at_idx`，TopN 接口维走 055 的 partial
> `executions_failed_created_at_idx`，Flaky 序列走 `executions_case_created_at_idx`，
> 套件失败成员链全 Nested Loop + 索引；小表（execution_index 304 / suite_executions
> 45 / failure_attributions 53 / ingest_runs 6 行）上的 Seq Scan 是正确计划不补索引，
> `ingest_runs` 无 (created_at) 单列索引是 12.1 清单的既定取舍（量级天然低、按 run
> 收敛后走 (ingest_run_id, seq)）；最重的 projects 聚合 26.7ms，全部远低于三档预算。
> **零迁移**：054/055 的索引已够用，P9 057 / P11 058 编号不变。开发期发现并修掉
> 三处自查缺陷：`suites` 表名实为 `test_suites`；窗口聚合 `ARRAY_AGG(expr) FILTER …`
> 的 FILTER 必须在聚合闭括号外（先在 psql 里抓到 syntax error 才落码）；node-pg 对
> 参数个数严格（多余报「bind message supplies N…」、跳位引用报「could not determine
> data type」）——每条查询各建各的 params 数组，共享只在同一条查询内多次引用同一
> 序号。`pnpm check` 通过；服务重启、缓存/超时/门槛 6–9 的行为验收与页面接线
> （P8-6）留给用户。
> **验收反馈六轮**：用户先误判「套件批量弹窗没实现 bug 功能」，随后自行定位到真因
> ——**单目标形态**缺行：抽屉的单条分支只显示裸名字，「当前归因 chip + bug 图标」
> 只在多目标清单里有，单条报告（恰好是测的那份套件）看起来像功能没做。修复：归因
> 对象区块单条/多条统一为同一行渲染（名称 + 当前归因 chip[title 带备注/来源/时间]
> + bug 图标），多目标额外给条数与滚动，单条在其下保留证据摘要。

> **P8-5 实现状态（2026-09-10）**：`components/charts/` 落地——`core.ts`
> （`niceMsStep`（从 TimelineGantt 收编，语义不变）/ `niceValueTicks`（数值轴
> 1-2-2.5-5×10^k）/ `pathSegments`（null 断线）/ `bucketTimeLabel` /
> `edgeIndices` / `nearestBucket`（hover 反查）/ `formatMsTick`）+
> `LineChart`（多 series、null 断线、透明 rect 捕指针按 `offsetX/plotWidth`
> 吸附最近桶、十字线竖腿 + active 点放大、常驻读数条兜底显示末桶值）、
> `StackedBars`（逐层堆叠——null 层真不占高；total=0 桶画 1px 灰线；hover 桶
> 高亮 + 常驻读数）、`Donut`（hover 高亮改描边加粗 + 其余片降透明度，中心
> 数字 hover 时切该片计数与占比）、`Sparkline`（看板 30 天形态用，末点小圆点，
> 空数据画贴底平线防读成加载失败）、`index.ts` 统一出面。**Trends.tsx 三张图
> 全部改为消费底座**（私有 LineChart/VolumeBars/FailureDonut 删除；y 轴刻度
> 与空态判定沿用原值，不趁机改口径）；**TimelineGantt 接入共享 `niceMsStep`
> 与 `formatMsTick`**（本地 NICE_STEPS_MS/niceStep/formatTick 删除，刻度
> 行为逐字不变），hover 读数行并类 `.chart-readout`（原 `.timeline-hover`
> 版式收编成一份，CSS 只留 timeline 特有约束）。`onBucketClick` 的接线点已
> 在底座 API 里预留（12.4 的下钻归 P8-6 接线）。CSS：`.chart-readout` 新增
> （常驻高度——条件渲染会把下面的内容顶一次），`.timeline-hover` 改为薄别名；
> i18n 补 `charts.*` 三键（两语言）；theme-preview 补图表底座参考节（含
> null 断线与空桶示例——living reference 从此覆盖图表）。零迁移、零新依赖
> （门槛 11：package.json 无 echarts/recharts/antv）。`pnpm check` /
> `pnpm build` 通过；hover 手感与两模式对照验收留给用户（AGENTS.md：重启与
> 页面验收不由 agent 代做）。P8-6 的统计页与看板 sparkline 从这套底座长。
>
> **验收追记（2026-09-10 第二轮）**：① hover 错位 / 断线不可读 / 孤立单点不可见
> 三缺陷修复（详见 `issue_fix/问题记录-P8-5图表底座三缺陷.md`，含 `preserveAspectRatio`
> 错位根因、`bridgeGaps` 语义分叉、ingest 耗时样本污染的代码 + 数据双修）；
> ② **趋势页口径三态化（用户验收反馈，改 P4.5 边界 2 的单开关）**：「含仓库执行」
> 复选框扩成「仅平台执行 / 仅仓库执行 / 全部」三态 segmented——`sampleKinds` 收敛为
> `SampleScope`（platform = flow/suite；repo = ingest+runner **仍一体不拆**，边界 2
> 的理由继续成立；all = 四类），趋势/汇总接口参数 `includeRepo` 换 `?scope=`（三态
> 白名单，缺省 platform），前端按口径切换提示文案；**仅仓库口径下失败分布两段
> （byEndpoint/byType）服务端跳过查询、前端不渲染**——它们读平台叶子表
> （P8-1 ③ 的数据源错位，挂在「仅仓库」标题下是错的），`all` 口径照旧展示并在
> 提示里写明「仅平台叶子」。`/stats/*` 的 `includeRepo` 暂保持二态（P8-6 接线时
> 直接采用 `SampleScope`）。

> **P8-6 实现状态（2026-09-10）**：四件事全部落地——
> - **项目层「数据统计」三段式**（`Trends.tsx` 重写，路由沿用 `trends` 深链不断、
>   导航文案改「数据统计」）：数据源整体切到 `/stats/*`（`projectIds` 钉在本项目
>   复用全局六条——项目层与看板从此一套口径；旧 `/reports/trend|summary` 前端
>   不再调用，接口按边界 10 保留、退役列收尾批次）。三段**四条独立请求**
>   （overview / trend / failures / flaky）各自到达各自渲染（边界 16），进入拉一次
>   + 手动刷新按钮；顶部筛选 = 时间窗（`days` 进 URL：24h/7d/**30d 默认**/90d/180d，
>   边界 17）+ 口径三态（不进地址栏，沿旧决策）+ 触发源（服务端 trend 扩参
>   `triggerSource` 白名单，**只过滤趋势段**——Readout 与归因读整窗事实，提示文案
>   写明）。503+2005 每段渲染「统计窗口过大」空态 + 缩窗建议 + 就地重试（边界 23
>   的前端半边，不白屏）；分位数 >30d 窗口面板内显式提示而非静默消失。
> - **下钻接线**（12.2 URL 表全量）：趋势桶（三张图都接 `onBucketClick`）→
>   `reports?status=failed&from=<bucket>&to=<bucket+1>`；归因环形片 →
>   `suite-reports?attribution=<code>`（未归因片用 `__unattributed__` 伪值，
>   SuiteReports 认 URL 初值）；TopN 行 → `stats.ts` 的 top SQL 补 refId
>   （endpoint 维 `MAX(endpoint_id)` / ci_task 维 `t.id` / suite 维
>   `MIN(ei.target_id)`）。下钻落点 `ExecutionRecords` 补 `from`/`to`/`caseId`
>   三个 URL 参数（可清除 chip 呈现，清掉回全量，不静默缩窄）。
> - **验收反馈一轮（2026-09-10 同日三项）**：① **TopN 下钻统一改判**——用户反馈
>   「套件/流程/仓库的下钻应进执行记录并自动填充筛选项」：四维全部落执行记录
>   （套件/CI 任务 → 父执行记录大类 `type=parent` + `kind=suite|runner` +
>   `keyword=名称`——runner 行的 target_name 是「任务名 #序号」，ILIKE 子串命中
>   该任务全部 run；接口/用例 → 单接口大类 `endpointId`/`caseId`），一律带
>   `status=failed` + 当前统计窗 from/to；Flaky 榜 api 腿同款带窗。② **父执行记录
>   列表补 from/to**（`executionIndex.ts`，endpoints.ts 同款 ISO 解析 + 400；
>   COUNT 与分页共用 WHERE）——下钻时间窗此前只有单接口记录支持。③ **时间窗 chip
>   提为两个大类共用**的筛选项标签（批量调试不参与），下钻上下文可见可清。配套
>   消歧：TopN tab 文案改「按接口/按用例/…」（裸维度名被误读成页面级筛选，以为
>   上面的图跟着切），榜上方加 form-note 写明「tab 只切这张榜、叶子计数不受口径
>   影响、点行进执行记录自动填筛选项」。
> - **验收反馈一轮缺陷（同日两条，用户报「按用例、按接口统计数据失败」）**：
>   ① TopN 按接口/按套件维 500——P8-6 补的 refId 聚合用了 `MAX/MIN(uuid)`，Postgres
>   无此聚合（42883；按用例维实际 200，失败文案来自另外两条 500），改
>   `ARRAY_AGG…[1]`（取组内最近一次失败的引用）；② `stats/overview` 带 projectIds
>   必炸（双 WHERE）——P8-4 潜伏缺陷：assets/coverage 六个子查询 `scopeWhere` 后又
>   跟 `WHERE status…`，scope 全量时片段为空才合法（P8-4 验收用管理员没踩到），
>   P8-6 前端永远带 projectIds 后全部触发，统一改 `scopeAnd` 并入既有 WHERE。两处
>   修后 SQL 均在 dev 库 psql 实跑验证；明细记
>   `issue_fix/问题记录-P8-6统计页接线两缺陷.md`。
> - **验收反馈二轮（同日两项）**：① **趋势图下钻改落父执行记录**——通过率/执行量/
>   耗时三张图的样本是执行级（一次流程/套件/仓库 run 一个样本），原下钻落单接口
>   叶子记录与图的样本不是一个层（用户反馈「跳进单接口记录没看懂」），改
>   `?type=parent&status=failed&from&to`；kind 不预设（platform/repo 口径在 kind
>   筛选里是 flow+suite / ingest+runner 的多选组合，单个值表达不了，窗口 + failed
>   是共享事实）。② **执行记录三个大类都加常驻时间范围筛选**——原生
>   datetime-local + `.input` 皮肤（TestPlans 既定纪律，不引 antd DatePicker），
>   起止两个输入框替换此前下钻才出现的时间窗 chip；输入框另持原始文本、只在值
>   完整可解析时提交（受控值直接绑 ISO 会在打字途中重置输入框）；批量调试列表
>   后端补 from/to（`batch-executions`，COUNT 与分页共用 WHERE，psql 验证过形状）。
> - **验收反馈三轮（同日两项）**：① **下钻不预置结论**——趋势桶与 TopN 四维的
>   下钻 URL 全部去掉 `status=failed`：下钻带的是上下文（时间窗 / 对象筛选 /
>   kind），「只看失败」留给列表里的人自己点（用户原话「还是要展示全部的记录」）；
>   归因片 → `attribution=` 筛选维持不变（点哪个分类片就是它的语义，不是预置结论）。
>   ② **仓库执行详情的入口归属扩到执行记录**——`?from=` 机制从只认
>   `suite-reports` 泛化为认任意合法 section（PAGES 白名单校验），执行记录两处
>   runner 行跳转补 `?from=reports`：从执行记录进、面包屑/侧栏归「执行记录」，
>   从仓库内（CI 任务/用例树/调度）进、不带参数归「仓库」——与 P8-3 反馈③
>   同一条「从哪进就归哪」的规则。
> - **验收反馈四轮（同日两项）**：① 时间范围筛选补**一键清除** chip（同时复位提交值
>   与输入框原文——只清 state 不清框会读成「清了没生效」）。② 仓库执行详情面包屑
>   从「#序号」改成「**任务名 #序号**」——执行记录 runner 行的身份就是
>   `execution_index.target_name`（任务名 #序号），点进去面包屑只剩「#12」对不上；
>   详情路由 JOIN `ci_tasks` 带出 `taskName`（列表路由不带，行身份已在 target_name），
>   psql 验证过 JOIN 形状。页内标题（RepoPageHead）同款：首版只改了面包屑、页头
>   仍是「仓库执行 #31」，用户复验指出后补齐——任务名缺失（任务已删）时退回
>   「仓库执行 #序号」兜底。
> - **验收反馈五轮（2026-09-10 同日六项，②③①⑥ 是看板改版、④⑤ 是统计口径与
>   下钻）**：
>   - ② **看板加项目筛选**：`?project=` 进地址栏，antd Select（全部项目/单项目，
>     选项 = 可见项目集）；选定后读数与三张趋势图全部带 `projectIds` 钉在该项目，
>     跨项目 Top 10 榜整段收起（筛了项目还看跨项目榜自相矛盾），page-head 换
>     「进入项目数据统计」按钮 + filteredHint；选了项目但选项清单未到时不发统计
>     请求（不可见 id 会 403，等一拍好过闪错误态）。
>   - ⑥ **看板补趋势三张图**（「项目质量概览没办法整体看出具体情况」）：通过率
>     折线 + 执行量堆叠柱 + 耗时分位（p50/p90/p99，bridgeGaps），与项目层数据统计
>     同一套 `components/charts/` 底座、同一份 execution_trend 桶、同一空态语义；
>     30d 固定窗口、`all` 口径，trendNote 写明混合耗时口径；**选定项目时**点桶下钻
>     （父执行记录 + 桶时间窗，不预置 status/kind——与三轮「展示全部」同判），
>     全部项目时图不可点（没有单项目列表可落）。
>   - ① **资产面 census 升卡片**：原「平台用例 N · 流程 N · 套件 N · 仓库用例 N」
>     一行事实格升为 readout 卡，资产面合为六卡（接口总量+sparkline / 平台用例 /
>     流程 / 套件 / 仓库用例 / 文本用例总量）。
>   - ⑥' **两个覆盖率读数与榜的指标切换 tab 撤掉**（「接口覆盖率、自动化覆盖率、
>     通过率、失败量看不出来有什么作用」——四者唯一的动作是切榜的排序列，读者
>     读不出）：接口覆盖率/自动化覆盖率 readout 撤（数字留在 Top 10 榜的列里比较
>     才有意义，**边界 20 的资产面四读数就此改六卡**）；Top 10 榜的
>     coverage/automation/passRate/failed segmented 撤（四列本来就全在表里，切 tab
>     只是换排序），**固定 failed 降序「最差在前」**（边界 19 的「指标列可切换 +
>     检索两形态」就此收窄为固定列单形态——复验追问「搜索框是不是没用了」后，
>     榜的关键字检索与页头搜索框一并撤除：找项目归项目管理页，榜的职责是「最差
>     在前」不是「找得到」，一个只服务于榜的搜索框读不出作用；`statsProjects`
>     的 keyword 参数后端保留）；通过率读数留在执行面（图出现后它是窗口
>     读数 + delta，作用自明）。`?metric=` URL 参数不再消费，通过率 sparkline 撤
>     （真图取代）。
>   - **验收六轮（同日一项①）：覆盖率读数补回并带「总量」**（「数据概览增加接口
>     覆盖率/自动化覆盖率/归因覆盖率的总量」）：执行面 readout 行补接口覆盖率、
>     自动化覆盖率两卡——**百分比 + 分子/分母并排**（68.1% 与 146/214 是两个互补
>     事实，五轮撤掉的两个读数以「带总量」的形态补回；悬停说明写全口径），归因
>     覆盖率卡补 delta 之外加一格「已归因失败 N / 未归因 M」（分母是 30d 窗口内
>     失败目标数，分母 0 时该格不渲染——「没有失败」时归因数字是噪音）。数据
>     全部来自 overview 既有字段（coveredEndpointTotal/endpointTotal、
>     specAutomatedTotal/specReviewedTotal、attribution.*），零后端改动。
>   - ④ **失败 TopN 仓库用例维两处修正**：下钻从「组内最近一次失败 run 详情」
>     （refId → `pipeline-runs/:id`，替用户挑了一次执行，用户反馈「很奇怪」）改
>     **用例树 keyword 检索**（`/repo/tree?keyword=<规范 case_key>`——树是这条
>     用例的资产页，最近任务列 + 抽屉历史都在）；配套把维度的分组身份从裸
>     `guessed_case_key` 改**规范身份**（LEFT JOIN `repo_test_cases`，ingest.ts 同
>     一把匹配尺：去参数化后缀直等 + `#` 形态折算）——同一条用例的两种 key 形态
>     此前会拆成两行，现合一（dev 库实测 40+30 → 40），榜行 name = 规范 case_key，
>     refId 不再返回。Flaky 榜两条仓库腿同款下钻。
>   - ⑤ **Flaky 榜增仓库任务腿**（「不稳定用例是不是可以增加仓库任务的 case」）：
>     `/stats/flaky` 从两腿（api=executions case_id 序列 / repo=ingest SDK 上报
>     序列）扩三腿，新增 **runner = pipeline_run_cases 序列**：按 (run, key) 折结论
>     （同 run 同 key 多行任一 failed/error 即 failed、否则任一 passed 即 success、
>     全 skipped 不入序列——与通过率分母同判），身份用 ④ 同一把规范尺（两种 key
>     形态折成一条用例，序列才不会断成两截）；MTTR/首跑通过率同款第三条查询并入
>     聚合。来源列三值：平台用例 / 仓库上报 / 仓库任务。`metrics.ts` FLAKY 注释
>     同步两条腿 → 三条腿。三条新 SQL（TopN repo_case / flaky runner 腿 / runner
>     MTTR）均已在 dev 库 psql 实跑验证（flaky 腿实测 10 行出榜、MTTR 124 恢复 /
>     35 用例；EXPLAIN 0.97ms 小表 Seq Scan 正确计划）。
>   - ③ **项目内统计「口径=全部时下钻应展示全部」核对为已成立**（二/三轮已改判
>     的行为，本轮复核）：口径=全部时趋势桶样本 = flow/suite/ingest/runner 父执行，
>     下钻 URL `?type=parent&from&to` 不预置 status/kind；dev 库实测 9/9 桶 total=3
>     与 execution-index 同窗 total=3 完全一致（含 canceled 时列表只多不少）。本轮
>     新增的看板趋势图下钻沿用同一语义。未改代码。
> - **看板扩展**（`GlobalApp` DashboardPage 重写，边界 18/19/20）：执行面四读数
>   （执行量/通过率/失败量/归因覆盖率）+ 7 天 delta（比率 pp / 计数绝对差；
>   `Delta` 原语进 `ui.tsx`，「升=好」按指标声明——失败量升是 fail 色）+ 通过率与
>   接口总量 30 天 sparkline（`statsTrend` execution_trend / asset_trend 两腿）；
>   资产面四读数（接口总量+sparkline / 接口覆盖率 / 自动化覆盖率 / 文本用例总量）
>   + 其余资产总量一行事实格；两个覆盖率读数可点 → 切 Top 10 榜同名列
>   （`Readout` 扩 `onClick`）；项目表改 **Top 10 反向榜**（四指标列 segmented
>   可切换、`metric` 进 URL、failed 传 desc、归因覆盖率列保留）+ 关键字检索两形态
>   （命中全量展示）；榜行点击 → `/projects/:id/trends`（与边界 22 闭环）。看板
>   执行面取 **`all` 口径**（全局盘点不含仓库 CI 会与「全局」自相矛盾，tip 用
>   passRateTip.all 承担混合口径说明）、固定 30d 窗口。旧 `api.dashboard` 前端
>   不再调用（接口保留；P8-8 的性能收口照记）。
> - **`/stats/*` scope 三态**（P8-5 追记兑现）：`includeRepo` 二态退役，
>   `?scope=platform|repo|all`（白名单外回 platform，reports.ts readSampleScope
>   同款）；overview / trend / projects 三处 + 缓存键同步；failures 的 TopN 刻意
>   不受 scope 影响（维度是显式选择，注释原话保留）。
> - **默认页改 trends（边界 22）**：`main.tsx` 的 index `Navigate`、`ProjectShell`
>   两处兜底段（`segments[2] ?? "trends"` / `SECTION_ALIASES ?? "trends"`）与
>   面包屑项目名链接四处同步（验收门槛 14 的「含面包屑返回项目」）；`overview`
>   重定向维持指 `endpoints`（「概览」语义不改）。
> 配套：归因环形分类色走强调色明度阶梯（color-mix 兑 surface）、未归因 = line 灰
> （分类不是语义，不占语义色）；Flaky 榜带阈值/MTTR/首跑通过率行（阈值从响应
> `thresholds` 插值，不写死）；charts 底座 `Donut` 补 `onSliceClick`、`Sparkline`
> 补 `maxWidth: 100%`；i18n 双语（`trends.*` 重写 + `dashboard.*` 增量 +
> `reports.*` 下钻 chip，插值统一 `{{}}` 双花括号）；CSS 新增 `.delta` 与
> `button.readout-click`（可点击读数，悬浮只抬边框）。**零迁移**（P9 057 编号
> 不变）。`pnpm check` 前后端通过；服务重启、三档性能预算（门槛 8）与 hover/
> 下钻手感验收按 AGENTS.md 留给用户。
>
> **读数下钻（2026-09-10 功能增补，「看板选项目后点数据进项目内」）**：看板与
> 项目层统计页的读数在读数区即可下钻，**选定项目时**接线（全部项目时无单项目落点，
> 与趋势图同判不给点）：
> - **分边面板**（`Readout` 扩 `drill` 槽，antd Popover 悬浮弹出）：接口覆盖率
>   「已覆盖 x / 未覆盖 x」→ 接口列表 + 新增 `?coverage=covered|uncovered` 服务端
>   筛选（`endpoints.ts` EXISTS test_cases，与 coverageRate 同口径）；自动化覆盖率
>   「已自动化 x / 未自动化 x」→ 文本用例库 `status=reviewed` + `automation=yes|no`
>   （既有筛选）；通过率「通过 x / 失败 x」与归因覆盖率「已归因 x / 未归因 x」→
>   父执行记录（status + 30d 窗）与报告列表（`attribution` 筛选，**新增
>   `__attributed__` 伪值**与既有 `__unattributed__` 对称）。
> - **整卡直点**（`onClick`，同 readout-click 语言）：失败量（`status=failed`——数字
>   语义即失败，归因片判例）、已归因失败、资产面六卡（接口总量/流程/套件/仓库用例/
>   文本用例总量 → 各自列表；平台用例 → 接口列表 `coverage=covered`）。
> - **Trends 同步**（执行量/通过率/失败量/归因覆盖率四读数，同款面板与判例；时间窗
>   用页面当前 days）。
> - 纪律沿 P8-6 三轮「下钻不预置结论」：执行量面板两侧是「全部 / 有结论」，不带
>   status；kind 一律不预设。`SuiteReports` 归因筛选下拉补「已归因」选项（伪值进
>   多选，与具体分类可共存）。i18n 双语 15 键；CSS `.readout-drillable` /
>   `.readout-drill`（`.drill-side` / `.drill-note`）。**零迁移**；服务重启与验收
>   按 AGENTS.md 留给用户。

> **P8-7 实现状态（2026-09-10）**：四件事全部落地——
> - **MCP 两个归因工具**（`lib/mcpToolsAttribution.ts`，注册进 `MCP_TOOLS`，上限
>   55 → **57**）：`list_unattributed_failures`（read，分页 + `since` 可选窗口；目标
>   母查询与 `stats.ts` 的 `failureTargetsSql` 同一口径但**方向反过来**——`fa.id IS
>   NULL` 反连接只取没归因的失败；每行带 label/failedAt/evidence 摘录，摘录按
>   「项目全部环境当前 secret 并集 + pipeline_run_case 再叠一层所在 CI 任务 env 值
>   （≥8 字符才遮）」读时脱敏、2KB 截断——与 `redactExecutionForMcp` 同一条纪律：
>   写入时的遮蔽用的是当时的 secret，读时重跑才可靠）；
>   `set_failure_attribution`（write，单条；批量刻意不做工具——描述里写明「循环本
>   工具，按目标幂等」，REST 的批量抽屉才是人用的入口）。`source` 写 `'mcp'`、
>   `created_by` 落 Token 签发人（`/mcp` 第 4 道闸门已保证签发人此刻有写权限）；
>   审计走 `mcp_tool.write`（detail 带分类与目标类型，note 不进）。
> - **校验收敛到 `lib/attribution.ts`（新文件）**：`validateAttributionTarget` /
>   `normalizeAttributionBugUrl` / `attributionTargetIsFailed` /
>   `attributionCategoryExists` 从 `routes/attributions.ts` 原样提取，REST 与
>   MCP 两侧同引一份——边界 8「复用 REST 同一套校验」的字面落法（与 validate.ts
>   之于写工具的关系同构）。REST 路由行为零变化（信封与审计形状留在路由侧）。
> - **TopN 六维**（`stats.ts`，边界 21 兑现）：`TOPN_DIMS` 扩 `flow` /
>   `repo_case`。流程维 = `execution_index` kind='flow' 失败行按 `target_name` 分组
>   （`NOT_SELF_DEBUG` 排自指行，suite 维同构）；仓库用例维 = 窗口内
>   `pipeline_run_cases` failed/error 行按 `guessed_case_key` 归并（计划原话：
>   `last_result` 只是最新态不拿来数窗口失败；NULL key 成不了组天然排除）。两维
>   refId 都取 `ARRAY_AGG…[1]`（组内最近一次失败）——流程维指向 flow 资产、仓库
>   用例维指向最近失败 run（下钻落 run 详情页，失败用例行就在里面）。两条 SQL 在
>   dev 库 EXPLAIN (ANALYZE) 复核过（0.93ms / 0.34ms，小表 Seq Scan 是正确计划）。
> - **`source` 筛选**（`stats/failures` 扩参 `?attributionSource=human|mcp`，白名单
>   外不过滤）：分布段只数该来源的归因行（joined 顺带带出 `fa.source`、TS 侧挑行
>   + 分类按 code 归并——未筛时同一分类的人打/agent 打两行合成一片，来源是打标
>   行为的属性不是分类）；**覆盖率读数（failedTargets/attributed/unattributed）
>   不随来源筛变化**——筛哪个来源「还有多少没归因」都是同一个整窗事实，一份扫描
>   顺带出 source 列，不为读数再扫一遍。缓存键扩 `attributionSource`。前端归因
>   面板头加来源 Select（全部/人工/Agent），筛来源时环形不加未归因片、覆盖行追加
>   来源说明（`attributionSourceNote`）。
> - **by-index 统一入口**（12.2 / 交互 6.2d 的预留路由，前后端各一条同语义）：
>   后端 `GET …/executions/by-index/:indexId` 302 按 kind 分派（runner →
>   `pipeline-runs/:runId`（`?from=` 只认 PAGES 白名单，防开放重定向）/ ingest →
>   `repo/runs` / flow 与 suite（含自指单步调试行）→ 执行记录页 `?parent=` 深链）；
>   前端 `ExecutionResolver`（`main.tsx` 挂 `executions/by-index/:indexId`，注册在
>   `reports` 之前）客户端同款分派——站内跳转走 React Router 不发整页请求，深链是
>   它的主场景；行不存在给空态（与分享页同条纪律，不跳登录）。
> - **前端配套**：Trends 的 TopN tab 扩到六维（`trends.topN.flow` / `repo_case`
>   双语）；drillTopRow 补两维（flow → 父记录 `kind=flow` + keyword + 时间窗；
>   repo_case → `pipeline-runs/:refId?from=reports`）；drillable 判据同步。
>   **零迁移**（P9 057 编号不变）。`pnpm check` / `pnpm build` 前后端通过；MCP
>   工具的实跑验收（门槛 10：写回 `source='mcp'`、人工覆盖变 human）、六维真实
>   失败数据出榜（门槛 13）与服务重启按 AGENTS.md 留给用户。

> **P8-8 实现状态（2026-09-11，两刀）**：
> - **第一刀（2026-09-10，用户确认范围）**：`/projects` 换用新 `queryProjectList`
>   （`dashboard.ts`）——只聚合资产计数小表（endpoints/environments/test_cases/
>   flows/test_suites/repo_test_cases/spec_cases，GROUP BY project_id 全有索引），
>   executions（P8-8 实测 817ms 的大头）一次都不碰；`queryProjectMetrics`（七表
>   全量）留给 `/dashboard` 聚合路由自持。前端 `ProjectMetric` 类型随行收缩，项目卡
>   统计块改七格资产计数（详见主计划 3.1 ②）。**第一刀前 `/dashboard` 373ms 的账
>   落在第二刀。**
> - **第二刀（2026-09-11，子查询 WHERE 下推——P8-8 计划原方向「可见项目集先收敛」）**：
>   `queryProjectMetrics` 先把「这份 WHERE 会放行的项目」收敛成一份具体 id 集
>   （`SELECT p.id FROM projects p ${where}`，由本函数自持的 clauses 推导、不是重新
>   实现一遍过滤），压一次 `$n` 推进**七个聚合子查询**（`WHERE project_id =
>   ANY($n)`）。三种形态：非管理员 = 可见集 ∩ 过滤（必推）；管理员带过滤（keyword/
>   projectIds）= 过滤后的集合（推）；管理员无过滤 = 不推（聚合对象本来就是全部
>   项目，全表扫是诚实形状——与 stats.ts 的 resolveScope/pushScopeParam 同一对
>   概念）。空集推一个永不命中的占位 id，不留「不推 = 全表聚合」的歧义形状。
>   COUNT 切片传参（`params.slice(0, filterParamCount)`）——node-pg 对参数个数
>   严格（P8-4 的教训），aggregateIds 的占位符不进 COUNT 的 bind message。
> - **索引复核结论：零新索引**。七张表全部已有 project_id 前导索引
>   （executions_project_created_at_idx / endpoints_project_id_idx /
>   environments_project_id_name_key / test_cases_project_id_idx /
>   schedules_project_created_at_idx / ci_tasks_project_created_at_idx /
>   spec_cases_status_idx——环境表唯一键 (project_id, name) 前导列即 project_id，
>   小表上 planner 自选 Seq Scan 是正确计划）。预聚合表（边界 17 的立项判据）不
>   触发——`/dashboard` 前端已无调用方（统计走 `/stats/*`，P8-6 已改），这条路径
>   只剩接口契约保留。
> - **EXPLAIN (ANALYZE, BUFFERS) 实测**（dev 库 executions 154,382 行 / heap 215MB）：
>   管理员无过滤（不推）原样 ~50ms 温存 / ~400ms 冷读（并行 Seq Scan——聚合对象
>   就是全库，诚实形状）；非管理员小可见集（16 行 executions 的项目）下推后
>   **0.087ms Index Scan**（executions_project_created_at_idx）；非管理员 = 大项目
>   成员（154k 行）下推后 planner 仍选并行 Seq Scan（自己的行就是大多数，等价
>   ~108ms）。**下推消灭的账是跨项目聚合**：非成员原本也在为全平台 executions 付
>   全表聚合（817ms 的账记在这里）。结果一致性验证：下推前后同查询三列
>   （execution_count/judged_count/passed_count）逐值相等。
> - **零迁移、零前端改动**（`/projects` 第一刀已收缩的类型不变）。`pnpm check`
>   通过；服务重启与门槛 8 的性能验收（`pg_stat_statements` Top 10 复核）按
>   AGENTS.md 留给用户。P8 至此八个批次全部实现。
>
> > **P8 验收结论（2026-09-10，用户暂记通过）**：P8-1 ~ P8-8 全量暂记验收通过。
> > 保留项：门槛 8 的实测半边（`pg_stat_statements` Top 10 复核、三档性能预算的
> > 现场读数）依赖 P8-8 后的服务重启，随重启补验——P8-8 的 EXPLAIN 侧已全部
> > 复核过（零新索引、下推形态三态实测）。

### 12.7 验收门槛

1. 同一次套件执行：报告列表、报告详情、分享页、通知模版四处通过率一致
   （passed/(passed+failed)）。
2. 单步调试不再出现在趋势样本里（对比 P8-1 前后的失败率读数）。
3. 一条失败归因后，全局分布图立即变化；未归因占比始终可见。
4. 归因覆盖率低于 100% 时，分布图上有明确的「未归因 N 条」提示。
5. 批量归因 20 条失败 ≤ 2 次点击 + 1 次提交。
6. 非系统管理员的全局统计只含其可见项目；URL 直访别人的项目数据 403。
7. 趋势折线 hover：十字线 + 常驻读数（时间/通过率/量）；点击跳转列表且时间窗正确。
8. 性能预算三档验收（边界 17）：Readout 缓存命中 < 300ms（两次刷新验证缓存生效）；
    **默认窗口 30d 全部段 < 800ms**；90d/180d 深挖 < 1.5s（仅此档触发汇总表立项判据）。
    三段式页面分段渲染——最慢段加载中不阻塞其他段首屏（肉眼验证 + 断网单段验证）。
    `/stats/*` 每条接口 `EXPLAIN (ANALYZE, BUFFERS)` 全部走 Index Scan；验收时
    `pg_stat_statements` Top 10 里无统计类语句触发 Seq Scan（边界 23）。
    人为构造超慢场景（如全项目 180d + 无索引前置关闭）返回 503 + 缩窗提示，
    前端不白屏、连接池不堆积。
9. Flaky 榜与人工观察一致（构造一条翻转用例验证判定）。
10. MCP `set_failure_attribution` 写回后 `source='mcp'`；人工覆盖后变 `human`。
11. 零新图表依赖（`package.json` 无 echarts/recharts/antv）。
12. 看板 readout 的全局接口覆盖率/自动化覆盖率与 Top 10 反向榜同列口径一致；点读数
    或榜行能落到对应项目的统计页（默认落地页，边界 22）。
13. 失败 TopN 六维各自可出榜（流程/仓库用例两维用真实失败数据验证分组键：`target_name`
    / `guessed_case_key`）。
14. 进入项目（含面包屑「返回项目」）默认落在数据统计页；直访 `/projects/:id` 与
    `/projects/:id/overview` 行为符合边界 22 的分叉。

---

## 十三、P9 — 站内助手（人物 + 聊天 + 站内通知，约 4 周）

> **新手教程已于 2026-09-16 自 P9-7 整项移出至 P13**（用户确认），见十九章。
> 本章范围收窄为人物 + 聊天 + 站内通知；下文涉及教程的边界 7、P9-7 批次与
> 验收门槛 10 均已删除线处理并留指针。

### 13.0 P9 范围与边界（2026-09-04 确认；2026-09-11 修订扩界）

**定位**

主计划 9.8 的「后置：站内助手」落成正式阶段。方向不变：**平台不实现 agent、不管
session / token / function call**，链路是

```
浏览器 → 平台助手代理（只转发 SSE）→ 外部 agent 平台（agent-vendor）→ 平台 /mcp → 库
```

平台在这条链里出现两次：哑管道 + 工具提供方。

**2026-09-11 范围修订（用户确认，四条）**：

1. **账号操作并入助手**：系统设置快捷入口、登出、本人重置密码进助手，全部走
   **本地通道**（指令表 + 确认卡片 + 本人 JWT），不经过外部 agent——上游挂了这
   三件事仍可用。系统管理页不搬家（管理员面：用户/审计/workers 留在页面），助手
   是入口不是替代；管理员重置他人密码不进助手（页面操作，指令可导航）。
2. **助手代理 provider 化**：上游配置从「全局一份环境变量」改为**系统级 provider
   表**——多 provider、AES-GCM 加密 Key、JSON 导入/导出、测试连接、默认切换
   （原边界 4 作废改写）。代理底座按 **adapter 契约 + 注册表**实现（形制照
   `lib/adapters`：一个 type 一个实现文件 + 查表分发），v1 只实现 `agent-vendor` 一个
   adapter；第二个 adapter（Dify / Coze / 公司自研平台）等真实平台出现再写，
   契约不变。agent 方接入要求与对接契约见 13.6。
3. **只接 agent 平台，不接裸 LLM**（收界）：provider 资格线 = 有会话管理 + 流式
   + 历史 API，缺一不叫 agent 平台。裸 OpenAI 兼容端点（one-api / vLLM / 自建
   LLM 服务）没有会话存储：接进来要么平台自己管上下文（冲掉「平台不实现 agent」
   边界）、要么退化成接不进 `/mcp` 的通用聊天框（无工具面，「站内」二字不成立）。
   真想用裸 LLM 的人，在 agent-vendor/Dify 里包一个 agent 再接我们——门户守在 agent
   平台这层。
4. **连带简化**：无状态 provider 不存在 → 多轮上下文与会话历史**全部由 agent 方
   持有**，平台只代理展示、不存不缓存不代管窗口（「谁有会话谁记上下文」）。
   provider 选择权第一版平台默认一份（`is_default`），用户自选后置到 preferences。

**新增范围**（用户 2026-09-04 确认）：**站内通知并入本阶段**——通知中心（铃铛小红点
+ 弹窗提醒）是助手壳的一部分；P6/P7 落地的成员变更、计划指派在此回补通知生产端。

**2026-09-14 修订（用户四条反馈，P9-4 落地后）**：

1. **助手默认开启、取消项目闸门**（作废 2026-09-11 边界 4 末句「项目级仍然只有
   `project_settings.assistant_enabled`」与 13.4.3 的项目侧「站内助手」页）：助手是
   「用户 × 会话」的功能，凭据后续也走用户级（见下条），项目管理员不该替成员决定
   开不开。迁移 **058** DROP 该列；`AssistantPage` / settings 的 assistantEnabled /
   导航项全部摘除；抽屉圆钮常驻。原验收门槛 1（闸门 404）随之作废。
2. **provider = 通用协议模板 + 用户级凭据**（批次 **P9-4b**，取代「按用户自选
   provider 后置 preferences」的旧口径；**2026-09-14 已实现**，见 13.4.5）：
   - provider 行降格为**通用协议模板**——4 个接口（建会话 / 发消息 SSE / 停止 /
     历史）+ SSE 事件映射 + 认证模板，外加 `user_params`（用户选这个上游时要填的
     参数模式，如 agent-vendor 的 agentId、apiKey、mcpToken）。**换平台 = 填一份配置，
     零开发**（作废 2026-09-11 边界 12 的「不做协议映射引擎」与边界 1 的 adapter
     注册表模型——`lib/assistant/agent-vendor.ts` 与注册表删除，引擎 `engine.ts` 按配置
     执行；存量 agent-vendor 行由迁移 059 原地翻译成标准协议配置）；
   - 每个用户自配凭据（`assistant_user_agents` 表，secret 项 AES-GCM 加密、接口只
     回键名）、自选默认（第一个配置的自动戴默认帽）；**系统行不再存共享 Key、
     不留兜底**——用户原话「要配置自己的」；
   - 未配置时抽屉内引导配置（「设置」chip 直接开配置卡，不再跳系统管理）；配置
     卡的**过渡落点在抽屉内**（最小可用），P12 个人中心落地后扩为该页的 agent
     凭据 tab（见十八章）；
   - mcpToken 暂存不用（聊天管道不需要它——引擎只带认证头；后续 MCP 身份绑定
     （13.6 L3）再消费）；管理面「测试连接」带临时参数（不落库），因为系统行上
     没有可测的 Key。
3. **会话标题自动生成**：首条消息折叠摘要落 `topic`（30 字符 + 省略号，服务端
   在消息路由的 fire-and-forget 里写），抽屉下拉从时间戳换成可读标题。
4. **人物独一无二** = P9-6 既定范围（种子 `users.id` 确定性生成），无需修订。

**2026-09-15 修订（P9-4c 立项，用户确认）**：聊天抽屉两件事——

1. **页面上下文注入（「识别意图」的落点）**：意图解析的主体是 agent（LLM），平台
   不做意图分类器；平台做的是把「用户发消息时正站在哪」变成明确元数据随消息送上
   （例：在接口工作台说「改一下当前接口的断言」时，agent 拿到 endpointId + 正在
   编辑的 caseId，不用猜「当前」指谁）。管道五环：
   - **采集**（前端）：`pageContextStore` + `usePageContext()`。URL 是底座（route +
     search——列表筛选大多已在 URL），关键工作台页额外注册组件态（activeCase /
     selectedNode / 抽屉 executionId 这些不在 URL 里的）；路由切换即清。未注册页
     只带 route（路径里的实体 id 仍在）；全局层页面没有抽屉，不采不注。
   - **透明**（前端）：输入区上方上下文 chip（面包屑摘要 + 点开看全量 JSON +
     「本条不带上下文」开关）——用户看得见 agent 会拿到什么，信任的关键。
   - **注入**（后端）：消息路由把 context 压成紧凑 JSON、封 ```apitest-page-context
     围栏、前缀拼进转发 message——**协议配置零改动**（`{{message}}` 渲染的就是拼好
     的全文，只有 message 一个字段的上游也能吃）。topic 生成仍用用户原文；历史代理
     回放时服务端把围栏剥掉（气泡永远只显示用户打的字）；序列化封顶 ~2KB + 顶层键
     白名单 + 值浅校验。
   - **消费**（agent 方，13.6 契约补条）：收到 page-context 块必须优先按它解析
     「当前/这个/刚才」类指代（拿 ID 调 MCP read 工具取全量），块里没有的信息要
     反问用户，不许猜。
   - **安全**：只带标识符 + 面包屑（name/method/url），**secret 值一个不进**（环境
     密钥绝不进上下文）；发给的是用户自己配的 agent，其 MCP token 本就 read scope、
     写走 proposal + 本人 JWT——注入不抬权。
2. **Markdown / 文本编排渲染**：assistant 文本块引 `react-markdown` + `remark-gfm`
   （仅此两个新依赖；默认不吃原始 HTML，XSS 面为零；不引语法高亮）。覆盖
   标题/列表/引用/表格/行内代码/围栏代码块（mono + 横向滚动 + 限高）/链接外开/
   任务列表/删除线。流式期间半张表格、未闭合代码块容忍渲染，token 到齐自然收敛。
   **8.13 边界 19 在聊天场景改写**为「react-markdown 安全渲染」——报告页维持
   pre-wrap 原边界不动。`apitest-proposal` 围栏渲染为代码块，P9-5 预览卡扫描不受
   影响。用户气泡 / 错误气泡 / 工具行维持纯文本。

批次切分：**P9-4c-1 上下文管道**（最重要，含后端）、**P9-4c-2 Markdown 渲染**
（独立且小）。零新迁移。

**后置增补之二**（用户 2026-09-07 提出）：**项目可见性两层 + 权限申请审批流**——非
项目成员在项目列表**看得到**项目但**进不去**（发现层开放、内容层不变）；站内信与人物
落地后，用审批流自助申请权限。取向与现状锚点见 13.7；**2026-09-16 已立项为 P14**
（二十章），不再是「记录取向不排期」。

**上游能力核对**（`智能体平台-第三方接入接口文档.md`，2026-09-04 引入）：

| 9.8 的前置疑问 | 文档答案 |
| --- | --- |
| HTTP API 支持流式？ | ✅ `POST /api/v1/chat/{conversationId}` SSE，事件 `MESSAGE` / `PROCESSING` / `FINAL_RESULT` / `HEART_BEAT` / `ERROR` |
| 能接受外部传入会话 id？ | ⚠️ 不传 id，但会话由平台创建（§2.1）且历史可查（§2.5）——平台侧记 `conversationId ↔ (project, user)` 映射即可，无需自存 transcript |
| 能连任意外部 MCP Server？ | ✅ `STREAMABLE_HTTP` 安装方式（§3），P5 的无状态 `/mcp` 走兼容姿态可接 |
| 能按会话注入凭据？ | ❌ 未提及（API Key 平台级绑定智能体，§鉴权）——**L3 定案走 proposal-first**，P5-3 的该实测项降为「确认有无动态 Header 能力，有则可升级」 |
| 能转述 elicitation / MRTR？ | ❓ 文档无此概念；按「不能」处理——delete 在聊天里降级为「请到页面上操作」提示（P5 9.4.1 的降级分支；职责三层拆解与实测判定方法见 13.6） |

**边界决策（15 项；2026-09-11 改写 1/4/6、增补 13–15，其余为 2026-09-04 原案）**

1. **事件归一升格为 adapter 契约（2026-09-11）**：归一事件 `token(text)` /
   `tool(name, status)` / `done(fullText)` / `error(message)` 是代理路由与前端
   唯一认知的事件形状；每个 adapter 只干「把自家协议翻译成归一事件」一件事，
   路由层按注册表查表分发（形制照 `lib/adapters/index.ts`）。agent-vendor 映射：
   `MESSAGE` 的 token 流原样拼；`PROCESSING`
   映射为「正在调用 list_endpoints…」的工具行（**用户能看见 AI 在调什么工具——信任
   的关键**）；`HEART_BEAT` 不转发，代理自己按 15s 发 SSE 注释行保活（长空闲连接
   防断，`routes/stream.ts:43` 的既有写法）；`ERROR` 映射为一条错误气泡 + 结束帧。
   上游加字段/改字段名时不让前端跟着改——**换上游更是零改动**（新增一种 agent =
   加一个 adapter 文件 + 注册表一行 + 系统管理多一个 type 选项）。
2. **对话正文不落库**（9.8 既定）：transcript 在 agent 平台侧（`GET …/messages` 可
   查），平台只存 `assistant_conversations` 映射行。理由照旧——再存一份等于把可能含
   业务数据的文本抄成两份。
3. **L3 身份绑定定案 proposal-first**（9.8 三选一的第 3 项）：聊天用的 MCP Token 只
   发 `read` scope；写操作由 agent 产出**草稿**（proposal），前端渲染成预览卡，用户
   点「确认应用」时**用自己的 JWT 调既有 REST**。零新增写库路径；`canAccess` 与审计
   全程落在真人。上游无按会话注入凭据能力（见上表），选项 1/2 的前提不成立。
   `ResponseScriptEditor.tsx:20` 的受控组件形态是草稿落点；草稿在回复正文中的围栏
   标记格式（`apitest-proposal`）见 13.6 对接契约。
4. **上游配置 = 系统级 provider 表（2026-09-11 改写，原「全局一份环境变量」作废）**：
   `assistant_providers`（name / type / config JSONB / capabilities / api_key_
   encrypted / enabled / is_default），多份并存 + JSON 导入导出 + 测试连接 + 默认
   切换，放**系统管理**（不是 project_settings——上游配置是平台级运维资产，每个
   项目一份是错的抽象层级）。Key 照 `notification_channels` 先例：AES-GCM 加密
   （`lib/crypto.ts`——要拿明文调上游，所以加密而非哈希）、写库即密、接口只回
   「已配置」、PATCH 三态补丁。项目级仍然只有 `project_settings.assistant_enabled`
   （默认 false，照 P5 边界 12 的 `mcp_enabled` 同款：服务端真不服务，不是藏入口）。
5. **人物：纯 Canvas 2D，种子 `users.id`**（9.8 既定）。搬 `hand-drawn-character-
   creator.html` 76-584 行（three.js 从 588 行起不搬），改画单张 2D canvas；动画只留
   眨眼、遵守 `prefers-reduced-motion`。头像不落库（确定性生成，前端每次画）；
   「换一个形象」用 `preferences.avatarSeed` 覆盖（不动 `users.id` 语义——改名≠换人，
   但允许本人主动换）。**`nightmare` 物种（12% 概率长角/锯齿嘴/空洞眼）默认移出**
   ——企业内网工具里它只会被当 bug 报；保留物种代码，皮肤开关藏进 preferences。
6. **聊天窗两层 + 账号指令（2026-09-11 扩界）**：本地指令集（主题/语言/导航/打开
   某页/当前项目切换说明）走前端命令表（前缀匹配，命中即执行并回系统气泡）——
   **agent 平台挂了这些仍可用**；未命中走自然语言通道。**新增账号指令**：
   `/设置`（抽屉内快捷设置卡：主题/语言直接改写 preferences，或导航系统管理页）、
   `/登出`（确认卡 → 前端登出回登录页，零新路由）、`/改密码`（受控表单卡：当前
   密码 + 新密码 ×2 → 既有 `POST /auth/change-password`，本人 JWT）。抽屉常驻
   快捷 chips（新会话/设置/改密码/登出），显式入口不靠猜意图；含密码/登出等
   账号词的消息本地拦截引导到卡片，不转发上游。
 7. ~~**新手教程数据驱动 + 一条主线**~~（**2026-09-16 移出至 P13**，用户确认；
    骨架 `{ route, selector, i18nKey }[]` JSON、`preferences.onboarding` 记完成态、
    一条 5 步主线（登录 → 建项目 → 建接口 → 跑一次 → 看报告）、侧边卡片 +
    目标元素描边（不用遮罩高亮）、`data-tour` 属性标靶点等完整边界原样随迁，
    见 19.0。）
8. **站内通知是一张新表，不并入 `notification_deliveries`**——那张记的是外发投递
   证据（HTTP 状态/error），站内通知是给用户看的消息（已读态）。两者语义不同。
9. **通知生产端**复用既有三个终态订阅点（`scheduler.ts:39-75` 的 alert 派发 / 套件
   通知 / CI 通知）+ 两个新源（成员变更、计划指派——**P9 回补 P6/P7 的生产端**）。
   收件人 = 项目全体成员（含 viewer）；不做按人订阅偏好（第一版）。
10. **小红点 + 弹窗**（用户 2026-09-04 确认）：铃铛入口（顶栏）未读数；进入助手抽屉
    看列表（标题 + 时间 + 深链，点击即读 + 跳转）；**新通知到达时 antd `notification`
    弹窗**（右上角）——「有通知时弹窗提醒 or 小红点提醒」两者都做：弹窗给「正在页
    面上」的即时感，小红点给「回头再看」的存量感。
11. **未读数轮询 60s + 页面获焦即拉**，不做实时推送——通知不是聊天，60s 延迟无感；
    SSE 推送要把跨项目的用户级通道引进来（现有 `stream.ts` 是项目级），为一个计数
    不值。
12. **不做**：语音、多轮记忆管理、知识库（agent 平台侧能力）、助手主动推送周报
    （那是 agent 平台的定时任务，不是平台功能）、**裸 LLM 直连**（修订 3）、
    **协议映射引擎**（custom adapter——用 JSON 描述协议本身，必然长成蹩脚小语言；
    真冒出陌生协议时写一个专用 adapter 文件更便宜，等同类怪协议出现第三个再议）、
    **按用户自选 provider**（后置 preferences）。
13. **provider 资格线与能力面（2026-09-11）**：`type` 必须是注册表内已实现的
    adapter（v1 仅 `agent-vendor`，导入未知 type 报错）；必备能力 = 建会话 + SSE 流式 +
    按会话查历史；`stop` 可选（无则按钮隐藏、前端断流即可）；上游「会话列表」
    接口**不需要**——抽屉列表读 `assistant_conversations` 映射表（topic 一行标题
    不算 transcript，边界 2 不破）。
14. **账号操作不外发（2026-09-11）**：密码不进消息流、不发上游——改密走受控
    表单卡 + `POST /auth/change-password` 本人 JWT；登出纯前端清 token；`pwd_epoch`
    语义与页面改密一致。
15. **无默认 provider 的姿态**：`assistant_enabled=true` 但平台无启用的默认
    provider 时，助手路由组返回明确的「未配置」错误（不是 404），前端圆钮显示
    「未配置」态并引导管理员到 provider 面板。

### 13.1 数据库迁移：057_p9_assistant.sql

> 编号顺延：原计划 055/056 已被 P8 占用（055 执行记录分区部分索引、056 归因
> bug_url），P9 顺延为 **057**（2026-09-11 复核，与 12.6 P8-8 末注一致）；
> P11 同步顺延为 058（16 章）。
>
> **058 已被 P9-4 修订占用（2026-09-14）**：`058_p9_assistant_always_on.sql`
> DROP `project_settings.assistant_enabled`（助手默认开启）。
> **059 已被 P9-4b 占用（同日）**：`059_p9_assistant_generic.sql`（通用协议 +
> 用户级 agent，13.0 修订块第二条）——P11 由 058/059 连续占用后再顺延为 **060**
> （16 章编号同步）。

```sql
ALTER TABLE project_settings ADD COLUMN IF NOT EXISTS assistant_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS assistant_providers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                      -- v1 仅 'agent-vendor'；注册表外 type 服务端拒绝
  config JSONB NOT NULL,                   -- 类型特有参数（baseUrl / agentId 等）
  capabilities JSONB NOT NULL,             -- {stop, history, attachments}：type 预设，导入 JSON 可收窄
  api_key_encrypted TEXT,                  -- AES-GCM（lib/crypto.ts）；只写不读，接口回「已配置」
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assistant_conversations (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES assistant_providers(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_conversation_id TEXT NOT NULL,   -- 上游 conversationId（agent-vendor 为 Long 文本）
  topic TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_conversations_user_idx
  ON assistant_conversations (user_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- 'member_change' | 'plan_assign' | 'alert' | 'suite_result' | 'ci_result'
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',           -- 站内相对路径
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);
```

**配置存储决策反转（2026-09-11）**：原「baseUrl/agentId/apiKey 走环境变量
（`ASSISTANT_BASE_URL` / `ASSISTANT_AGENT_ID` / `ASSISTANT_API_KEY`，部署期资产）」
方案作废——用户要求运行期可配置、可多份、可 JSON 导入，落成 `assistant_providers`
表。原顾虑（Key 在库里、库被 MCP 读）由既有先例承接：AES-GCM 加密 + 只写不读 +
PATCH 三态补丁（`notification_channels.ts` 同款）、MCP 工具面不暴露系统级表、
provider 管理路由仅系统管理员。

`assistant_conversations.provider_id`：会话路由按会话行上的 `provider_id` 取
adapter——默认 provider 只决定**新建会话**归属，切换默认后旧会话照常收发；
provider 删除级联删会话（`ON DELETE CASCADE`）。

### 13.2 后端新 API

```
# provider 管理（系统管理员，全局层）
GET    /api/v1/system/assistant/providers               列表（Key 只回「已配置」）
POST   /api/v1/system/assistant/providers               创建（type 必须在注册表内）
PATCH  /api/v1/system/assistant/providers/:id           更新（secret 三态补丁，同通知渠道）
DELETE /api/v1/system/assistant/providers/:id           删除（会话级联，见 13.1）
POST   /api/v1/system/assistant/providers/:id/test      测试连接：建会话 → 发 ping → 归一事件回显
POST   /api/v1/system/assistant/providers/:id/set-default
POST   /api/v1/system/assistant/providers/import        JSON 导入（{name,type,config,capabilities}，不含 Key）
GET    /api/v1/system/assistant/providers/:id/export    JSON 导出（永不带 apiKey）

# 助手（项目级；assistant_enabled=false 时整组 404，与 /mcp 同款闸门；
#      开启但全局无默认 provider 时回「未配置」错误，非 404——边界 15）
POST   /api/v1/projects/:id/assistant/conversations          创建（按默认 provider，转发上游 conversation/add）
GET    /api/v1/projects/:id/assistant/conversations          我的会话列表（读映射表，不调上游）
POST   /api/v1/projects/:id/assistant/conversations/:id/message   转发消息，SSE 流回（hijack；按会话的 provider_id 取 adapter）
POST   /api/v1/projects/:id/assistant/conversations/:id/stop      转发上游 stop（provider 无此能力时 400）
GET    /api/v1/projects/:id/assistant/conversations/:id/messages  历史代理（转发上游，带缓存头）

# 通知（跨项目，用户级）
GET    /api/v1/notifications?unread=1&page=&pageSize=    我的通知（分页）
GET    /api/v1/notifications/unread-count                未读数（轮询端点）
POST   /api/v1/notifications/:id/read                   标已读
POST   /api/v1/notifications/read-all                   全部已读
```

`lib/inbox.ts`：`deliverInbox(projectId, kind, title, body, link)`——拉项目成员
批量插入 + fire-and-forget（照 `writeAuditLogAsync` 的取舍：通知写失败不能拖垮业务
事务）。

### 13.3 前端

- **顶栏铃铛**（`ProjectShell` 与 `GlobalApp` 顶栏）：未读数 badge + 下拉最近 10 条；
  「查看全部」进通知列表页（全局层路由 `/notifications`）。
- **助手抽屉**：右下角常驻圆钮（人物头像 32px）→ 展开 420px 抽屉（头像 96px +
  会话切换 + 消息流 + 输入框）。消息流支持：markdown 纯文本（照 8.13 边界 19 的
  pre-wrap 纪律，不引渲染器）、工具调用行、**proposal 预览卡**（草稿 + 差异摘要 +
  「确认应用 / 放弃」——扫描 `apitest-proposal` 围栏渲染，格式见 13.6）。
  **快捷 chips（2026-09-11）**：输入框上方常驻 新会话 / 设置 / 改密码 / 登出
  四枚，显式入口不靠猜意图。无默认 provider 时圆钮显示「未配置」态并引导管理员。
- **provider 管理面板（2026-09-11，系统管理页，仅系统管理员）**：类型选择
  （注册表驱动）+ 按 type 渲染参数表单（config schema）+ Key 三态输入 +
  测试连接（归一事件实时回显）+ JSON 导入/导出 + 默认切换 + 启停。
- **人物生成器**：`lib/avatar.ts`（种子 → 物种/五官/配色确定性生成）+ 两个尺寸
  React 封装。眨眼动画仅抽屉打开时运行（Quiet Console「全应用只允许一个环境动画」
  ——与在飞请求呼吸点不同时出现）。
- **本地指令表**：`/主题 深色`、`/语言 en`、`/打开 接口管理`……前缀匹配 + 回车直发
  兜底。**账号指令（2026-09-11）**：`/设置`、`/登出`、`/改密码` 三条 + 账号词
  本地拦截（边界 6/14），卡片形态与快捷 chips 同款。**输入即识别（2026-09-16 增补，
  见 13.4.11）**：输入框上方候选浮层，边打边挑指令名与参数（主题值 / 语言值 / 页面名），
  ↑↓ 选、Tab 补全、点选等价于 Tab。

### 13.4 实施顺序（P9-1 … P9-8，2026-09-11 重排：provider 化与账号指令并入对应批次；2026-09-16 修订：P9-7 教程移出至 P13，编号不复用、P9-8 收尾保留）

| 步 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| P9-1 | 迁移 057（providers + conversations + notifications）+ inbox + 铃铛 + 列表页 + 两个新源回补 | 通知闭环（小红点 + 弹窗） | 已实现（2026-09-11，见 13.4.1） |
| P9-2 | 代理底座 provider 化：adapter 契约 + 注册表 + agent-vendor 实现 + 助手五条路由 SSE + 事件归一；**联调实测清单**（13.6：elicitation/MRTR 转述 + 按会话注入凭据两项问询） | curl 能对话 | 已实现；stg 联调正常流式 + e2e 8/8 已过；13.6 两项问询已答复（均不支持，见 13.4.2）——功能请求 `智能体平台-MCP支持需求.md` 待 agent-vendor 排期 |
| P9-3 | provider 管理：CRUD + 加密 Key + JSON 导入导出 + 测试连接 + `assistant_enabled` 闸门 + 无默认 provider 引导 | 运行期可换上游 | 已实现（2026-09-11，见 13.4.3） |
| P9-4 | 聊天抽屉 UI（消息流/工具行/输入/快捷 chips） | 手工验收链路 | 已实现（2026-09-14，见 13.4.4；同日修订：助手默认开启 + topic 标题，迁移 058） |
| P9-4b | 用户级 agent 凭据 + 上游通用协议化（2026-09-14 修订新增）：系统 provider = 通用协议模板（4 接口 + SSE 映射 + 用户参数模式），用户自配 agentId/apiKey/mcpToken、未配置时抽屉内引导 | 每人能用自己的 agent；换平台零开发 | 已实现（2026-09-14，见 13.4.5） |
| P9-4c | 聊天窗口 Markdown 渲染 + 页面上下文注入（2026-09-15 修订新增）：上下文采集/透明/注入/消费/安全五环 + react-markdown 文本编排 | 「当前接口」类指代可解析；回复排版可读 | 已实现（2026-09-15，见 13.4.6） |
| P9-5 | 本地指令表（主题/语言/导航 + 账号指令卡 + 敏感意图拦截）+ proposal 预览卡（草稿 → 本人 JWT 应用） | 「AI 起草、人确认」+ 账号自助闭环 | 已实现（2026-09-15，见 13.4.7） |
| P9-6 | 人物生成器（Canvas 2D 移植 + 头像挂点 + 换形象） | 形象可见 | 已实现（2026-09-16，见 13.4.8） |
| ~~P9-7~~ | ~~教程骨架 + 主线 5 步 + 双 i18n~~ **2026-09-16 移出至 P13**（见十九章，原编号作废不复用） | 新用户引导可用（随迁 P13） | 已移出 |
| P9-8 | 收尾：上游异常演练（断流/限流/ERROR 事件）+ 验收 | 门槛全过 | 已实现（2026-09-16，见 13.4.10）；演练物料 `apitest-e2e-python/drill/`，验收按 AGENTS.md 待手工 |

#### 13.4.1 P9-1 实现状态（2026-09-11）

- **迁移 057**（`057_p9_assistant.sql`）：`project_settings.assistant_enabled`
  （默认 false，照 mcp_enabled 先例）+ `assistant_providers`（name UNIQUE / type
  CHECK v1 仅 'agent-vendor' / config / capabilities / api_key_encrypted / enabled /
  is_default）+ `assistant_conversations`（user 索引、provider 级联删）+
  `notifications`（kind 五值 CHECK、unread 部分索引 + (user, created_at DESC)
  索引、project_id SET NULL 活过项目删除）。providers / conversations 两张表
  本批只立结构，路由在 P9-2 / P9-3。**057b**（`057b_p9_notification_recipients.sql`，
  收件口径变更的追加迁移）：`execution_index.triggered_by`（ON DELETE SET NULL，
  与 pipeline_runs 038 同款）——058 已被 P11 预留，字母后缀照 039b 先例。
- **`lib/inbox.ts`**：两个入口按收件口径分流（**2026-09-11 用户确认修订**：
  alert / suite_result / ci_result 从「全体成员」改为「谁触发发给谁」，非人触发
  不发——受众不明确的广播只是噪声，需要关注定时 / Webhook 结果的人已由站外
  渠道覆盖；member_change / plan_assign 维持全员 / 单人原口径）：
  - `deliverInbox(projectId, kind, title, body, link, excludeUserId)`——一次
    `INSERT … SELECT` 全体成员（含 viewer，边界 9），`excludeUserId` 给「移除成员」
    用（被移除的人下次请求就 403，再发深链只会制造打不开的入口）；
  - `deliverInboxToUser(projectId, userId, …)`——定点发给触发人，`userId` 为空
    **不发**（宁缺毋滥：发给错误的人比没有更糟，他会开始忽略铃铛）。
  两者都 fire-and-forget（`.catch` 只记 console，通知写失败不拖垮业务事务，
  `writeAuditLogAsync` 同款取舍）。
- **通知四条 REST**（`routes/notifications.ts`，用户级无项目前缀，`currentUser`
  即守卫）：列表分页（`unread=1` 筛选 + projectName 读时 LEFT JOIN 快照）、
  未读数（轮询端点）、单条标读（他人行 404 不泄露存在性）、全部已读
  （COALESCE 保首次阅读时间）。`mapUserNotification` 进 `models/types.ts`
  （snake→camel 边界纪律）。
- **五个生产源全部接上**：
  - **member_change 两处写点三处调用**（`routes/members.ts`）：POST upsert（新
    加入 / 角色变更两态文案）、PATCH 改角色、DELETE 移除（excludeUserId）。
  - **plan_assign**（`routes/testPlans.ts` 的项 PATCH）：assignee 键显式变了才发
    （BEFORE CTE 取改前值比对——RETURNING 里读到的已是改后行）；指派给谁发谁
    （单收件人不走成员扇出，直接插行），取消指派不发（「没有你的事了」不构成
    一条需要点击的通知）。
  - **alert / suite_result / ci_result 三处既有订阅点定点加发**（`lib/alerts.ts`，
    收件口径见上）：触发人落在 `execution_index.triggered_by`（套件 / 流程，迁移
    **057b** 补的列——057 已应用只能前向加文件；CI 用 `pipeline_runs.triggered_by`
    038 既有）。手动 / MCP execute / 「立即运行」都带人；调度器 / Webhook 不带
    （`TriggerContext` 扩 `userId`，非人触发缺省 → 站内不发）。深链直指报告页 /
    run 详情页；外发渠道照旧——站内与外发解耦。
- **前端**：
  - `api.ts` 通知四条 + `UserNotification` 类型；`stores/notificationsStore.ts`
    （zustand：未读数 + 最近 10 条 + loaded 旗——两个壳的铃铛读同一份，轮询只跑一份）；
  - `hooks/useNotifications.ts`（`useNotificationPolling` 挂在 Root：60s 轮询 +
    窗口获焦即拉（边界 11）+ 新到达 antd notification 弹窗（边界 10）——**首轮只定
    基线不弹**，存量未读不轰炸；401 静默由拦截器接管）；
  - `BellMenu.tsx`：顶栏铃铛（未读 badge 99+ 封顶）+ Popover 下拉最近 10 条（点击
    即读 + 深链走 navGuard confirmLeave——从编辑页经通知离开时未保存守卫照常拦）+
    下拉内「全部已读」（recent 行就地落已读态，不与计数矛盾）；挂全局层顶栏
    （退出左侧）与项目壳顶栏（项目切换器左侧）各一枚；
  - `NotificationsPage.tsx`（全局层路由 `/notifications`，GlobalApp 第四页）：分页
    列表 + 全部/未读 segmented 筛选（手写 `.segmented`，与执行器面板同形态）+
    行点击即读 + 深链 + 页头「全部已读」〔P12-2 后挂载点改为 `/me/notifications`，
    组件本身不变——见 18.5〕；
  - 样式（`design-system.css` 新增 P9-1 段）：badge 走 accent（交互元素），
    未读点中性 accent 小圆点（通知不是执行结果，不占 pass/fail 语义色），
    已读行整行降 `--ink-2`（降级不是标记）；i18n 双语 `notifications.*` 命名空间。
- **验证**：前后端 `pnpm check` 通过；服务重启（迁移 057 应用）与门槛 7 的实测
  （成员加入后 ≤60s 小红点 + 弹窗 + 深链落点）按 AGENTS.md 留给用户。

#### 13.4.2 P9-2 实现状态（2026-09-11）

- **adapter 契约 + 注册表（`lib/assistant/`，形制照 `lib/adapters`）**：
  - `types.ts`：归一事件 `token(text)` / `tool(name, status)` / `done(fullText)` /
    `error(message)`（边界 1）——**done/error 是终态**，streamMessage 产出的流必须
    以二者之一收尾（上游断流无终态时由 adapter 合成；客户端断开不合成——没人听
    的事件没有意义）。能力面 `{stop, history, attachments}` 是 type 预设（provider
    行可收窄）；契约里 stop 可选、建会话 / 流式 / 历史必备（资格线，边界 13）。
    `streamMessage` **两段式**：上游响应头到达且 OK 才 resolve——那之前抛错让路由
    在 hijack 前回干净 JSON，之后只以 SSE error 终态帧送出（门槛 5 的通道）。
  - `index.ts`：注册表（loader 表 + memoize + `assertType` 键自检 + 同步
    `isSupportedAssistantType`——P9-3 的 CRUD 用它答「type 是不是真的」）；v1 仅
    `agent-vendor` 一项。
  - `sse.ts`：增量 SSE 解析器（跨 chunk 半行缓冲、多行 data 按 spec 连接、注释行
    丢弃）——Node 没有内建 SSE 客户端（EventSource 是浏览器 API）。
  - `providers.ts`：provider 行 → 运行时（`api_key_encrypted` 是 base64 文本——
    列是 TEXT，与 notification_channels 的 BYTEA 形态不同，P9-3 写入侧用
    `encryptSecret(...).toString("base64")`；AES-GCM 解密只在调上游这一瞬间存
    在，不进日志不回响应）。`loadEnabledDefaultProvider` 按 `is_default AND
    enabled`（默认行被停用即视为无默认）；解密失败按 provider 不可用抛清楚，
    不静默降级成无 Key——那只会得到一个更难排查的上游 401。
  - `agent-vendor.ts`：建会话（`conversation/add`，`data` 即 conversationId，Long 落库
    统一 TEXT）/ 流式（`MESSAGE`→token（`think` 不在归一契约里，丢弃）、
    `PROCESSING`→tool（名称缺省退 `data.type`）、`FINAL_RESULT`→done（
    `outputText` 空时退 token 累计值）、`ERROR`→error、**`HEART_BEAT` 吸收不转
    发**）/ stop / 历史（上游「会话列表」接口刻意不用——抽屉列表读映射表，边界
    2/修订 4）。一问一答接口 15s 超时 + `code === "0000"` 业务码判定（HTTP 200
    但业务码非 0000 是其常态错误形状）；未知 eventType / 解析失败按协议噪音丢弃
    ——上游加事件类型时旧前端不掉线。
- **五条路由（`routes/assistant.ts`）**：
  - 闸门顺序：`requireProjectAccess`（POST 一律 write——viewer 能读列表/历史，
    不能建会话/发消息/停止）→ `assistant_enabled`（false 整组 `callNotFound`，
    与未知路由逐字节同形，照 /mcp 的 mcp_enabled 同款，门槛 1）→ **无启用的默认
    provider**（503 + 新错误码 **2005**「未配置」，组级检查给前端圆钮统一信号，
    边界 15）→ 会话按 `(id, project, user)` 取（他人的 id 404 不泄露存在性）→
    会话**自己的** provider（按 `provider_id` 取 adapter，门槛 13；被停用
    503/2005）→ 注册表查 adapter。
  - 新错误码 **2006**（502）= 上游调用失败——与 2005 分开是照 failNoRunner/2004
    的取舍（「找管理员配 provider」与「agent 平台挂了」是两个处置动作）。
  - `POST …/message`：body `{message, attachments?}`（消息 ≤32768 字符；附件
    ≤10 且需能力面开 attachments，fileUrl 限 http(s)）；两段式 + hijack（CORS
    头手动搬、`X-Accel-Buffering: no`，写法照 routes/stream.ts）；**断开检测挂
    `reply.raw`**（POST 的请求体进 handler 前就被 Fastify 消费完，`request.raw`
    的 close 信号不可靠）+ AbortController 同砍上游 fetch 与读循环；**15s 注释
    行保活**（上游 HEART_BEAT 已被 adapter 吸收，边界 1 的 15s 口径）；终态帧后
    停止消费；`last_active_at` fire-and-forget bump。
  - `GET …/conversations` 读映射表不调上游；`POST …/conversations` 按默认
    provider 建会话落映射行；`POST …/stop` 行能力面 + adapter 实现双判定，无则
    400（13.2 的口径）；`GET …/messages` 历史代理——index/limit 透传（limit
    1–100 默认 50）+ `Cache-Control: private, max-age=60`。
  - `AssistantConversation` + `mapAssistantConversation` 进 `models/types.ts`
    （snake→camel 边界纪律）。
- **联调姿势**：已收进 e2e 的幂等种子脚本——`apitest-e2e-python` 里
  `source env.local.sh && python3 setup/seed_assistant.py`（借 server 的
  crypto.ts 产密文 → upsert provider → find-or-create 项目并开开关；细节见
  下条 stg 联调实测与脚本头注释）。
- **stg 联调实测（2026-09-11，用户提供的真实平台 + ak- Key；同日二轮：接口文档
  更新 + agentId 更正为 26，正常流式已验证）**：
  - **通（agentId=26，Key 绑定的智能体）**：建会话 / 会话列表 / `stop` /
    历史 / **发消息 SSE 正常流式——224 个 MESSAGE token 逐段 + FINAL_RESULT
    success=true（totalTokens 3930）**；经代理全链路同样通过（token×N + done
    终态），e2e 8/8。SSE 帧是 `data:{...}`（冒号后**无空格**）——解析器按
    spec 的可选空格处理，天然兼容。
  - **两处协议实况（更新后的文档已正式确认，adapter 方向对齐）**：
    ① `conversationId` 必须 **body + 路径都传**（只放路径回 `4000`）；② 错误
    判定以 `FINAL_RESULT` + `data.success=false` 为准、平台**不发** ERROR 事件
    ——adapter 的 `success:false` → error 终态映射正中口径。
  - **初轮「额度不足」假象的根因**：agentId 绑错（用了 1，Key 绑定 26）——
    平台对未绑定 id 也建会话、路由到无额度配置的模型，报
    `quota_not_enough`。更正后无需充值。`modelId` 按文档口径第三方不传
    （数字无效、字符串 400，模型在平台后台配）。平台自己的前端通道
    `/api/agent/conversation/chat` 走浏览器会话，ak- Key 打它 500、cookie
    重放 4010（预期内）。
  - **HEART_BEAT / PROCESSING 未观察到**（正常回复 ~3s 即终；当前智能体纯问答
    无工具调用）——HEART_BEAT 不依赖（代理自发 15s 保活）；PROCESSING 待
    「会触发工具调用的智能体」后复核（正是 MCP 工具面接线的前置观察）。
  - **e2e 落地（apitest-e2e-python）**：`setup/seed_assistant.py`（P9-3 的
    CRUD/开关落地后退休；agentId 默认 26）+ `test_case/assistant/` 八用例——
    五条路由 × 协议不变量（终态唯一且在最后、done 带 fullText / error 带可读
    message、闸门 404、空消息 400、未知会话 404、历史含刚发消息）。**8/8
    通过、全套 33 passed 零回归**（2026-09-11 二轮，正常流式路径；一轮跑的
    是 error 路径——两条终态通道都实测过）。测试侧 SSE 消费按空行切事件
    自攒缓冲（`iter_lines` 会把长事件 JSON 拦腰截断）。
  - **对接材料**：`智能体平台-联调问题清单.md`（仓库根）——问题明细（P0 已
    解除、P1×3 已随文档确认收口）+ 待补信息 5–9 项（data 空格稳定性 /
    attachments 开放性 / stop 语义 / elicitation 转述 / 按会话注入凭据）+
    我们的调用流程与复现命令，可直接转 agent-vendor 侧。
- **验证**：`pnpm check` 通过；stg 联调（正常流式 + 错误路径两条终态）与 e2e
  8/8 已过。仍待补（**MCP 接线整体被网络阻断后置**：平台本地部署、agent-vendor 在
  公司内网，其智能体出站打不到我们的 /mcp——部署到可达网段是硬前置，P2-8 同类
  问题；问题清单第 10 项）：PROCESSING 事件的真实字段形状（等接线后智能体真
  调起工具）。**13.6 两项问询已答复（2026-09-11，均「不支持」，对方附了代码
  证据：McpExecutor/ModelInvoker 无确认环节、serverConfig 静态共用、ak-Key →
  单一 userId）——与 13.6 的预期完全一致，proposal-first 与 read-only 工具面
  的收口维持不变**；功能请求整理成 `智能体平台-MCP支持需求.md`（需求 A
  elicitation 转述 / 需求 B 会话级凭据三档方案），待 agent-vendor 排期——A 落地才
  开放 delete 类工具，B 落地才把「确认应用」留在会话内。

#### 13.4.3 P9-3 实现状态（2026-09-11）

- **后端 `routes/assistantProviders.ts`（全部 `requireSystemAdmin`，系统级）**，九条：
  类型目录 `GET /system/assistant/provider-types`（注册表驱动——`lib/assistant/index.ts`
  新增 `listAssistantTypes()`，第二个 adapter 落地即自动出现）/ 列表（Key 只回
  「已配置」；会话计数用**标量子查询**随行带出——删除确认的影响面读数，不另开
  usage 路由）/ 创建（type 必须在注册表内；能力面建行时照抄 type 预设）/ PATCH
  （**Key 三态补丁**照 notification_channels：缺省不动 / null 清除 / 字符串设置；
  type 建后不可改——400 显式拒绝，删了重建比就地改型诚实）/ DELETE（无 409/force：
  会话映射级联是 13.1 的设计而非需要拦截的引用；影响面由列表计数在确认框说清）/
  set-default（事务内先摘旧默认再戴新帽——「默认唯一」没有部分唯一索引，由路由保；
  停用行也允许设默认，那正是边界 15 的姿态）/ import（apiKey 字段出现即 400——
  明文 Key 不该在任何文件里旅行）/ export（下载件非信封，specCases 导出同款；
  永不带 apiKey，也不带 enabled/is_default 运行态）/ test（**测试连接**：建会话 →
  发 `ping` → 归一事件 SSE 回显，与发消息路由同一条 adapter 链路同一种两段式
  + 15s 注释行保活 + reply.raw 断开检测；测试会话不落映射表；停用/未配 Key 的
  草稿行允许测——指向性报错正是测试要回显的东西）。
- **能力面收窄校验**（边界 13）：行是 type 预设的**子集**——PATCH/导入可把 true 收成
  false、可恢复到预设上限，不能扩宽超过预设；未知 key 拒绝。重名走资源级 2003 预检
  （lower 比对，dataSources 同款）+ 23505 兜底。
- **审计**（`lib/audit.ts` 四动作）：assistant_provider.create / .update / .delete /
  .set_default——detail 只带 name/type 与变更摘要（Key 只记 set/cleared，明文绝不进）；
  导入复用 create 动作带 `imported: true`。
- **`assistant_enabled` 闸门收口**：`GET/PUT /projects/:id/settings` 挂上
  assistantEnabled（无行 = false + PUT COALESCE 保留，mcpEnabled 同款三处纪律）。
- **前端 provider 面板**（`AssistantProvidersPanel.tsx`，系统管理第五个 tab「助手
  provider」，排在 Runner 之后——同是「平台依赖的外部系统」）：类型选择（注册表
  驱动）+ 按 type 渲染参数表单（v1 已知 `agent-vendor` 两字段 baseUrl/agentId；未知类型退
  JSON 文本域，第二个 adapter 落地前端没跟上时配置仍可读写不挡路）+ Key 三态输入
  （留空不动 + 「清除已保存的 Key」勾选）+ 能力面复选框（预设没有的灰掉不可勾）+
  测试连接弹窗（归一事件实时回显：» 文字增量 / ⟐ 工具调用 / ✓✗ 终态；停止只砍流
  不关弹窗，已收到的回显还有用）+ JSON 导入弹窗（粘贴式）+ 导出（blob 落盘，文件名
  白名单化）+ 默认切换 + 启停；**无默认 provider 引导**：面板顶部在有行却无启用默认
  时给一行警告（系统侧落点）。
- **前端项目侧（本批的落点决策）**：计划未给 `assistant_enabled` 指定页面归宿（13.3
  只列了抽屉与 provider 面板，而抽屉是 P9-4）——本批新增**项目配置组「站内助手」页**
  （`/projects/:projectId/assistant`，`AssistantPage.tsx`）：开关（canManage 同
  McpPage 头部位置）+ 服务状态探测（`probeAssistantAvailability` 读助手路由组自己的
  闸门语义：200=就绪 / 503+2005=未配置 / 404=未开）+ **未配置引导双读者两答案**
  （系统管理员给「前往系统管理」直达按钮，其他管理员被告知找谁——边界 15 的项目侧
  落点）。P9-4 抽屉落地后本页继续作为开关与状态页（抽屉是对话入口不是配置面）。
  `projectStore` 挂 assistantEnabled（settings 回写收口成 `applySettings` 单函数）。
- **e2e 种子退休**：`setup/seed_assistant.py` 的职责（直插 provider + SQL 开关）由
  本批的管理面接管——联调改走系统管理页表单（或直接用 CRUD API）；stg 的 provider
  行已存在，无需迁移。
- **验证**：前后端 `pnpm check` 通过；服务重启与门槛 11/12（导入 JSON→补 Key→测试
  连接、Key 全链路不可见）的实测按 AGENTS.md 留给用户。零新迁移（057 已立全部结构）。

#### 13.4.4 P9-4 实现状态（2026-09-14）

- **后端小改（会话行带能力面）**：`mapAssistantConversation` 挂 `providerCapabilities`
  ——列表查询 INNER JOIN provider 带出 `capabilities AS provider_capabilities`（FK +
  级联删保证行不悬空），创建路由在调用点补（建会话时 provider 就在手上，省一次回读）；
  缺席一律按 false 收（`providers.ts` readCapabilities 同款纪律——宁隐藏不错显示）。
  抽屉的停止按钮显隐（门槛 13）与历史加载判定都读它，不问系统管理面（那是仅系统
  管理员的）。零新迁移。
- **前端 `AssistantDock.tsx`**（挂 ProjectShell，项目级常驻入口；fixed 定位不占排版）：
  - **圆钮**：右下角 44px；项目开关关掉或探测回「已关」（竞态）时整个不渲染（服务端
    真不服务，不是藏前端入口）；无启用的默认 provider 时 dashed 降级态 + 点开抽屉给
    引导（边界 15 的抽屉落点：系统管理员直达 /system，其他成员被告知找谁——与
    AssistantPage 同一组文案）。头像 32px（圆钮）/ 96px（抽屉头）两档是 P9-6 的挂点
    （`AssistantAvatar` 占位组件，换芯不动壳）。
  - **420px 抽屉**：行为归 antd Drawer（焦点陷阱 / ESC / mask 点击关闭——Quiet Console
    的 antd 边界），外观归 `design-system.css` 新增 P9-4 段（≤520px 吃满整宽）。会话
    切换 Select 读映射表（topic 上游还没写的口子恒空，退「MM-DD HH:mm」时间标签；
    粘性选择但重开时验真——被删会话回落最近活跃一条，不给 antd Select 喂裸 UUID）。
  - **消息流**：**按会话分桶**（`threads[conversationId]`——切走再切回不丢内容；流式
    回合写自己的桶，中途切走互不干扰）+ pre-wrap 纯文本（8.13 边界 19，不引渲染器；
    `apitest-proposal` 围栏本批原样显示，预览卡 P9-5）+ 工具行 `⟐ name · status`
    （与 provider 测试回显同一套图标语汇，门槛 3）+ 错误气泡（fail 语义色——上游报错
    是失败不是装饰）+ 等待首 token 的呼吸点（busy 家族，在飞请求的唯一环境动画）。
    跟随滚动带粘性：上翻历史不拽底，回到底部自动恢复。
  - **流式**：`streamAssistantMessage`（api.ts，与测试连接共用抽出的 `consumeAssistantSse`
    手写解析——帧按空行切、长 JSON 防拦腰截断；hijack 前的干净 JSON 错误翻译成 error
    终态事件，调用方只认 done/error）。事件落块：token 追加进最后一个文本块（工具行
    隔断时另起一块）、tool 独立成块、done 的 `fullText` 权威替换累计值（拼接漂移不
    留气泡）、error 收尾落错误气泡；流断无终态帧补「连接中断」气泡（不让「正在思考」
    悬空——adapter 契约之外的第二道兜底）。发送 Enter / Shift+Enter 换行（IME 组合态
    防误发）；没有会话时直接输入 = 隐式建会话（chip 的「新会话」是显式入口，两条路
    同一张映射表）。
  - **历史回放**（边界 2 的读侧）：切会话 / 重开抽屉整桶替换（上游是权威——别处 /
    别的设备聊过的内容在这里自愈）；正在流式的会话跳过（回放会冲掉在飞回合）；
    能力面没开 history 标记不可用（提示行 + 保留本次打开后的本地消息），不撞 400；
    失败给重试。
  - **停止**：按钮跟着**在飞的回合**（`streamingId`，不是当前显示的会话——中途切走
    也不停错地方）且按能力面显隐（门槛 13，无 stop 能力的 provider 只有发送置灰）；
    只调上游 stop 路由不本地断流——半截回复留在气泡里比悄悄消失诚实。
  - **快捷 chips 四枚**（边界 6，输入区上方常驻）：新会话（项目写，viewer 不渲染）；
    设置 / 改密码 / 登出本批先导航既有页面（/system、/change-password、Modal.confirm
    + logout）——**卡片形态（抽屉内改 preferences、受控改密表单卡）P9-5 落地**，行为
    已有、形态后补；导航走 navGuard confirmLeave。viewer 的输入区不渲染、给只读提示
    （「只藏入口不做禁用态」纪律，后端守卫仍是单一事实）。
  - i18n 双语 `assistantDrawer.*`（26 键）；未配置引导复用 `assistant.*` 既有键。
- **验证**：前后端 `pnpm check` 通过（2026-09-14 报错修复时补跑）；服务重启与实测按
  AGENTS.md 留给用户。
- **2026-09-14 同日修订（用户四条反馈，13.0 修订块的落地部分）**：
  - **助手默认开启**：迁移 **058** DROP `project_settings.assistant_enabled`；
    `routes/assistant.ts` 五处项目闸门全摘（`assistantEnabled()` 辅助函数删除）、
    `projects.ts` settings GET/PUT 摘字段（COALESCE 参数从 $5 收回 $4）、前端
    `AssistantPage` + 路由 + 导航项 + `projectStore.assistantEnabled` /
    `updateAssistantEnabled` 全链路摘除，i18n 只留抽屉引导仍用的四个键
    （stateUnconfigured / unconfiguredAdminHint / unconfiguredMemberHint /
    goProviders）。抽屉圆钮对全体项目成员常驻，无配置步骤。
  - **会话 topic 自动标题**：消息路由的 fire-and-forget bump 扩成
    `topic = CASE WHEN topic = '' THEN $2 ELSE topic END`（首条消息折叠空白、
    30 字符 + 省略号）；抽屉在首条消息的流结束后拉一次列表换掉时间戳标签。
    e2e 新增「首条消息自动生成会话标题」用例（轮询等 fire-and-forget 落地），
    删除「闸门 404」用例（门槛作废），seed 脚本不再碰 project_settings。
    〔**2026-09-16 用户决策：会话相关的 e2e 用例全部删除**
    （`apitest-e2e-python/test_case/assistant/` 整目录移除；`data/config.py` 的
    `assistant_project_name`、seed 脚本尾行提示同步清理）：① 会话用例每跑一次就在真实
    上游上建会话、发消息，留下一堆脏数据；② 「发消息读 SSE 到底」要读真实上游收尾，
    而服务端每 15s 发 SSE 注释保活（`routes/assistant.ts` 的 `HEARTBEAT_MS`），客户端
    读超时永不触发——上游卡在「有数据但不给结果」时整条流一直挂着，把 runner 作业拖到
    时限（`timed_out` + 报告解析跳过），一次上游抖动吃掉整包。助手与上游异常改为手工
    验证：浏览器抽屉观察 + `drill/` 假上游演练（README 已改口径）。〕
  - 用户级凭据与上游通用化当天在 **P9-4b** 落地（用户第二轮反馈：「设置该是用户
    视角、上游要通用模式」），见 13.4.5。

#### 13.4.5 P9-4b 实现状态（2026-09-14，用户第二轮反馈：用户视角的设置 + 通用上游）

- **模型**：provider 行 = **通用协议模板**（`protocol` JSONB：4 接口 + SSE 事件映射
  + 认证模板 + 业务码判定；`user_params` JSONB：用户参数模式）；凭据 = **用户级**
  （`assistant_user_agents`：params 明文 + secrets 密文，(user, provider) 唯一）。
  系统共享 Key 彻底作废（不留兜底）。迁移 **059**：新表 + provider 列改造，存量
  agent-vendor 行原地翻译成标准协议配置（baseUrl 从原 config 继承）；P11 顺延 060。
- **引擎**（`lib/assistant/engine.ts`，取代 agent-vendor adapter + 注册表）：模板渲染
  （`{{user.x}}` / `{{conversationId}}` / `{{message}}` / `{{index}}` / `{{limit}}`；
  值整体是占位符且渲染为数字时按数字进 JSON——agent-vendor Long 型 id 兼容）+ 点路径取值
  + SSE 映射翻译（token/tool/done/error + ignore 列表；done 带 success 标记且为
  false 时按错误终态）+ 两段式流（响应头 OK 才 resolve，此前抛错让路由回干净
  JSON）。终态纪律与原 adapter 同款。
- **路由**：
  - `routes/assistant.ts`——闸门语义变为「用户没配默认 agent」→ 503/2005（抽屉
    引导进设置卡）；会话收发按「会话行 provider_id × 该用户在此 provider 上的
    agent」解析（换默认后旧会话照常）；能力面从协议形状派生（stop/history 端点
    有定义 = 有能力）。
  - `routes/assistantProviders.ts`——CRUD 换 protocol + userParams（浅校验：baseUrl
    http(s)、必备端点、SSE 事件字段；深对错归测试连接）；测试连接 body 带临时
    参数（不落库）；导入/导出 {name, protocol, userParams}；类型目录路由删除。
  - `routes/assistantUser.ts`（新，`currentUser` 守卫）——上游目录 / 我的 agent
    （secret 只回键名）/ PUT（params 整份替换 + secrets 三态补丁，必填按
    params ∪ 保留 secrets 验，第一个 agent 自动戴默认帽）/ set-default / test
    （用已存参数走真链路，回 JSON 摘要）。
- **前端**：
  - 系统管理 provider 面板：**页内引导式编辑器**（2026-09-14 第三轮反馈——弹窗表单
    既看不全也没法对照，且字段不自明）：列表 ↔ 编辑 ↔ 测试三个页内视图（零弹窗，
    仅 JSON 导入保留小弹窗）；编辑器按**调用链顺序**分六步——基础连接（含模板变量
    总说明：引擎内置 {{message}}/{{conversationId}}/{{index}}/{{limit}} vs
    {{user.键名}}）→ ① 建会话（前置）→ ② 发消息（核心，含 SSE 事件映射）→
    ③ 停止（后置·可选）→ ④ 历史（后置·可选）→ 用户参数；每步带前置/后置说明，
    每个字段带「值从哪来、填错了会怎样」的一行 hint；必备项缺失时保存跳到对应
    步骤；测试视图先收临时参数（不落库）再回显归一事件；
  - 抽屉「设置」chip → **我的 agent 配置卡**（抽屉内视图切换，不跳系统管理）：
    选上游 → 按参数模式渲染表单（secret 三态：留空保持 / 填值覆盖 / 勾选清除）
    → 保存 / 设为默认 / 测试（结果内联回显）；保存后重探闸门；
  - 未配置引导两味：平台无上游 → 找系统管理员；有上游没配 → 「配置我的 agent」
    按钮直接进设置卡。
- **e2e**：seed 直插通用协议 provider 行 + 经 API 为种子管理员配用户 agent（不再
  借 server 的 crypto.ts 本地加密）；用例断言不变（协议不变量天然与引擎解耦）。
- **空库默认上游种子（2026-09-17 增补，用户要求）**：`seedAssistantProvider()`（照
  `seedAdmin()` 先例在启动时跑一次）按名字幂等插入 `agent-vendor-agent`（固定名，agent-vendor 通用
  协议 + `user_params`）；`assistant_providers` 原本为空时它同时是默认行，已有库则只补
  一行、不抢默认位、不覆盖任何已有配置。baseUrl 从 **`agent-vendor_BASE_URL`** 读（内网地址
  不入库），未配置则整体跳过。这样空库开箱不必等管理员手配即可到「配置我的 agent」
  这一步。
  同批修一条守卫缺陷（见 `issue_fix/问题记录-助手未配置空体两缺陷.md`）：
  `loadResolvedDefaultAgent` 的「没有默认 agent」腿原先只 `return undefined` 没回响应，
  Fastify 以 200 空体收场——前端把空体当数据（会话列表报错、建会话白屏）。补齐
  503/2005 `fail` 后，未配置一律走 13.0 边界 15 的「未配置」引导，不是错误。
- **验证**：前后端 `pnpm check` 通过；服务重启与实测按 AGENTS.md 留给用户。
  手工验收链路：系统管理建 provider（或用存量翻译行）→ 抽屉圆钮 → 设置卡配
  agentId/apiKey → 测试 → 保存（自动默认）→ 对话流式 → 切换上游再配一份 →
  换默认后旧会话仍可收发。
- **挂账**：mcpToken 已存不用（等 13.6 L3 的 MCP 身份绑定消费）；配置卡的完整
  形态（个人信息页 agent 凭据 tab）在 P12。

#### 13.4.6 P9-4c 实现状态（2026-09-15，用户确认范围：聊天 Markdown + 页面上下文）

- **后端（`lib/assistant/context.ts` 新文件 + `routes/assistant.ts` 两处）**：
  - `normalizePageContext`：顶层键白名单（page/route/entities/focus/filters/
    selection）+ 值浅校验（标量、单值 256 字符、selection ≤50 条）；坏形状整体
    降级为不注入（宁缺毋滥，不配 400）。尺寸预算 2048 字符：超标先丢 selection
    再丢 filters，仍超则不注入。
  - `composeForwardedMessage`：紧凑 JSON 封 ` ```apitest-page-context ` 围栏、
    前缀拼进转发 message——**协议配置零改动**（`{{message}}` 渲染拼好的全文）；
    topic 生成仍用原文（fire-and-forget 读 body.message，不受拼接影响）。
  - 历史代理：`stripContextPrefix` 剥掉每行开头的围栏——气泡永远只显示用户打的
    字（live 气泡本来就没有前缀，这里管上游回放；本批之前的旧消息无围栏，no-op）。
- **前端采集（`stores/pageContextStore.ts` + `hooks/usePageContext.ts` 新文件）**：
  - store 持 `PageContext`（page/entities/focus/filters/selection——只放标识符与
    面包屑，**secret 值绝不进**）；hook 内容序列化后才进 effect 依赖（组件每轮
    渲染都是新对象，拿引用当依赖会把 store 刷成高频写），挂载写入、卸载清空。
  - **route 不由页面填**：抽屉发送时从 `useLocation` 合成（单一事实源）；未注册
    页面也带 route——路径里的实体 id 仍在。
  - **13 处页面注册**（URL 是底座，注册只补不在 URL 里的组件态）：EndpointWorkspace
    （activeCase + sideTab + 最近执行）、EndpointList（勾选集）、FlowWorkspace
    （打开的节点，树查找含循环框内）、SuiteWorkspace（最近报告）、ExecutionRecords
    （筛选 + 抽屉中的执行）、SuiteReportPage（报告名/套件名——分享页不注册）、
    CiTaskEditor（任务名）、PipelineRunPage（任务语境 + 当前 tab）、RepoCaseTree
    （抽屉目标 + case_key 勾选）、IngestUnmatched（登记中的路径）、Environments
    （抽屉编辑中的环境）、SpecCases（editing + 勾选）、Alerts（编辑中的规则）。
    C 类弱实体页（趋势/成员/MCP/Mock/数据源/测试计划等）不注册，route 自带 id。
- **前端透明与注入（`AssistantDock.tsx`）**：输入区上方上下文 chip——MapPin +
    「上下文」+ mono 面包屑摘要（method+url 优先，实体名/焦点次之），点开看全量
    JSON，「本条不带」一次性开关（发送后复位，is-off 划线不消失）；发送时
    `sentContext` 随 body.context 上送。viewer 不能发送，chip 不渲染。
- **Markdown 渲染（`AssistantMarkdown.tsx` 新组件 + `design-system.css` P9-4 段）**：
  `react-markdown` + `remark-gfm`（仅此两个新依赖）；默认不吃原始 HTML（XSS 面
  为零）、链接强制外开、不引语法高亮。只渲染 assistant 文本块；用户气泡/错误
  气泡/工具行维持纯文本；`.assistant-md` 收回容器的 pre-wrap（markdown 自己管
  换行），代码块/表格用既有 token（raised 底、mono、横向滚动、限高）。流式期间
  半张表格容忍渲染。`apitest-proposal` 围栏按代码块渲染，P9-5 预览卡扫描不受
  影响。**8.13 边界 19 的聊天场景改写就此记档**（报告页维持原边界）。
- **i18n**：`assistantDrawer.context / contextOff / contextSkipped` 双语三键。
- **2026-09-15 同日反馈（抽屉太小）**：420px 固定宽改**默认占视口 70%**（封顶
  1440——大屏聊天正文行宽不无限拉长）+ **左缘拖拽条**可调 420–1600（pointer
  capture，拖过即存 `localStorage.apitest.assistantWidth`，双击条清偏好回默认；
  拖拽中掐掉 antd 宽度过渡）；设置卡收窄 640 居中（聊天要宽——表格/代码，配置
  表单不要）；窄屏 ≤520px 吃满整宽的既有规则不变（100vw !important 压过内联宽）。
- **2026-09-15 二次反馈（主题/语言外置）**：抽屉头右缘加主题/语言快捷切换钮
  （图标跟当前主题三态走 Sun/SunMoon/Moon；Languages 切中英）——落库走
  `applyPreference` 同一条路（本地指令 / 快捷钮两个入口一套持久化，不长第二
  套）；prefs 未加载置灰。**设置卡内的「个性化」区随之删除**（用户二次确认：
  外置后不放第二份入口）——设置卡只剩「我的 agent」，孤儿样式
  （`.assistant-prefs*` / `.assistant-settings-divider`）与 i18n 键
  （`preferences` / `prefsHint`）一并清理。外置首版有缺陷（prefs 取数效应还
  挂在已删分区的 `view === "settings"` 条件上，直接进对话视图时快捷钮永远
  置灰）——同日实测抓到即修，记 `issue_fix/问题记录-助手头部快捷钮不可点.md`。
- **验证**：按 AGENTS.md 留给用户——前后端 `pnpm check`、服务重启与手工链路
  （接口工作台说「改一下当前接口的断言」→ 上游收到的 message 前缀带
  endpointId/caseId 围栏；历史回放不见围栏；回复含表格/代码块的排版；「本条
  不带」开关后上游收不到围栏）。

#### 13.4.7 P9-5 实现状态（2026-09-15，本地指令表 + 账号指令卡 + 拦截 + proposal 预览卡）

- **零后端改动、零迁移**：proposal 应用走既有 REST（`GET/PATCH cases`）+ 本人
  JWT，账号操作走既有 `POST /auth/change-password` / `PUT /system/preferences`——
  proposal-first（边界 3）与「零新增写库路径」按原案兑现。
- **本地指令表**（`lib/assistantCommands.ts` 新文件，纯函数）：`/主题` `/语言`
  `/打开` `/项目` `/设置` `/改密码` `/登出` `/帮助` 八条，中英双语名，**前缀
  匹配**（`/主` 命中 `/主题`；`/p` 同时是 project/password 前缀 → 歧义回执列
  候选，不猜）；`/打开` 目标页 = 项目层 14 页 + 全局 4 页，别名双语（精确 →
  前缀两级匹配，多命中交回候选）；`/` 单字符视为 `/帮助`（新用户的第一个 `/`
  应该看到指令表）。未命中的 `/` 开头输入按自然语言直发上游（回车直发兜底）。
  执行归 AssistantDock（指令表是数据，副作用归调用方）。
- **主题桥**（`theme.ts`）：`requestThemePreference(value)` 派发自定义事件，
  `useMode()` 监听后走自己的 `setPreference`——单一持有者不动（Quiet Console
  规则），事件只是又一个输入源；服务端偏好同步落 `PUT /system/preferences`
  （与系统管理页同一份，两边互改互见）。
- **账号指令卡的卡片形态**（P9-4 悬置项兑现）：改密 chip / `/改密码` → 抽屉内
  **受控表单卡**（当前密码 + 新密码 ×2 → 既有改密接口，`renewSession` 续命，
  pwd_epoch / 审计语义与页面改密一致；不再跳 `/change-password` 页）；`/设置` →
  设置卡顶部新增**个性化分区**（主题 / 语言两枚 Select 直接改写 preferences，
  分隔线下仍是 P9-4b 的我的 agent 配置）；`/登出` 维持确认卡（Modal.confirm +
  前端清 token，零新路由）。
- **敏感意图拦截**（边界 6/14）：非指令消息含账号词（密码 / 口令 / password /
  登出 / 注销 / logout / sign out 等）即本地拦截、**不转发上游**——三档：明确
  改密意图（动宾正则，中英）→ 拦截 + 自动开改密卡；明确登出意图 → 拦截 + 弹
  确认卡；仅含账号词 → 拦截 + 指引回执（提示改措辞可继续与 AI 聊其他内容）。
  被拦截的用户气泡只在本地显示（上游历史里永远没有这条，回放后消失 = 「没
  发过」的如实呈现）。
- **系统气泡**：`ChatEntry` 增 `system` 角色（dashed 边 + 降一档墨色，与用户/
  助手气泡拉开）承载指令回执 / 拦截提示 / 改密完成；只活在显示态，不建会话、
  不碰上游。无会话时落 `__local__` 本地桶（指令在没建会话时也要有地方回话）。
  `applyEvent` 改为「找最后一个 streaming 的助手条目」落块——流式中跑本地指令
  不再打断 token 落块（门槛 5 的加强：本地通道连流式中都可用）。
- **proposal 预览卡**（`AssistantProposalCard.tsx` 新组件 + `splitProposalSegments`）：
  assistant 文本块按**完整** `apitest-proposal` 围栏切段——围栏外仍是 markdown
  （P9-4c-2 渲染器不动），围栏内解析成卡；未闭合围栏（流式到一半）按代码块
  渲染，token 到齐自然收敛成卡；坏 JSON / 未知 kind 不成卡、按代码块如实显示
  （13.6 第一版只 `response_script` 一种 kind，枚举外不应用——前向兼容）。
  卡片：kind 标签 + 目标用例名（`api.case` 实时拉取，缺失时如实报「不存在或
  已删除」且不可应用）+ 草稿正文（mono 限高滚动）+ 差异摘要（现有 N 枚 /
  应用后追加为第 N+1 枚）+ 确认应用 / 放弃。**应用 = 重读用例最新
  responseScripts → 追加一枚启用的新脚本（`name` 取草稿缺省 assistant-draft）
  → 整份 PATCH**——追加而非替换（非破坏：既有脚本原样保留，接口工作台还能
  删）；重读避免把别处刚保存的脚本冲掉。终态（applied/dismissed）按草稿内容
  键（caseId+script 短哈希）存 dock 级 Map，流式重渲染不丢；历史回放换桶后
  自然复位。viewer 卡片只读不给按钮（「只藏入口不做禁用态」纪律，后端守卫
  仍是单一事实）。
- **i18n**：`assistantCmd.*`（24 键：帮助列表 / 歧义 / 用法 / 回执 / 三档拦截
  文案）+ `assistantPassword.*`（3 键）+ `assistantProposal.*`（11 键）+
  设置卡 2 键 + 空态指令提示 1 键，双语；指令回执用 `i18n.t` 而非渲染闭包的
  `t`——`/语言 en` 切换后回执要用新语言写。
- **验证**：按 AGENTS.md 留给用户——`cd apitest-web && pnpm check`、服务重启与
  手工链路（`/帮助` 列表 → `/主题 深色` 全局换肤 → `/打开 接口管理` 跳页 →
  输入「帮我改密码」被拦截并开卡 → 改密后本会话续命；让 agent 产出
  `apitest-proposal` 围栏草稿 → 卡片确认应用 → 用例 responseScripts 追加一枚、
  审计 created_by 是本人；viewer 打开同一会话卡片只读）。

##### 13.4.7.1 MRTR 删除确认表单卡（2026-09-15 增补，验收驱动）

用户实测「让 agent 删环境」暴露：/mcp 的 MRTR 闸门与上游转述都正常，但确认请求
（agent-vendor 以 `MESSAGE + data.type=ELICITATION + elicitationSchema` 混进聊天流）被
引擎 token 映射当普通文字吞掉——表单结构整个丢弃，抽屉里没有任何确认入口。缺陷
细节与上游 resume 通道（`/api/v1/chat/resume-elicitation`）对 API-Key 会话稳定
5000 的复现证据见 `issue_fix/问题记录-助手MRTR删除确认被当文字吞掉.md`。落地：

- 协议映射新增 `sse.elicit`（与 token 同 kind、判别字段分流）与 `sse.tool.input`
  （确认卡拿删除目标），迁移 060 给 agent-vendor 方言协议补齐；归一事件新增
  `{type:"elicit", text, tool, input, schema}`（后端 `lib/assistant`，前端同形）。
- 前端 `AssistantElicitationCard`：MRTR 确认请求渲染成**表单**——文案 + 后果 +
  「确认删除 / 放弃」；确认动作走**本人 JWT 的既有 REST**（`GET usage` 两段式，
  与环境页同款删除语义），v1 工具枚举只 `delete_environment`，未知工具只读引导。
- provider 编辑面板 `buildInput` 以原协议为底保留表单未管理的键——管理员改配置
  不再把 elicit / tool.input 悄悄剥掉。
- 上游第三方 resume 通道修复后，确认动作可切回 MCP 往返（枚举映射的形状已留好）。
- **两轮后补（同日用户实测）**：① 确认记录平台侧持久化——`elicit_log` jsonb
  （迁移 061）+ `POST …/conversations/:id/elicit` 记录接口 + 历史代理按时间戳并回
  system 行（前端 i18n 渲染），回放后确认记录仍在；② agent 回复里 agent-vendor 的
  `<markdown-custom-process>` 过程标记在 `AssistantMarkdown` 渲染层剥离（工具状态
  我们已有工具行呈现，标记是重复噪音；只剥该已知标记不泛化清洗）。
- **2026-10-21 撤销（用户决策）**：`/mcp` 的 MRTR 闸门整体移除，`delete_*` 改为一次
  调用即执行、由客户端按 `tools/list` 的 `destructiveHint: true` 在调用前向人确认
  （见 `DEVELOPMENT_PLAN.md` 9.4.1）。因此前端不再会收到 `elicit` 事件：
  `AssistantElicitationCard` 与 `sse.elicit` 映射成为**死路径**，保留只为回放历史
  会话里已存的 elicit 行；不要再为它新增工具枚举。

#### 13.4.8 P9-6 实现状态（2026-09-16，人物生成器）

- **零迁移、后端仅类型**：preferences 是 jsonb 直通合并，`system.ts` 的
  Preferences 类型补 `avatarSeed?: string` / `avatarNightmare?: boolean` 两个
  可选键即全部后端改动（PUT 不逐键校验——与 theme/language 同款信任边界，
  前端读写侧自防护：非字符串/空白种子按无覆盖处理）。
- **`lib/avatar.ts`（新文件，纯函数）**：移植 `hand-drawn-character-creator.html`
  76–584 行——seeded random（hashSeed + mulberry32）、铅笔笔刷（多遍抖动折线 /
  椭圆 / blob 填充 / 排线）、调色板、物种表、五官绘制（眼/嘴/鼻/发/耳/头/躯干/
  手臂/腿/地面）照搬；three.js 部分（588 行起）不搬——部件不再各自成纹理贴 3D
  平面，而是按原版世界坐标与 z 序（地面 < 腿 < 躯干 < 手臂 < 头 < 耳 < 眼 <
  鼻 < 嘴 < 发）以缩放变换直接落笔到单张 2D canvas，笔画按最终分辨率光栅化
  （不经过纹理降采样，小尺寸反而更清晰）。
- **取景两档**：`framing: "bust"`（半身：头+耳+发+肩口）给顶栏入口 30px（改位
  前是 32px 圆钮）——全身在这个尺寸只剩斑点；`"full"`（全身站姿+地面线）给
  抽屉头 96px。头像自带奶油纸底不随主题：深墨线在深色页底上会消失，纸底让
  两种模式都成立（贴纸观感有意为之）。
- **确定性**：五官滚动一条 rng 流（同种子同人物）；描边抖动按部件独立成流
  （`seed:part`，原版共享一条流——增删部件会整张脸重新洗牌），眼睛例外——每次
  眨眼换流（`seed:eyes:N`，boiling line）。小尺寸给笔画设 ≥1.1 设备像素下限
  （32px 档 w=5 铅笔线自然渲染只剩 ~1 设备像素，等于发丝）。
- **`components/Avatar.tsx`（React 封装）**：canvas（dpr 封顶 2）+ 眨眼时钟
  （1.6–6.2s 睁 → 110–180ms 闭）。**眨眼是唯一动画**（边界 5：原版的转头/
  跳跃/庆祝/表情切换不搬），`animate` 由调用方控制，`prefers-reduced-motion`
  永远静止，`animate` 关闭立即停在睁眼帧。
- **挂点换芯**（AssistantDock）：入口 30px 半身（2026-09-16 第二轮反馈后位于
 **顶栏原铃铛位**，portal 进两壳 topbar 的槽位）/ 抽屉头 96px full
  （`animate={open && !streaming}`——眨眼只在抽屉打开且无在飞请求时运行，
  Quiet Console 单环境动画约束，与在飞呼吸点不同时出现）；「换一个形象」=
  抽屉头快捷钮（Dices，与主题/语言同一排）写一个新 `preferences.avatarSeed`
  （randomUUID），两档同步换。种子解析：avatarSeed（非空字符串才算）>
  `users.id` > 兜底。preferences 取数维持「抽屉打开时拉一次」的既有决策
  （不为头像把请求提前到 mount）——首次打开前入口用 users.id 兜底画像。
- **nightmare 默认移出**（边界 5）：滚动概率 0（`avatarNightmare === true` 时
  恢复 12%），物种代码与暗色调色板全保留；开关藏在 preferences 无界面入口，
  后续要暴露就是一行 SettingRow 的事。
- **i18n**：`assistantDrawer.rerollAvatar`（换一个形象 / New look）1 键。
- **验证**：按 AGENTS.md 留给用户——`cd apitest-web && pnpm check`，服务重启与
  手工链路（同一账号重登头像不变、两个账号头像不同 → 抽屉头 96px 全身像偶尔
  眨眼、发消息时眨眼停 → 点「换一个形象」两档同时换 → 深色模式下
  头像仍是纸底贴纸 → reduced-motion 下不眨眼）。

#### 13.4.9 2026-09-16 增补（用户反馈驱动）：人物反应 + 通知入口移入助手 + 对话用户级化

四轮用户定位修订，同日落齐（`pnpm check` 前后端双过；迁移 062 待 `./start.sh`
应用——会话表去 project_id 后新 INSERT 才能落行，存量会话行随列删除一并清理）：

- **人物反应**（13.4.8「动画只留眨眼」按用户要求放宽为「眨眼 + 状态反应」）：
  `lib/avatar.ts` 增 `gaze`（瞳孔视线）/ `pose`（cheer 举手，drawArmUp 随本轮补
  移植）/ `jump`（跳跃弧线）/ `mouth`（表情覆盖，不在物种嘴型池的值忽略——猫
  不张嘴、nightmare 不微笑）；`Avatar` 增 `mood`（持续基线：流式中 = thinking
  「想」的视线）与 `pulse`（一次性反应，nonce 触发）。反应是**同一张脸上的
  表演**——不动物种与配色；全部是状态变化驱动的离散动画（greet 开抽屉 / sent
  发消息低头看 / done 欢呼跳 / error 抿嘴委屈 / bounce 入口小跳），眨眼仍是
  唯一的 idle 循环且只在 idle 心情跑。reduced-motion：眨眼与跳跃停、表情保留
  （表情是状态不是动效）。
- **通知入口移入助手 + 助手入口改位顶栏**（13.0 边界 10 修订；同日第二轮用户
  反馈：助手不放右下角，放原铃铛位）：**顶栏铃铛撤掉，助手入口头像按钮 portal
  进两个壳 topbar-actions 的 `#assistant-topbar-slot`**（壳互斥渲染、槽位唯一；
  组件本体仍在 DockedShell 单挂载——切壳不断流；`.assistant-entry` 34px 圆面
  装 30px 半身头像，空槽 `:empty` 不占宽）。通知常驻入口 = 顶栏助手钮的未读
  徽标（99+ 封顶）+ 抽屉头 Bell 钮（未读小圆点，active 态）+ 抽屉「最近通知」
  视图（最近 10 条，行样式复用 bell-item 家族；点行 = 标已读 + 深链
  confirmLeave、全部已读就地清、「查看全部」进 /notifications 整页——整页与
  antd 弹窗、Root 轮询照旧）。BellMenu 组件删除；新通知到达（未读数上升，非
  首轮存量）入口按钮小跳一下。〔P12-2 后「查看全部」改指 `/me/notifications`
  ——通知页成为个人中心的 tab，见 18.5；本段描述的是 P9 当期的形态。〕
- **对话用户级化**（会话是「人」的，不挂项目——2026-09-16 用户定位修订）：
  迁移 062 删 `assistant_conversations.project_id`；路由组搬出项目段
  `/api/v1/assistant/conversations*`（currentUser 守卫，登录即用，viewer 只读
  概念随项目闸门一并消失）；前端挂点从 ProjectShell 上移 main.tsx 的
  DockedShell（PasswordGate 内层——全局页与项目页同一份会话，切页面/切项目
  对话照旧、在飞流不断）。项目上下文按消息随发随带（P9-4c 围栏不变，全局页
  无 pageContext 时上下文 chip 不渲染）；项目资产卡（proposal / MRTR 确认）
  在无项目上下文时降级只读（`projectId` 可空 + outsideProject 文案，写资格 =
  在项目内 && 项目写角色）；`/打开` 项目页目标在全局页给回执、候选列表只报
  全局页。e2e assistant 模块同步去项目 fixture。
- **i18n**：`assistantCmd.openNeedsProject` / `projectNone`、
  `assistantProposal.outsideProject`、`assistantElicit.outsideProject` 4 组新键；
  `assistantDrawer.readonlyHint`（viewer 只读提示）随概念删除。
- **验证**：按 AGENTS.md 留给用户——迁移 062 + `./start.sh --restart api worker`
  后手工链路（看板页顶栏头像按钮开助手能聊、进项目聊的是同一份会话列表 →
  发消息头像低头看、流式中视线抬起、完成欢呼、错误委屈 → 开抽屉打招呼 →
  新通知到达入口按钮跳 + 徽标 → 抽屉内看最近通知、点行深链 → 顶栏不再有
  铃铛、原铃铛位是助手头像）。

##### 2026-09-22 增补：手臂姿态帧扩展（用户要求「给人物设计更多动作」）

在 13.4.9「人物反应」之上补 4 个手臂姿态帧（沿用同一约束：反应 = 同一张脸上的
表演，不动物种与配色；离散、状态变化驱动，reduced-motion 下位移停、姿态帧保留；
仅 `full` 取景有手臂，`bust` 圆钮无臂不受影响）：

- **`lib/avatar.ts`**：`AvatarPose` 由 `idle | cheer` 扩为
  `idle | cheer | wave | shrug | point | crossed`；新增 `drawArmWave` / `drawArmShrug`
  / `drawArmPoint` / `drawArmCrossed`（几何照搬既有 `drawArm` / `drawArmUp`）；手臂
  分派改 `ARM_POSES` 左右分侧表——对称姿态两侧同函数靠镜像成右臂，**wave / point
  单侧做动作、另一侧仍垂手**。
- **`Avatar.tsx`**：`AvatarPulseKind` 增 `wave` / `shrug` / `point`（均非跳跃，走
  保持计时）；`pose` 派生扩为「cheer > wave/shrug/point 一次性 > thinking=crossed
  持续 > idle」，并补 shrug 抿嘴+略低头、wave 微笑+平视、point 视线朝指向侧。
- **触发点（AssistantDock）**：合抽屉挥手告别（`wave`，Drawer 不销毁子树、滑出帧
  仍可见）/ 用户叫停生成摊手（`shrug`）/ 流式中抱臂等待（`crossed`，由 thinking
  心情自动带出，无新触发）。`point` 姿态与绘制就绪，暂未接事件——留待「助手抛出
  可操作项（如 MRTR 确认卡出现）时指一下」这类明确状态变化再接。
- **验证**：按 AGENTS.md 留给用户——`cd apitest-web && pnpm check`，服务重启后手工
  看抽屉头 96px：开/合抽屉挥手、发消息→流式抱臂、按停止摊手；reduced-motion 下
  只落姿态帧不位移。

##### 2026-09-22 再增补：流式踱步 walk（用户明确放宽 Quiet Console 规则 4）

用户要求「消息发送时抱臂 + 走路」。抱臂已由 thinking 心情带出（发消息即流式→抱臂）；
走路是**循环动画**，与锁定契约的规则 4「全应用只允许一个环境动画」冲突。**用户明确
决定放宽规则 4**：从「只允许 1 个」放宽为「允许 2 个，且都必须绑在流式状态、结束即停」
——新增的第二个 = 助手流式回复时原地踏步。已同步改 `quiet-console` skill 的规则 4
（附 2026-09-22 放宽说明）与 Banned 行。

- **`lib/avatar.ts`**：`AvatarOptions` 增 `walk`（相位 0..1 循环，调用方 rAF 驱动）；
  `drawLeg` 加 `swing ∈ [-1,1]`（膝/脚前后摆 + 抬脚，swing=0 退回直立腿）；两腿相位
  差半拍，`toX/toY` 叠加躯干左右微摆 `sway` 与每半拍一次的小起伏 `bob`。仅 `full`
  取景有腿。
- **`Avatar.tsx`**：新增 walk rAF 时钟，**只在 `mood==="thinking"` 且非 reduced-motion
  时跑**（~1s 一个步态循环），流式结束 mood 回 idle 即停在站立帧；与抱臂 pose 叠加
  = 「踱步思考」。reduced-motion 下不跑循环，只留站立 + 抱臂静态帧。
- **边界**：踱步只绑流式状态，和在飞呼吸点同时出现是这次放宽后允许的一对；不得再
  加第三个循环，也不得让任一循环脱离在飞请求常驻。
- **验证**：按 AGENTS.md 留给用户——`pnpm check` + 服务重启后看：发消息→抽屉头小人
  抱臂原地踏步、回复结束停下站直；reduced-motion 下只抱臂不迈腿。

#### 13.4.10 P9-8 实现状态（2026-09-16）上游异常演练

三类上游异常逐条落点（**不做脱敏**——上游自报的错误文案原样透出，那是上游说的话，
平台不替它改写）：

- **ERROR 事件（链路已有，本次只补码）**：上游 `ERROR` 事件与 `FINAL_RESULT
  success:false` 两条路都以错误终态收尾（`engine.ts` 的 done 映射判 success），
  文案原样、**不带码**。
- **限流**：引擎把 HTTP 失败包装成 `AssistantUpstreamError`（带 `status` +
  `Retry-After`；秒数与 HTTP-date 两种形态都归一，上限一小时）；`upstreamRateLimit()`
  **只认 429**（503 带 Retry-After 不并按限流——那是「服务不可用」，告诉用户「稍后
  重试」会把排查方向带偏）。新增错误码 **2007**（HTTP 429）+ `Retry-After` 如实
  转发；五个上游出口（新建会话 / 发消息 / 停止 / 历史 / 我的 agent 测试）统一走
  `failUpstream`，系统管理的测试连接对齐同一口径。前端：429 → 限流文案（错误气泡
  与动作 toast 两处），不再贴上游英文原文。
- **断流**：聊天腿补**静默预算** `STREAM_IDLE_TIMEOUT_MS = 60s`——此前一问一答腿有
  `AbortSignal.timeout` 兜底，流式腿裸挂：上游连着却一个字不发就永久占用连接与
  15s 心跳。预算测的是**两块数据的间隔**（上游心跳、token 都重置它），所以
  「只发心跳不给结果」不超时（`heartbeat_only` 演练项即此预期）。
- **归一事件新增可选 `code`**：`upstream_silent`（静默超预算）/ `stream_incomplete`
  （干净收尾零事件）/ `upstream_stream_failed`（hijack 后的传输级截断，路由 catch
  打的）/ `rate_limited`（429）。前端按码换本地化文案（`assistantDrawer.rateLimited`
  / `upstreamSilent` / `streamIncomplete` / 复用 `streamAborted`），不带码的错误
  原样显示上游文案；i18n 三组新键 zh/en 双份。
- **凭据通道两缺陷**（收尾自查发现，细节留 `issue_fix/问题记录-助手凭据通道两缺陷.md`）：
  ① PUT `my-agents` 的 `params` 通道能装 `secret: true` 项（明文 Key 落库并回显，
  破门槛 12）→ 现 400 拒收；② 凭据解密失败冒 500 → 统一 `loadResolvedDefaultAgent`
  降级 503/2005「去设置卡重填」。两处都是门槛 2/12 的前置。
- **演练物料**（`apitest-e2e-python/drill/`）：`stub_upstream.py` 是零依赖假上游，
  按迁移 059 的 agent-vendor 方言实现 5 条接口 + `eventType` SSE，12 个故障模式（ok /
  silent / stall_mid / heartbeat_only / drop / empty / error_event / fail_result /
  ratelimit / ratelimit_create / http500 / bad_content_type）；`POST /__mode` 切
  模式、`?mode=` 单次覆盖、按会话记忆历史。`README.md` 是逐项演练清单（「期望后端 /
  期望界面」两列 + 门槛 2/3/5/12/14 对应项 + 凭据可见性回归步骤），准备三步只把
  种子脚本的 `agent-vendor_BASE_URL` 换成桩，**不动协议配置**。
- **验证**：按 AGENTS.md 留给用户——本批无新迁移，`./start.sh --restart api worker`
  后照 `drill/README.md` 逐项走。重点三项：silent 约 60s 收尾成「上游长时间没有
  回应」、ratelimit 回 429/2007 + `Retry-After` 且气泡是「上游限流，稍后重试」、
  drop 的半截回复 +「连接中断，回复未完成」。（本批未跑 `pnpm check`，与「类型检查
  需用户明示」的项目口径一致。）

#### 13.4.11 2026-09-16 增补（用户要求）：`/` 指令输入即识别（候选浮层）

P9-5 的指令通道只在**回车发送时**解析：老手够用，新用户等于「指令不可见」——得先
知道指令名才打得出来（空态那枚「查看本地指令」按钮是唯一入口）。本批把识别提到
输入过程中，语义与执行路径一字未改：

- **纯解析层**（`lib/assistantCommands.ts` 新增 `completeCommand`）：与 `parseCommand`
  **共用同一套匹配谓词**（`name === token || name.startsWith(token)`）——浮层里出现的
  候选就是回车时会命中的那几条，两边永不打架。两段式位置：**指令位**（`/`、`/主`、
  `/th`）与**参数位**（`/主题 深`、`/打开 接`，值型参数的别名表与页面表都按已输入
  片段过滤）。补全语言跟界面走（中文界面补 `/主题`，英文界面补 `/theme`）；**已经
  打对的别名不改写**（打了 `/接口管理` 不会被 Tab 换成 `/接口`）。没有项目上下文时
  `/打开` 只报全局页（与回执同口径，不推打不开的页）。
- **浮层 UI**（`AssistantDock`）：输入框上方候选列表（形态照 `VariableField` 的
  `.var-field-pop` 语汇：面 + 细线 + 阴影 + 选中底色，新增 `.assistant-cmd-*` 一组）；
  候选行两列（mono 补全文本 + 说明），参数形状作为第三列提示（`深色｜浅色｜系统`）。
  **↑↓ 选、Tab 补全、点选等价于 Tab**（mousedown 不是 click——失焦会先收浮层）；
  指令位补全后自带尾空格、自然落到参数位，下一层候选直接出现（参数词汇靠这一步
  可发现）；参数位补全即收浮层。`Escape` 收起、打到下一个字符重新武装。
- **Enter 仍是发送**（13.3 回车直发兜底不动）：前缀命中的指令照 `parseCommand` 执行，
  未命中的 `/xxx` 照旧作为消息发给 AI——浮层不抢发送键。两者不同这点写在浮层页脚
  （`assistantCmd.paletteHint`）。
- **i18n**：新键 15 组 ×2 语言（`cmd*` 8 条说明、`hint*` 3 条参数形状、`langValue_*`
  2 条语言自名、`paletteTitle` / `paletteHint`）。
- **验证**：按 AGENTS.md 留给用户——`/`（全表）、`/主`（单条 → Tab → 参数位）、
  `/主题 深`（值候选）、`/打开 接`（页面候选）、`/p `（project/password 歧义时仍停在
  指令位让用户挑）、`/xxx`（无候选、浮层不出现、回车直发上游）、Shift+Enter 换行后
  不再识别。（本批未跑 `pnpm check`，同 13.4.10 口径。）

### 13.5 验收门槛

1. ~~`assistant_enabled=false` 的项目：助手路由组 404 且不泄露配置存在性。~~
   （**2026-09-14 作废**：项目闸门随迁移 058 取消，助手默认开启——见 13.0 修订块。）
2. 对话过程网络面板里**没有**上游 API Key（全链路服务端转发）。
3. `PROCESSING` 工具行如实显示 agent 正在调用的工具名。
4. agent 产出的草稿（如一段响应脚本）经预览卡「确认应用」后用**本人 JWT** 落库；
   审计里 created_by 是本人。
5. agent 平台停机：本地指令（主题/语言/导航）仍可用；聊天通道给出明确错误气泡。
6. 长空闲（>30s 无 token）：连接不断（保活注释行生效）。
7. 成员被加入项目后 ≤60s 顶栏出现小红点与弹窗；点击通知深链到正确页面。
8. 同名用户头像相同；改名后头像不变；「换一个形象」只影响本人。
9. `prefers-reduced-motion` 下无眨眼动画。
 10. ~~主线教程 5 步全程无「目标元素找不到」的卡死（找不到自动跳步）。~~
    （**2026-09-16 随 P9-7 移出至 P13**，见 19.0 验收门槛。）
11. （2026-09-11 增）导入 provider JSON（补 Key + 测试连接通过）后，零代码改动
    即可在抽屉内对话；导出 JSON 不含 apiKey；导入未知 type 报错。
12. （2026-09-11 增）apiKey 在任何 API 响应与前端网络面板不可见（写库即密、
    接口只回「已配置」）。
13. （2026-09-11 增）切换默认 provider 后，旧 provider 的会话仍可打开且按原
    provider 收发（`provider_id` 隔离）；无 stop 能力的 provider 停止按钮不出现。
14. （2026-09-11 增）上游停机时 `/登出`、`/改密码`、`/设置` 可用；改密走
    `POST /auth/change-password`，`pwd_epoch` / 审计语义与页面改密一致；密码不出
    现在消息流、不发给上游。

15. （2026-09-16 增，P9-8）上游异常三类各有明确收尾：断流（连接掐断 / 静默超预算
    / 干净收尾零事件）给出错误气泡而非悬挂；限流回 429 + 错误码 2007 并如实转发
    `Retry-After`；上游 ERROR 事件与 `success:false` 以错误终态落地。
    **演练物料**：`apitest-e2e-python/drill/`（stub 上游 12 个故障模式 + 逐项清单，
    门槛 2/3/5/12/14 的对应项与凭据可见性回归步骤都在那份 README 里）。

### 13.6 agent 方接入要求与对接契约（2026-09-11 确认）

分三层：**运行接口**（agent 平台系统必须具备）、**接入交付物**（对接时要拿到手的
东西）、**双方约定**（需要共同定义的契约）。

**一、运行接口 — 必备三项 + 可选一项**

| # | 能力 | agent-vendor 对照 | 为什么 |
| --- | --- | --- | --- |
| 1 | 创建会话 | `POST /conversation/add` → conversationId | 资格线：没有会话概念的不算 agent 平台，进不了注册表 |
| 2 | 发消息（SSE 流式） | `POST /chat/{id}` 逐 token 事件 | 事件字段名可任意（adapter 翻译），但语义必须能区分**文字增量 / 完成 / 错误** |
| 3 | 按会话查历史 | `GET /{id}/messages` | 平台不存 transcript（边界 2/修订 4），刷新/换设备后的消息回放全靠上游 |
| 4 | 停止生成（可选） | `POST /{id}/stop` | 无则能力降级：前端断流，按钮隐藏 |

上游的「会话列表」接口**不需要**——抽屉会话列表读自己的 `assistant_conversations`
映射表。SSE 事件**最好还有**（没有不阻断，只影响体验）：工具执行状态（`PROCESSING`
类——抽屉里「正在调用 list_endpoints…」进度行，信任感的关键）；心跳
（`HEART_BEAT`；没有则代理自己发保活注释行，已设计）。

**二、接入交付物 — 建一个 provider 要拿到手的东西**

1. **Base URL**：我们服务端可出站访问的 API 地址。⚠️ 部署硬前置——apitest-server
   所在网段必须能出站打通 agent 平台（P2-8 同类教训，启动前实测）。
2. **API Key**：绑定目标智能体（agent-vendor 为 `ak-xxx`，Bearer 头）；我们侧 AES-GCM
   加密落库，接口只回「已配置」。
3. **agentId**（或等价标识）：有些平台 Key 自动关联智能体，有些要显式传。

**三、双方约定 — 唯一需要共同定义的新契约**

**MCP 工具面接线**（agent 从「通用聊天」变「站内助手」的根）：

- **我们给 agent 方**：`/mcp` 端点 URL（Streamable HTTP 无状态形态）+ 一枚
  **read scope 的 MCP Token**（P5 机制，最小权限）；他们在自己后台把 `/mcp`
  装进智能体（agent-vendor 的 `STREAMABLE_HTTP` 安装方式）。
- **agent 方的活**：智能体人设/提示词/工具编排都在他们侧配置；只用 read 工具、
  写操作产出**草稿**。

**Proposal 草稿格式**（P9-5 的核心约定，先定再对接）：agent 在回复正文中用固定
围栏标记草稿，前端扫描渲染成预览卡，「确认应用」时用本人 JWT 调既有 REST。
第一版只一种 kind，枚举与既有 REST 一一对应，后续按需扩：

~~~markdown
```apitest-proposal
{"kind": "response_script", "caseId": "…", "script": "…"}
```
~~~

**页面上下文块（P9-4c，2026-09-15）**：平台在每条用户消息前缀一个
` ```apitest-page-context ` 围栏（紧凑 JSON：page / route / entities / focus /
filters / selection——标识符 + 面包屑，无 secret 值）。agent 方约定：**必须优先
按该块解析「当前/这个/刚才」类指代**（拿 ID 调 MCP read 工具取全量），块里没有的
信息要反问用户，不许猜；用户侧展示与历史回放已由平台剥掉该块，agent 不要在回复里
复述它的原文。

**转述 elicitation / MRTR — 三层职责拆解（谁实现什么）**

| 层 | 谁实现 | 现状 |
| --- | --- | --- |
| 两回合协议（`inputRequired` + 确认判定 + 拒绝文案） | **我们** | P5 已实现（`mcpToolResult.ts` 的 `mrtrGate`） |
| 转述到人（确认请求变会话一问、人的回答带回第二次调用） | **agent 方** | MCP 会话是 agent-vendor ↔ `/mcp` 直连，助手代理只转聊天 SSE、不在工具调用回路上——这层我们写不了 |
| 等效替代（确认由真人完成） | **我们** | proposal 卡 / 页面引导——L3 proposal-first 的由来 |

上游不支持转述时的三种典型结局（为何按「不支持」收口）：**幻觉**（「已删除 ✓」
但库里还在）、**贴机器文**（`inputRequests` JSON 原样进气泡）、**自作主张**（LLM
自己代答 `confirm=true`——比不支持更糟，等于 AI 替人拍板不可逆删除）。故聊天
token 只发 read scope，delete 类工具不进 agent 工具面，被要求删除时按人设引导
「请到页面操作」。

**实测方法（排 P9-2 联调实测清单，非验收门槛）**：

1. 预检（问 agent 方研发，便宜）：运行时对工具返回的 `inputRequired` /
   elicitation 类结果怎么处理；mcp-proxy 所用库（rmcp 0.10 / rmcp-soddygo 1.5.0）
   是否支持把 elicitation 转进会话。顺带问「按会话注入凭据」（P5-3 留的账）。
2. 黑盒十分钟：`/mcp` 装进测试智能体 + 含 delete scope 的测试专用 token +
   可牺牲测试套件 → 聊天下删除指令。**判定标准不是「删没删成」，而是「它问没
   问你」**：会话内出现确认问答且按答复执行 = 支持；声称已删但库里还在 / 贴
   JSON / 卡住 = 不支持；未问直接删（两次调用间隔极短、会话无确认文本）=
   **危险假阳性**，按不支持处理且不可放宽。佐证：库内实际状态 + `audit_logs` /
   MCP 动作审计 + 两次调用时间戳与会话内容对照。
3. 两项答案都不改变设计：不支持是预期（方案已收口）；即使支持，写操作的审计
   主体仍落 MCP token 而非真人（除非上游还能按会话注入凭据——另一个他们没有
   的能力），proposal-first 地位不动。

**明确不要求 agent 方提供**（避免对接扯皮）：按会话注入凭据（proposal-first 已
定）、转述 elicitation / MRTR（delete 降级页面操作）、替我们存数据（transcript
归他们，我们只存一行映射）。

### 13.7 后置增补：项目可见性两层 + 权限申请审批流（2026-09-07 提出；**2026-09-16 立项为 P14**，原 13.6，2026-09-11 因新增 13.6 顺延）

> **本节已转正为二十章 P14**（2026-09-16 用户确认排期）：提出时的取向六条与现状
> 锚点**原样随迁** 20.0 并扩编为范围 / 边界 / 迁移 / 路由 / 批次 / 门槛，完整口径
> 以二十章为准。本节保留标题与提出日期作为 2026-09-07 的取向记录入口，正文不再
> 重复维护。

---

## 十四、P10 — 性能、版本（插件机制 2026-09-18 砍除）

> **原 P6，2026-09-04 顺延为 P10**（新增 P6 用户与权限 / P7 测试管理 / P8 数据统计 /
> P9 站内助手四个阶段插在它之前）。章节内编号随之由 `10.x` 改为 `14.x`；文档其余位置引用
> 本章时写 **P10 14.1** 而不是旧的「P6 10.1」。**顺延不是降级**：它排在最后的理由从头到尾
> 没变——归档与截断是口径变更，得先有稳定的读侧口径（P8-1 收口）才谈得上改存储形状。
>
> **2026-09-05 自主计划十四章整章并入本文件**，内容原样搬移，未改一字；主计划原位只留
> 一行指针。
>
> **2026-09-18 范围修订（用户确认）**：① **14.2 插件机制整项砍除**——三个候选窄缺口
> （运行时加载的第三方 MCP 工具 / 自定义通知渠道 / 自定义报告渲染器）用户明确全部不要，
> 本节不占批次、不占迁移（决策理由与等价能力核对见 14.2）；② **14.1 性能拆为三批
> P10-1（大响应体口径变更 + 转存对象存储，迁移 065）/ P10-2（执行历史归档分区表，
> 迁移 066）/ P10-3（查询缓存补齐，零迁移）**，顺序与依赖见 14.1；③ **14.3 版本历史
> 展开为三批 P10-4（统一版本模型 + 资产接入，迁移 067）/ P10-5（版本列表 + 改动内容
> diff 展示 + 回滚，零迁移）/ P10-6（执行结果回放，边界待确认）**，其中 **「变更历史
> 必须展示改动内容」是 14.3 的硬验收项**，见 14.3；④ **新增 P10-7 前端列表首屏闪空态
> 修复**（零迁移、纯前端，根因/影响面/修法见 14.5，验收「有数据的列表不出现空态帧」）；
> ⑤ **新增 P10-8 顶层操作区不随内容滚动**（零迁移、纯前端、改动面较大，分三步铺开与碰撞
> 收口见 14.6）；⑥ **八批实施顺序见 14.4**（迁移线串行 065 → 066 → 067，P10-3/P10-5 与
> 前端线可并行；前端线 P10-7 → P10-8 内部串行，P10-6 待边界拍板）。

### 14.1 性能优化 —— 三批（2026-09-18 用户确认范围与批次）

**现状核对（2026-09-18，落码前先钉事实）**

> 以下两条「现状」中，前两条已被 **P10-1（2026-09-19 实现）** 改写，保留原文作为该批次
> 的提出依据；迁移起号已由 064 → **065**。第 4 条已被 **P10-2（2026-09-20 实现）** 改写；
> 第 3 条已被 **P10-3（2026-09-20 实现）** 改写（进程内 stats 缓存 → Redis 共享缓存 + 扩面 + 写失效）。

- **大响应体是硬砍丢弃，不是转存**：`lib/run.ts:311-315` 在 `RESPONSE_LIMIT = 10_000`
  处 `slice`，超出部分直接消失；`executions.response_body` 从未存过完整正文，只留
  `response_truncated` 标志与 `response_size_bytes` 真实大小。**（P10-1 已改：超限正文
  转存对象存储，行内仍只留预览。）**
- **对象存储已就位但只服务产物**：`lib/objectStore.ts` 的 `fs` / `s3` 双驱动 +
  presign 上传/下载 + `getSharedObjectStore` memoize（P4.5 落地，见 8.4），执行记录侧
  一字未用。**（P10-1 已改：新增 `putObject` 服务端写入，执行正文成为第二个消费者。）**
- **没有查询缓存**：ioredis 只用于 BullMQ 队列 / 取消广播 / 告警订阅；唯一缓存是 P8-4
  给 `/stats/*` 的 **30s 进程内存 TTL**，多 API 实例不共享，也不覆盖其它热点读路径。
  **（P10-3 已改：新增 `lib/queryCache.ts` Redis 共享缓存，stats 换掉进程内 Map 并扩到
  /dashboard、GET /projects，写失效不靠纯 TTL。）**
- **`executions` 未分区**；最新迁移 **064**，本阶段起号 **065 / 066**（**065 已用于
  P10-1**，P10-2 起号 066）。**（P10-2 已改：`executions` 按季范围分区，066 落地。）**

#### P10-1 大响应体口径变更 + 转存对象存储（迁移 065）★口径变更，先定规则再写码

- **阈值分档**：≤ 10KB 维持现状内联进 `response_body`；> 10KB 正文转存对象存储，
  `executions` 只留对象 key + `content-type` + 真实大小，不再内联全文。
- **两个「大」必须拆开**：现有 `response_truncated` 表达「为断言/展示截断到 10KB」，
  与「完整正文已转存、可按需拉全量」是两件事。新增列（`response_body_object_key`
  等）表达后者，`response_truncated` 原义不动。
- **详情页显示**：默认前 10KB 预览 + 「下载完整响应」按钮，走 objectStore presigned
  GET（沿用产物那条「平台不代理大流」规则：runner 直传 / 浏览器直下）。
- **断言与 extract 口径不动**：仍只跑截断后的 10KB（`assert.ts` / `applyExtracts` 的
  `RESPONSE_LIMIT` 契约保持），避免动断言判定与通过率。
- **转存可关**：受项目或系统设置控制，默认小项目走 `fs` 即可，不强制依赖 S3。
- **边界**：历史行无完整正文可补，`response_body_object_key` 为空即「无全量」，不回填。

> **P10-1 实现状态（2026-09-19）**：迁移 **065**（`065_p10_response_body_offload.sql`）
> 落地三条改动——`executions.response_body_object_key TEXT` +
> `response_body_storage_driver TEXT CHECK ('fs','s3')`、`project_settings.offload_large_response
> BOOLEAN NOT NULL DEFAULT true`。**未加 size / content-type 列**：002 的
> `response_size_bytes` / `response_content_type` 记的本来就是完整正文的真实值与类型。
> 对象 key 由执行 id 派生（`executions/<id>/response`），一次执行至多一个正文对象，同
> key 重写即覆盖；**不走 `artifacts` 表**（039 注释里的预留在此收口为「用 executions 列」，
> 理由：一次执行最多一个对象、多一张多态表只多一次 join）。
>
> **落码前拍板的三条口径（2026-09-19 用户确认）**：① **转存开关是项目级、默认开**——
> 没有系统设置表，复用 `project_settings`（读写挂在 `requireProjectAdmin`，与前两个开关
> 同权限）；**项目级开关默认 true 是这张表的第一例**，`VALUES` 侧缺省必须 COALESCE 到
> `true`，否则「只改默认环境」的一次局部 PUT 会把没碰过的项目悄悄关掉转存。② **落盘上限
> 走环境变量 `RESPONSE_OFFLOAD_MAX_BYTES`，默认 8MB**（与 `INGEST_MAX_BODY_BYTES` /
> `RUNNER_COMPLETE_MAX_BODY_BYTES` 同口径）；`response.text()` 本来就整段进内存，这条线
> 只约束写盘量。③ **公开分享页不提供「下载完整响应」**——那条通路要登录态的项目端点，
> 分享页两者都没有，入口按 `publicView` 收起，公开证据闭包保持只读。
>
> **实现要点**：`lib/objectStore.ts` 的 `ObjectStore` 接口补 `putObject`（fs 直写 + 越界
> 防护、s3 `PutObjectCommand`），并新增 `getWriterObjectStore()` 供无 `FastifyRequest` 的
> worker 进程取 store（fs 现造、s3 复用 memo，避免把空 base 固化进产物直链）；转存在
> `executeRequest` 里**脱敏后**写对象（对象里不能有明文 secret），且**推迟到 `durationMs`
> 定格之后**——写对象是平台开销，不该算进被测接口的耗时；写失败只记日志，降级为「无全量」，
> 不让执行失败。断言 / extract / 响应脚本仍只吃 10KB，判定与通过率零变化。读侧新增
> `GET /api/v1/projects/:id/executions/:executionId/response-body` 按需签 5 分钟短活直链
> （不随执行详情下发：详情被列表 / 分享 / MCP 复用，行行签会浪费并泄进分享载荷）；API 只
> 回传布尔 `responseBodyStored`，不回传 key。前端 `DownloadFullResponseButton` 同时接入证据
> 抽屉与接口工作台实时响应面板。**对象删除 / 生命周期仍留 P10-2**（对象与行同生命周期，
> 不能只归档行留下孤儿对象）。**历史行不回填**；`responseBodyStored=false` 覆盖
> 历史行 / 项目关闭转存 / 超上限 / 写入失败 四种合法状态。

#### P10-2 执行历史归档（分区表，迁移 066）

- `executions` 按时间分区（月 / 季），冷分区归档；**这是「要不要预聚合表」的正确入口**
  ——先分冷数据，再谈预聚合（P8 边界 17 刻意没建汇总表与物化视图）。
- 与 P10-1 联动：归档冷分区时，对象存储里的大响应体必须同生命周期处理（保留 / 转冷 /
  清理），不能只归档行、留下孤儿对象。
- **读侧口径不变**：`/stats/*`、看板、执行记录列表语义一律不动，只是底层分区裁剪加速。

> **P10-2 实现状态（2026-09-20）**：迁移 **066**（`066_p10_executions_partition.sql`）把
> `executions` 换成了 **`PARTITION BY RANGE (created_at)`、按季**的分区表，并新增归档台账
> `execution_partition_archives`。
>
> **落码前拍板的六条口径（2026-09-20 用户确认）**：① **按季，不按月**——用户先问「这样分
> 后面维护容易吗」，核对后改的推荐：分区**不会让列表查询变快**（执行记录列表本来就走
> `executions_project_created_at_idx`），它换来的只有「批量移除从 DELETE 百万行变成 DETACH
> 一张表」，所以粒度该对齐归档窗口而非查询模式；按月 12 张/年 vs 按季 4 张/年，多出的 3 倍
> 关系数换不到额外收益。② **到期分区只 DETACH + 改名 `executions_archived_YYYYqN`，自动维护
> 永不 DROP**——脱离即读侧不可见（API 只查 `executions`），数据仍在库里，何时真删由人决定。
> ③ **对象只在表被真正 DROP 的那一刻删**：14.1 的「不能只归档行、留下孤儿对象」在这里的正解
> 是「同生共死」而不是「归档就删」——DETACH 保留期内行还在，对象就得在。④ **保留窗口走
> `EXECUTION_RETENTION_MONTHS`，默认 0 = 自动归档整个关闭**（删历史是破坏性动作，不开箱即开）。
> ⑤ 新增只读出口 `GET /api/v1/system/execution-partitions`（平台管理员）。⑥ 最终清理走
> **`DELETE /api/v1/system/execution-partitions/:name`**（平台管理员）——因为②+③合起来意味着
> 自动维护永不删对象，若清理只能靠人在 psql 里 `DROP TABLE`，对象必然变成永久孤儿；这条端点
> 是**唯一**会同步删对象的通路。
>
> **三处不可回避的结构变更**：① 主键 `id` → **`(id, created_at)`**（分区键必须进唯一约束；
> `id` 放前面保住 16 处按 id 单查的索引前缀），代价是 `id` 的**全局**唯一性不再由约束保证，
> 改由 UUIDv4 保证。② **两条入向外键拆除**——`execution_steps.http_execution_id` /
> `mocks.snapshot_execution_id` 无 `created_at`，组不成合法外键；列保留、`ON DELETE SET NULL`
> 语义消失，降级为「悬垂即证据已消失」（现有读法都是 LEFT JOIN / 取回再查，可降级），
> **DROP 时由清理例程显式置空**，DETACH 时刻意不置空（脱离可逆）。③ **DEFAULT 兜底分区**：
> 维护拍停了也绝不能写失败。
>
> **唯一的净损失项**：`WHERE id = $1`（worker 认领 / 取消 / 详情 / 下载直链，16 处）无
> `created_at` 不能裁剪，**逐分区探索引**，成本随分区数单调增长——这也正是不选按月的理由。
>
> **实现要点**：`lib/executionArchive.ts` 是运行时那一半（预建当前季 + 两季、到期 DETACH +
> 改名 + 记台账、列现状、清理）；维护拍挂在既有 scheduler 进程上（6 小时一拍，事务级
> advisory lock `8_013_501`，多实例安全），不起第四个进程。`ObjectStore` 补 `deleteObject`
> （fs 吞 ENOENT、s3 天然幂等），清理时**驱动对不上的对象不删**并如实回报 `objectsSkipped`
> （与 P10-1 下载直链的驱动校验同一判断）。清理顺序是**先删对象 → 再断指针 → 最后 DROP**：
> 对象存储没有事务，反过来做一旦中途失败，key 会随表一起消失、谁也不知道还剩哪些孤儿。
> 唯一的静默失败面是**兜底分区滞留行**（维护拍长期停摆时行落进 `executions_default`，既不会
> 被归档又会挡住该季分区的创建）——维护拍**先查后建**并把这一季报为 `blocked`（事务里报错会
> 毒化整个事务，`try/catch` 救不了后面几季），状态接口另给一个精确的 `strandedRows`。
> **读侧零改动**：61 处涉及 `executions` 的 SQL、`mapExecution` 一字未动。
>
> **前端（2026-09-20 追加）**：系统管理新增「执行归档」tab（`ExecutionArchivePanel.tsx`，
> 第 8 个管理员 tab），消费上面两条端点——在役分区表 + 已归档分区表 + 保留期/驱动/兜底滞留
> 读数，清理按钮走 danger 二次确认并回报 `objectsDeleted` / `objectsSkipped`。
> **命名撞车的处置**：tab 内的「分区」是存储分区，与「执行器」tab 里的「分区」（P2-8 网段
> 标签）无关，面板首行与 `ExecutionStoragePartition` 的类型注释都点明了；状态用中性 `.chip`
> 而非语义色（`--pass/--fail/--skip/--busy` 是运行状态的保留词，见 quiet-console 规则 2）。
> `droppedBy`（用户 id）**不在界面回显**——裸 uuid 无可读含义，「谁清的」由审计流回答。

#### P10-3 查询缓存补齐（复用 ioredis，零新依赖，无迁移）

- P8-4 的 **进程内存 30s TTL 换成 Redis 共享缓存**（复用 `createRedis()`），多 API
  实例一致。
- 扩到其它热点只读路径（看板聚合 `/dashboard`、`GET /projects` 的 `queryProjectList`
  等 P8-8 已下推但仍偏重的读）。
- **失效策略**：写操作（执行完成 / 资产 CRUD / 归因变更）主动 `DEL` 相关 key，不靠
  纯 TTL 兜脏读。
- **缓存 key 带可见项目集维度**，避免越权命中他人聚合结果。

**批次顺序**见 **14.4 实施顺序**（本节局部次序：065 → 066 → 缓存）。**依赖零新增**（objectStore、
ioredis 均在）。里程碑挂 M7。

> **P10-3 实现状态（2026-09-20，已实现，零迁移零新依赖）**：
> - **新模块 `lib/queryCache.ts`**（写侧半边全在这一处）：复用 `createRedis()` 懒建单例，
>   `cacheGet` / `cacheSet(key, scope, data)` / `invalidateProjects(ids)` + 共享的
>   `scopeHash(scope)`。缓存条目按其依赖的项目集打「标签」——每个项目一个 Redis SET
>   （`qcache:tag:<projectId>`），系统管理员全量聚合挂 `qcache:tag:__all__`；失效时读标签
>   集、一次性 `DEL` 其中全部 key + 标签本身。TTL 30s 仅作兜底。每个 Redis 操作用
>   `safe()` 包一层 **try/catch + 200ms 超时**——`createRedis()` 的 `maxRetriesPerRequest:null`
>   断连会无限等重连，对缓存是灾难，故超时兜底而非依赖 ioredis 重试；Redis 不可达时读
>   当 miss、写/失效当 no-op，请求照走数据库。
> - **P8-4 的进程内 30s Map 换成共享缓存**：`stats.ts` 六条只读路由（overview / trend /
>   failures / flaky / coverage / projects）删掉本地 `Map` + `scopeCacheKey`，改走
>   `cacheGet`/`cacheSet`，键里的可见集哈希改用共享 `scopeHash`（与 dashboard/projects 同
>   一实现，同一集合两侧产出同一分片键 / 同一标签）。多 API 实例读数不再随命中哪个实例漂移。
> - **扩到两条热点只读路径**：`/dashboard`（`queryProjectMetrics` 七表聚合，P8-8 实测大头）
>   与 `GET /projects`（`queryProjectList`）各挂 30s 缓存，键 = 路由 + 可见集哈希 + 过滤/分页
>   维度。新增 `dashboard.ts:visibleScope(user)`（系统管理员 = `all`，否则读
>   `user_project_roles` 得可见集）供两处共用。
> - **失效策略（不靠纯 TTL）两个钩子**：① **执行落终态** —— `lib/events.ts` 的
>   `publishEvent` 在事件状态非「运行中」枚举时 `void invalidateProjects([projectId])`（worker
>   进程、无 HTTP 请求，跨进程失效同一份 Redis 缓存）；② **API 侧项目级写** ——
>   `index.ts` 一个 `onResponse` 全局钩子：`/api/v1/projects[/:id]` 下的成功变更方法
>   （资产 CRUD / 归因 / 成员 / 项目改名删）按 `:id` 失效相关缓存，胜过在几十个写路由里各撒
>   一句 DEL；`POST /api/v1/projects`（建项目、无 id）只清 `ALL_TAG`。
> - **越权对齐（验收门槛 6 的缓存侧）**：键带可见集哈希，可见集不同的用户读不到同一份
>   聚合缓存；成员增删改变用户可见集哈希，天然 miss + onResponse 一并失效。
> - **未跑类型校验/构建**：按 `AGENTS.md`「校验类命令需用户明确要求」，本轮未执行 `pnpm check`。

### 14.2 插件机制 —— **整项删除**（2026-09-18 用户确认）

不再做通用插件框架。三个候选窄缺口（运行时加载的第三方 MCP 工具 / 自定义通知渠道 /
自定义报告渲染器）用户明确全部不要。

**决策理由（2026-09-18 核对）**：本节原定的钩子点已被既有设施等价覆盖，且通用插件框架
与「薄栈、枚举刻意封闭」的 server-contract 相冲突，新增的只有「运行时/第三方加载、
免重新部署」这一点，而它不在用户诉求内。等价能力对照：

| 原计划的插件钩子 | 已实现的等价能力 | 位置 |
| --- | --- | --- |
| 执行前钩子 | 脚本前置钩子 `runScriptHook`（改写/签名外发请求） | `lib/sandbox.ts` |
| 执行后钩子 | 后置响应脚本 `runResponseScript` + 终态通知 `notify_config` | `lib/sandbox.ts` / `lib/notify.ts` / `lib/pipelineNotify.ts` |
| 断言钩子 | 脚本断言 `runScriptAssertion`（`ctx.assert` 契约） | `lib/sandbox.ts` / `lib/assert.ts` |
| 报告生成 | allure / junit 双解析器 + 自渲染视图 | `apitest-runner/src/report/` + `lib/allureReport.ts` |

另有五处注册表式扩展面已存在：MCP 工具表（`lib/mcpServer.ts`）、数据源适配器
（`lib/adapters`）、助手 provider 协议引擎（`assistant_providers.protocol`，加平台是填
数据不是写码）、对象存储双驱动（`lib/objectStore.ts`）、SDK 传输补丁
（`apitrack-sdk-python/patch/`）；用户自定义代码由 `node:vm` 沙箱完整覆盖。故本节删除，
**不占批次、不占迁移、不进 M7 验收**。

### 14.3 版本历史 —— 三批（2026-09-18 用户确认范围；**变更历史须展示改动内容**）

**现状与前置（2026-09-18 核对）**

- **现有的「谁改的」只有元数据，没有内容**：`updated_at` 列 + P11 的 `created_by` /
  `updated_by` 与 `audit_logs`（谁 / 何时 / 什么动作）——**既没有内容快照，也没有 diff**。
- **已有定义级快照只服务执行，不是历史序列**：`test_cases.request_snapshot`、
  `flows.nodes`、`scenarios.steps` 是「当前值」的副本，每次保存**覆盖**，留不下上一版。
- **回放依据缺一半**：`run_spec` 终态即清空（`lib/run.ts:495-496`）不能当回放源；
  `executions.request_snapshot` 可用但默认脱敏（项目开 `store_plaintext` 才是明文）。
- **环境只快照了名字**：`environment_name` 有，**变量值与 secret 集合没有历史快照**。

**统一模型（关键边界：一套模型，不做两三套）**

- 新增 `asset_versions` 版本表：`(project_id, asset_type, asset_id, version_no,
  snapshot JSONB, change_summary, created_by, created_at)`，唯一键
  `(asset_type, asset_id, version_no)`。
- `asset_type` 单一枚举覆盖 接口 / 接口用例 / 文本用例 / 环境（流程、套件按需）——
  P7 边界 18（文本用例版本历史）、P6 边界 16（用例版本历史）、P11 边界 10（diff/
  回滚）三处欠账**都在这张表上还**，刻意分处做会长出两套版本模型。
- **保存即产出新版本**（写路径挂钩），不靠 `audit_logs` 事后反推。
- **secrets 纪律**：环境快照里 `secrets` 只存 key 与「是否变更」标记，**不存值**；
  diff 只显示「某 secret 已变更」，绝不回显明文（与全站脱敏口径一致）。

#### P10-4 统一版本模型 + 资产接入（迁移 067）

- `asset_versions` 建表 + 写路径钩子：接口、接口用例、文本用例、环境（流程 / 套件
  按需后排）。
- **保留策略待定**（建议每资产保留最近 N 版或按时间窗裁剪，避免无界增长）——落码前
  定一个，作为本批的显式决策点。
- **边界**：不引入「评审流 / 审批状态机」（P6 边界 16 已排除）；版本是**内容的序列**，
  不是流程状态。快照写入与资产写入**同事务**，失败整体回滚。

> **P10-4 实现状态（2026-09-20）**：迁移 **067**（`067_p10_asset_versions.sql`）建
> `asset_versions` 单表——`(id, project_id, asset_type, asset_id, version_no, snapshot JSONB,
> change_summary, created_by, created_at)`，唯一键 `(asset_type, asset_id, version_no)` +
> 倒序读索引 `(asset_type, asset_id, version_no DESC)`。**四类资产写路径已接入**：接口
> （`routes/endpoints.ts` 建/改/复制）、接口用例（`routes/cases.ts` 建/改）、文本用例
> （`routes/specCases.ts` 建/改）、环境（`routes/environments.ts` 建/改/复制）。
>
> **落码前拍板的四条口径（2026-09-20）**：① **保留策略 = 每资产保留最近 N 版**，N 走环境变量
> `ASSET_VERSION_RETENTION`（默认 **50**，`0` = 不裁剪）；裁剪在落新版的**同一事务**里做，按
> `version_no` 保留最高的 N 个、删更早的。`version_no` 单调递增、永不复用——裁剪删掉早期版本后
> 编号不回头，「回滚到第 N 版」的编号永远指向同一份内容。② **`asset_id` 不建外键**：一列指向四张
> 不同的表，组不成单一外键。只对 `project_id` `ON DELETE CASCADE`（删项目连版本一起消散）；删单个
> 资产时版本历史留存为孤儿行（版本是「曾经存在过的内容」的证据，与执行历史「谁改的」同一取向，
> 只随项目删除清理）。③ **归属/时间带在版本行自己身上**：四张源表归属列不齐（`spec_cases` 没
> `updated_by`，`environments` 连 created_at/updated_at 都没有），故「谁在何时存了这一版」由写路径
> 写入版本行的 `created_by`（= `context.user.id`，NULL = 系统写入）与 `created_at`，不从源行取。
> ④ **secret 纪律**：环境快照的 `secrets` **只存键名**（取自 `mapEnvironment.secretKeys`），绝不存值
> ——diff（P10-5）只显示「某 secret 已变更」，靠比较键集合，不回显明文（与全站脱敏口径 Spec 4.6 一致）。
>
> **实现要点**：`lib/assetVersions.ts` 是写侧半边——`recordAssetVersion(client, ...)` 只接
> `PoolClient`（**不自己 connect / BEGIN**，进调用方已开好的事务，保证「快照与资产行一起成功或一起
> 回滚」计划 14.3 边界），取 `MAX(version_no)+1`、插入、按 `RETENTION` 裁剪；四个快照构造器
> （`endpointSnapshot` / `testCaseSnapshot` / `specCaseSnapshot` / `environmentSnapshot`）都从
> `map*()` 出参（camelCase、已脱敏）取字段，天然避开 `created_by_email` / `updated_at` 这类派生/
> 会话性字段（不是「内容」，进快照只会让相邻两版看起来改过其实没改）。`change_summary` 只记动作
> 标签（`创建` / `更新` / `复制`）；改动内容的 diff 由 **P10-5** 服务端算，不落这张表。**写路径事务化改造**：
> `cases.ts` 建/改本就有事务，只在 COMMIT 前加一句 `recordAssetVersion`；`endpoints.ts` /
> `environments.ts` / `specCases.ts` 的单条写原是 `pool.query`，各自包了一个 `withVersion` 事务壳
> （`writeEndpointWithVersion` / `writeEnvironmentWithVersion` / `writeSpecCaseWithVersion`，无行即
> ROLLBACK 回 `undefined`→404）。spec case 建的取号重试循环改为**每次尝试一个独立事务**：撞号
> （23505）后 ROLLBACK 再重取号，否则事务中毒无法在同连接续跑。②**未接入 bulk 路径**（import /
> batch-update）——本批只覆盖单条人工写；导入/批改的资产在首次手工保存前无版本行（可后排补）。
> **读侧（版本列表 / diff / 回滚）是 P10-5，本批不含**。

#### P10-5 读侧：版本列表 + 改动内容展示（diff）+ 回滚（零新迁移）

- 后端：`GET .../versions`（版本列表）+ `GET .../versions/:a/diff/:b`（默认相邻两版），
  **diff 由服务端计算**——结构化字段逐键比对，文本 / JSON Schema / 脚本按行比对。
- 前端：版本列表选中两版后展示 **diff（新增 / 删除 / 修改着色）**。★**硬验收项：变更
  历史必须能看到改动内容**（不能只有时间与作者）；环境 secret 只显示「已变更」。
- 回滚：把目标版本快照写回资产 → **再生成一个新版本**（不删历史、不就地改写），走既有
  的不可逆动作确认语义（对齐 `delete` 的 MRTR / 二次确认）。
- **边界**：diff 只读，不改内容；回滚不改变「历史不可变」这一条。

> **P10-5 实现状态 + 入口决策（2026-09-20）**：
>
> **读侧已实现**（`routes/assetVersions.ts`，零新迁移，统一一条路由覆盖四类资产，`:assetType`
> 枚举 + `:assetId` 源表归属校验——版本模型本就是一张表，读侧不再拆四份）：
> - `GET .../assets/:assetType/:assetId/versions`：倒序版本列表，带「谁在何时存的」
>   （`created_by_email` 由读侧 JOIN users 带出）与每版 snapshot；
> - `GET .../assets/:assetType/:assetId/versions/diff`：默认相邻两版（最新 vs 次新）；
> - `GET .../assets/:assetType/:assetId/versions/:a/diff/:b`：任意两版 diff；
> - `POST .../assets/:assetType/:assetId/versions/:versionNo/rollback`：把该版快照写回资产 →
>   再产一个新版本（`changeSummary` 记「回滚至 vN」，不删历史），走二次确认；环境回滚不复原
>   secret 值（快照只有键名），响应 `secretsPreserved` 明示。
>
> **diff 由服务端算**（`lib/assetDiff.ts`）：逐顶层字段比对 → 深相等跳过的跳过；一边缺 =
> 新增/删除；两边都有且不等 = 修改。任一差异都产一份**逐行 LCS diff**（字符串用原文、结构化
> 值用缩进 JSON 规范串），前端只上色。环境 `secretKeys` 是键名数组，diff 天然只显示「哪个键名
> 增/删」，永不回显明文（Spec 4.6）。★ 硬验收项（改成什么可见）由此满足。
>
> **回滚写回**（`lib/assetVersions.ts` 的 `restore*` + `restoreAssetSnapshot`）：复用写侧同
> 一条事务纪律（只接 PoolClient，快照与写回一起成功或一起回滚）。三条跨时间边界自己扛：引用
> 失效落 NULL（接口/用例的失效默认环境）、唯一冲突抛 409（环境旧名被占）、secret 列不动。
>
> **入口决策（用户拍板，2026-09-20）**：对这四类有版本历史的资产，**版本历史是资源里唯一的
> 「历史」入口**——变更历史（审计那套：动作码 / 字段名 / IP）对普通用户不可读，且版本历史已
> 带「谁/何时/动作」。故这四类 UI 用「版本历史」按钮替换原「变更历史」，变更历史只留在项目级
> 审计页。审计本身是给管理员排查用的，不是资源详情的历史（建议作为独立方向再审 UI 可读性）。
>
> **前端收口（2026-09-20，四类全接完）**：通用组件 `VersionHistoryDrawer.tsx`（列表 + diff
> 上色 + 回滚二次确认，viewer 可看、回滚按写权限渲染，环境 secret 只显键名）。四处入口：
> ① 环境 `Environments.tsx`（抽屉 `extra` 按钮，`assetType="environment"`）——早前已接，本轮
> 修掉重命名漏改的 `setChangeHistoryOpen`→`setVersionHistoryOpen`（`onClose` 崩溃）；
> ② 接口 + 接口用例 `EndpointWorkspace.tsx`——**移除旧 `ChangeHistoryDrawer`**，改挂
> `VersionHistoryDrawer`，`assetType` 随屏上编辑对象在 `endpoint` / `test_case` 间切，回滚后
> `reloadAfterRollback` 重拉接口草稿或当前用例；③ 文本用例 `SpecCases.tsx` 的 `SpecCaseDrawer`
> ——新增 `extra` 版本历史按钮（`assetType="spec_case"`，仅已存在用例），回滚后重拉详情并推
> 列表 revision。旧 `ChangeHistoryDrawer` 现只剩 `AuditLogsPanel` 项目级审计页在用。
>
> **后续项（新窗口解决，超出本批范围）**：Mock / 脚本 / 流程 / 套件 / 数据源 / SQL 定义 /
> 调度 / Webhook / 通知渠道 / 告警规则等资源**没有版本历史**（它们不在 P10-4 的
> `asset_versions` 写路径范围，只有审计变更历史）。用户要求这些资源**也要做版本历史**——
> 先扩 P10-4 写路径（为这些资源逐一接 `recordAssetVersion` 快照钩子），再做与 P10-5 同款读侧。
> 当前它们保留现有「变更历史」入口，不属本批改动。

#### P10-6 版本历史扩面 + 变更历史下线（2026-09-20 重定义）

> **原「执行结果回放」提案已删除**（2026-09-20 用户拍板）：`run_spec` 已清空，回放要么只做
> 纯回看（价值低、执行详情页已能看证据），要么得新增一份回放专用快照才能复现——投入与收益
> 不匹配，用户判定「没什么大作用」，整项砍除，不再占里程碑。

**本批两件事**（承接 P10-5 的入口决策：版本历史是资源详情里唯一的「历史」入口）：

**① 版本历史扩面到 6 类用户编写型资源**（+ SQL 定义随数据源）——Mock / 脚本 / 流程 /
套件 / 数据源（含其 SQL 定义）/ 仓库任务。这些和接口/用例同属「用户编写、值得看改了什么
+ 回滚」的内容资产。做法完全复用 P10-4/P10-5 已铺好的地基（一张 `asset_versions` 表、
服务端通用 diff `lib/assetDiff.ts`、通用读侧路由 `routes/assetVersions.ts`、通用回滚分派
`restoreAssetSnapshot`、前端通用 `VersionHistoryDrawer`），**每类只是重复同一套接线**：
> - **迁移**：一条新迁移把 `asset_versions.asset_type` 的 CHECK 扩出 7 个新枚举值
>   （`mock` / `script` / `flow` / `test_suite` / `data_source` / `sql_definition` / `ci_task`），
>   forward-only，不动表结构。
> - **`AssetVersionType` 联合**（models/types.ts）+ 每类一个 `*Snapshot` 构造器（从现成
>   `mapMock` / `mapScript` / `mapFlow` / `mapTestSuite` / `mapDataSource` / `mapSqlDefinition` /
>   `mapCiTask` 出参取，天然脱敏）+ 每类一个 `restore*` + `restoreAssetSnapshot` 加 case。
> - **写路径事务化**：各资源的建/改包进事务后 COMMIT 前调 `recordAssetVersion`（`scripts` /
>   `flows` / `ci_tasks(删)` / `suites(删)` 已有事务壳，`mocks` / `suites(写)` / `dataSources` /
>   `sql_definitions` / `ci_tasks(写)` 需补事务壳，与 P10-4 的 `writeXWithVersion` 同款）。
> - **读侧路由**：`routes/assetVersions.ts` 的 `:assetType` 校验与 `:assetId` 源表归属校验
>   各扩 7 类（各自的源表 + project 归属）。
> - **前端**：`AssetVersionType` 加 7 类；在 MockList / PublicScripts / FlowWorkspace /
>   SuiteWorkspace / DataSourceDetail（data_source + sql_definition）/ CiTaskEditor 各挂一个
>   `VersionHistoryDrawer` + 回滚后重拉，替换原 `ChangeHistoryDrawer`。
>
> **三处 per-resource 皱褶**（其余都是纯机械接线）：`scripts` 有 `script_deps` 子表，回滚要
> 连依赖一起写回；`data_source` 的 `credentials_encrypted` 是密文，快照绝不含（`mapDataSource`
> 只出 `passwordConfigured` 布尔，回滚不动该列，与环境 secret 同纪律）；`flow` 快照是整张
> 节点图、体积偏大，但每资产版本数由 `ASSET_VERSION_RETENTION`（默认 50）封顶、可裁剪。
>
> **成本判断（2026-09-20，用户委托计算后拍板「全做」）**：地基已成型，边际成本是**中等且
> 机械**（非高风险）。运行期开销可忽略——每次保存在既有事务里多一条 `MAX+1` 查询 + 一条
> INSERT + 一条裁剪 DELETE；存储被 retention 封顶。故按推荐**全做**，不走「只删不建」的回退。

**② 变更历史（ChangeHistoryDrawer）资源详情入口全下线**——审计日志已能回答「谁在何时触发」，
资源详情不再各挂一个变更历史抽屉。**移除全部 10 处 per-resource 入口**：group-1 的 7 处
（mock / script / flow / test_suite / data_source / sql_definition / ci_task，被版本历史取代）
+ group-2 的 3 处（`schedule` / `notification_channel` / `alert_rule`，直接去掉，不接版本历史
——调度 / 通知渠道 / 告警规则不属「用户编写内容资产」，回看审计即可）。**保留**项目级审计页
（`AuditLogsPanel` 本体）给管理员排查；`ChangeHistoryDrawer` 组件在所有 per-resource 入口摘除
后可一并删除。

**批次顺序**：068（扩 CHECK 枚举）→ 后端写路径 + 读侧 + 回滚逐类接 → 前端逐资源接线 + 摘
变更历史入口。**依赖**：P10-4/P10-5（地基）。里程碑挂 M7。

> **实现状态（2026-09-20，已实现）**：
> - **迁移**：`068_p10_asset_versions_expand.sql` 把 `asset_versions.asset_type` 的 CHECK 扩到 11 类。
> - **后端**：`lib/assetVersions.ts` 补齐 7 类 `*Snapshot` 构造器与 `restoreAssetSnapshot` 分派
>   （脚本连 `script_deps` 一起写回；`data_source` 快照只出 `passwordConfigured`、回滚不动密文列）；
>   各资源写路径在事务里调 `recordAssetVersion`；`routes/assetVersions.ts` 的 `:assetType`/`:assetId`
>   校验扩 7 类。
> - **前端**：`AssetVersionType` 扩 11 类；`VersionHistoryDrawer` 挂到 MockList / PublicScripts /
>   FlowWorkspace / SuiteWorkspace / DataSourceDetail（`data_source` + `sql_definition`）/ CiTaskEditor，
>   回滚后各自重拉（SQL 定义只重拉当前一条、抽屉保持打开）。**变更历史入口 10 处全下线**：group-1
>   的 6 处（mock/script/flow/test_suite/data_source/sql_definition）改挂版本历史、ci_task 新挂版本历史；
>   group-2 的 3 处（schedule/notification_channel/alert_rule）直接摘除，回看项目级审计页。
>   `ChangeHistoryDrawer` 组件与其专属 i18n（`audit.history*` / `audit.fields`）一并删除。

### 14.4 实施顺序（2026-09-18 用户确认）

**排序原则**

1. **口径变更先于存储结构变更**：P10-1 决定「超 10KB 正文去哪、详情页显示什么、历史行怎么
   算」，P10-2 的归档与对象生命周期必须建立在它之上——反过来做会先归档出一批没有全量正文
   的行，再回头补口径。
2. **含迁移的批次串行、一次一个迁移号**：沿用仓库 forward-only 迁移纪律（`server-contract`），
   不在同一轮并行改 schema，避免迁移编号与回滚语义撞车。故 065 → 066 → 067 严格串行。
3. **迁移线（性能）与迁移线（版本）解耦但不同轮**：`asset_versions` 是新表，与执行存储无
   依赖，理论可并行；但两条线都要动 schema，按原则 2 排成先后，不并行开两张迁移。
4. **零迁移批次并行收口**：P10-3（缓存）与 P10-5（diff 读侧）无迁移，可并行推进；缓存的
   失效策略要知道写路径最终形状，故排在 P10-1/P10-2 之后。
5. **P10-6 重定义为版本历史扩面 + 变更历史下线**（2026-09-20）：原「执行结果回放」已砍除。
   依赖 P10-4/P10-5 地基，独占一条 CHECK 扩枚举迁移（068）。

**执行序列**

| 序 | 批次 | 迁移 | 前置 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | **P10-1** 大响应体口径变更 + 转存对象存储 | 065 | — | 风险最高、口径变更，最先做、最先暴露问题 —— **已实现**（2026-09-19，见 14.1 实现状态） |
| 2 | **P10-2** 执行历史归档（分区表） | 066 | P10-1 | 对象生命周期必须先由 P10-1 定义 —— **已实现**（2026-09-20，按季分区；见 14.1 实现状态） |
| 3 | **P10-4** 统一版本模型 + 资产接入 | 067 | —（与性能线解耦） | 承接 065/066 之后，独占本迁移号 —— **已实现**（2026-09-20，见 14.3 实现状态） |
| 4 | **P10-5** 版本列表 + diff 展示 + 回滚 | 无 | P10-4 | ★diff 改动内容是硬验收项 —— **已实现**（2026-09-20，四类入口全接完；见 14.3 实现状态） |
| 5 | **P10-3** 查询缓存补齐 | 无 | P10-1 / P10-2 收口后 | 失效策略依赖写路径最终形状；可与 4 并行 —— **已实现**（2026-09-20，`lib/queryCache.ts` Redis 共享缓存 + stats/dashboard/projects 接入 + 双失效钩子；见 14.1 实现状态） |
| 6 | **P10-6** 版本历史扩面（6 类资源 + SQL 定义）+ 变更历史下线 | 068（扩 CHECK 枚举） | P10-4 / P10-5 | 原「执行结果回放」已删除（2026-09-20）；见 14.3 的 P10-6 小节 —— **已实现**（2026-09-20，后端 11 类快照/回滚 + 前端 7 类接线，`ChangeHistoryDrawer` 及其 i18n 全下线；见 14.3 的 P10-6 小节） |
| 7 | **P10-7** 前端列表首屏闪空态修复 **[x] 已实现 2026-09-19** | 无 | —（零迁移、纯前端） | 见 14.5「实现状态」 |
| 8 | **P10-8** 顶层操作区不随内容滚动 **[x] 已实现 2026-09-19** | 无 | P10-7（`ui.tsx` 与列表页重叠） | 改动面大、分三步；见 14.6 |

**关键路径**：P10-1 → P10-2 → P10-4 → P10-5（版本线不阻塞性能线，但迁移线串行）。
**可并行**：第 4 步（P10-5）、第 5 步（P10-3）不含迁移；前端线（第 7、8 步）亦可与迁移线并行。
**前端线内部串行**：P10-7 → P10-8——两者同改 `ui.tsx` 与列表页骨架，**不并行**（避免同文件互撞）。

**批次顺序**见本节，14.1 / 14.3 内的「批次顺序」只是各自小节的局部次序。

### 14.5 前端列表首屏闪空态修复（P10-7，零迁移，纯前端）

**问题（2026-09-18 用户报告）**：列表本来有数据，进入页面时会闪一下——先渲染「无数据」空态，
数据到达后再替换。项目切换时也会出现（依赖项目 store 的筛选下拉短暂清空）。

**根因（2026-09-18 定位，两类，同一症状）**

- **M1：`loading` 初值 `false` + 取数在 paint 之后的 `useEffect`**。首帧 `loading === false`
  且列表为 `[]`，直接落到 `!loading && <Empty>` 空分支。代表：`EndpointList.tsx:46 / 99-101 /
  402`；`SuiteReports.tsx:135 / 149-152 / 326`；`GlobalApp.tsx:615 / 647 / 695`。
- **M2：项目门控提前 `return`，`setLoading(true)` 在 return 之后**。形如
  `if (!projectId || loadedProjectId !== projectId || projectLoading) return;` 后才
  `setLoading(true)`——项目 store 就位前 `loading` 始终为 `false`，空态不是闪一帧，而是**持续
  整个加载窗口**。命中：`EndpointList.tsx:100`、`FlowList.tsx:53`、`SuiteList.tsx:64`、
  `SuiteReports.tsx:150`、`Alerts.tsx:103`、`IngestRuns.tsx:55`、`IngestUnmatched.tsx:78`。
- **正确写法已有先例，但只改了一页**：`Members.tsx:45-46` 明确注释「初始 true：项目 store 未
  就位前 load 不发请求，false 会让空态闪一下「还没有成员」」——其余列表仍是 `useState(false)`。
- **影响面**：约 **13 个列表组件 / ≈18 个列表 + 2 个 picker** 会闪；另有 7 页 + 3 面板此前各用
  不同写法单独加固（`useState(true)` / `loading ? … :` / `if (!x) return loading` /
  `!loading && Empty`）——**写法不统一正是只有部分页面不闪的原因**。
- **同族问题（项目切换）**：项目路由无 `key`（`main.tsx:139`），切项目**不重挂载** → 页面本地
  列表不置空，显示**上一个项目的旧数据**（另一种可见缺陷）；`projectStore.loadProject` 在
  `set({ loading: true })` **之前**先清空 `environments` / `endpoints`（`projectStore.ts:54-55`），
  故依赖 store 的筛选下拉会短暂清空；`refresh()` 从不设 `loading`（`projectStore.ts:47-51`）。
- **无共享取数层**：没有 `useApi` / `useListData` 之类 hook；`ui.tsx` 只导出 `Empty`，**没有
  loading / pending 语义**，各页自拼 `<p className="muted">{t("common.loading")}</p>`。

**修法（统一，不再逐页各写一套）**

1. **抽共享就绪语义**：`useListData`（或等价）暴露 `{ items, status: 'loading' | 'ready' |
   'error', reload }`，`loading` 由「项目就绪 + 首次取数」派生，**首帧即 loading**；或最小改法
   ——`loading` 初值 `true` + `hasLoaded` 门（**首次取数结束前不渲染 `Empty`**），照
   `Members.tsx:45-46` 先例铺到全部列表页。
2. **`Empty` 补 pending 语义**（`src/ui.tsx`）：页面不必各自拼 `!loading &&`。
3. **修 M2**：项目门控 `return` 之前不得跳过 loading——要么 return 前即判定为 loading，要么由
   第 1 条的派生状态接管，取消 ad-hoc 的 `loadedProjectId !== projectId || projectLoading`
   提前返回。
4. **项目切换**：给项目路由加 `key={projectId}`（`main.tsx`），或在 `projectId` 变化时先置
   loading 再取数——消除旧数据残留与下拉清空。
5. **统一 `projectStore`**：`loadProject` 先 `loading:true` 再清数据（或保留旧值 + pending 标记）；
   `refresh()` 明确 loading 语义。

**契约约束（quiet-console）**：列表与空态均**手写**，**不引入 antd `Table` / `Spin` /
`Skeleton`**；loading 仍是手写 `muted` 文案；**不得为遮闪加动画或过渡**（运动预算只允许状态
切换 `--t` 120ms 与唯一呼吸点）。

**边界**

- 不改任何取数接口与分页语义，纯渲染时序与状态初值。
- 「项目切换旧数据残留」（第 4 条）与「首屏闪空态」同族，**建议一并修**；若本轮只修闪屏，第 4
  条可拆出单列，落码前确认。
- **验收标准**：有数据的列表进入页面**不出现空态帧**（含项目切换）；加载中显示 loading 文案；
  空数据仍正确显示空态；双模式与 940/700/560/420 断点不回归。

**实现状态（已实现，2026-09-19）**——取最小改法，并一并修项目切换（用户口径「不闪屏」）：

- **修法选型**：不引入 `useListData` 共享 hook；照 `Members.tsx:45-46` 先例把列表页 `loading`
  初值改为 `true`（首次取数结束前不落 `!loading && <Empty>` 空分支），一处消除 M1/M2 两类闪空态。
  `ui.tsx` 的 `Empty` **不加 pending 语义**：各页既有 `!loading &&` 守卫配合初值 true 即已不闪，
  改 `Empty` 签名要动所有调用点、收益不抵改动面。
- **落码文件（11 个列表 `loading` 初值 false→true）**：`Alerts` / `EndpointList` /
  `ExecutionRecords` / `Environments` / `GlobalApp`（项目卡片墙）/ `FlowList` / `SuiteList` /
  `SuiteReports` / `IngestRuns` / `IngestUnmatched` / `ResourceSchedules`。已 `useState(true)` 的
  页面（`Members` / `CiTaskList` / `TestPlans` / `MockList` / `NotificationsPage` / `PublicScripts`
  / `DataSourceList` / `DataSourceDetail`）与非 `!loading` 门控页（`McpPage` 走 `tools===undefined`、
  `Trends` 走状态机）不动。
- **第 4 条（项目切换旧数据残留）一并修**，未用 `main.tsx` 路由级 `key`（会重挂整壳、切项目闪
  一下侧栏/顶栏），改为 `ProjectShell.tsx` 给 `<Outlet key={projectId}>`：切项目只重挂正文、壳保持
  挂载，页面本地列表状态随之复位，消除旧数据残留且不闪壳。
- **第 5 条 `projectStore.loadProject`**：改为**先 `set({ loading:true })` 再清 `environments`/
  `endpoints`**，依赖 store 的筛选下拉据此显示「加载中」而非在清空到重取之间闪一帧空列表。
  `refresh()` 维持不设 loading（只刷项目列表/角色，不属首屏取数窗口）。

### 14.6 顶层操作区不随内容滚动（P10-8，零迁移，纯前端，改动面较大）— **[x] 已实现 2026-09-19**

**问题（2026-09-18 用户报告）**：大部分页面下滑时，顶层操作区（搜索、新建、保存、筛选）会
被一起滚走，用户必须在滚动中途回滚到顶部才能操作。期望：**顶层操作部分保持不动**，只有下方
列表 / 正文滚动。

**现状核对（2026-09-18 定位，结构性事实）**

- **滚动归属有利**：全站只有一个纵向滚动容器 `.content`（`design-system.css:590-599`，
  `.console` 100dvh + `overflow: hidden`，`.topbar` 在文档流内无 `position`）。因此
  `position: sticky; top: 0` 在 `.content` 内即天然落在 52px topbar 之下，无需手算 topbar 高度。
- **`.table-scroll` 只横向滚动**（`3704-3705`，`overflow-x: auto`，无 `max-height`）——列表页
  仍是单一纵向滚动上下文，**sticky 可行**；这也是唯一利好。
- **⚠ `.grid { overflow: hidden }`（`853-860`）与 `.table-scroll { overflow-x: auto }` 是
  sticky 包含块**：任何放进它们内部的 sticky（如未来的表头吸附）都会失效——本次需绕开。
- **页面骨架不统一，共四种组合**：① `page-head` + `filter-bar` 与 `table-scroll` 平级
  （EndpointList / ExecutionRecords / SuiteList / FlowList / Environments / Members / TestPlans /
  Trends …）；② `page-head` + `.tabs`（Environments / Alerts / McpPage / SystemPage）；③
  `RepoPageHead` + `RepoTabs`（六个 repo 页，且 `CiTaskList` 中间夹了 `readouts` KPI 块）；
  ④ 头部嵌在包装层里（**SpecCases 的 `filter-bar` 在 `.spec-split` 右列内**；全局页在
  `.page-card` 内）。**没有单一 class 可改，也没有全局挂载点**——`.content` 由各页各自
  `return <main className="content">` 生成，`ProjectShell`/`GlobalApp` 只提供外层 `.frame`。
- **已有 sticky 元素会与之一撞**，且各自写死偏移：`.spec-tree { position: sticky; top: 0;
  height: calc(100dvh - 150px) }`（`1696-1704`）、`.workbench-side { top: var(--s4) }`（`2432`）、
  `.history-rail { top: var(--s5) }`（`2479-2481`）、`.picker-group td { top: 0 }`（`3132-3140`，模态内）。
- **写死的视口高度假定「顶部没有吸附条」**：`.spec-tree` `100dvh - 150px`（1698）、
  `.mindmap-canvas` `100dvh - 205px`（1861）、`.history-card` `calc(100vh - 210px)`（2434）、
  `.flow-canvas` 族 `100dvh - 300px`（3371）——加吸附条后**全部要重算**。
- **宽度与背景**：`.content > * { max-width: var(--measure) }`（`602`，--measure 1680px）——吸附条
  直接做成 `.content` 子元素在超宽屏**只覆盖到 1680px，右侧会露出滚动内容**；且吸附条必须给
  不透明底色，否则内容透字。
- **层级无预留**：`.topbar` / `.content` 均无 `z-index`。吸附条必须**在表格之上、在正文浮层
  之下**——正文浮层有 `z-index: 10/11/30`（`var-picker-scrim` 10、`var-picker-pop` 11、
  `mindmap-menu` / `var-field-pop` / `assistant-cmd-pop` 30），antd 门户 1000+。
  ⚠ `.var-picker-scrim` 是 `position: fixed; inset: 0; z-index: 10` 的全屏遮罩。
- **断点**：≤560px `.content` 内距改 `var(--s5)`，且 `.page-head` 变纵向堆叠（1524-1557）——
  吸附条在小屏**变高**，本就吃紧的纵向空间更少。
- **影响面**：约 **28 个页面级组件 + ≈7 个嵌套 tab 面板**、其中 **≈25–28 个真有会滚走的
  搜索/新建/保存/筛选行**。其中 **工作台的「保存」条**（`EndpointWorkspace.tsx:929-931`、
  `FlowWorkspace.tsx:980`、`SuiteWorkspace.tsx`、`CiTaskEditor.tsx:376-391`）滚走体感最差。

**修法（统一组件 + 分三步铺开，不逐页各写一套）**

- **统一载体**：新增 `ui.tsx` 的 `PageToolbar`（或等价 `.page-sticky` 包装）+ 设计系统样式
  ——统一承担 `position: sticky`（`top: 0`）、**不透明底色**、内距、层级、以及**跨满滚动条
  的背景**（用负 margin / `::before` 铺满 scrollport，解决 1680px 上限与透字），并预留
  一个层级 token（介于 `1` 与正文浮层 `10` 之间）。
- **第一步（主体，覆盖绝大多数）**：把第 ①、④ 两种「`page-head` + `filter-bar` 平级」的列表页
  包进 `PageToolbar`（含**工作台的保存条**——体感收益最大，建议优先）。
- **第二步（特例）**：③ repo 页（决定 `readouts` KPI 块是否跟随吸附：建议吸附条只含
  head+tabs+filter，`readouts` 照常滚动）+ SpecCases（`filter-bar` 在 `.spec-split` 内，需按
  该网格单独粘）+ 全局页（`.page-card` 内，包含块是 `.page-card`，偏移/圆角与项目页不同）。
- **第三步（碰撞收口）**：**同步重算所有写死偏移**——`.spec-tree` / `.workbench-side` /
  `.history-rail` 的 `top` 改为「吸附条实际高度」变量，`.spec-tree` / `.mindmap-canvas` /
  `.history-card` / `.flow-canvas` 的 `calc(100dvh - N)` 跟着改；并明确吸附条在 ≤560px 的
  降级（建议小屏只吸附操作按钮行、标题让位，避免吸附条占掉过多高度）。
- **不做**：不改取数、分页、表格结构；**不引入 antd `Table` / `Spin`**；**不加动画**
  （吸附是布局行为，不是动效）。

**契约约束（quiet-console）**：吸附条属「壳/导航」范畴，必须手写；遵守「只有 `.content`
滚动」这一不变量（**不得**把吸附条做成 `position: fixed`，那会退化成第二个壳层）；视觉用
中性底（`--surface`/`--bg`）+ 既有 `--line` 分界，**不得**用语义色或阴影做「浮起感」；吸附
条自身不进动效预算。

**边界与决策点（落码前确认）**

1. **吸附范围**：只吸附「操作行」（新建/搜索/筛选）还是连 `page-head` 标题一起吸附？建议
   一起（否则标题滚走后页面失去上下文），但小屏需降级。
2. **单条还是多条**：`ExecutionRecords` 的 `filter-bar` 很高、`CiTaskList` 中间夹 `readouts`
   ——吸附条过高会挤占正文，建议**限制吸附条总高并在过高时只吸附首行**。
3. **SpecCases 的 `.spec-tree`** 已经 `sticky top: 0` + `100dvh - 150px`，与吸附条是**同一
   滚动上下文里的两个 sticky**，必须一起改，属本批风险最高点。
4. 工作台（编辑器类）与列表页是否同批——建议同批，但可拆成「列表页 / 编辑器」两次验收。

**验收标准**：① 列表页下滑时 `page-head` + 操作/筛选行**保持可见**，正文从其下方穿过；
② 吸附条背景**不透明且铺满滚动条宽度**（超宽屏右侧不露字、不透字）；③ 吸附条层级**在
表格之上、在 `var-picker` 等正文浮层之下**，打开浮层时不被压在下面；④ `.spec-tree` /
画布 / 历史栏等既有 sticky 与写死视口高度**无重叠、无裁切**；⑤ 940/700/560/420 断点与双
模式不回归（含 ≤560px 的降级形态）；⑥ 无新增动画；⑦ 无横向滚动（`scrollWidth === clientWidth`）。

**实现状态（分三步、每步停下供验收；吸附范围取「head + 操作/筛选行一起吸、小屏降级」）**

- **决策点定案**：① 吸附范围＝`page-head` + 操作/筛选行一起吸；② 过高的 `filter-bar`（如
  `ExecutionRecords`）本轮先整条吸附，限高/只吸首行留作第三步小屏降级一并处理；③ `.spec-tree`
  等既有 sticky 的偏移重算在第三步；④ 列表页与工作台/编辑器分批验收——**第一步只做列表页**。

- **[x] 第一步（已实现 2026-09-19）——统一载体 + 主体列表页**：
  - `ui.tsx` 新增 `PageToolbar`（纯承载节点，不做 `position:fixed`）；`design-system.css` 新增
    `.page-toolbar`：`position:sticky; top:0`、层级 token `--z-page-toolbar:5`（表格之上、
    `var-picker-scrim`10 之下）、不透明底 `--bg`、靠负外边距把底色铺过 `.content` 顶/侧留白与
    超宽屏右侧（解决 1680px 上限与透字）、`--line` 分界、条内 measure 与纵向间距统一接管。
  - `.content` 顶/侧内边距抽成 `--content-pad-top`/`--content-pad-x` 变量，`.page-toolbar` 据此
    对齐；`data-topnav`（全局壳）改写为覆盖该变量（全局页正文在第二步接入）。
  - 铺到组合①列表页共 **10 个**：`EndpointList` / `FlowList` / `SuiteList` / `ExecutionRecords`
    / `Members` / `TestPlans`(列表) / `DataSourceList` / `MockList` / `SuiteReports`(列表) /
    `Trends`。（`EndpointList` 的 `bulk-bar` 选中条留在吸附条之外，随正文滚动。）

- **[x] 第二步（已实现 2026-09-19）——组合②/③ 起步，后续经卡片化改版铺满全部页面**：
  - **[x] 组合②`.tabs` 页**：`Environments`（page-head + envs/scripts tabs 一起吸；envs 的
    `filter-bar` 留在正文）、`Alerts`（page-head + channels/rules/deliveries tabs）、`McpPage`
    （仅 page-head）。
  - **[x] 组合③ repo 页 5 个**：`CiTaskList` / `RepoCaseTree` / `IngestRuns` / `IngestUnmatched`
    / `RepoCredentials`——各自把 `RepoPageHead` + `RepoTabs` 包进 `PageToolbar`；`CiTaskList` 的
    `readouts` KPI 块留在吸附条外照常滚动（决策点 2 定案）。
  - **[ ] 顺延到后续**：工作台保存条（结构与列表页不同、与 `.workbench-side`/`.history-rail`
    既有 sticky 交叉，需随第三步偏移重算一起做）；组合④ 全局页（在 `.page-card` 内，包含块不同，
    需先核 `.page-card` 是否形成 sticky 包含块）与 `NotificationsPage`/`MePage`（全局壳内）；
    `SpecCases`（`.spec-split` 内，与 `.spec-tree` 同上下文，计划列为本批最高风险）；详情页
    `SuiteReportPage`/`TestPlanPage`/`DataSourceDetail`。

- **验收反馈修正（2026-09-19，第二步中）**：
  1. **吸附条与正文分开**：`.page-toolbar` 底色由 `--bg` 抬到 `--surface`，**去掉 `border-bottom`
     分界线**（下方可滚动内容自带边框，再画线会与它的顶边打架）；条内下缘留 `--s4`、与正文再由
     `margin --s5` 拉开。确立纪律：**搜索/筛选输入框必须留在吸附区内**（`Environments` 原把 envs
     的 `filter-bar` 漏在滚动区，滚动时输入框顶部被吸附条盖住，已移入 toolbar）。
  2. **删除列表页中间态**：移除 `正在搜索…`/`common.loading` 这类首屏 loading 文案（12 个列表页：
     `EndpointList`/`FlowList`/`SuiteList`/`ExecutionRecords`/`SuiteReports`/`Environments`/
     `Members`/`TestPlans`/`DataSourceList`/`MockList`/`CiTaskList`/`IngestRuns`/`IngestUnmatched`/
     `Alerts`），加载期间**不渲染任何中间态**；`Empty` 仍由 `!loading` 守卫（空数据不闪）。
     保留：`CiTaskList` 展开行内的 `historyLoading`、`RepoCaseTree` 未放置面板、`Trends` 图表
     状态机与详情页（`TestPlanPage`/`SuiteReportPage`）的加载态——那些不是列表首屏闪屏。
  2b. **补齐（2026-09-19）**：`PublicScripts`（环境页 scripts tab）与 `RepoCaseTree` 主列表上
     残留的 `common.loading` 中间态一并移除（`Empty` 仍由 `!loading` 守卫）；`IngestRuns`
     展开行内的明细 loading 同样改为加载期间不渲染。仍保留的是「非列表首屏」加载态：
     `CiTaskList` 展开行 `historyLoading`、`RepoCaseTree` 未放置面板与 `SpecCaseDrawer`、
     勾选执行的触发弹窗任务列表、`Trends` 图表状态机、详情页加载态。

- **卡片化改版（2026-09-19，第二步中；目标形态由「吸附条」改为「上下两张同宽卡片」）**：
  - **形态**：`.content-split`（纵向 flex + `overflow:hidden`，正文不再整体滚动）把列表页
    `main.content` 分成两张同宽卡片——上卡 `.page-toolbar`（`position:static`、边框圆角，
    承载标题/描述/操作/搜索/筛选，固定不滚），下卡 `.list-card`（`display:flex;
    flex-direction:column; overflow:hidden`，卡内滚动、表头吸附、滚动条在卡内），两卡间
    `--s4` 间隙。高度由 flex 分配，不写死视口高度，标题行高变化不再裁切列表。
  - **滚动归属（关键约束）**：表格页的滚动必须落在 `.list-card > .table-scroll`（`flex:1;
    min-height:0; overflow:auto`）——`.table-scroll` 自身即滚动包含块，表头吸附才成立。
  - **新增通用滚动容器 `.list-scroll`**（非表格内容：统计读数/图表/分区面板/树）：`flex:1;
    min-height:0; overflow:auto`，内容按普通块流排，不被当成卡的 flex 子项压扁、也不会像
    没有滚动容器那样被整块裁掉；空态用 `min-height:100%` 撑满滚动视口后居中。**表格页不得
    用它**（滚动祖先变了会失效表头吸附）。`.list-card > * { min-width:0 }` 保留（防宽内容
    撑破卡边）。
  - **已卡片化**：`Environments`（样板）/ `EndpointList` / `FlowList` / `SuiteList` /
    `DataSourceList` / `IngestRuns` / `IngestUnmatched` / `RepoCredentials` / `Members` /
    `MockList` / `SuiteReports` / `Alerts` / `CiTaskList`；`Trends` 本轮改用 `list-scroll`
    （非表格页原先无滚动容器，被 `overflow:hidden` 整块裁掉且不能滚）。
  - **本轮新增**：`ExecutionRecords`（三种 `recordType` 分支同一时刻只渲染一条，卡内始终
    只有一个 `.table-scroll`）、`TestPlans`（列表）、`RepoCaseTree`（覆盖率 KPI 连同
    `countingNote` 从正文移入上卡，树体走 `list-scroll`）、`McpPage`（三个分区面板走
    `list-scroll`）。
  - **同根因补齐**（卡片化后卡内没有纵向滚动容器、内容被 `overflow:hidden` 整块裁掉）：
    `RepoCredentials`（分区面板走 `list-scroll`）、`SuiteReports`（裸 `report-grid` 表补
    `.table-scroll`）、`Alerts` 派发 tab（裸表补 `.table-scroll`）、`PublicScripts`
    （环境页 scripts tab 的列表补 `.list-card`，此前 fragment 直挂 `.content-split` 无滚动）、
    `IngestUnmatched`（不变量说明与「显示已静默」筛选移入上卡，主表 + 分页 + 末尾「判定规则」
    面板统一走 `list-scroll`——此前面板作卡内静态页脚会被裁掉且够不着）、`Members`
    （成员表与「最近审计」表同卡两张 `.table-scroll` 抢 `flex:1`，改为整块 `list-scroll`）。
  - **已知待办**：`IngestUnmatched` 的末尾「判定规则」面板与主表同卡（主表 `table-scroll`
    占 `flex:1`，面板作静态页脚，展开较高时会被裁）；过高 `filter-bar` 在小屏仍占较多高度
    （限高留待后续，小屏的「装不下」已由本节末的小屏兜底解决）。

- **剩余页面收口（2026-09-19 续做）**：
  - **详情页转卡片**（`content-split` + 上卡 head/读数 + 下卡 `list-scroll`）：`TestPlanPage`
    （读数进上卡、项表进下卡直接 `table-scroll`）、`SuiteReportPage`（`SuiteReportDetail`
    拆 `head`/`body`，站内视图两张卡；分享页仍返回原始片段）、`DataSourceDetail`（head +
    tabs 进上卡，配置/SQL 分支进 `list-scroll`）、`PipelineRunPage`（`RepoPageHead` 进上卡，
    facts/notes/tabs/面板进 `list-scroll`）、`ProjectAuditPage`（审计表走 `list-card`）。
  - **工作台保存条**：`EndpointWorkspace`（page-head + case-banner 进上卡，workbench 进
    `list-scroll`）、`SuiteWorkspace`（page-head + run-bar 进上卡）、`CiTaskEditor`（页头 +
    `RepoTabs` 进上卡，分区面板进 `list-scroll`）。`FlowWorkspace` 不改：`.flow-content`
    本身是定高 flex 列（画布撑满、`.content` 不滚），页头原本就常驻。
  - **用例库 `SpecCases`**：head + `filter-bar` 进上卡（`filter-bar` 从 `.spec-split` 右列
    移到上卡），`.spec-split` 进 `list-scroll`；`≥941px` 时卡片给高度、左右两栏各自滚
     （新增 `.list-card .spec-split`/`.spec-tree` 规则与右列 `.spec-main`），左树不再按视口
     写死 `100dvh - 150px`。
  - **筛选条进上卡 / 成员页去审计（2026-09-19 验收反馈）**：`IngestRuns`（筛选 + 总数）、
    `Alerts` 派发 tab、`ProjectAuditPage`（描述进 `page-head`、筛选项进工具卡）的筛选项从
    列表卡移到工具卡——只筛下面那张表的控件与它筛的表分居两卡，会读成「三个标签各管一段」。
    `AuditLogsPanel` 为此拆成 `useAuditLogs`（状态）/ `AuditLogsFilters` / `AuditLogsTable`
    三块，系统页那个自足面板的渲染不变。`Members` 删除表尾「最近变更（审计，最近 50 条）」
    摘要：它与项目「审计日志」页同接口、同一批行，留着只是把一份可下钻的清单复述成不可
    下钻的 50 行；随之删掉 `auditLogs` 状态、`AuditDetail` 依赖与 `members.auditTitle` /
    `members.auditEmpty` 两个 i18n 键（中英各一份）。
  - **全局层**：页面装在单张 `.page-card` 里。**改为「卡内滚动」**（2026-09-19 验收：卡内
    sticky 会让正文滑到操作区之上/之下重叠）——`.content` 不再滚动，`.page-card` 撑满视口
    高度成 flex 列，`.page-card-toolbar` 固定在卡顶（flex、非 sticky），正文在
    `.page-card-body` 里滚动；铺到 `DashboardPage`（head + 筛选提示）、`ProjectsPage`
    （head + filter-bar）、`SystemPage`（head + tabs）、`MePage`（head + tabs）。
  - **第三步碰撞收口（本轮做掉的部分）**：`.list-card .mindmap-canvas` 改为填满右栏
    （`height:100%`）、`.list-scroll .history-card` 高度按卡高重算（`calc(100dvh - 300px)`）；
    `.workbench-side`/`.history-rail` 的 sticky `top` 仍在卡内生效（口径与原文一致）；
    `≤560px` 新增卡片内距收紧。`FlowWorkspace` 的 `.flow-canvas`/`.flow-list-wrap` 写死高度
    未动（该页未进卡片模型）。
  - **未做/待验收**：`SpecCases`、工作台、全局层与详情页改版需**人工目视验收**（本次未跑
    build/preview）；`.spec-tree` 在 `≥941px` 的「卡内定高 + 双栏自滚」是最大改动点。

- **[x] 第三步（碰撞收口，已实现 2026-09-19）**：`top` 与写死 `calc(100dvh - N)` 已在卡片化页面按卡高重算
  （见上）；`≤560px` 卡片内距降级已加。**残留小尾（不阻塞本阶段）**：过高 `filter-bar` 限高、
  `.flow-canvas` 族若日后进卡片模型需再算。

- **[x] 小屏兜底补做（2026-09-21，纯 CSS，用户实测后补）**：卡片模型的隐性前提是「高度
  充裕」——矮视口/窄屏下工具卡换行变高会把下卡压扁。补三件事：① `.content-split` 装不下时
  自己滚（滚动仍落在规则 5 的 `.content` 上，不再 `overflow: hidden` 裁掉工具卡下缘）；
  ② `.list-card` 保底 `min-height: 240px`，不再被 flex 压成一条缝；③ **≤560px 走「紧凑档」
  而不是退回整页滚动**（用户定案 2026-09-21：卡片模型保留——工具卡常驻、列表卡吃到视口底，
  即本节决策点 1 的「小屏降级」按「收工具卡」而非「让操作区滚走」落地）：标题与操作合并
  一行（原先纵向堆叠要 100px 上下）、描述收成一行截断、标题 19→17px / 描述 13→12px、
  壳与两卡内距各收一档；表格正文 13px / 表头 11px / mono 不动。整页滚动降级只留
  **极端矮视口**（`max-height: 460px`，横屏手机 / 桌面矮窗口）。全局层 `.page-card`
  同根因同修（`overflow-y: auto` + 正文保底高度，极端矮视口 `height: auto` 交回 `.content` 滚）。
  ④ **窄/矮窗口的横向收口（同日第二轮，用户截图复核后补）**：行操作列改 `position: sticky;
  right: 0`（超宽表横向溢出时操作列钉在容器右缘，「看不到操作按钮」不再依赖横滑）；
  `≤1100px` 收掉创建人/更新人两列（共 296px，详情与审计可查），把宽度还给名称与操作列；
  紧凑档触发改为 `max-width: 560px` **或** `max-height: 620px`（1000×490 这类半屏窗口同样生效）。
  缺陷本身的过程记录见 `issue_fix/` 的 P10-8 小屏记录；`filter-bar` 限高仍未做。

---

## 十五、依赖与里程碑

### 15.1 新增依赖（八个阶段合计）

| 阶段 | 依赖 | 用途 | 备注 |
| --- | --- | --- | --- |
| P6 | — | — | 零（邀请码 scrypt 照抄第三次……第五次） |
| P7 | `exceljs` | `.xlsx` 固定模板解析 + 计划 CSV 导出的升级路径 | 后端按需 `import()`，不进启动路径 |
| P8 | — | — | 零（手写 SVG 是定案） |
| P9 | — | — | 零（Canvas 2D 人物、SSE 复用既有） |
| P10 | — | — | 零（查询缓存复用 P1 已装的 `ioredis`；对象存储抽象已于 P4.5 落地 `lib/objectStore.ts`；版本历史复用既有 JSONB 与审计设施；插件机制 2026-09-18 砍除，不引入插件加载/沙箱依赖） |
| P12 | — | — | 零（MCP SDK / scrypt / 既有 pg 与 antd 全复用） |
| P13 | — | 迁移 070（`mcp_binding_requests` + 通知 kind 扩值；2026-09-21 二轮反馈的 MCP 绑定许可申请） | 信息架构三项零后端；MCP 绑定许可申请为迁移 070 + 五条 REST + `/mcp` 闸门放宽 |
| P14 | — | — | 零（可见性拆层是既有查询的改写；审批流 REST / 站内信 / 成员 upsert 全复用既有设施） |

### 15.2 里程碑（并入主计划 12.1 表）

| 里程碑 | 阶段 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| M8 | P6 | 注册 + 成员与角色 + 三级权限 + 审计可读 | 邀请码注册即入项目；viewer 界面无写入口；成员变更可审计 |
| M9 | P7 | 文本用例库 + XMind/Excel 导入 + 绑定 + 测试计划 | 300 条 XMind 导入正确；自动化覆盖率可读；计划可标结果可导出 |
| M10 | P8 | 口径收口 + 失败归因 + 全局/项目统计 + 下钻 | 四处通过率一致；归因分布与覆盖率同屏；图表 hover/下钻可用；零图表库 |
| M11 | P9 | 站内助手 + 站内通知（教程 2026-09-16 移出至 P13 / M14） | 代理对话可用且 Key 不出服务端；proposal-first 闭环；通知小红点 + 弹窗 |
| M7 | P10 | 性能 + 版本历史 + 前端体验（原 P6 顺延；插件机制 2026-09-18 砍除） | 支持 1000+ 并发执行；**变更历史可查看改动内容（diff）**；**有数据的列表首屏不出现空态帧**；**下滑时顶层操作区保持可见** |
| M12 | P11 | 列级归属 + 资源 CRUD 全审计 | 任意核心资源可查「谁建/谁改」（列表直读 + 审计下钻两路）；系统写入显示「系统」；viewer 无审计读权 |
| M13 | P12 | 个人中心 + 用户级 MCP Token | 一把 token 跨项目（A 写 B 读同一会话完成）；个人中心集齐改密/通知查看全部/MCP Token/agent 凭据挂点；项目侧绑定可见可踢；吊销/解绑/关闸/降权即时生效 |
| M14 | P13 | 个人中心并入助手卡片 + 卡内问候 + `/docs` 文档（2026-09-21 改题，原「新手教程」砍除） | `/me` 路由删除且五 tab 内容在卡片内功能完整；基本信息无改密表单（抽屉改密保留）；卡片空态 `HI, {{用户名}}` 双语；头像旁 `_blank` 打开 `/docs`，左目录 + 右正文双语；无 `/me` 死链 |
| M15 | P14 | 项目可见性两层 + 权限申请审批流（自 13.7 转正） | 非成员可见项目身份（名称/描述）但任何指标不可见，看板聚合分母不含非成员项目；URL 直达渲染「无权限」落地页而非裸 403；申请→站内信通知 project_admin→批准（走既有成员 upsert）/拒绝→结果通知申请人全程闭环；同一 (project, user) 只有一条 pending |

### 15.3 主计划与规格已同步的编辑（2026-09-04 全部完成）

- [x] 主计划原「十、P6 性能/插件/版本」→「十四、P10」（内部 10.x → 14.x）。
- [x] 主计划 9.8 加指针：P9 已立项，见本文件十三章。
- [x] 主计划「一、整体路线图」ASCII 图扩为 P0…P10。
- [x] 主计划头部加「P6–P9 已规划」说明与本文指针。
- [x] 主计划「十一、依赖安装清单」（P7 `exceljs` 行）与「十二、里程碑」（M8–M11 + M7 改挂 P10）。
- [x] `API_AUTOMATION_SPEC.md` 路线表补 P6–P10 行。
- [x] 全文旧「P6 10.1」类引用改为「P10 14.1（原 P6 10.1）」。

### 15.4 P10 并入本文件（2026-09-05 完成）

- [x] 主计划「十四、P10 — 性能、插件、版本」整章移入本文件（十四章，紧跟十三章），内容原样未改。
- [x] 文件更名 `DEVELOPMENT_PLAN_P6-P9.md` → `DEVELOPMENT_PLAN_P6-P10.md`，标题与头部归属/章节映射说明同步。
- [x] 15.1 补 P10 零新增依赖行（「四个阶段合计」→「五个阶段合计」）；15.2 补 M7 行（与主计划 12.1 表一致）。
- [x] 主计划十四章原位替换为一行指针；头部说明、路线图 ASCII、9.8、依赖清单、里程碑表中的文件名引用同步更名。
- [x] `API_AUTOMATION_SPEC.md` 路线表 P6 行的文件名引用同步更名。

### 15.5 P11 立项并入本文件（2026-09-07 完成）

- [x] 新增十六章 P11 — 资产归属（列级 created_by/updated_by + 审计级 audit_logs 接入），
  范围、边界 11 项、迁移示意、改动量摸底与分批（第一轮 P11-1 ~ P11-8 / 第二轮 P11-9 ~
  P11-10，实施顺序见 16.6）全部落在本文件。
- [x] 15.2 里程碑表补 M12 行（与主计划 12.1 表一致）。
- [x] 主计划新增「十五、P11 — 资产归属」指针章 + 路线图 ASCII / 头部说明 / 12.1 里程碑表同步。
- [x] 本文件标题与头部归属、章节映射说明扩为 P6–P11。

### 15.6 P12 立项并入本文件（2026-09-14 完成）

- [x] 新增十八章 P12 — 个人中心 + 用户级 MCP Token（token 归人、绑定归项目、scope
  放绑定上、工具面 projectId 参数化、read 补活体复查；全局层 /me 页集齐改密 /
  通知查看全部 / MCP Token / agent 凭据挂点），范围、边界 12 项、迁移示意、改动面
  摸底与分批（P12-1 后端 / P12-2 前端）全部落在本文件。
- [x] 13.0 的 P9-4b「个人信息界面另行规划」补指针：落点 = P12 个人中心的 agent
  凭据 tab（若 P9-4b 先行则先建最小页，P12 扩为完整个人中心）。
- [x] 15.1 补 P12 零新增依赖行（「五个阶段合计」→「六个阶段合计」）；15.2 里程碑表
  补 M13 行（与主计划 12.1 表一致）。
- [x] 主计划新增「十六、P12」指针章 + 头部说明 / 路线图 ASCII / 9.0 Token 形状修订
  指针 / 12.1 里程碑表同步。
- [x] 本文件标题与头部归属、章节映射说明扩为 P6–P12。

### 15.7 文件更名 P6-P10 → P6-P12（2026-09-14 完成）

- [x] `DEVELOPMENT_PLAN_P6-P10.md` → `DEVELOPMENT_PLAN_P6-P12.md`（随 P12 立项，
  覆盖范围扩为六个阶段；同 15.4 的 P6-P9 → P6-P10 更名先例）。
- [x] 全仓活指针同步：主计划 12 处（头部说明 / 十四~十六章指针章 / 里程碑表）、
  `API_AUTOMATION_SPEC.md` 路线表 2 处、`issue_fix/` 索引与记录 6 处。
- [x] 15.4 历史记录中的旧文件名（P6-P9 → P6-P10 那一行）保留原文不改——它记录的是
  2026-09-05 那次更名的事实。

### 15.8 P13 立项并入本文件（2026-09-16 完成）

- [x] 新增十九章 P13 — 新手教程（P9-7「教程骨架 + 主线 5 步 + 双 i18n」**整项移出**：
  范围、边界（数据驱动骨架 + 一条 5 步主线 + 侧边卡片描边 + `data-tour` 标靶）、
  前端改动面与验收门槛随迁；迁移零新增——完成态走 `preferences` JSONB 加键）。
- [x] 十三章收窄：章题去「新手教程」；边界 7 / 13.4 的 P9-7 行 / 验收门槛 10 删除线
  处理并留指针（P9-8 编号保留，批次不再复用 P9-7）；13.3 教程条目移入 19.0。
- [x] 15.1 补 P13 零新增依赖行（「六个阶段合计」→「七个阶段合计」）；15.2 里程碑表
  M11 交付物去教程、补 M14 行（与主计划 12.1 表一致）。
- [x] 主计划新增「十七、P13」指针章 + 头部说明 / 路线图 ASCII / 9.8 / 12.1 里程碑表
  同步。
- [x] 本文件标题与头部归属、章节映射说明扩为 P6–P13。
- [x] 文件更名 `DEVELOPMENT_PLAN_P6-P12.md` → `DEVELOPMENT_PLAN_P6-P13.md`（随 P13
  立项，同 15.4 / 15.7 更名先例）；全仓活指针同步，历史记录中的旧文件名保留原文
  （15.7 那条纪律沿用）。

### 15.8b P13 改题（2026-09-21 用户确认）

- [x] 十九章改写：原「新手教程」v1.0 整项砍除（存档留档不实现），P13 改为三项——
  ① `/me` 五 tab 并入 `AssistantDock` + 删 `/me` 路由 + 删基本信息改密表单 +
  旧回链改跳抽屉；② 助手卡片空态问候改 `HI, {{用户名}}`（双 i18n）；
  ③ 新增应用内 `/docs`（头像旁 `_blank` 入口、左目录 + 右正文、双 i18n、初稿本方起草）。
  范围 / 边界 4 条 / 前端改动面 / 验收门槛 5 条 / 实施批次 P13-1~P13-3 / M14 / 明确不做
  同步重写。
- [x] 头部说明补 2026-09-21 P13 改题块；15.1 P13 依赖行改为「纯前端信息架构调整，
  无后端 / 无迁移」；15.2 里程碑 M14 交付物与验收标准改写；M11 行的「教程移出至 P13」
  措辞保留（历史事实）。
- [ ] 主计划 `DEVELOPMENT_PLAN.md` 十七章指针 / 头部 P13 说明 / 路线图 ASCII /
  9.8 段 / 12.1 里程碑 M14 行同步（本轮同步）。
- 注：文件名 `DEVELOPMENT_PLAN_P6-P14.md` 不变（阶段编号未变，仅 P13 换题）。

### 15.8c P13-1 二轮反馈并入（2026-09-21 完成）

- [x] 新增 19.0b「P13-1 二轮反馈」：三项反馈的范围与边界（通知回收进抽屉 / MCP Token
  平铺 + tab 常驻 / MCP 绑定许可申请）。
- [x] 19.0 第 1 项「通知」条加回退标记、范围新增第 4 项；边界 1 由「零后端、零迁移」
  改为「信息架构零后端，第 4 项带迁移 070 + 五条 REST」；19.2 M14 验收标准扩写；
  19.3 明确不做补 MCP 申请的边界与「通知全量分页页不再提供」。
- [x] 19.1 批次表补 P13-4 行（**已实现**）；新增 19.5 实现记录（后端迁移 / lib /
  五条 REST / 闸门放宽 + 前端申请与审批面板 + 口径说明）。
- [x] 15.1 P13 依赖行由「零」改为「迁移 070（`mcp_binding_requests`）+ 五条 REST +
  `/mcp` 闸门放宽」；头部说明补 2026-09-21 二轮反馈块。
- [x] 主计划 `DEVELOPMENT_PLAN.md` 十七章指针 / 头部 P13 说明 / 路线图 ASCII /
  12.1 里程碑 M14 行同步（本轮同步）。

### 15.8d P13 三轮反馈并入（2026-09-26 完成）

- [x] 新增 19.0c「P13 三轮反馈」：① 「个人凭证」拆为「API Key 凭证 / agent 凭证」
  两 tab（agent 凭证读取设置内的列表，只读 + 「去配置」跳设置卡预选上游）；
  ② 聊天窗展示会话绑定的 agent 上游（切换器 chip + 选项后缀 + 新会话默认上游提示），
  并记下「上游 A 会话切默认到 B 后旧会话照常收发」的行为答复与三条例外。
- [x] 19.1 批次表补 P13-5 行（**已实现**）；19.2 M14 验收标准补凭证拆 tab 与
  聊天窗上游展示，分区清单改为五 tab。
- [x] 主计划 `DEVELOPMENT_PLAN.md` 十七章指针补 2026-09-26 三轮反馈块（本轮同步）。

### 15.8e `/docs` 站内助手节补「只做转发、不记历史」（2026-09-27）

- [x] `docs.section.assistant.body`（双语）新增边界描述：平台是哑管道，消息只转发给
  上游、回复流式转发回来，对话正文不在平台落库；历史保存在上游、重开时向上游回放；
  平台只留会话映射（绑定上游 + 标题摘要）。顺带把原「历史消息按会话保存」的歧义
  措辞改掉（听起来像平台存正文）。

### 15.9 P14 立项并入本文件（2026-09-16 完成）

- [x] 新增二十章 P14 — 项目可见性两层 + 权限申请审批流（**13.7 后置增补转正**：
  取向六条与现状锚点原样随迁 20.0 并扩编为范围 / 边界 / 迁移示意 / 路由示意 /
  改动面 / 批次与门槛；13.7 原位改为转正指针，正文不再重复维护）。
- [x] 13.0「后置增补之二」段落去「不排期」口径，补 P14 指针。
- [x] 15.1 补 P14 零新增依赖行（「七个阶段合计」→「八个阶段合计」）；15.2 里程碑表
  补 M15 行（与主计划 12.1 表一致）。
- [x] 主计划新增「十八、P14」指针章 + 头部说明 / 路线图 ASCII / 12.1 里程碑表同步。
- [x] 本文件标题与头部归属、章节映射说明扩为 P6–P14。
- [x] 文件更名 `DEVELOPMENT_PLAN_P6-P13.md` → `DEVELOPMENT_PLAN_P6-P14.md`（随 P14
  立项，同 15.4 / 15.7 / 15.8 更名先例）；全仓活指针同步，历史记录中的旧文件名保留
  原文（15.7 那条纪律沿用）。

---

## 十六、P11 — 资产归属（谁创建 / 谁更新，列级 + 审计级，约 1.5 周）

> 版本: v1.1（2026-09-07 立项，范围与边界已确认；2026-09-17 增补边界 11「触发人可见」；
> P11-1 ~ P11-10 已实现——见 16.6 实现状态）。

### 16.0 P11 范围与边界（2026-09-07 确认）

**问题**

平台的核心资源**没有归属概念**：接口、用例、环境、流程、套件等 P0–P3 时代的表只有
`created_at` / `updated_at`，没有任何 user 列。「这个接口谁建的」「上次是谁改的」
在平台上无处可查——出问题只能翻日志，交接只能靠口口相传。

**现状盘点（2026-09-07 摸底）**

- **已带归属的表（P4.5 之后建的，天生有 `created_by`）**：`ci_tasks`、`git_credentials`、
  `ingest_tokens`、`ingest_path_rules`、`runner_tokens`、`mcp_tokens`、`report_shares`、
  `invitations`、`spec_cases`、`spec_case_links`、`test_plans`（owner）、
  `pipeline_runs`（triggered_by）。**本阶段不动它们。**
- **完全无归属的 14 张核心表**：`endpoints`（001）、`test_cases`（007）、
  `environments`（001）、`flows`（012）、`test_suites`（026）、`scripts`（011）、
  `data_sources` / `sql_definitions`（016）、`mocks`（028）、`schedules` /
  `webhook_triggers`（030）、`notification_channels` / `alert_rules`（031）、
  `spec_modules`（052）。
- **可复用的既有设施**：`audit_logs` 表 + `writeAuditLogAsync()`（fire-and-forget，
  `lib/audit.ts`）+ `AUDIT_ACTIONS` 枚举——但只覆盖 CI 触发、Token 签发与 P6 用户/
  成员动作，核心资源 CRUD 完全没接；读侧 `GET /projects/:id/audit-logs`
  （project_admin 限定）与前端 `AuditLogsPanel.tsx` 现成。

**两个层次（都做，分两批）**

- **方案 A — 列级归属**：回答「谁建的、谁最后改的」。14 张表各加 `created_by` /
  `updated_by`，列表页直接显示。
- **方案 B — 审计级归属**：回答「谁在什么时候改了什么、改了几次」。核心资源 CRUD
  接入 `audit_logs`，资源详情挂「变更历史」入口。
- **第三问 — 触发人（2026-09-17 增补，见边界 11）**：执行/触发记录也要回答「这次是
  谁触发的」，随方案 A 一起落（`execution_index` / `pipeline_runs` 已有列只需展示，
  单条执行 `executions` 补 `triggered_by`）。

**边界决策（11 项；11 为 2026-09-17 用户增补，其余为 2026-09-07 原案）**

1. **一个迁移：`060_p11_ownership.sql`**（原 056，2026-09-11 因 P8 占用 055/056、
   P9 占用 057 顺延为 058；2026-09-14 再被 P9-4 修订的 058 与 P9-4b 的 059 占用，
   顺延为 060）。14 张表各
   `ADD COLUMN IF NOT EXISTS created_by / updated_by UUID REFERENCES users(id) ON DELETE SET NULL`。
   旧行 NULL 即可（项目未发布，无历史包袱，不回填——「数据兼容」纪律的正用）。
   索引只建 `(project_id, created_by)` 不建 updated_by：按创建人筛选是列表诉求，
   按更新人筛选没有真实场景。
2. **不复制已有归属的表**：上面 12 张天生有 `created_by` 的表不补 `updated_by`
   （等有真实「谁改的」诉求再单独加，不在本阶段批量铺列）。
3. **`updated_by` 只在用户触发的写路径更新**。调度器（`lib/schedule.ts`）、告警引擎
   （`lib/alerts.ts`）、Webhook 公开触发（`webhookTriggers.ts` 的 `last_triggered_at`）
   等系统路径写 `NULL`——「系统」不是一个用户，写 NULL 语义为「非人工更新」，前端显示
   「系统」而不是空。禁止把这些路径的 `updated_by` 硬塞成任务创建人。
   **2026-09-17 复核更正**：本边界原先把 `lib/caseSync.ts` 也列为系统路径，实为误记——
   该模块的四个导出函数**只**被 `cases.ts` 的「同步到流程」人工路由调用，没有任何调度 /
   对账入口，因此 P11-4 给它写了 `updated_by`（`writeFlowNodes` 的 `actorId` 必填）。
   同理 `lib/suiteMembers.ts`（用例/流程删除时从 manual 套件摘成员）也是人动作，写人。
4. **REST 全挂、MCP 全挂、ingest 导入挂**。所有 INSERT 写 `context.user.id`（REST）
   或 Token 签发人（MCP，`mcpAuth` 已返回 createdBy）；`endpoints.ts` 的 duplicate、
   `ingest.ts` 的导入创建同样写入操作者。UPDATE 路径在既有 `updated_at = now()` 旁
   顺带写 `updated_by`（~23 处，分布在 routes + `lib/mcpToolsWrite*` + caseSync 等约
   20 个文件）。
5. **方案 B 动作集**：`AUDIT_ACTIONS` 扩 14 类资源 × create/update/delete ≈ 42 个动作
   （`endpoint.create` / `endpoint.update` / `endpoint.delete` …）。detail 只记字段名
   列表（「改了哪些键」）与动作证据，**绝不记 payload 值**——沿用 8.1 的 4KB 护栏
   与「审计回答谁改了什么，不回答改成什么」的纪律。脚本内容、环境 secrets 值天然
   被挡在外面。
6. **审计挂在主写路径成功之后**（fire-and-forget，失败不拦业务请求——既有取舍不重开）。
   批量删除（`endpoints.ts` batch-delete）落一行带 `ids` 数量的动作而不是每行一笔。
7. **读侧分两层**：列级（createdBy/updatedBy）进 mapper，所有项目成员可见（viewer
   含）；审计级走既有 `/projects/:id/audit-logs`，**从 project_admin 放宽到 developer**，
   viewer 仍不可见（审计日志含 email 与 IP，viewer 不该读）。
8. **资源详情「变更历史」抽屉**：资源详情/工作台加一个入口，按
   `target_type + target_id` 查该资源的审计行（新查询路由
   `GET /projects/:id/audit-logs?targetType=&targetId=`，复用既有过滤参数）。
   只列动作、时间、操作者、字段名列表，不做 diff 视图。
9. **前端列表列**：11 个列表组件（EndpointList / CaseBox / FlowList / SuiteList /
   Environments / MockList / DataSourceList / PublicScripts / ResourceSchedules /
   Alerts 的两个 tab / SpecCases）加「创建人 / 更新人」列，NULL 显示「—」、
   updated_by 为 NULL 且 updated_at 新于 created_at 显示「系统」。i18n 三处词条。
10. **不做版本历史/diff/回滚**——那是 P10 14.3 的范围（「接口变更追踪」），本阶段只
    回答归属，不回答内容演变。P7 11.0 边界 16 已把同一件事归到那里。
11. **触发人可见（2026-09-17 用户增补）**：执行/触发记录也要回答「这次是谁触发的」。
    归属是两问，资产问「谁建/谁改」，运行问「谁按的按钮」——同一阶段一起收口。
    - **已有列，缺展示**：`execution_index.triggered_by`（迁移 057b）与
      `pipeline_runs.triggered_by`（038）在人工路径已写入（REST 手动 / 套件 / 流程 =
      `context.user.id`，MCP execute = Token 签发人；`flows.ts:432` / `suites.ts:266` /
      `mcpToolsExecute.ts:261` / `trigger.ts:625`），定时 / Webhook / 非人 CI 留 NULL
      （P9-1 收件口径，与边界 3 的「非人工」同义，前端显示「系统」）。但读侧 mapper
      只回 uuid（`models/types.ts:2676`），前端零处渲染（`api.ts` 有 `triggeredBy?`
      无人消费）——本阶段补读侧解析与展示，不需要动这些写路径。
    - **缺落点**：单条执行 `executions`（001）无任何操作者列——手动跑一次接口、勾选执行
      的套件成员、流程节点执行都只落这张表，「谁跑的」现在无处可查。补
      `triggered_by UUID REFERENCES users(id) ON DELETE SET NULL`（第 15 张表，**不建
      索引**——按触发人筛执行记录没有真实场景，与边界 1 同款取舍），并给
      `EnqueueInput` 加可选 `triggeredBy`：REST → `context.user.id`，MCP execute →
      Token 签发人，调度 / Webhook / CI → NULL。
    - **子执行继承父执行触发人**（本项主要实现细节）：套件成员（`insertRun` 扇出）与
      流程节点执行（worker 内 `flowGraph.ts:261` 落 `executions`）都要取父执行的
      `execution_index.triggered_by`。否则「我手动跑了一次套件」下面几十条成员行全显示
      「系统」——把「谁触发的」答成「没人触发」，比不显示更糟。
    - **展示位置**：执行记录页三个 tab（单条 / 批量 / 父执行，`ExecutionRecords.tsx`）
      与报告列表（套件报告 `SuiteReports.tsx`、CI 任务运行 `CiTaskList.tsx` /
      `PipelineRunPage.tsx`、报告详情）的触发列，现有 `triggerLabel` 只渲染触发源，
      扩为「触发源 · 触发人」；NULL 显示「系统」。项目成员均可见（同边界 7，无权限差异）。
    - **不做**：按触发人筛选执行记录；在审计里重复记执行触发（`ci_task.trigger` 已在、
      MCP execute 有 `mcp_tool.execute`）。

### 16.1 数据库迁移：064_p11_ownership.sql（**已实现 2026-09-17**；原 056，2026-09-11 顺延 058、2026-09-14 再顺延 060、实施时因 063 已被 P12 占用而实落 064，P14 顺延 065。下面为示意，实际形态见 `migrations/064_p11_ownership.sql` 与 16.6 实现状态）

```sql
-- 14 张表同一模式，旧行 NULL 即可（不回填；项目未发布无历史包袱）
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
-- … test_cases / environments / flows / test_suites / scripts / data_sources /
--   sql_definitions / mocks / schedules / webhook_triggers / notification_channels /
--   alert_rules / spec_modules 同款
CREATE INDEX IF NOT EXISTS endpoints_project_created_by_idx ON endpoints(project_id, created_by);
-- … 其余 13 张同款（只建 created_by，不建 updated_by，见边界 1）

-- 第 15 张：单条执行的操作者（边界 11）。它是运行记录不是资产，只有一列、无索引，
-- 也不参与上面的 created_by/updated_by 模式（执行行建了就定，没有「更新人」语义）。
ALTER TABLE executions ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES users(id) ON DELETE SET NULL;
```

### 16.2 改动量与触点（立项摸底，2026-09-07；2026-09-17 补边界 11）

| 项 | 方案 A | 方案 B | 触点 |
| --- | --- | --- | --- |
| 迁移 | 1 个文件，29 列（14 表 × 2 + `executions.triggered_by`）+ 14 索引 | 0（复用 audit_logs） | `migrations/064_p11_ownership.sql` |
| INSERT | ~22 处写 created_by + `EnqueueInput.triggeredBy` 一路下传 | ~22 处挂 create 审计 | routes/*.ts（14）+ mcpToolsWrite*（7）+ ingest.ts + lib/scripts.ts + lib/enqueue.ts |
| UPDATE | ~23 处写 updated_by | ~23 处挂 update 审计 | 同上 + caseSync / schedule / suiteMembers / alerts（系统路径除外，边界 3） |
| DELETE | —（不记列） | ~14 处挂 delete 审计 | routes/*.ts + mcpToolsWrite* |
| types.ts | ~12 mapper + 类型加两字段；`Execution` / `ExecutionIndex` / `PipelineRun` 加 `triggeredByEmail` | 审计 detail 类型 | `models/types.ts` |
| 前端 | api.ts + 11 列表组件加两列 + 执行记录/报告列表触发列并入触发人 | AuditLogsPanel 放权限 + 历史抽屉 | `components/*.tsx` |

### 16.3 分批交付（两轮；批次细分见 16.6）

- **第一轮（方案 A + 触发人，P11-1 ~ P11-8）**：迁移 064 + 全部 INSERT/UPDATE 触点
  写 user + `executions.triggered_by` 与 `EnqueueInput.triggeredBy` 下传（含子执行继承
  父触发人）+ mapper 补字段与 `triggeredByEmail` 解析 + 11 个列表加列 + 执行记录/报告
  列表触发列显示触发人。验收：任一核心资源创建后能在列表看到创建人；换人编辑后更新人
  变化；系统路径（调度改 `next_run_at`）不显示人；手动跑一次套件/流程/接口后，父执行
  与其下全部子执行都显示同一个触发人，定时与 Webhook 触发显示「系统」。
- **第二轮（方案 B，P11-9 ~ P11-10）**：AUDIT_ACTIONS 扩 42 动作 + 全写路径挂审计
  （成功后 fire-and-forget）+ 审计路由放开 developer + 过滤参数 targetType/targetId +
  前端「变更历史」抽屉（**P11-9 = 前两项、P11-10 = 后三项，均已实现（2026-09-17）**）。
  验收：对任一资源 create/update/delete 后审计页可见对应动作行；
  资源详情能拉出该资源的完整变更列表；viewer 调审计路由 403。

### 16.4 里程碑

| 里程碑 | 阶段 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| M12 | P11 | 列级归属 + 触发人可见 + 资源 CRUD 全审计 | 任意核心资源可查「谁建/谁改」（列表直读 + 审计下钻两路）；执行/报告记录可查「谁触发」（手动跑一次后父执行与全部子执行同一触发人）；系统写入与定时/Webhook 触发显示「系统」；viewer 无审计读权 |

### 16.5 明确不做

- 不做逐版本 diff / 回滚（P10 14.3）。
- 不做「按人筛选全部资产」的全局视图（P8 统计阶段的候选，有诉求再立项）。
- 不做「按触发人筛选执行记录」（边界 11；`executions.triggered_by` 因此不建索引）。
- 不给 12 张已带 created_by 的表批量补 updated_by（等真实诉求）。
- 不在审计 detail 里记 payload 值或字段前后值（既有纪律，护栏已在 `lib/audit.ts`）。

### 16.6 实施顺序（P11-1 … P11-10，2026-09-17 排定；批次口径见 16.3）

| 步 | 内容 | 产出 |
| --- | --- | --- |
| P11-1 | **迁移 064**：14 张表 `created_by`/`updated_by` + `executions.triggered_by` + 14 个 `(project_id, created_by)` 索引（边界 1/11） — **已实现**（2026-09-17） | 本地库跑通，`\d executions` 见新列 |
| P11-2 | **写路径 · 内容资产（REST）**：`endpoints.ts`（create / duplicate / 导入 / update，最大单独一批）→ `cases.ts` → `environments.ts` → `flows.ts` → `suites.ts` → `routes/scripts.ts` + `lib/scripts.ts` → `dataSources.ts`（`data_sources` + `sql_definitions`）→ `mocks.ts` → `specModules.ts` — **已实现**（2026-09-17） | 内容类资源的建/改落人 |
| P11-3 | **写路径 · 调度与告警（REST）**：`schedules.ts` → `webhookTriggers.ts` → `notificationChannels.ts` → `alertRules.ts` — **已实现**（2026-09-17） | 调度与告警资源的建/改落人 |
| P11-4 | **写路径 · MCP 与导入**：`mcpToolsWriteCore.ts`（endpoints / test_cases / flows / environments）→ `mcpToolsWriteCrud.ts`（suites / schedules / alert_rules）→ `mcpToolsWriteExtra.ts`（scripts）→ `mcpToolsSpec.ts`（spec_modules）→ `routes/specImport.ts` → `routes/ingest.ts`（写 `identity.createdBy` / 导入操作者）；**外加系统路径复核**（`schedule.ts` / `caseSync.ts` / `alerts.ts` 保持不写；`suiteMembers.ts` 是人动作要写） — **已实现**（2026-09-17；`caseSync.ts` 经复核改判为人路径并写人，见边界 3 更正） | MCP 与导入写路径落人；`updated_at = now()` 全部可归类「人 / 系统」 |
| P11-5 | **读侧 mapper 与列表 JOIN**：`models/types.ts` 16 个 mapper 加 `createdByEmail`/`updatedByEmail`（14 张表 + `TestCaseSummary` + `SpecCase`）；各列表查询 LEFT JOIN users 取 email 快照（照 `mapAuditLog` 形制） — **已实现**（2026-09-17） | 列表接口回名字；viewer 亦可见（边界 7） |
| P11-6 | **触发人（写路径 + 读侧）**：`EnqueueInput.triggeredBy` → `insertRun` 写 `executions.triggered_by`；REST 调用方（endpoints / cases / flows 单步 / suites / 批量）取 `context.user.id`、MCP execute 取 Token 签发人、调度 / Webhook / CI 留 NULL；**子执行继承**（套件成员由套件入队下发、流程节点由 worker 从父 `execution_index.triggered_by` 取）；`Execution` / `ExecutionIndex` / `PipelineRun` 补 `triggeredByEmail` 解析 — **已实现**（2026-09-17；另给 `BatchExecution` 派生同名读写侧，见实现状态） | 单条 / 父执行 / 报告三类记录都能答「谁触发」 |
| P11-7 | **前端 · 资产归属列**：`api.ts` 类型（`createdByEmail`/`updatedByEmail`）+ 12 个列表位加两列（`EndpointList` / `FlowList` / `SuiteList` / `Environments` / `MockList` / `DataSourceList` / `PublicScripts` / `ResourceSchedules` / `Alerts` 两 tab / `SpecCases`；`CaseBox` 是卡片列表，改成 meta 行两项，见实现状态）+ `components/OwnerCell.tsx` + `.col-owner` + i18n — **已实现**（2026-09-17） | 列表直读「谁建 / 谁改」 |
| P11-8 | **前端 · 触发人展示**：`api.ts` 加 `triggeredByEmail` + 抽 `lib/trigger.ts`（`triggerLabel` 扩为「触发源「引用」 · 触发人」、新增 `triggerPersonLabel`）；`ExecutionRecords.tsx` 三 tab 各加「触发人」列（原先没有触发列，见实现状态），`SuiteReports.tsx`（列表 + 详情，含免登录分享页）、`SuiteRunDrawer.tsx`、`CiTaskList.tsx`、`PipelineRunPage.tsx` 的触发列改为源 + 人 + i18n — **已实现**（2026-09-17） | 报告与执行记录直读「谁触发」；NULL → 「—」（手动）/「系统」（非手动） |
| P11-9 | **审计动作 + 挂载（方案 B）**：`AUDIT_ACTIONS` 扩 14 资源 × create/update/delete ≈42 动作 + detail 类型（只字段名列表）；按 P11-2 ~ P11-4 同一文件顺序挂审计，成功后 fire-and-forget；批量删除（`endpoints.ts` batch-delete）落一行带 `ids` 数量 — **已实现**（2026-09-17；MCP 写工具与 `mcp_tool.write` 并行落资源动作，见实现状态） | 每个写路径都有动作行，detail 无 payload 值（边界 5/6） |
| P11-10 | **审计读侧与前端 + 收尾**：`routes/systemUsers.ts` 项目审计路由放宽到 developer（viewer 仍 403）+ `targetType`/`targetId` 过滤；`AuditLogsPanel.tsx` 权限放开 + 资源详情「变更历史」抽屉（不做 diff，边界 8）+ i18n；更新本节与 16.3 状态，交用户验收 — **已实现**（2026-09-17；含项目「审计日志」页与 10 个资源的抽屉入口，见实现状态） | 审计下钻可用；viewer 403；两轮验收口径通过 |

> **次序理由（2026-09-17）**：先迁移、再写路径、再读侧、最后前端——方案 A 与
> `executions` / 触发人展示同轮落（一次迁移、一次前端轮），方案 B（P11-9 / P11-10）
> 在其后独立一轮，避免「审计先挂、列还没写」时 detail 拿不到字段名。
> 单个批次内部仍按「一个文件一次改动」推进，不把 P11-2 ~ P11-4 并成一次大改。
>
> **每批通则**：启动 / 重启服务与 type-check / build 由用户执行（AGENTS.md「验证归属」
> 与「类型检查需显式请求」）；实现轮不自行跑测试或浏览器验收。

**实现状态**

- **P11-1（2026-09-17）**：`migrations/064_p11_ownership.sql` 落地。14 张核心表各补
  `created_by` / `updated_by UUID REFERENCES users(id) ON DELETE SET NULL`（`ADD COLUMN
  IF NOT EXISTS`，旧行不回填，边界 1/2）；14 条 `(project_id, created_by)` 索引（`updated_by`
  无索引，边界 1）；第 15 张 `executions` 补 `triggered_by`（单列无索引，运行记录无「更新人」
  语义，边界 11）。写路径（P11-2 ~ P11-4、P11-6）与读侧 / 前端（P11-5、P11-7、P11-8）
  尚未接，迁移先行为的是让后续写入有列可落。**未在本地库执行、未验收**——按 AGENTS.md
  验证归属，迁移与 `\d executions` 复核由用户跑 `./start.sh` 时完成。
- **P11-2（2026-09-17）**：9 个 REST 写路径文件接入 `created_by` / `updated_by`，全部取
  `context.user.id`。触点：`endpoints.ts` 5 处（create / patch / duplicate / 导入 update /
  导入 insert；`WRITE_COLUMNS` 与 `writeValues()` 共享给 create 与导入，两处一起改，避免漂移）、
  `cases.ts` 3 处（create INSERT / patch / 三处脚本持久化调用传 actor）、`environments.ts` 3 处、
  `flows.ts` 2 处 + 2 处 actor、`suites.ts` 2 处、`routes/scripts.ts` 2 处、`dataSources.ts` 4 处、
  `mocks.ts` 2 处、`specModules.ts` 3 处（含子树整块 UPDATE 与逐行 reorder）。
  **`lib/scripts.ts` 加了 `actorId` 一路下传**（`persistCaseScripts` / `persistCaseLifecycleScripts` /
  `persistFlowScripts` 三个导出函数为尾参默认 `null`，内部 helper 为必填）：匿名脚本的建、跨宿主
  复制、以及在保存用例/流程时被就地改写（`UPDATE scripts SET content`）都落人。默认 `null` 是给
  P11-4 的 MCP 调用方留的——那三个调用点在 P11-4 传 `identity.createdBy`。
  两条**实现期发现**（不影响本轮验收，P11-4/前端轮需知）：
  1. `environments` 表**没有 `created_at` / `updated_at` 列**（001 起就没有，P11-1 只补了
     created_by/updated_by），所以它的 UPDATE 没有既有的 `updated_at = now()` 可依附，边界 9
     的「`updated_at` 新于 `created_at` → 显示系统」在这张表上不成立。环境只由人工 REST 路径写，
     `updated_by` 为 NULL 就是「建后未改过」，前端应显示「—」而不是「系统」。
  2. `lib/caseSync.ts:writeFlowNodes` 的 `UPDATE flows SET nodes, updated_at = now()` 被
     `cases.ts` 的**人工**「同步到流程」路由调用，而该文件在 P11-4 的「系统路径保持不写」名单里。
     本轮按文件边界未动它，结果是同步一次流程会写 `updated_at` 而不写 `updated_by`（前端会显示
     「系统」）。**P11-4 复核时必须区分**：`caseSync` 自己的对账入口不写，`writeFlowNodes` 这个
     被人工路由复用的 helper 要么收 `actorId`、要么由调用方传入。
- **P11-3（2026-09-17）**：4 个调度/告警 REST 文件接入，全部取 `context.user.id`。
  `schedules.ts` 2 处（create INSERT / put）、`webhookTriggers.ts` 3 处（create / put /
  rotate-secret）、`notificationChannels.ts` 3 处（create / put / 删除渠道时对
  `alert_rules` 摘除悬空 `channel_ids` 的连带清理）、`alertRules.ts` 2 处（create / put）。
  **两处刻意不写**（边界 3，均已在代码处留注释）：
  1. `webhookTriggers.ts` 公开触发路由的 `UPDATE webhook_triggers SET last_triggered_at`
     ——外部调用方触发的**运行事实**，没有登录用户可写；「触发人」这一问由 P11-6 的执行
     记录回答，不在这张配置表上。
  2. `lib/schedule.ts`（`next_run_at` / `last_run_at`）与 `lib/alerts.ts`
     （`alert_rules.last_fired_at`）——调度器与告警引擎的系统路径，在 P11-4 的复核名单里，
     本轮未动这两个文件。
  **一条实现期发现**：`notificationChannels.ts` 的删除连带清理里，`alert_rules` 的
  `channel_ids` 摘除按「内容确实变了」写了 `updated_by` + `updated_at`；同一个循环里
  `test_suites.notify_config` 的摘除**未写**——它和 `ci_tasks` 共用一份语句模板，而
  `ci_tasks` 不在 14 张表内（按边界 2 不补 `updated_by`），整批留给 P11-4 与
  `suiteMembers.ts` 一起处理（同一类「级联改套件」的归属）。
- **P11-4（2026-09-17）**：MCP 与导入写路径接入，actor 一律取 `identity.createdBy ?? null`
  （Token 签发人，`McpIdentity.createdBy` 在类型上可选，故用 `?? null` 兜底）。
  `mcpToolsWriteCore.ts` 8 处（`upsertEndpoint` 的 INSERT/UPDATE——`ENDPOINT_WRITE_COLUMNS`
  与 `endpointWriteValues` 同步加列，供 `create_endpoint` / `copy_endpoint` 共用；
  `update_endpoint`；`saveCase` 的 INSERT + `persistCaseLifecycleScripts`；
  `update_case` 的 UPDATE + `persistCaseLifecycleScripts`；`upsert_flow` 的 INSERT/UPDATE +
  `persistFlow`；`upsert_environment` 的 INSERT/UPDATE）、`mcpToolsWriteCrud.ts` 7 处
  （`create_suite` 的 INSERT/UPDATE、`update_suite`、`create_schedule`、`update_schedule`、
  `create_alert_rule` 的 INSERT/UPDATE、`update_alert_rule`；alert_rules 两个分支共用一份
  `values` 数组，`$11` 在 INSERT 是 `created_by`、在 UPDATE 是 `updated_by`）、
  `mcpToolsWriteExtra.ts` 3 处（`create_script` 的 INSERT/UPDATE、`update_script`）、
  `mcpToolsSpec.ts` 1 处（`create_spec_module`）、`routes/specImport.ts` 1 处（模块前缀补建，
  `ON CONFLICT DO NOTHING` 时保留原 `created_by`）、`routes/ingest.ts` 1 处（「从未匹配区
  一键登记」建最小 endpoint；该处列清单手工镜像 `endpoints.ts` 的 `WRITE_COLUMNS`，注释已
  同步）。**P11-2 留下的两处尾巴同轮收口**：`lib/caseSync.ts:writeFlowNodes` 收必填
  `actorId`（复核后改判为人路径，见边界 3 更正）、`lib/suiteMembers.ts:detachSuiteMember`
  收 `actorId`（人动作）；`notificationChannels.ts` 删除渠道的连带清理里，`test_suites`
  的 `notify_config` 摘除补上 `updated_by` + `updated_at`，`ci_tasks` 因无该列（边界 2）
  按表拼后缀跳过。
  **系统路径复核结论（边界 3，均在代码处留注释）**：`lib/schedule.ts` 三条 UPDATE
  （`next_run_at` / `last_run_at`）、`lib/alerts.ts` 的 `alert_rules.last_fired_at`、
  `webhookTriggers.ts` 公开触发路由的 `last_triggered_at` **保持不写**——都是运行簿记，
  没有登录用户在这一刻改过配置。三条 create 路径的内部跟写（`saveCase` 的 assertions、
  `persistFlow` / `flows.ts` create 的 nodes）也不写 `updated_by`：它们是同一事务里
  新建行的收尾，行上 `updated_by` 本就该是 NULL（显示「—」而非「系统」）。
- **P11-5（2026-09-17）**：读侧落地。`models/types.ts` 新增 `Ownership` 类型（两字段
  可选且可空，`null` 的语义是「本次查询没有这个值」）+ `ownershipEmail()` 取值口，
  15 个实体类型 `& Ownership`、`SpecCase` 只加 `createdByEmail`；**16 个 mapper** 一并
  回 `createdByEmail` / `updatedByEmail`（14 张表 + `TestCaseSummary`（CaseBox 用的就是
  它）+ `SpecCase`）。
  **字段名说明**：16.2 写的「加 `createdBy`/`updatedBy`」是列级归属的简称，实际落在 API 上
  的是**两个 email 字段**——P11-7 的前端契约读的就是 `createdByEmail`/`updatedByEmail`，
  且与既有 `ProjectMember.grantedByEmail`、`mapAuditLog.user_email` 同一形制。回 uuid 没有
  消费方（没有「按用户 ID 跳转」的界面），故不发。原始 uuid 仍在表上，需要时再单开字段。
  **列表 JOIN**：13 个路由文件的列表查询接上 `LEFT JOIN users creator/updater` 取 email
  快照，覆盖边界 9 的 12 个列表组件的全部数据源（endpoints / cases / flows / test-suites /
  environments / mocks / data-sources / sql-definitions / scripts / schedules /
  webhook-triggers / notification-channels / alert-rules / spec-cases）。其中 schedules、
  webhook-triggers 的投影常量被列表与详情共用，详情因此一起拿到归属；mocks / data-sources /
  sql_definitions / environments / flows / test_suites 抽出 `SELECT_*` 投影常量（列表的
  分页与全量两条分支共用一份，避免列清单漂移）。
  **两个数据一致性陷阱（都在代码处留了注释）**：
  1. 基表**必须显式取 `x.*`**。原来这些列表是 `SELECT *`，加 users join 后裸 `*` 会在两表
     同名的 `id` / `name` / `created_at` 上取到 **users 的值**——映射会静默换行，不是报错。
     为此把 8 处 `SELECT *` 改成 `SELECT <别名>.*` 并给基表起别名。
  2. `endpoints` / `flows` / `test_suites` / `environments` 的 WHERE 里原本有不带前缀的列
     （`name` / `description` / `tags` / `created_at` / `default_environment_id` …），join
     users 后 `name` / `created_at` 会变 ambiguous（users 也有同名列）→ 报错。已一律加上
     表前缀（cases / scripts / schedules / webhook-triggers / spec-cases / mocks 的子句本来
     就带前缀，未动）。
  **刻意不 join 的两处**：`spec_modules` 的模块树（边界 9 没有它对应的列表组件，字段照
  `Ownership` 读成 null）；create/update 的 `RETURNING *` 与各详情内部读取。这些路径上
  `createdByEmail` 为 null 表示「本次查询没取归属」，前端刷新列表后补齐。
  **两处数据口径限制（前端 P11-7 必须知道，否则会显示错）**：
  1. `SpecCases` 只有**创建人**：`spec_cases` 按边界 2 没有 `updated_by` 列，
     `updatedByEmail` 不存在，「更新人」列只能显示「—」。
  2. `Environments` 没有 created_at / updated_at（001 起就没有），边界 9 的
     「`updated_at` 晚于 `created_at` → 显示系统」在这张表上不成立——`updatedByEmail`
     为 null 只表示「建后没改过」，应显示「—」而不是「系统」。
- **P11-6（2026-09-17）**：触发人（边界 11）落地。
  **写路径**：`EnqueueInput.triggeredBy` → `insertRun` 写 `executions.triggered_by`（迁移 064
  的唯一新列）。REST 三处取人：`queueEndpointRun` 加尾参（单条调试与**批量**两条调用点都传
  `context.user.id`，因此批量里每一行都是按批量按钮的那个人）、`routes/flows.ts` 单步调试、
  `routes/cases.ts` 执行用例；MCP 两处取 Token 签发人（`run_endpoint` 经 `queueEndpointRun`、
  `run_case`）；调度 / Webhook / 非人 CI / 仓库上报（`ingest.ts` 的 `trigger_source='ci'`）
  一律 NULL——已逐条核对，无需改这些写入点。
  **子执行继承**（本项主要实现细节）：套件**用例**成员由 `performSuiteRun` 从 run_spec 里冻的
  `spec.trigger.userId` 下发（`performSuiteRun` 本就把 flow/trigger 一并读出来）；套件**流程**
  成员早已走 `insertFlowRun` 的 `trigger` 通道，本次核对待确认后未改；流程节点落
  `executions` 的证据由 `flowGraph.executeRequestStep` 从 `GraphContext.triggeredBy` 继承，
  该值由 `performFlowRun` 认领后**从父 `execution_index.triggered_by` 读一次**再下发（每个
  节点各查一次库没有意义；`nested()` 展开上下文，子流程/循环体内层图同样继承）。
  **读路径**：`TriggeredByEmail` 类型（两字段同 `Ownership` 的可选可空约定，但 null 语义
  **不同**——那边是「建后没改过」显示「—」，这边是「非人触发」显示「系统」，已在类型注释里
  写明不要统一）+ `Execution` / `ExecutionIndex` / `PipelineRun` / `BatchExecution` 四个
  mapper 回 `triggeredByEmail`。查询接线的四种形态：
  1. **executions 列表与详情**（`endpoints.ts`）：`LEFT JOIN users triggerer`（列表的 WHERE
     已逐条 `executions.` 限定，加 join 不撞名）。
  2. **pipeline-runs 列表与详情**（`pipelineRuns.ts`）：同上（列都带 `pr.` 前缀）。
  3. **execution-index 列表与详情**（`executionIndex.ts`）：用**标量子查询**而不是 join——
     这条 WHERE 的列没带前缀，`users` 同名的 `created_at` / `status` 会让整条查询 ambiguous。
  4. **批量**（`batch_executions`）：**没有触发行人列**（064 只给 `executions` 加），但一次批量
     里每一行的触发人必然相同 → 从成员行**派生**一列（标量子查询 `LIMIT 1`），不加列不加索引。
  报告侧：`reportPayload.ts` 的套件报告详情（`ei` 上加一条 users join）与仓库报告详情、
  `reports.ts` 的 `suite-reports` UNION（**两个分支列序必须一致**，触发人列在两支里都紧跟
  `trigger_*` 三列）及其行内 mapper。`CiTaskList` 的触发列读的是**展开后的历史表**（该表的
  数据源是 ci-tasks 的 runs 列表，已接线），收起行不显示触发源，故 `mapCiTask.lastRun` 未扩字段。
  **刻意不接线的读取点**（字段读成 null = 「本次查询没取」，P11-8 不要在这些地方显示该列）：
  接口/用例/流程抽屉的范围执行历史列表、MCP 的 `get_execution` / `list_executions`、
  免登录分享页的 executions 列表、批量详情里的成员行、create/update/cancel 的
  `RETURNING *`。另：`routes/flows.ts` 的 `executeGenericStep` 写的一次性自指索引行保持 NULL
  （它被排除在父执行列表外，没有展示位）。
  与 P11-5 的写侧无关，**未在本地库执行、未跑 `pnpm check`**（同上）。
- **P11-7（2026-09-17）**：前端归属列落地，共 12 个列表位。
  **类型**：`api.ts` 新增 `Ownership` 类型（与后端同名的可选可空两字段 + 三态语义注释），
  14 个资源类型 `& Ownership`（Environment / DataSource / Mock / Endpoint / Script /
  TestCase / TestCaseSummary / Flow / TestSuite / Schedule / WebhookTrigger /
  NotificationChannel / AlertRule / SpecModule；`FlowSummary` 继承 Flow），`SpecCase` 只加
  `createdByEmail`。
  **共用件**：`components/OwnerCell.tsx`（三态：email / 「系统」/「—」；只有「更新人」列会把
  空值 + `updatedAt > createdAt` 读成「系统」，创建人列的空值一律「—」）+ `.col-owner`
  （148px，配 `.table-scroll` 兜底）+ 3 个共享 i18n 键（`common.createdBy` /
  `common.updatedBy` / `common.bySystem`，zh + en 各一份）。
  **12 个列表位**：EndpointList / FlowList / SuiteList / Environments / MockList /
  DataSourceList / PublicScripts / ResourceSchedules / Alerts（channels + rules 两张表）/
  SpecCases 用表格两列（SpecCases 只一列）；**CaseBox 例外**——它是工作台侧栏的卡片列表
  （div + meta 行，没有表头），两列改成 meta 行里的「创建人 / 更新人」两项，仍然直读、仍然
  走同一个 `OwnerCell`。
  **三处必要的连带改动**（都在本批，理由写在代码注释里）：
  1. **`.table-scroll` 包裹**：给 EndpointList / FlowList / SuiteList / Environments /
     PublicScripts / ResourceSchedules / Alerts 七张原本裸 `<table class="grid">` 的表加了
     滚动容器。新增两列各 148px，不包会让窄屏下右缘被 `overflow: hidden` 裁掉（看不见又够不着）；
     包上之后横滚发生**表内**，页面本身仍永不横滚（Quiet Console 布局不变量，19 个组件已有的做法）。
  2. **补 P11-5 漏掉的一条读侧 join**：工作台侧栏用例盒的数据源是
     `GET /endpoints/:endpointId/cases`（后端 `routes/cases.ts` 的 `SELECT * FROM test_cases`），
     P11-5 只接了项目级那份，这条没接 → 侧栏两列会永远空。本批补上 `LEFT JOIN users`。
  3. **MockList 是唯一未本地化的列表页**（正文仍是字面中文）。新增的两列用共享 i18n 键，
     其余未动——该页整体本地化另立项。
  **两处按数据事实收窄（边界 9 原写「两列」）**：`SpecCases` 只加「创建人」（`spec_cases` 没有
  `updated_by`，一列永远「—」比不显示更糟）；`Environments` 的两列空值只能是「—」（001 起就
  没有时间列，没有「系统」这一态）。
  **未在浏览器里跑**（AGENTS.md 验证归属）：只做了机械核对——逐文件 JSX 标签配平（table /
  th / td / tr / `.table-scroll` 包裹）、逐表列与单元格对齐（colgroup ↔ th ↔ td ↔ OwnerCell
  数量一致）。`pnpm check` / `pnpm build` 与 `/theme-preview.html` 两模式走查由用户执行。
- **P11-8（2026-09-17）**：触发人展示落地。
  **类型**：`api.ts` 新增 `TriggeredByEmail`（一字段，语义注释写明与 `Ownership` 的空值话术
  **不同**：这里 null = 没有人工触发人），7 个类型 `& TriggeredByEmail`（Execution /
  ExecutionIndex / `BatchDebugResult`（批量，`BatchDebugSummary` 经 `Omit` 继承）/
  SuiteReport / SuiteReportSummary / `SuiteExecutionDetail` / PipelineRun）。
  **共用件**：新 `lib/trigger.ts`——`triggerPersonLabel(t, email, source)`：有 email 就显示；
  为空且触发源**不是手动**（定时 / Webhook / 非人 CI，边界 3 写 NULL）→「系统」；为空且是
  手动 →「—」（这次响应没取到，如入队回执）；`triggerLabel(t, source, refName, email)`
  **从 `SuiteReports.tsx` 迁到这里**（`SuiteRunDrawer` / `SuiteReports` 两处 import 改路径），
  文案变成「触发源「引用」 · 触发人」，第 4 参显式 `undefined` 时只渲染触发源（兼容不带这一维
  的形状）。i18n 加 `common.triggeredBy`（zh/en）。
  **展示点**：`SuiteReports.tsx` 列表与报告详情（详情组件与**免登录分享页**共用 → 分享页
  一起拿到）、`SuiteRunDrawer.tsx` 的报告标识行、`CiTaskList.tsx` 展开历史表的触发列（原来
  只渲染触发源）、`PipelineRunPage.tsx` 的触发事实行（页头，项目内详情）。
  **`ExecutionRecords.tsx` 三个 tab 原先没有触发列**（边界 11 的「展示位置」假设它已有）——
  本批给三张表各加一列「触发人」：父执行 tab 有 `trigger_source` 可判，手动 + 缺 email 读
  「—」；单条执行与批量**没有** `trigger_source`（`executions` 只存触发人），缺 email 一律读
  「系统」。三张表同时包上 `.table-scroll`（与 P11-7 同一理由）。
  **不接的两处**：看板的「触发源分布」是聚合读数（不是行级触发人，按人聚合另立项）；
  免登录的 **Runner** 报告分享页本来就没有触发事实行（只渲染 `PipelineReportBody`，没有新
  增展示位；套件分享页因为共用 `SuiteReportDetail` 自然拿到了）。
  **未在浏览器里跑**：只做机械核对——文件内 JSX 标签配平、`ExecutionRecords` 的 3 表头 ↔
  3 单元格 ↔ 3 包裹一一对应、5 处 `triggerLabel` 与 3 处 `triggerPersonLabel` 调用签名一致。
  `pnpm check` / `pnpm build` 与两模式走查由用户执行。
- **P11-9（2026-09-17）**：审计动作 + 全写路径挂载（方案 B）。`lib/audit.ts` 的 `AUDIT_ACTIONS`
  扩 **42 个动作**（14 资源 × create/update/delete，`target_type` 与动作前缀同名，读侧
  `targetType` 过滤直接可用），并加 `auditFields()`（只取请求体**键名**的排序列表，绝不读值）
  与 `AuditFieldDetail` / `AuditBatchDetail` 两个 detail 形状类型；`AuditInput.targetId` 放宽为
  `string | null`（批量动作没有单一目标行）。
  **挂载**按 P11-2 ~ P11-4 同一文件顺序，全部在**主写路径成功之后** fire-and-forget：
  `endpoints.ts`（create / update / duplicate / delete / batch-delete **一行带 `ids` 数量** /
  import 逐条 create+update——逐条是为了资源「变更历史」拉得到）、`cases.ts`（create / update /
  delete / sync-to-flows 逐条 `flow.update`）、`environments.ts`、`flows.ts`、`suites.ts`
  （含 force 连带删的 schedule / webhook_trigger 各一行）、`routes/scripts.ts`、
  `dataSources.ts`（data_sources + sql_definitions 各三处）、`mocks.ts`、`specModules.ts`
  （reorder 落一行带数量）、`schedules.ts`、`webhookTriggers.ts`（rotate-secret 记
  `{fields:["secret"]}`，明文不进）、`notificationChannels.ts`、`alertRules.ts`、`ciTasks.ts`
  （连带删的 schedule / webhook_trigger）、`specImport.ts`（补建模块一行带数量）、`ingest.ts`
  （「从未匹配区一键登记」）。
  **MCP 写路径落两行**：`lib/mcpToolResult.ts` 新增 `auditMcpResource()`；`mcpToolsWriteCore`
  （endpoint / case / flow / environment）、`mcpToolsWriteCrud`（suite / schedule / alert_rule）、
  `mcpToolsWriteExtra`（script / environment）、`mcpToolsSpec`（spec_module）在每个写工具成功后
  与既有 `mcp_tool.write` **并行**落一行同名资源动作（`userId` = Token 签发人）——前者答「经哪把
  钥匙、哪个工具」，后者答「哪个资产的变更历史」。幂等命中（skip）分支不落资源动作。
  **三处级联按「内容确实变了」补审计**（与 P11-3/P11-4 的 `updated_by` 口径一致）：删用例 / 流程
  摘套件成员 → 逐条 `test_suite.update`（带 `detachedMember` 证据）；删通知渠道摘
  `channel_ids` / `notify_config` → `alert_rule.update` / `test_suite.update`；删套件 / CI 任务
  连带删调度与 Webhook 触发 → 各一行 `schedule.delete` / `webhook_trigger.delete`。
  **刻意不挂**（边界 3 系统路径 + 非本阶段资源）：`lib/schedule.ts`（`next_run_at` /
  `last_run_at`）、`lib/alerts.ts`（`last_fired_at`）、`webhookTriggers.ts` 公开触发的
  `last_triggered_at`；`lib/scripts.ts` 的匿名脚本写（`owner_case_id` / `owner_flow_id`，随宿主
  用例/流程的审计行）；`spec_cases` / `ci_tasks` 等不在 14 张表内的资源无同名动作。
  **未在本地库执行、未跑 `pnpm check`**：按 AGENTS.md 验证归属，类型检查与手工验收由用户执行。
- **P11-10（2026-09-17）**：审计读侧与前端 + 收尾。
  **读侧放宽（边界 7）**：`lib/rbac.ts` 新增 `requireDeveloper`（判据与
  `requireProjectAccess(…, true)` 相同——任何非 viewer 角色通过；单独命名是为了让「一次不含
  viewer 的读」不必伪装成写权限），项目审计路由 `GET /projects/:id/audit-logs` 从
  `requireProjectAdmin` 换成它：**developer 可读、viewer 仍 403**，系统管理员照旧短路。
  **过滤与分页（边界 8 的数据面）**：同一路由接上 `action` / `targetType` / `targetId` 与
  `page` / `pageSize`（缺省第 1 页 50 条，与旧「最近 50 条」同量），动态 WHERE 用
  `params.push` + `$${params.length}`（规则 4），非法 `targetId` 在 uuid cast 前回 400（规则 5），
  `meta` 从 `{ total }` 扩成 `{ page, pageSize, total }`。
  **前端**：`api.projectAuditLogs(projectId, filters)` 改分页形状；`AuditLogsPanel.tsx` 新增
  `projectId` 作用域（项目内不重复「项目」列、第二行改标 target_id 短前缀、加 `targetType`
  过滤），同文件新增 `ProjectAuditPage`（项目配置 → **审计日志**页，`ProjectShell` 的
  `nav.audit` 入口**对 viewer 不渲染**——路由不藏，后端仍是权限的单一事实）与
  `ChangeHistoryDrawer`（按 `targetType + targetId` 拉行，只列动作 / 操作者 / 变更字段 / 时间，
  **不做 diff**；字段名由 P11-9 的 `auditFields()` 写入，`DETAIL_KEYS` 把 `fields` / `ids` /
  `imported` 排到前面）；i18n 补 `nav.audit` 与 8 个 `audit.*` 键（中英各一份）。
  成员页的「最近变更（审计，最近 50 条）」摘要**跟着后端判据从 project_admin 放宽到
  developer**（前端闸门比后端严也是一种漂移），完整视图仍在新的审计页。
  **抽屉入口（8 个资源 10 处）**：接口工作台（`endpoint`，加载了用例则跟 `test_case` 走）、流程
  工作台（`flow`）、套件工作台（`test_suite`）、数据源详情页（`data_source`）与 SQL 编辑抽屉
  （`sql_definition`）、环境编辑抽屉（`environment`）、Mock 编辑抽屉（`mock`）、公共脚本编辑
  抽屉（`script`）、调度编辑抽屉（`schedule`）、告警渠道与规则编辑抽屉（`notification_channel`
  / `alert_rule`）；入口一律 `canWrite`（= developer+）才渲染，抽屉关闭时同时复位自己的
  `open`，避免内嵌抽屉在外层抽屉关闭后仍留在屏幕上。
  **未挂入口的两种资源**：`webhook_trigger` 前端至今没有管理界面（只有 API/MCP 路径），
  `spec_module` 只有模块树（重命名/建删的 Modal，没有「模块详情」面）——两者的历史走项目
  「审计日志」页的 `targetType` 过滤，符合边界 8 的「资源详情/工作台」字面范围。
  **未在本地库执行、未跑 `pnpm check` / `pnpm build`、未做浏览器走查**：按 AGENTS.md 验证归属，
  迁移、类型检查与手工验收均由用户执行（本批前端改动只做了机械核对——所有改动文件通过解析
  级语法检查）。
- **未在本地库执行、未跑 `pnpm check`**——按 AGENTS.md 验证归属，迁移、类型检查与手工验收
  均由用户执行。

## 十七、后置：产物下载侧转发（P4.5 边界 14 修订，2026-09-11 用户确认，未排期）

> 自 `DEVELOPMENT_PLAN.md` 8.4 迁入（主计划过大，扩编文档承载后续事项——同 15.4/15.5 的
> 并入方向）。原「硬约束：平台永不代理大文件流」条目保留在主计划 8.4，以本节修订为准。

**背景**：双域名部署（办公网页面域名 A / 内网 API 域名 B）下，办公网浏览器不可达 MinIO
端点。dev 一直在用 s3 驱动（`apitest-server/.env` `ARTIFACT_STORAGE_DRIVER=s3`，MinIO 由
compose 起），本地没炸只是因为浏览器可达本地端点；公司部署时 s3 驱动的浏览器下载直链
（presigned URL 直指 `ARTIFACT_S3_ENDPOINT`，不经 B）当天即断。四条数据路径只有这一条断：
Runner 上传（`presignPut`）内网仍可直传，`reportPayload` 服务端读取与 `objectExists` 都是
API 主机 → MinIO，不受影响。

**方案（已定，未排期）**：下载侧改走平台路由——

- `presignGet` 对 s3 驱动也返回 fs 同款平台直链 `/runner/artifacts/:key/download`（token
  签 key + 过期，`signFsToken` 与驱动无关，机制复用）；
- 下载 handler 按驱动分流：fs 读磁盘流回（现状），s3 从 MinIO `GetObject` 流式转吐——
  pipe 不缓冲，Content-Length / Content-Disposition 改由平台头下发（不再靠 S3 签名参数）；
- 上传保持 presigned 直传不动，平台不进上传数据路径。

**边界 14 修订**：硬约束收窄为「**上传**不代理；下载侧允许流式转发」。原条目担忧的
「200MB allure 报告占住一个 Node 进程」改由流式纪律（恒定内存、不 Buffer 整个对象）与
带宽成本回应，不再一票否决。

**临时退路**：实现落地前如需先上公司环境，把该环境 `ARTIFACT_STORAGE_DRIVER` 临时切回
`fs`（零代码，产物落 API 主机磁盘，直链即 B 的 API 路由），落地后切回 s3。

技术细节与双域名同族问题全量盘点见 `issue_fix/问题记录-通知reportUrl双域名部署失效.md`。

---

## 十八、P12 — 个人中心 + 用户级 MCP Token（约 2 周）

> 版本: v1.2（2026-09-14 立项，范围与边界已确认；**2026-09-16 P12-1 后端整批与
> P12-2 前端整批均已实现，尚未验收**。P12-1：迁移 063、`mcpAuth` 用户级主体 + 绑定、
> 闸门五道、工具面 projectId 集中注入、`list_my_projects` / `copy_endpoint`、`/me`
> 用户级 REST 五条 + 项目侧绑定两条、审计 bind/unbind。P12-2：`MePage` 四 tab +
> `McpPage` 降级 + 通知迁址 + 账号区进助手抽屉头 + i18n，落点与实施期决定见 18.5；
> 跨项目 MCP e2e
> 为独立后续项 P12-1b）。
> 本节实施前的复核修订见 18.0 边界 1/5/6 的 2026-09-16 注记。

### 18.0 P12 范围与边界（2026-09-14 确认）

**问题**

三个散落的「用户级」缺口，一件事把它们串起来——平台所有跟「我这个人」有关的界面
和凭据都没有一个落点：

1. **MCP Token 是项目级**（迁移 050：`mcp_tokens.project_id NOT NULL`，scope 挂在
   token 上），57 个工具全部隐式读 `identity.projectId`。有 A、B 两项目权限的用户，
   agent 在 A 的会话里够不到 B 的接口——「把 B 的接口复制进 A 的流程」无法在一个
   窗口完成。理论上可以配两个 MCP server 各拿一把 token，但两套同名工具多数客户端
   处理不了，实际不可用。
2. **平台没有个人中心**。改密只有 `POST /auth/change-password` 一个端点（入口在 P9
   助手的账号指令里，页面无）；P9-4b 的用户级 agent 凭据明确写着「个人信息界面另行
   规划」（13.0 修订 2）；MCP Token 升级为用户级后同样需要归宿。
3. **通知「查看全部」是孤立全局路由**（`/notifications`，铃铛下拉跳转）。改密、
   通知、凭据散在三处，「我的」这个维度在导航里不存在。

**现状盘点（2026-09-14 摸底）**

- `mcp_tokens`（050）：`project_id` + `scope` 都在 token 行上；无绑定表。
- 鉴权 `lib/mcpAuth.ts`：`McpIdentity = { tokenId, projectId, scope, createdBy }`，
  单项目；候选集按 `token_prefix` 部分索引收窄 + scrypt 比对（这条机制本阶段**原样
  保留**）。
- 闸门 `routes/mcp.ts` 四道：token → 401、`mcp_enabled` → 404、scope → -32601、
  写/执行按签发人重跑 `canAccess` → 403。**read 工具不重跑 `canAccess`**——签发人
  被移出项目后 read token 仍可读，直到吊销或关闸（本阶段顺手收掉这个缺口）。
- 工具面 57 个（`MCP_TOOLS`），SQL 一律 `WHERE project_id = identity.projectId`，
  项目是身份的一部分而不是参数。
- REST `routes/mcpTokens.ts`：项目级三条（列表/签发/吊销）+ 工具清单一条；
  签发要求项目 write。
- 前端：`McpPage.tsx`（项目侧管理页）、`BellMenu.tsx` + `NotificationsPage.tsx`
  （全局路由 `/notifications`）、用户菜单只有登出。
- P9-4b（未实现）：用户级 agent 凭据的界面落点悬置，等个人信息界面。

**两个层次（都做，分两批）**

- **方案 A — 用户级 MCP Token**：token 归人、绑定归项目、scope 放绑定上，工具面
  按参数选项目。**改写 P5 9.1/9.3 的 token 形状口径**（项目级 → 用户级 + 绑定）。
- **方案 B — 个人中心**：全局层 `/me` 页，集齐改密 / 通知查看全部 / MCP Token /
  agent 凭据挂点（P9-4b 的落点）。

**边界决策（12 项）**

1. **一个迁移：`063_p12_personal_mcp.sql`**（迁移号顺延：P9 实占 057/057b/058–062，
    本阶段实施时最新空位 063；原示意号 060 已作废——2026-09-16 实施前复核确认）。
    `mcp_tokens` `DROP COLUMN project_id / scope`——项目未发布、无历史数据要保护
    （「数据兼容」纪律的正用），**既有 dev token 全部作废重签，不搬数**；新表
    `mcp_token_projects` 承接绑定（见 18.1）。`mcp_tokens_prefix_idx` 部分索引与吊销
    即时生效的机制一行不动；`mcp_tokens_project_idx`（050）随 `project_id` 列删除由
    PG 自动回收，无需显式 DROP。P14 的迁移号随之从 063 顺延为 064。
2. **scope 放绑定上，不放 token 上**。一把 token 绑 N 个项目时「A 可写、B 只读」
   必须可表达；token 本体无 scope，写权限的爆炸半径不再随绑定数线性增长。
   `normalizeScopes` 的 read 恒在归一（现 `mcpTokens.ts`）原样搬到绑定侧。
3. **绑定是过滤器，不是授权**。绑定时刻要求实时角色匹配：read 绑定需该项目 read、
   write/execute 绑定需该项目 write；调用时刻**每次**重跑 `canAccess(owner, 目标
   项目)`——**read 也查**（收掉现状盘点里的缺口）。owner 被删（`created_by`
   `ON DELETE SET NULL`）= 整把 token 失效，不再有「无主 read token」。
4. **`mcp_enabled` 仍是项目总闸**（404），语义从「每连接」变「每调用按目标项目」。
   项目侧新增**解绑权**：项目管理员可踢掉任何人绑到本项目的 token——签发权上移到
   用户后，项目管理员对「谁的开门钥匙能开我这扇门」的最终控制不丢。
5. **工具面统一加必填 `projectId` 参数**（`copy_endpoint` 另加 `fromProjectId`），
   校验为 `isUuid` + 绑定集成员。未绑定项目的调用回 `-32601`——与「工具不存在」
   刻意同形（P5 验收门槛 1 的纪律延续：不泄露「那个项目存在 MCP 通道」）。
   **实现落点（2026-09-16 实施修订）：参数注入与绑定解析集中在 `lib/mcpServer.ts`
   的注册包装里一次完成，不逐个改 57 个工具声明。** 理由：逐个改是 57 份
   schema + 149 处 `identity.projectId` 的机械改动，任何一处遗漏都等于少一道
   绑定校验；集中解析保证「每个工具都校验」是结构性的而不是纪律性的。注册包装
   从 `args.projectId` 解出目标绑定，把该绑定的 `projectId` 与 `scope` 注入
   `identity` 后调用 handler——**handler 体内的 `identity.projectId` 逐字不变**，
   语义从「token 的项目」变成「本次调用的目标项目」。**两个例外**（无项目数据的
   工具不注入也不解析）：`get_script_contract`（静态契约）与新增的
   `list_my_projects`（自查绑定集）——它们不携带 `projectId`，也不受闸门②③。
   新增两个工具：`list_my_projects`（read，agent 运行时自查可触达项目与各自
   scope——`tools/list` 回不了这个答案，且**零绑定时也注册**，否则 agent 连
   「我没有项目」都问不出来）与 `copy_endpoint`（write，跨项目复制的便捷通道：
   from 项目读 + to 项目建；目标项目 = `projectId`，源项目 = `fromProjectId`，
   两者都要在绑定集里）。工具面上限 57 → **59**。
6. **闸门重排为五道**（`routes/mcp.ts`）：① token 有效 → 401（不变；**owner 被删
   （`created_by IS NULL`）在此判 401——整把 token 失效，不留无主 read token**）；
   ② tools/call 从参数取目标项目，**未绑定 → -32601**（不看 mcp_enabled——绑定
   关系与开关状态都不泄露）；③ `mcp_enabled(目标项目)` → 404（不变，每调用判）；
   ④ 有效 scope = 该绑定的 scope，工具不在集 → -32601（②④ 的 JSON-RPC 错误带一条
   **逐字相同**的 `error.data.hint`：项目级工具要传已绑定的 `projectId`，先调
   `list_my_projects`——2026-09-16 增补，见 18.5 决定 7）；⑤ 按 owner 重跑
   `canAccess(owner, 目标项目, write = 工具 scope ≠ read)` → 403（**read 也查**，
   收掉现状盘点的缺口：owner 被移出项目后 read token 立刻读不动）。项目自由工具
   （`get_script_contract` / `list_my_projects`）只受①约束。`tools/list` 的注册
   裁剪按全部绑定的 scope **并集**（能力面按并集展示，放不放行逐调用判——单项目
   裁剪会让绑了 5 个项目的 agent 看到五份重复清单）。
7. **REST 面整体挪用户级**：`/api/v1/me/mcp/tokens` 五条 + 项目侧绑定两条（见
   18.3）；原 `/projects/:id/mcp/tokens` 三条删除，`/projects/:id/mcp/tools`
   保留。签发/吊销从「项目 write」改为「本人」——写权限的控制点从签发移到绑定
   （边界 3/4），纪律等价。
8. **审计动作扩两个**：`mcp_token.create` 改挂用户级（无 projectId）；
   新增 `mcp_token.bind` / `mcp_token.unbind`（detail 记项目与 scope——绑定的影响
   面就是「外部 agent 的读写执行通道各开了哪些门」）；`mcpCallRejected` 的 detail
   补目标项目。明文与哈希仍不进审计（既有纪律）。
9. **个人中心是全局层页面**（路由 `/me`，与项目管理、数据看板同层，不进项目壳），
   入口在右上角用户菜单。**四个 tab**：基本信息（email/姓名只读 + 改密表单，复用
   既有 `/auth/change-password` 端点零改动）/ 通知（`NotificationsPage` 迁入为
   `/me/notifications`，组件与逻辑不动只换挂载点；通知四条路由与五个生产源**零
   改动**，只挪查看入口）/ MCP Token（列表 + 签发弹窗 + 绑定管理 + `/mcp` 端点地址
   展示）/ agent 凭据（P9-4b 落点——**本阶段只留 tab 占位不实现**，P9-4b 实现时
   挂进来）。
10. **自助改名 / 改邮箱 / 注销不做**（P6 systemUsers 管理面已有，个人中心不复制
    admin 能力）；**通知生产端与收件口径不动**（P9-1 定案）。
11. **跨项目「引用」不做**：流程节点直接指向另一项目的接口是流程模型改动（跨项目
    外键、执行时 RBAC、B 侧撤权后 A 的流程语义），与 token 形状无关，有诉求另行
    立项。本阶段交付的跨项目能力 = **复制**（`copy_endpoint` 或 get + create 组合）。
12. **ingest / runner token 不跟**：它们是机器凭据，语义就是「某项目的上报/执行
    通道」，项目级是对的；只有 MCP token 是「人的代理通道」，跟人走。三种凭据
    前缀（`apitrack_` / `apirunner_` / `apimcp_`）刻意不同，本阶段不合并。

### 18.1 数据库迁移：063_p12_personal_mcp.sql（示意）

> 编号以实施时最新空位为准：2026-09-16 复核 P9 实占至 062，本阶段落 **063**。

```sql
-- token 本体：项目归属与 scope 移除（既有行不搬——未发布无包袱，重签即重签）
ALTER TABLE mcp_tokens DROP COLUMN IF EXISTS project_id;
ALTER TABLE mcp_tokens DROP COLUMN IF EXISTS scope;

-- 绑定表：token × 项目 × scope（scope 在这里，见边界 2）
CREATE TABLE IF NOT EXISTS mcp_token_projects (
  token_id   UUID NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope      TEXT[] NOT NULL DEFAULT '{read}',   -- 'read' / 'write' / 'execute'，read 恒在
  bound_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, project_id)
);
CREATE INDEX IF NOT EXISTS mcp_token_projects_project_idx ON mcp_token_projects (project_id);
-- mcp_tokens_prefix_idx（050）原样保留：前缀收窄候选集 + 排除吊销行，鉴权热路径不变
```

### 18.2 改动面摸底（立项时点）

| 层 | 改动 | 触点 |
| --- | --- | --- |
| 鉴权 | 新增 `McpPrincipal = { tokenId, createdBy?, bindings }`（`created_by` 为空一律 401）；前缀收窄查询不变，绑定集按命中行二次带回 | `lib/mcpAuth.ts` |
| 闸门 | 四道 → 五道重排（边界 6），目标项目从工具参数取 | `routes/mcp.ts` |
| 工具面 | **参数注入与绑定解析集中在注册包装**（边界 5 修订）；`identity` 形状不变，handler 零改动；新增 2 个 | `lib/mcpServer.ts` + 新增 `list_my_projects` / `copy_endpoint` 两个工具文件 |
| REST | 用户级五条 + 项目侧两条；项目级三条删除 | `routes/mcpTokens.ts`（重写） |
| 审计 | create 改形 + bind / unbind 两动作 + 拒绝审计补项目 | `lib/audit.ts` + 各路由 |
| mapper | `mapMcpToken` 去 project/scope、加 bindings 数组；新增绑定行映射 | `models/types.ts` |
| 前端 | 个人中心新页四 tab + McpPage 降级 + 铃铛迁址 + i18n | 见 18.4 |
| e2e | MCP 用例全量补 `projectId` 参数 + 跨项目新例 | `apitest-e2e-python` |

### 18.3 API 面（新增 / 改写）

```
# 个人中心（全局层，无项目前缀）
GET    /api/v1/me/profile                                   # 基本信息（/auth/me 聚合别名）
POST   /api/v1/auth/change-password                         # 既有端点零改动，前端补页面入口
GET    /api/v1/me/bindable-projects                         # canAccess 项目集 + 每项目 scope 上限
GET    /api/v1/me/mcp/tokens                                # 本人 token 列表（含绑定数组）
POST   /api/v1/me/mcp/tokens                                # 签发（name；明文只在响应出现一次）
DELETE /api/v1/me/mcp/tokens/:tokenId                       # 吊销（软删留审计）
POST   /api/v1/me/mcp/tokens/:tokenId/bindings              # 绑定（projectId + scope ≤ 实时角色）
DELETE /api/v1/me/mcp/tokens/:tokenId/bindings/:projectId   # 本人解绑

# 项目侧（降级为只读 + 解绑）
GET    /api/v1/projects/:id/mcp/bindings                    # 本项目全部绑定（谁的 token / scope / last_used_at）
DELETE /api/v1/projects/:id/mcp/bindings/:tokenId           # 项目管理员解绑（write）
GET    /api/v1/projects/:id/mcp/tools                       # 保留（工具清单展示）

# 删除：GET / POST / DELETE /projects/:id/mcp/tokens（能力上移 /me）

# 通知（/api/v1/notifications* 四条零改动，仅前端迁入个人中心 tab）
```

### 18.4 前端

- **`MePage.tsx`**（全局层路由 `/me`，四 tab，Quiet Console 同款 page-card 形态）：
  基本信息（只读 + 改密表单）/ 通知（`NotificationsPage` 迁入为 `/me/notifications`，
  组件不动）/ MCP Token（签发弹窗 + 绑定管理，从 `McpPage.tsx` 演化）/ agent 凭据
  （占位 tab，文案「随助手凭据功能开放」）。
- **`McpPage.tsx` 降级**：签发区删除，改只读绑定表（绑定人 / scope / last_used_at）
  + 解绑按钮；`mcp_enabled` 开关留在项目设置（总闸语义不变）；工具清单区保留。
- **入口与迁址**：右上角用户菜单加「个人中心」〔**实施期修订**：2026-09-16 用户
  反馈改为「账号区整体移进站内助手抽屉头」——见 18.5 决定 2；本条原方案作废〕；
  `BellMenu` 的「查看全部」改跳
  `/me/notifications`；`GlobalApp` 注册 `/me/*` 路由；旧 `/notifications` 路由删除
  （未发布无包袱，不留兼容跳转）。
- i18n 中英两区补个人中心 / 绑定管理 / 迁址词条。

### 18.5 实施顺序（P12-1 / P12-2）

- **P12-1（后端整批）**：迁移 063 + `mcpAuth` 身份改造 + 闸门五道重排 + 工具面
  `projectId` 参数化（集中注册包装，边界 5 修订）+ `list_my_projects` /
  `copy_endpoint` + REST 全套 + 审计。**一批做完的理由**：身份形状一改，工具面
  不跟着改则 `/mcp` 直接不可用，中间态没有交付价值。
  **e2e 说明（2026-09-16 复核）**：`apitest-e2e-python` 目前**没有任何 MCP 用例**
  （原「用例全量补 `projectId`」不成立，无对象可改）。跨项目 MCP e2e 是**新增**
  工作，按 AGENTS.md「测试需显式请求」列为独立后续项（P12-1b），不在本次实现内，
  待用户点名再做。
  验收：一把 token 绑 A(write) + B(read)——`list_my_projects` 可见两项目与各自
  scope；B 的 `get_endpoint` 通、B 的 `create_endpoint` 拒（-32601 形状）；
  `copy_endpoint` B→A 通；解绑 B 后 B 的读也拒；A 关 `mcp_enabled` 后 A 全 404；
  owner 被移出 B 后 B 的读拒（read 活体复查，缺口收口）；owner 被删后整把
  token 401；吊销后 401（无缓存窗口，延续 050 门槛）。
- **P12-2（前端整批）**：`MePage` 四 tab + `McpPage` 降级 + 铃铛迁址 + 用户菜单
  入口 + i18n。
  **实现状态（2026-09-16，尚未验收）**：`MePage.tsx`（基本信息 / 通知 / MCP Token /
  agent 凭据占位四 tab）、`McpPage.tsx` 降级为「服务与端点 + 只读绑定表 + 工具清单」、
  `UserMenu.tsx` 新增、`NotificationsPage` 整组件迁入 `/me/notifications`、i18n 中英
  两区补齐（并重写 `mcp.serviceHint` / `mcp.tokensHint` 两处「scope 在 Token 上」的
  旧口径）。
  实施期决定的落点（超出/细化了 18.4 的字面描述，记录如下）：
  1. **tab 由地址栏驱动**：`/me` / `/me/notifications` / `/me/mcp` /
     `/me/credentials`（未知段 replace 回 `/me`）——通知 tab 要能被助手抽屉的
     「查看全部」直接指过来，也要能贴给别人（与项目层各页同款纪律）。
  2. **账号区落在站内助手的抽屉头**（2026-09-16 用户反馈修订，原「右上角用户菜单」
     方案作废）：抽屉头快捷钮排首位加「个人中心」，末位加**常红**的「登出」——账号级
     动作与通知 / 换形象 / 主题 / 语言同属「我自己」的操作，收在头像这一排；抽屉头
     全视图常驻（未配置 agent 时也在），登出不会因为没配 agent 就找不到。**两个壳的
     顶栏不再有任何账号控件**（全局壳原先那枚孤立登出钮与临时加的用户菜单一并撤掉，
     项目壳侧栏底部的登出钮同样撤掉——账号区只有抽屉头一处）。对话视图里的「登出」
     chip 同改常红，与头行那枚同名同动作。
  3. **迁址不只改一处**：助手抽屉「查看全部」与助手本地指令 `/打开 通知` 同改指
     `/me/notifications`（`CommandPage` 新增 `path` 字段表达「路由 ≠ key」），
     `COMMAND_PAGES` 补「个人中心」一项。
  4. 通知 tab 保留 `NotificationsPage` 自带的页头（组件一字不动是 18.4 的明写口径）。
  5. **绑定弹窗带出既有绑定集**（2026-09-16 用户反馈）：弹窗里列「这把 Token 现在
     开着：项目（scope）…」，选中**已绑定**的项目时把该绑定的 scope 带进勾选框、按钮
     改文案为「改权限」——不带出的话，Token 已有的 write / execute 在弹窗里看不见，
     提交还会把写权限静默降级成只读。未选项目时写 / 执行恒灰，明确写出原因
     （上限由你在该项目的实时角色决定）。
  6. **agent 凭据 tab 文案改成自解释**：原名题「凭据功能尚未开放」读不出是什么——
     改为点明「站内助手的『我的 agent』凭据（上游地址 + API Key，按用户各配各的）今天
     在助手抽屉的设置卡里配置，这一格是它未来迁进来的归宿」（功能仍不动，边界 9 不变）。
  7. **`-32601` 补一条同一措辞的自救提示**（2026-09-16 用户反馈：上游 agent 反复
     "Method not found"，然后「尝试不带参数」，越试越必然失败）：闸门②④的 JSON-RPC
     错误加 `error.data.hint`——「项目级工具要在 arguments 里传 token 已绑定的
     `projectId`，且该绑定的 scope 覆盖这个工具；先调 `list_my_projects` 取」。
     **两个原因（缺参数 / 未绑定 / scope 不够）连提示也逐字相同**——hint 的有无本身
     就是侧信道，「不泄露项目有没有 MCP 通道」的纪律不变。tool 名不在注册表时由 SDK
     自答（形状本就不同，那一步不涉项目，无需对齐）。
  验收：个人中心改密后旧密码失效、新密码可登录；通知 tab 的全量分页 / 未读筛选 /
  全部已读 / 行点击深链与迁址前逐项一致；MCP tab 走完签发 → 绑定 → 项目侧可见 →
  项目侧解绑全链路；项目侧再无签发入口。

### 18.6 里程碑

| 里程碑 | 阶段 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| M13 | P12 | 个人中心 + 用户级 MCP Token | 一把 token 跨项目（A 写 B 读同一会话完成）；个人中心集齐改密/通知查看全部/MCP Token/agent 凭据挂点；项目侧绑定可见可踢；吊销/解绑/关闸/降权即时生效 |

### 18.7 明确不做

- 跨项目「引用」（流程节点指向另一项目的接口）——流程模型改动，另行立项。
- 自助改名 / 改邮箱 / 注销账号（admin 面已有，不复制）。
- 通知生产端与收件口径的任何改动（P9-1 定案，只挪查看入口）。
- ingest / runner token 的用户级化（机器凭据，项目级是对的）。
- token 级 scope（已移到绑定上，不存在「一把万能写 token」）。
- agent 凭据 tab 的实现（P9-4b 的范围，本阶段只留占位）。

---

## 十九、P13 — 个人中心并入助手卡片 + 卡内问候 + 功能说明文档

> 版本: v2.2（2026-09-21 用户确认**改题**：原 v1.0「新手教程（自 P9-7 移出）」
> 整项**砍除**——用户判定一条主线教程价值不足，不做。P13 改为三件事：① `/me`
> 个人中心五 tab 整体并入站内助手抽屉、删除 `/me` 路由；② 助手卡片空态问候改为
> `HI, {{用户名}}`；③ 新增应用内 `/docs` 功能说明文档，头像旁入口 `_blank` 打开、
> 左侧标题目录 + 右侧正文。
> **v2.2（2026-09-21，P13-1 走查验收反馈）**：① 个人中心删「通知」分区，通知回到
> 抽屉自己的 `notifications` 视图（恢复 bell-item 列表样式）；② MCP Token 去卡片、
> 平铺两张表，me 视图返回键与 tab 条固定不随滚动消失；③ **新增 MCP 绑定许可申请**
> （成员申请角色上限之外的档位、通知 project_admin、批准行即授权，迁移 070）——
> P13 因此不再是零后端，边界 1 已改。见 19.0b / 19.5）。
>
> **v1.0 存档（已废弃，不实现）**：新手教程——数据驱动骨架
> （`{ route, selector, i18nKey }[]` JSON + `preferences.onboarding` 完成态）+
> 一条 5 步主线（登录 → 建项目 → 建接口 → 跑一次 → 看报告）+ 双 i18n。
> 2026-09-21 用户确认砍除，理由：先不做没被验证有人走完的引导。

### 19.0 P13 范围与边界（2026-09-21 确认）

**定位**

P12 把个人中心做成了独立的 `/me` 五-tab 页，同时站内助手抽屉（`AssistantDock.tsx`）
已内置 settings（agent 凭据实际编辑处）/ password / notifications（近 10 条）等
视图——个人中心与助手抽屉是**两套并存的账号面**。P13 收口这个重复：把 `/me`
整体并入助手卡片，`/me` 路由删除。顺带补两个小项（卡内问候、功能说明文档）。

**范围（三项）**

1. **个人中心整体并入助手卡片**：`/me` 现有五个 tab——基本信息（邮箱 / 姓名 /
   角色只读）、通知、我的申请、MCP Token、agent 凭据——**全部**并入站内助手抽屉，
   成为卡内视图 / 分区。`/me` 与 `/me/:tab` 路由**删除**；`GlobalApp` 的 `page="me"`
   分支与相关 `navigate("/me...")` 入口改为「打开助手抽屉并切到对应视图」。
    - **通知**：~~并入后卡内即完整通知（列表 + 分页 + 未读筛选 + 全部已读），
      复用 `NotificationsPage.tsx` 能力放进卡片，不再是「近 10 条」的缩略视图。~~
      **2026-09-21 二轮反馈回退**：通知不进个人中心——个人中心删「通知」分区，
      通知回到抽屉自己的 `notifications` 视图（见 19.0b）。

   - **agent 凭据**：`/me/credentials` 原本只是占位空态，真正编辑本就在抽屉
     settings——此项等于把占位收口到卡内正式分区。
   - **基本信息**：只读账号块（邮箱 / 姓名 / 角色）进卡片。**删除其中的改密码
     表单**（见边界 2）。
   - **我的申请 / MCP Token**：随迁进卡片（我的申请 = P14 权限申请列表；
     MCP Token = 用户级 token 管理）。
2. **卡片问候语**：助手卡片空态标题由现「开始一段对话 / Start a conversation」
   改为 `HI, {{用户名}}`（`assistantDrawer.emptyTitle` 键改为插值形态，中英双语；
   用户名取当前登录用户 name，缺失时回退 email 前缀）。
3. **功能说明文档 `/docs`**：应用内新增 `/docs` 路由，**头像（助手入口按钮）旁**
   加一个入口，`target="_blank"` 新标签打开。页面**左侧标题目录**（清晰分节的
   章节标题，可点击锚点定位）+ **右侧正文**。内容按现有平台功能（项目 / 接口 /
   流程 / 套件 / 调度 / 报告 / 助手 / 统计 / 权限 / 个人中心等）分节，中英双语。
    初稿由本方起草覆盖各功能，用户校订。
4. **MCP 绑定许可申请（2026-09-21 二轮反馈新增，见 19.0b / 19.5）**：项目 MCP 页
   给成员一条申请出口——申请自己在该项目把 Token 绑到角色上限之外的档位
   （viewer 只有 read）。提交后站内通知 project_admin，管理员在项目 MCP 页审批；
   批准行本身就是授权（有效 scope = 角色上限 ∪ 已批准申请），绑定时校验与 `/mcp`
   第 5 道闸门都读它。**只批单项目的 MCP 通道档位，不改成员角色**（用户选定的口径：
   不涉及角色变更）。

**边界**


1. **收口而非重造**：agent 凭据 / 通知 / 改密路径的后端 API 一律复用现有
   （`/me/profile`、`/notifications*`、凭据配置接口、`/auth/change-password`
   保留给抽屉内既有 password 视图）——**信息架构部分零后端改动、零迁移**。
   ~~P13 是前端信息架构调整，零后端改动、零迁移。~~ **2026-09-21 修订**：第 4 项
   （MCP 绑定许可申请）自带后端与迁移（070 + 五条 REST + `/mcp` 闸门放宽），
   其余仍纯前端。
2. **改密码删除范围（2026-09-21 确认：只删基本信息里的）**：删除**基本信息分区
   内**的改密码表单（原 `MePage.tsx` `ProfileTab` 的三输入框表单）。助手抽屉里
   既有的 password 视图与「改密码」快捷 chip **保留不动**——改密入口仍在，只是
   不再出现在基本信息分区。
3. **`/docs` 是应用内路由（2026-09-21 确认）**：走 React 路由 `/docs`（非
   `public/` 静态页），入口按钮 `target="_blank"`；内容用结构化数据 / markdown
   维护在前端，双语复用既有 i18n 机制。文档为**只读展示**，不做编辑器 / 后台配置。
4. **`/me` 删除后的回链**：任何指向 `/me...` 的旧链接（如 P14 站内信里「查看我的
   申请」、审计 / 通知跳转）改为打开助手抽屉对应视图；不得留死路由。

**前端改动面**

- `MePage.tsx`：五 tab 内容拆为可复用视图/分区，迁入 `AssistantDock.tsx`；
  文件删除或退化为薄封装（视迁移落点定）。`ProfileTab` 的改密表单删除。
- `AssistantDock.tsx`：`view` 状态扩展以容纳 profile / requests / mcp 分区
  （现有 chat / settings / password / notifications 之外），notifications 视图
  升级为完整通知能力（复用 `NotificationsPage`）。空态标题改插值问候。
- `main.tsx`：删除 `/me`、`/me/:tab` 路由；`GlobalApp.tsx` 的 `page="me"`
  分支移除。新增 `/docs` 路由（`_blank` 目标，独立于 `DockedShell` 壳或轻壳）。
- 新增 `DocsPage.tsx`（左目录 + 右正文）+ 文档内容源（结构化 JSON / markdown，
  双 i18n）。头像入口旁加 `/docs` 触发按钮（`GlobalApp.tsx` / `ProjectShell.tsx`
  的 topbar，或 `AssistantDock` 入口附近）。
- `i18n.ts`：`assistantDrawer.emptyTitle` 改插值键；新增 `docs.*` 与迁入分区
  所需键（多数可复用既有 `me.*` / `notifications.* ` 键）。

**验收门槛**

1. `/me` 与 `/me/:tab` 路由不可再访问（直达 404 或重定向到抽屉），原五 tab 内容
   在助手卡片内均可达且功能完整（通知可分页 / 全部已读；凭据可编辑；MCP Token /
   我的申请可用）。
2. 基本信息分区无改密码表单；助手抽屉内既有改密视图仍可用。
3. 助手卡片空态显示 `HI, {{用户名}}`（中英双语），用户名正确取值。
4. 头像旁入口点击后 `_blank` 打开 `/docs`；左侧标题目录可点击定位，右侧正文
   分节展示；中英双语。
5. 无指向已删 `/me...` 的死链接。

### 19.0b P13-1 二轮反馈（2026-09-21 用户走查，用户确认）

P13-1 交付后用户走查提出三项，本轮全部落地：

1. **个人信息内删除通知跳转**：个人中心（助手抽屉 `me` 视图）删「通知」分区；
   顶栏铃铛回到抽屉自己的 `notifications` 视图，列表样式用回之前助手内的
   `bell-item`（点行标已读 + 深链、全部已读轻链接），不再借道个人中心。
   `NotificationsPage.tsx`（全量分页页）随之无挂载点，**文件删除**。
2. **MCP Token 不再用卡片**：`McpTokensTab` 的逐 Token 卡片（`.me-token`）换成
   两张平铺表——「Token」（名字 / 前缀 / 已绑项目 / 最近使用 / 签发时间 / 动作）与
   「绑定明细」（Token × 项目 × scope × 绑定时间 / 改权限 / 解绑）。
   同时修「进入 MCP Token 后切 tab 栏消失」：抽屉 `me` 视图改成三层纵向 flex
   （返回键 / tab 条 / 滚动正文），返回键与 tab 条固定在正文之上（`.assistant-me` /
   `.me-panel`），正文再长也不把切换钮带走。
3. **项目内 MCP 增权限申请（新功能，带后端）**：迁移 070 `mcp_binding_requests`
   + `lib/mcpScopes.ts`（有效 scope = 角色上限 ∪ 已批准申请）+ 五条 REST
   （`POST/GET /projects/:id/mcp/binding-requests`、`GET /me/mcp/binding-requests`、
   `POST /mcp/binding-requests/:id/approve|reject`）+ `/mcp` 第 5 道闸门按单档放宽
   （批了 write 不等于能 execute，缓存键随之从 read/write 两分改为按档）。
   前端：项目 MCP 页成员视角申请面板（仅 viewer）与管理员视角审批面板；
   个人中心绑定弹窗显示「审批中」并指向申请入口。见 19.5 实现记录。

### 19.0c P13 三轮反馈（2026-09-26 用户走查，用户确认；零后端）

1. **「个人凭证」一格拆掉**：原 tab（用户级 API 密钥 + agent 凭据占位）撤掉，
   改为两个独立 tab——「API Key 凭证」（用户级 API 密钥面板原样搬入）与
   「agent 凭证」。agent 凭证 tab **读取设置内的列表**：与助手抽屉「设置」卡
   「我的 agent」同一份数据（`GET /assistant/providers` 上游目录 +
   `GET /assistant/my-agents` 我的配置），逐上游一行（名称 / 默认 / 停用 / 已配置 /
   明文参数 + 密文键名 / 更新时间），**只读**；编辑（改参数 / 设默认 / 测试连接）
   仍在「设置」卡，行上「去配置」跳过去并预选该上游（设置卡取数完成后一次性
   尊重该预选，其余时候照旧「我的默认 → 系统推荐 → 第一个」）。同一种东西不做
   两个可编辑入口。
2. **聊天窗展示当前会话绑定的 agent 上游**：会话切换器行加上游 chip（会话行
   `provider_id` → `my-agents` 的 providerName），会话选项后缀也带上游名；无会话
   时显示「新会话」将用的默认上游。hover 说明绑定语义：**会话创建时绑定上游、
   之后一直走它（用你该上游上的凭证），换「默认 agent」只影响新建会话**。
   行为答复（用户问：配两个上游、上游 A 会话 1 聊完再切上游 B，会话 1 还能聊吗）：
   **能聊也能看**——会话 1 钉在 A 上，收发与历史都走 A；B 只决定新会话归属。
   例外：A 被删（`ON DELETE CASCADE` 连会话一起删）、A 被停用、或用户清掉 A 上的
   凭证 → 会话 1 收发 / 回放回 503/2005 未配置。

### 19.1 实施批次

| 步 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| P13-1 | `/me` 五 tab 并入助手抽屉 + 删除 `/me` 路由 + 删基本信息改密表单 + 旧回链改跳抽屉 | 个人中心收口进卡片 | **已实现**（2026-09-21，见 19.4；二轮反馈见 19.0b / 19.5） |
| P13-2 | 助手卡片空态问候改 `HI, {{用户名}}`（双 i18n） | 卡内个性化问候 | **已实现**（2026-09-21，见 19.6） |
| P13-3 | `/docs` 功能说明文档（左目录 + 右正文 + `_blank` 入口 + 双 i18n + 初稿内容） | 应用内功能文档 | **已实现**（2026-09-21，见 19.7；初稿待用户校订） |
| P13-4 | MCP 绑定许可申请（迁移 070 + 五条 REST + `/mcp` 闸门放宽 + 项目 MCP 页申请/审批 + 绑定弹窗状态） | 角色上限之外的 MCP 档位自助申请 | **已实现**（2026-09-21，见 19.5） |
| P13-5 | 「个人凭证」拆成「API Key 凭证 / agent 凭证」两 tab（agent 凭证读取设置内的列表，只读 + 「去配置」跳设置）+ 聊天窗展示会话绑定上游（切换器 chip + 选项后缀 + 默认上游提示） | 凭证归属一眼可读；聊天窗看得见走的是哪个上游 | **已实现**（2026-09-26，见 19.0c） |

### 19.2 里程碑

| 里程碑 | 阶段 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| M14 | P13 | 个人中心并入助手卡片 + 卡内问候 + `/docs` 文档 + MCP 绑定许可申请（二轮反馈）+ 凭证拆 tab 与聊天窗上游展示（三轮反馈） | `/me` 路由删除且个人中心分区（基本信息 / 我的申请 / MCP 凭证 / API Key 凭证 / agent 凭证）在卡片内功能完整且 tab 条常驻；agent 凭证 tab 读设置内的列表（只读 + 去配置跳设置）；聊天窗展示会话绑定的上游；基本信息无改密表单（抽屉改密保留）；通知只有抽屉 `notifications` 视图一个落点；卡片空态 `HI, {{用户名}}` 双语；头像旁 `_blank` 打开 `/docs`，左目录 + 右正文双语；MCP 绑定许可申请「成员申请 → project_admin 站内通知 → 批准即授权（角色上限 ∪ 已批准申请）→ 个人中心可绑定」闭环，且不动成员角色；无 `/me` 死链 |

### 19.3 明确不做

- ~~新手教程（v1.0 全部内容）~~——2026-09-21 砍除。
- ~~后端 / 数据库改动（P13 纯前端信息架构调整，零迁移）。~~ **2026-09-21 二轮反馈
  修订**：MCP 绑定许可申请（P13-4）自带迁移 070 与五条 REST；信息架构三项仍纯前端。
- 基本信息里的自助改名 / 改邮箱（沿用 P12 只读口径）。
- 助手抽屉内既有改密视图与 chip 的移除（只删基本信息里的改密表单）。
- `/docs` 的文档编辑器 / 后台可配 / 版本化（只读展示，内容改前端源文件）。
- 通知 / 凭据后端接口重构（复用现有 API）。
- **MCP 绑定许可申请不做的事**：不改成员角色（批的是单项目 MCP 档位，不是
  `user_project_roles`）；不引入可配置审批人（固定 project_admin）；不做限流 /
  冷却（被拒可立即再申请）；不做「一次申请批多个项目」（一项目一条）；不做许可的
  过期 / 撤销 UI（撤销走数据库或后续批次）。**边界**：许可补的是档位不是成员身份
  ——`/mcp` 第 5 道闸门先判成员（read），被移出项目后历史批准不再放行。
- 通知全量分页页（`NotificationsPage`）不再提供——通知只保留抽屉的「最近 10 条」
  速览与「全部已读」（二轮反馈口径）。

### 19.4 P13-1 实现记录（2026-09-21）

个人中心整体并入助手抽屉、`/me` 路由删除、基本信息改密表单删除、旧回链改跳抽屉。
纯前端、零后端、零迁移（边界 1）。改动面：

- `MePage.tsx`：`MePage`（`page="me"` 独立页）退化为**受控分区** `MeCenter({ tab, onTab })`
  ——去掉 URL 壳（`useParams`/`useLocation`/`navigate` tab 驱动）、页头与回程键；五分区
  （基本信息 / 通知 / 我的申请 / MCP Token / agent 凭据）实现原样保留。`ProfileTab`
  **删除改密表单**（三输入框 + `submit` + `renewSession`，边界 2），只剩只读账号块。
- `AssistantDock.tsx`：`view` 增 `me`（原 `notifications` 缩略视图删除），新增 `meTab`
  状态 + `openMe(tab)`。抽屉头「个人中心」钮落 `me/profile`、铃铛落 `me/notifications`
  （全量分页页，取代「近 10 条」）；两枚钮 active 态跟 `view`/`meTab`，再点回对话。
  `me` 视图复用 `.assistant-settings` 滚动容器渲染 `<MeCenter>`。删除
  `openDrawerNotification` / `markAllDrawerRead` / `formatNotificationWhen` 与
  `notificationsRecent` / `setUnread` 依赖（通知能力回落 `NotificationsPage`）。
  `/打开 个人中心`、`/打开 通知` 指令改为就地切 `me` 视图分区，不再导航。
- `main.tsx`：删除 `/me`、`/me/:tab` 路由（`*` 兜底重定向到 `/dashboard`，无死路由）。
- `GlobalApp.tsx`：删 `MePage` import、`GlobalPage` 的 `"me"`、`page === "me"` 分支。
- `assistantCommands.ts`：`me` / `notifications` 两个 `CommandPage` 去掉 `path`
  （不再拼路由），`global` 仅表「全局层可用」。

未做（留后续批次）：~~P13-2 卡片空态问候 `HI, {{用户名}}`、P13-3 `/docs` 文档~~
（均已实现，见 19.6 / 19.7）。`.assistant-notifications*` CSS 暂留（无引用，不影响；
后续可清）。验收按 AGENTS.md 交用户手工走查。

### 19.5 P13-1 二轮反馈实现记录（2026-09-21）

三项反馈的落点（1 / 2 纯前端，3 带后端与迁移）：

1. **通知回收进抽屉**
   - `AssistantDock.tsx`：`view` 重新纳入 `notifications`；恢复
     `formatNotificationWhen` / `openDrawerNotification` / `markAllDrawerRead` 与
     `notificationsRecent` / `setUnread` 依赖；抽屉头铃铛 active 跟
     `view === "notifications"`，`/打开 通知` 就地切该视图。通知视图不再有
     「查看全部」尾链接（整页已不存在）。
   - `MePage.tsx`：`MeTab` 去掉 `notifications`，分区条回到四项；删 `NotificationsPage`
     import 与渲染。`NotificationsPage.tsx` 文件删除（无其他引用）。
2. **MCP Token 平铺 + 顶部常驻**
   - `MePage.tsx` `McpTokensTab`：逐 Token 卡片改为「Token」表 + 「绑定明细」表两张
     平铺表（`bindingRows` = 全部 Token 的绑定展开，行内可改权限 / 解绑）。
   - `AssistantDock.tsx` + `design-system.css`：`me` 视图由
     `.assistant-settings assistant-me` 改为 `.assistant-me`（三层纵向 flex：返回键
     `.assistant-me-head` / tab 条 / 滚动正文 `.me-panel`），宽度上限 960；删
     `.me-token*` / `.me-binding-table` 旧卡片样式。
   - `MePage.tsx` 绑定弹窗：`me.scopeBeyondRoleApply` 指出申请入口，选中项目有待审
     申请时显示「审批中」。
3. **MCP 绑定许可申请（P13-4）**
   - 迁移 `070_mcp_binding_requests.sql`：`mcp_binding_requests` 表（project / user /
     scope[] / status / handled_by / note）+ 单 pending 部分唯一索引 + 两条查询索引
     + `notifications_kind_check` 扩 `mcp_binding_request`。
   - `lib/mcpScopes.ts`（新）：`MCP_SCOPES` / `ROLE_MAX_SCOPE` / `grantedMcpScopes` /
     `grantedMcpScopesByProject` / `effectiveMcpScopes` / `mergeMcpScopes` /
     `hasMcpScopeGrant`。`routes/me.ts` 与 `lib/mcpToolsMe.ts` 的重复角色表就此归一，
     两处 scope 上限都改读有效集。
   - `routes/mcpBindingRequests.ts`（新，五条 REST，注册于 `index.ts`）：
     `POST/GET /api/v1/projects/:id/mcp/binding-requests`（成员提交 / 管理员列表）、
     `GET /api/v1/me/mcp/binding-requests`（本人跨项目）、
     `POST /api/v1/mcp/binding-requests/:id/approve|reject`。提交只落「超出有效上限」
     的档位（否则 409）；批准带条件 UPDATE 原子消费 pending；审计
     `mcp_binding_request.approve|reject`；通知走 `deliverInboxToRole`
     （新申请 → project_admin）与 `deliverInboxToUser`（结果 → 申请人）。
   - `routes/mcp.ts`：第 5 道闸门 `tokenMayAccess` 按**单档**判——角色判不过时看该档
     是否被批准；请求内缓存键从 `${project}:${read|write}` 改为 `${project}:${scope}`。
   - `api.ts` / `McpPage.tsx`：`McpBindingRequest` 类型 + 五条方法；项目 MCP 页新增
     成员申请面板（仅 viewer，含审批中 / 已批准 / 被拒态与申请弹窗）与管理员审批
     面板（申请待办表 + 批准 / 拒绝）；`i18n.ts` 增 `mcp.perm*`、
     `me.scopeBeyondRoleApply`、`notifications.kind_mcp_binding_request`。

**口径说明（与用户选项对齐）**：用户选定「申请 MCP 单项目绑定许可（不涉及角色
变更）」。因此授权粒度取 **(project, user, 档位)** 而不是「某把 Token」——Token 是
易变的钥匙、许可说的是「这个人在这扇门上能开到哪一档」，落在人上才能同时约束
「绑定时的勾选」与「调用时的第 5 道闸门」。批准行即授权、无第二张事实表；撤销只需
改状态（后续如需要）。

### 19.6 P13-2 实现记录（2026-09-21）

助手卡片空态问候由「开始一段对话 / Start a conversation」改为个性化 `HI, {{用户名}}`。
纯前端、零后端、零迁移。改动面：

- `i18n.ts`：`assistantDrawer.emptyTitle` 由固定文案改为插值键——中文 `HI，{{name}}`、
  英文 `HI, {{name}}`（`{{name}}` 走既有 `t(key, { name })` 插值契约）。
- `AssistantDock.tsx`：新增 `user?.name` / `user?.email` 两个 `useAuthStore` 选择器，
  算出 `greetingName = name 去空白 || email 前缀 || ""`；空态标题渲染改为
  `t("assistantDrawer.emptyTitle", { name: greetingName })`。用户名缺失时回退 email
  `@` 前缀（两者皆空则问候不带名字，不报错）。

验收按 AGENTS.md 交用户手工走查。

### 19.7 P13-3 实现记录（2026-09-21）

应用内 `/docs` 功能说明文档：头像旁入口 `_blank` 打开、左目录 + 右正文、双 i18n、
初稿内容覆盖各功能。纯前端、零后端、零迁移（边界 3：只读展示，不做编辑器 / 后台
配置 / 版本化）。改动面：

- **新增 `DocsPage.tsx`**：与报告分享页同族的「轻壳」——`.docs-shell` 占满视口，
  只有正文列滚。顶栏（lockup 回主页 + 标题）+ 双栏（`.docs-toc` 固定宽左目录 /
  `.docs-content` 正文独立滚）。章节由 `SECTIONS` 常量维护（intro / projects /
  endpoints / flows / suites / schedules / reports / stats / assistant /
  permissions / account 共 11 节），每节标题 / 正文都是 i18n 键；正文用
  `react-markdown + remark-gfm` 渲染（与助手回复同一套，链接 `_blank` 外开）。
  `IntersectionObserver` 做 scroll-spy（`rootMargin` 上偏，当前判定落视口上部），
  点目录项 `scrollIntoView` 平滑定位。`document.title` 打开时设为「功能说明 · 应用名」。
- **`main.tsx`**：新增 `/docs` 路由，挂在 `Protected` 内、`PasswordGate` 与
  `DockedShell` 之外——登录仍是前提，但不受改密闸限制（新标签打开不该被弹去改密页），
  也不挂站内助手（文档是独立读物）。
- **`AssistantDock.tsx`**：顶栏 portal 由单个助手按钮改为 `<>文档钮 + 助手钮</>`——
  文档钮是 `<a href="/docs" target="_blank">`（原生中键 / ⌘+点击另开），装 `BookOpen`
  图标，`.assistant-entry.docs-entry` 复用 34px 圆钮外形（ink-3 描线、悬浮走 accent）。
- **`design-system.css`**：`.assistant-topbar-slot` 改 inline-flex 容两枚入口；新增
  `.docs-*` 全套（轻壳 / 顶栏 / 目录 / scroll-spy active 态 / 正文 markdown 读物尺寸 /
  <760px 窄屏目录折成横向条）。强调色只上 active 目录项与链接（合规）。
- **`i18n.ts`**：中英各新增 `docs.open` / `docs.openTip` / `docs.title` /
  `docs.tagline` / `docs.tocLabel` + 11 节 `docs.section.<id>.title|body`。正文为
  **初稿**，覆盖各功能概述，交用户校订。

验收按 AGENTS.md 交用户手工走查（`/docs` 直达、`_blank` 打开、目录点击定位 +
滚动高亮、中英双语切换）。

---

## 二十、P14 — 项目可见性两层 + 权限申请审批流（自 13.7 转正）

> 版本: v1.0（2026-09-16 立项：13.7 后置增补（2026-09-07 提出）转正排期，用户
> 确认；尚未实现）。

### 20.0 P14 范围与边界（取向自 13.7 原样随迁，扩编为完整口径）

**定位**

原十三章的后置增补（13.7，2026-09-07 提出，当时「记录取向不排期」），2026-09-16
用户确认排期为 P14。当初后置的两个理由现已兑现：**触达靠站内信**——P9 通知中心
（`lib/inbox.ts` + 铃铛）已落地；**审批流复用成员管理**——P6-4 成员 upsert +
`granted_by` + `member.upsert` 审计已落地。本阶段是把已记录的取向接上已就位的地基。

**现状锚点**（2026-09-16 复核，行号随 P8-8 拆轻后移）

`queryProjectMetrics`（`routes/dashboard.ts:42`，非管理员的
`EXISTS(user_project_roles)` 过滤在 `:57`）与 P8-8 拆出的 `queryProjectList`
（同文件，给 `/projects` 的轻查询）都是同一口径——非成员在项目列表 / 数据看板 /
项目切换器**完全看不到**非成员项目（不是「看得到进不去」），URL 直达
`GET /projects/:id` 由 `requireProjectAccess`（`lib/rbac.ts:46`）回 403。发现层的
缺失正是动因：连项目存在都不知道，「找谁要权限」无从谈起——成员页展示管理员清单的
前提是先进得了项目（P6-4 的产品理由只覆盖了已进项目的 viewer）。

**范围**

- **可见性拆两层，指标不随身份外泄**：项目身份（名称 / 描述）对全部登录用户可见；
  接口数 / 通过率等指标仍只对成员计算与下发，看板聚合的分母不含非成员项目——
  「看得到」买到的是发现，不是数据。
- **无权限落地页**：非成员 URL 直达项目时不再是裸 403——身份级端点回 200（项目名 +
  管理员线索），前端渲染「无权限 + 申请入口」落地页。这是审批流的 UX 前置，也是
  `requireProjectAccess` 之外唯一要开的口子。
- **审批流复用成员管理，不开第二条写路径**：新表 `access_requests`；**批准 = 现有
  成员 upsert**（`granted_by` 落审批人，`member.upsert` 审计照旧），拒绝只记状态。
  P6-4 成员页的人工添加与 P6-3 邀请码通道照旧——审批流是用户主动的自助通道，
  不是唯一通道。
- **触达靠站内信**：新申请 → 通知全体 project_admin；审批结果 → 通知申请人。
- **幂等**：同一 (project, user) 只允许一条 pending；被拒后可再申请（第一版不限流）。

**边界决策**

1. **指标不随身份外泄**（随迁取向 1）：`/projects` 与 dashboard 对非成员下发的是
   身份级字段（名称 / 描述 / 「是否成员」标记），任何资产计数与执行指标仍走成员
   过滤；`/stats/*` 的可见项目集口径不变（P8-4 的 `resolveScope`）。
2. **`requireProjectAccess` 之外唯一开口 = 身份级端点**（随迁取向 2）：新端点只回
   项目身份 + 管理员线索，不回任何项目内容；其余全部项目级端点维持 403 原样。
3. **批准 = 既有成员 upsert**（随迁取向 3）：不写第二条「加成员」路径，`granted_by`
   落审批人、`member.upsert` 审计照旧；管理员也可在审批时改定角色后批准。
4. **人工添加与邀请码通道照旧**（随迁取向 3）：审批流是自助通道，不是唯一通道。
5. **通知只发 project_admin**（随迁取向 4 的收窄）：`deliverInbox` 是全体成员扇出，
   申请通知需按角色过滤——`lib/inbox.ts` 加 project_admin 定向投递（或给
   `deliverInbox` 加 role 过滤参数），第一版不引入「可配置审批人」。
6. **幂等与再申请**（随迁取向 5）：partial unique index 保证单 pending；被拒后可
   立即再申请，第一版不限流、不做冷却。
7. **实施时再定的开口**（随迁取向 6）：申请是否带建议角色（管理员可改后批准）；
   非成员可见的管理员线索到什么粒度（email / 仅姓名）；项目切换器是否列出带锁的
   非成员项目（**倾向不列**——切换器是「进入」的入口，目录页才是「发现」的入口）。

**数据库迁移：`064_p14_access_requests.sql`（示意；编号以实施时最新空位为准——
2026-09-16 已用至 062，P12 实施时落 063，P14 顺延为 064）**

```sql
CREATE TABLE IF NOT EXISTS access_requests (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  suggested_role TEXT CHECK (suggested_role IN ('project_admin','developer','viewer')),  -- NULL = 未带建议（边界 7 开口）
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  handled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_requests_pending_uniq
  ON access_requests (project_id, user_id) WHERE status = 'pending';  -- 边界 6：单 pending

-- 站内信 kind 扩一个 'access_request'（057 的 CHECK 是列级匿名约束，PG 默认名
-- notifications_kind_check；drop + 重建，六值全集）
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CHECK (kind IN ('member_change', 'plan_assign', 'alert',
  'suite_result', 'ci_result', 'access_request'));
```

**路由（示意）**

```
# 可见性两层（身份级端点——requireProjectAccess 之外唯一开口，边界 2）
GET  /projects/:id/identity          # 登录即可访问：项目名/描述 + 管理员线索（粒度边界 7）
# /projects 列表对非成员追加身份级条目（无任何指标字段；形状实施时定——扩既有
#   queryProjectList 的外层 WHERE，还是独立目录端点）

# 审批流（新表 access_requests）
POST /projects/:id/access-requests   # 非成员提交申请（已有 pending → 409，幂等边界 6）
GET  /projects/:id/access-requests   # project_admin：本项目申请列表（含待审/历史）
GET  /access-requests/me             # 本人跨项目的申请与状态（全局层，无项目前缀）
POST /access-requests/:id/approve    # project_admin：批准 = 既有成员 upsert（角色可在
                                     #   批准时改定，granted_by = 审批人，边界 3）
POST /access-requests/:id/reject     # project_admin：拒绝只记状态（handled_by/at）
```

**改动面摸底**

| 处 | 改动 | 说明 |
| --- | --- | --- |
| `routes/dashboard.ts` | `queryProjectList` 外层 WHERE 拆两层（身份全量 / 指标成员过滤） | `queryProjectMetrics` 不动——它只服务已进项目的看板 |
| `routes/projects.ts` + 新 `routes/accessRequests.ts` | 身份级端点 + 审批流 REST 五条 | 批准复用 `routes/members.ts` 的 upsert 路径 |
| `lib/inbox.ts` | project_admin 定向投递（新函数或 `deliverInbox` 加 role 过滤） | `InboxKind` 扩 `'access_request'` |
| `lib/rbac.ts` | 不动（身份级端点不走 `requireProjectAccess`，边界 2） | — |
| 前端 | 无权限落地页（项目名 + 管理员线索 + 申请入口）+ 成员页「权限申请」tab（审批列表）+ `/me` 或项目目录的「我的申请」入口 + i18n 双区 | 落地页在 P14-1 先上「找管理员」降级态，P14-2 接申请入口 |

**验收门槛**

1. 非成员在项目列表能看到非成员项目的名称 / 描述，看不到任何指标；看板聚合的
   分母不含非成员项目（P8 口径零回归）。
2. 非成员 URL 直达项目渲染「无权限」落地页（不再是裸 403），落地页可见管理员线索。
3. 申请 → 全体 project_admin 收到站内信；批准 / 拒绝 → 申请人收到结果站内信，
   深链可达对应页面。
4. 批准后申请人即获所批角色，成员页与 `member.upsert` 审计口径与人工添加一致。
5. 同一 (project, user) 只有一条 pending（重复提交 409）；被拒后可再申请。
6. 既有通道回归：P6-3 邀请码注册、P6-4 成员页人工添加行为不变。

### 20.1 实施批次

| 步 | 内容 | 产出 | 状态 |
| --- | --- | --- | --- |
| P14-1 | 可见性两层 + 无权限落地页（`queryProjectList` 拆层 + 身份级端点 + 前端列表/落地页；**零迁移**，落地页先上「找管理员」降级态） | 发现层可用：看得到、进不去有落地页 | **已实现**（2026-09-21）：`queryProjectList` 去成员过滤 + 每行 `is_member`，非成员行指标置 null；新 `GET /projects/:id/identity`（登录即读，回身份 + project_admin 姓名/邮箱线索）；前端 `ProjectShell` 身份闸 + 无权限落地页、目录页非成员卡仅「查看」、切换器只列成员项目；管理员线索粒度取姓名 + 邮箱，切换器不列非成员项目 |
| P14-2 | 审批流（迁移 063 + `access_requests` REST + inbox 定向投递 + 前端申请入口/审批 tab/我的申请） | 自助申请闭环 | **已实现**（2026-09-21）：迁移落 **069**（编号顺延——063 已被 P12 占用，实施时最新空位是 069）；`access_requests` 表（partial unique index 保单 pending + 项目/用户级双索引）+ notifications kind 扩 `access_request`（DROP/ADD `notifications_kind_check`，六值全集）；新 `routes/accessRequests.ts` 五条 REST（提交走 `currentUser` 非 `requireProjectAccess`——非成员正是要用这口子；approve/reject 无项目前缀，自读申请行拿 project_id 再 `myRoleInProject` 把关；带条件 UPDATE 原子消费 pending，并发第二个批准者 409）；批准 = 既有成员 upsert（`granted_by` = 审批人、`member.upsert` 审计 detail.via='access_request'、`member_change` 通知照旧，边界 3）；`lib/inbox.ts` 加 `deliverInboxToRole`（project_admin 定向投递，边界 5），拒绝审计新动作 `access_request.reject`；前端：无权限落地页接申请入口（可带建议角色 + pending/被拒状态条）、成员页拆「成员/权限申请」两 tab（`?tab=requests` 深链，仅 project_admin）、个人中心加「我的申请」tab；i18n 双区。角色建议可空（边界 7，管理员批准时改定）；被拒可再申请（边界 6，不限流） |

### 20.2 里程碑

| 里程碑 | 阶段 | 交付物 | 验收标准 |
| --- | --- | --- | --- |
| M15 | P14 | 项目可见性两层 + 权限申请审批流（自 13.7 转正） | 非成员可见项目身份（名称/描述）但任何指标不可见，看板聚合分母不含非成员项目；URL 直达渲染「无权限」落地页而非裸 403；申请→站内信通知 project_admin→批准（走既有成员 upsert）/拒绝→结果通知申请人全程闭环；同一 (project, user) 只有一条 pending |

### 20.3 明确不做

- 指标对非成员开放（任何形态的「预览数据」——看得到 ≠ 数据，取向 1 的红线）。
- 第二条成员写路径（批准只走既有成员 upsert，取向 3）。
- 邮件 / 站外触达（站内信够用，P9 未引 SMTP 的口径不变）。
- 可配置审批人 / 多级审批（第一版固定 project_admin 全体）。
- 申请限流 / 冷却（被拒可立即再申请，取向 5）。
- 项目切换器列非成员项目（倾向不列，边界 7 的开口随实施定，默认不做）。
