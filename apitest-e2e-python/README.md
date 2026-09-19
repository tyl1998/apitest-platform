# apitest-e2e-python

针对 `apitest-server` 的接口自动化测试（pytest + requests）。

## 目录结构

```
apitest-e2e-python/
├── conftest.py          # session 级 fixture：登录拿 JWT、封装 api 客户端
├── data/
│   ├── config.py        # 环境配置（base_url / 账密），环境变量可覆盖
│   └── constant.py      # 响应码等断言常量
├── req/
│   └── http_req.py      # HTTP 请求封装
├── setup/
│   └── seed_assistant.py # P9-2 助手联调种子（agent-vendor provider 行 + 用户 agent 凭据；手工跑）
├── drill/               # P9-8 上游异常演练（stub 假上游 + 逐项清单，非 pytest）
├── test_case/
│   ├── auth/            # /api/v1/auth/*
│   ├── p10/             # P10-1 大响应转存种子上游（造一条 responseBodyStored=true 的执行）
│   ├── projects/        # /api/v1/projects*
│   ├── runner/          # /api/v1/system/runner-*（Runner 相关只读查询）
│   └── system/          # /api/v1/system/*（limits / runner-labels 只读查询）
└── utils/
    └── other_utils.py   # 唯一项目名等工具
```

## 站内助手（P9-2）

助手行为**不再有 pytest 用例**（2026-09-16 用户决策）。原因两条：

- 会话用例必须在真实上游（agent-vendor stg，经 apitest-server 代理）上建会话、发消息，测完
  留下一堆会话/消息映射脏数据；
- 「发消息并读 SSE 到底」那类断言读的是真实上游的收尾，而服务端每 15s 发一行 SSE
  注释保活（`routes/assistant.ts` 的 `HEARTBEAT_MS`），客户端读超时永不触发——上游卡在
  「有数据但不给结果」时整条流一直挂着，把 runner 的作业拖到时限（`timed_out`，报告
  解析随之跳过），一次上游抖动吃掉整包。

要联调/验证助手，走手工通道：`source env.local.sh && python3 setup/seed_assistant.py`
配好上游，然后在浏览器里用顶栏助手抽屉观察；上游异常（断流 / 限流 / ERROR 事件）用
下一节的假上游演练——可控、可复现，且不占 CI。

## 上游异常演练（P9-8）

上游坏法（断流 / 限流 / ERROR 事件）的操练不走 pytest：`drill/stub_upstream.py` 是
一个零依赖的假 agent 平台（按迁移 059 的 agent-vendor 方言实现同一份协议，把 provider 的
`baseUrl` 指过去即可、不动协议配置），12 个故障模式按需切换；
`drill/README.md` 是逐项清单（期望后端 / 期望界面 + 验收门槛对应项）。见那份文档。

## 运行

前置：apitest-server 在跑（默认 `http://localhost:3000`），种子管理员
`admin@local.test / admin123` 可登录。

```bash
pip install -r requirements.txt
python -m pytest test_case -v
```

日志：默认在 CLI 上按 `时间 | 级别 | 来源 | 内容` 打印（`pytest.ini` 的
`log_cli_*` 配置），每个 HTTP 请求一行（`apitest.http`）、用例开始/结束各一行
（`apitest.e2e`）。要关掉只保留断言输出：

```bash
python -m pytest test_case -v -o log_cli=false
```

覆盖地址或账密：

```bash
APITEST_BASE_URL=http://localhost:3000 \
APITEST_EMAIL=admin@local.test \
APITEST_PASSWORD=admin123 \
python -m pytest test_case -v
```

也可以用 `--host` 直接指定被测服务根地址（留空默认 `http://localhost:3000`）：

```bash
python -m pytest test_case -v --host http://127.0.0.1:3000
```

## P10-1 前端核验种子（test_case/p10）

给「下载完整响应」按钮造一条真实的大响应执行，跑通后打开浏览器核验：
`python -m pytest test_case/p10 -v`。它起一个本机假上游（11KB 响应），建端点、
排队执行并轮询到终态，断言 `responseBodyStored=true`，再走一遍详情页按钮调用的
`/response-body` 直链端点。

**前置：apitest-server 与 worker 都在跑**（执行队列从不内联进 API 进程）。若 worker
没起，执行会停在 `queued`，用例按超时失败并提示，不会误当成通过。

## apitrack 上报（可选）

装好 `apitrack-sdk`（`pip install -r requirements-dev.txt`）后 source 配置再跑，结果即上报平台（Token 在 `env.local.sh`，
不入库）：

```bash
pip install -r requirements-dev.txt
source env.local.sh
python -m pytest test_case -v           # 跑完自动上报
python -m pytest --apitrack-dry-run     # 只打印 payload，不发出去
python -m apitrack doctor               # 看探测到的 git/commit/branch 配置
```

## 约定

- 响应包络统一为 `{code, message, data}`，成功 `code=0`（见
  `apitest-server/src/lib/response.ts`）。
- 每个用例自建项目、自清理（或留独立名字），互不依赖执行顺序。
