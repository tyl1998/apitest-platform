# apitest-e2e-python

针对 `apitest-server` 的接口自动化测试（pytest + requests）。

## 目录结构

```
apitest-e2e-python/
├── conftest.py          # session 级 fixture：登录拿 JWT、封装 api 客户端
├── data/
│   ├── config.py        # 环境配置（base_url / 账密 / 助手联调项目名），环境变量可覆盖
│   └── constant.py      # 响应码等断言常量
├── req/
│   └── http_req.py      # HTTP 请求封装
├── setup/
│   └── seed_assistant.py # P9-2 助手联调种子（agent-vendor provider 行 + 项目开关；P9-3 落地后退休）
├── drill/               # P9-8 上游异常演练（stub 假上游 + 逐项清单，非 pytest）
├── test_case/
│   ├── assistant/       # /api/v1/projects/:id/assistant/*（P9-2 五条会话路由）
│   ├── auth/            # /api/v1/auth/*
│   ├── projects/        # /api/v1/projects*
│   ├── runner/          # /api/v1/system/runner-*（Runner 相关只读查询）
│   └── system/          # /api/v1/system/*（limits / runner-labels 只读查询）
└── utils/
    └── other_utils.py   # 唯一项目名等工具
```

## 站内助手（P9-2）

`test_case/assistant` 打的是**真实 agent-vendor stg 平台**（经 apitest-server 代理转发，
Key 不出服务端）。前置种子一次：

```bash
source env.local.sh && python3 setup/seed_assistant.py
```

（`env.local.sh` 里的 `agent-vendor_API_KEY` 即 agent-vendor 管理后台签发的 ak- Key，不入库。）

平台侧 LLM Key 额度不足时（2026-09-11 联调现状），消息走 error 终态——用例断言
协议不变量（终态唯一、字段非空），done / error 都接受；额度修复后同一组用例自然
覆盖正常流式。未种子时整模块 skip 并给出种子命令提示。

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
