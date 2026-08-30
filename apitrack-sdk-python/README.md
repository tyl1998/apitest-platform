# apitrack-sdk

把**已有的 pytest 仓库**的运行结果报给 ApiTrack 平台，让平台看得见「这个系统被测到了
多少」。平台不持有、不执行、不重放你的测试代码。

## 接入（三步，测试代码一行都不改）

```bash
pip install apitrack-sdk
```

```bash
export APITRACK_URL=https://apitrack.example.com
export APITRACK_TOKEN=apitrack_xxxxxxxx
```

```bash
pytest              # 原样，命令不变
```

插件通过 `pytest11` entry point 自动加载：不用改 `conftest.py`，不用加 `-p` 参数。

先看一眼会报什么：

```bash
pytest --apitrack-dry-run     # 打到 stdout，不发出去
python -m apitrack doctor     # 看探测到的 git/commit/branch/CI 信息
```

## 它不会做的事

- **不影响用例执行**：采集只是往内存 list 里追加一条 dict，全程零网络；上报只在
  `pytest_sessionfinish` 发生一次。
- **不吃掉响应流**：桩绝不读 `.content` / `.text` / `.json()`。`stream=True` 的响应逐块读
  出来的内容与没装这个包时逐字节相同。响应大小只从 `Content-Length` 取。
- **不动退出码**：上报 5 秒超时 + 一次重试，失败只打一条 warning。
- **不发凭据**：`Authorization`、`Cookie` 以及名字含 `token|secret|key|password` 的头只留
  键名。请求体默认**不传**（`APITRACK_BODY_CAPTURE=1` 才传，且截断）。
- **没有 Token 时完全不生效**：`APITRACK_TOKEN` 缺失时连请求拦截都不装，本地跑测试等于
  这个包不存在。

## 环境变量

| 变量 | 说明 |
|---|---|
| `APITRACK_URL` | 平台地址（写根地址或直接写到 `/ingest` 都行） |
| `APITRACK_TOKEN` | 项目级上报 Token，形如 `apitrack_…` |
| `APITRACK_BODY_CAPTURE` | `1` 时带截断后的请求体，默认不带 |
| `APITRACK_TIMEOUT` | 上报超时秒数，默认 5 |
| `APITRACK_GIT_URL` / `APITRACK_COMMIT` / `APITRACK_BRANCH` | 覆盖自动探测（浅克隆、非 git 工作树时用） |

## 用例身份与显示名

`case_key` 是身份，`name` 是显示，两者分开——改一句 docstring 不会在平台上长出一条新用例。

| 字段 | 来源 |
|---|---|
| `case_key` | pytest nodeid 去掉 `[...]`；`@case(key=…)` 可覆盖 |
| `name` | `@case("…")` > docstring 首行 > 函数名原样 |
| `description` | docstring 首行之后的全部内容 |
| `tags` | pytest marker 名（剔除内置的）∪ `@case(tags=[…])` |

参数化用例在平台上是**一条**用例、多个子结果。

可选的显式覆盖：

```python
from apitrack import case

@case("创建订单-VIP", key="order.create.vip", tags=["smoke"])
def test_create_order():
    ...
```

## 全量与删除对账

平台按「范围内的全量」决定是否把代码里已删掉的用例标记为消失。范围取自 pytest 自己的
参数，零配置：

| 命令 | 范围 | 全量 | 平台侧对账范围 |
|---|---|---|---|
| `pytest` | 仓库根 | 是 | 全仓 |
| `pytest tests/order/` | `tests/order` | 是 | 只 `tests/order` 下 |
| `pytest tests/order/ -m smoke` | `tests/order` | 否 | 不对账 |
| `pytest tests/order/test_a.py` | 该文件 | 是 | 只该文件 |

`-k` / `-m` / `--lf` / `--ff` / `-x` / `--deselect` 与收集报错一律判为非全量。平台侧还要求
分支等于仓库配置的跟踪分支才真正执行删除，所以一次 feature 分支上的全量跑不会删任何东西。

## 支持的 HTTP 库

`requests`（`HTTPAdapter.send`）与 `httpx`（`HTTPTransport.handle_request` 及其 async 版）。
两者都靠探测，装了哪个打哪个，两个都没装就什么都不打。`aiohttp` 首版不支持。

## 崩溃时会发生什么

`-x` 中断、CI 超时、OOM 会让 `pytest_sessionfinish` 不执行，那一次运行**整份不上报**。
这是有意的：宁可平台上「昨晚那次没有记录」，也不要半份数据被当成全量去删用例。

## 发布（维护者）

只发**一个**分发包：`apitrack-sdk`。发布走 **Trusted Publishing（OIDC）**，仓库里没有也
不需要 PyPI token。

流水线有两条路径，靠触发方式区分：

| 触发 | 版本号 | 上传目标 | 用途 |
|---|---|---|---|
| Actions 页 **Run workflow** | `<主包版本>.dev<run 号>` | 只 TestPyPI | 调试，想跑几次跑几次 |
| 打 tag `v0.1.0` | `0.1.0` | TestPyPI → PyPI | 真发布 |

调试路径每次自动带一个新的 `.devN` 版本号，这一点是必需的而不是方便：TestPyPI 与 PyPI 一样
**版本号不可重用**，若复用 `0.1.0`，上传会被 `skip-existing` 静默跳过，接着 `verify` 装下来
的是第一次上传的旧包并绿着通过——你以为修好了，其实一行新代码都没验到。

调试循环：

```
改代码 → push main → Actions 页 Run workflow → 看 verify → 重复到绿
```

真发布（tag 必须与 `pyproject.toml` 的 `version` 逐字一致，否则 `build` 在构建前就失败）：

```bash
git tag v0.1.0 && git push --tags
```

`pypi` job 只在 tag 路径执行，手动跑到 `verify` 就停。

### 首次发布前的人工前置（都在网页上）

1. **两个站点各登记一次 pending publisher**（包还没发过，所以用「发布前先登记」）：
   [TestPyPI](https://test.pypi.org/manage/account/publishing/) 与
   [PyPI](https://pypi.org/manage/account/publishing/)。四项元数据必须与本工作流逐字一致：
   PyPI Project Name `apitrack-sdk` / owner `tyl1998` / repo `apitrack-sdk-python` /
   workflow `publish.yml` / environment `testpypi` 或 `pypi`。错一个字符的表现是 OIDC 拒绝，
   报错长得像权限问题。
2. **GitHub 仓库 Settings → Environments** 建 `testpypi` 与 `pypi`。
3. 建议给 `pypi` environment 加一个 **required reviewer**：那是最后一道人工闸门，即使误打了
   tag 也会停下来等确认。
