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
├── test_case/
│   ├── auth/            # /api/v1/auth/*
│   ├── projects/        # /api/v1/projects*
│   ├── runner/          # /api/v1/system/runner-*（Runner 相关只读查询）
│   └── system/          # /api/v1/system/*（limits / runner-labels 只读查询）
└── utils/
    └── other_utils.py   # 唯一项目名等工具
```

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
