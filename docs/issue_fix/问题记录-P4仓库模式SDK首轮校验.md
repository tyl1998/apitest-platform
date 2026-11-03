# 问题记录 — 仓库模式 SDK（apitrack-sdk）首轮 TestPyPI 校验

> 阶段：P4-10 / P4-11（仓库模式上报 SDK）
> 发现方式：GitHub Actions `verify` job（从 TestPyPI 装包后跑真实 pytest）
> 日期：2026-08-30

---

## 1. `describe()` 抛 `AttributeError: 'function' object has no attribute 'read'`

**状态**：已修

### 现象

`verify` job 里从 TestPyPI 装好包、在探针目录跑 `pytest` 时，pytest 报 INTERNALERROR：

```
INTERNALERROR>   File ".../site-packages/apitrack/plugin.py", line 194, in pytest_collection_modifyitems
INTERNALERROR>     self.collector.register_case(describe(item))
INTERNALERROR>   File ".../site-packages/apitrack/plugin.py", line 88, in describe
INTERNALERROR>     override = case_meta.read(function) if function is not None else {}
INTERNALERROR> AttributeError: 'function' object has no attribute 'read'
```

值得注意的是这条 traceback 顺带**证明了 entry point 是好的**：插件被 pytest 自动加载、
`pytest_collection_modifyitems` 被调用了，否则根本走不到这一行。所以 P4-11 那条「零改动
接入」的机制本身没问题，炸的是采集第一步。

### 根因

包命名空间里，**子模块被同名函数遮蔽**。

`apitrack/__init__.py`：

```python
from .case import case      # 先导入子模块 apitrack.case，再把 `case` 重新绑定成函数
```

`from .case import case` 的执行顺序是：① 导入子模块 `apitrack.case`（此时包属性
`apitrack.case` 是那个**模块**）；② 把 `case` 这个名字绑定为模块里的 `case` **函数**，
覆盖掉①的结果。

于是 `apitrack/plugin.py` 里的

```python
from . import case as case_meta   # 拿到的是装饰器函数，不是模块
```

取到函数，`case_meta.read(...)` 自然没有 `read` 属性。

`@case` 是用户唯一会写的公开 API，`from apitrack import case` 必须成立；而模块名与它同名
恰好是最自然的组织方式。所以问题不在命名，在**包内取符号的方式**。

### 为什么本地没发现

`describe()` 需要一个 pytest `Item` 才能进，而开发机装不上 pytest（pip 的 SSL 证书链失败），
本地那轮验证只覆盖了 `split_nodeid` 这类纯函数。`describe()` 是**唯一**读 `@case` 元数据的
地方，于是这条路径一次都没被执行过——缺陷在「装包」之前就存在，而当时唯一的自动化是「装完
之后验行为」，位置错了一层。

### 修法

1. `plugin.py` 改为**直接导入符号**，不经过包属性：
   ```python
   from .case import read as read_case_override
   ```
   两处调用点同步改名。
2. `__init__.py` 与 `plugin.py` 的模块 docstring 各写明这个遮蔽陷阱与「包内一律直接导符号」
   的规矩——否则下一个人还会写出 `from . import case`。
3. **补 `describe()` 的测试，且不依赖 pytest**：`describe()` 只用到 `nodeid` / `name` /
   `function` / `iter_markers` 四样，用一个手搓的 `FakeItem` 就能覆盖（`tests/test_units.py`
   新增三条：默认推导、`@case` 覆盖、无 docstring 回落）。缺口的成因是「这条路径需要 pytest
   才能进」，那就让它不需要。
   已确认这三条测试**能真的抓住原 bug**：把修复 stash 掉之后它们复现同一个 `AttributeError`。

---

## 2. 上传前不跑仓库自己的测试（流程缺陷）

**状态**：已修

### 现象

问题 1 是一个 30 秒就能被单元测试抓到的缺陷，却一路走到了「构建 → 上传 TestPyPI → 装包 →
跑 pytest」的最后一步才暴露，并且烧掉了一个 TestPyPI 版本号。

### 根因

`publish.yml` 的第一个 job 是 `build`，仓库里的 `tests/` 从未在 CI 里被执行。整条流水线只有
「装完之后验行为」这一层保护，而它排在上传之后。

### 修法

新增 `test` job 并让 `build` `needs: test`：在 checkout 出来的源码树上直接
`pip install pytest requests && python -m pytest tests -q`。同类问题在上传前暴露，不消耗任何
版本号。

`requests` 一并装上是刻意的：`tests/test_plugin_session.py` 里验「`stream=True` 的响应不被桩
吃掉」的那条用 `skipif` 判断 requests 是否存在，不装它会被静默 skip——而那条恰好是最重要的
行为保证之一。

---

## 3. 修复推送后 re-run 旧 run，验的仍是旧包（流程缺陷，空转一轮）

**状态**：已修（工具侧尽量兜住 + 文档写明）

### 现象

问题 1 的修复推送之后，`verify` 报**一字不变**的同一个 `AttributeError`，行号也还是
`plugin.py:88` / `194`。当时的判断是「修复没生效」。

实际上远端 `origin/main` 的 `plugin.py` 已经是修复版（`read_case_override`，行号 94/228），
两条线索指向真相：

- 日志里的包版本是 `apitrack-sdk-0.1.0.dev1` —— 后缀 `1` 来自 `GITHUB_RUN_NUMBER`，
  也就是**第 1 次 run**；
- traceback 的行号（88/194）对应修复**之前**的文件。

### 根因

点的是 **Re-run**，而不是新建 run。GitHub 的 re-run 保留原 run 的 commit SHA 与
run number，按定义就是**重测那个旧 commit**；「Re-run failed jobs」更进一步——`build` 根本
不重跑，`verify` 直接 `download-artifact` 复用上一次构建的 wheel。

工具侧也有责任：dev 版本号当时用的是 `GITHUB_RUN_NUMBER`，它在 re-run 时**不变**。于是
`0.1.0.dev1` 撞上已存在的版本，`skip-existing: true` 把上传**静默**跳过，`verify` 又老老实实
装回那个旧包。三件事叠起来，症状与「修复无效」完全一致，而唯一的线索是 traceback 的行号
对不上——那已经是浪费了一整轮之后才会被注意到的东西。

### 修法

三处，都是让「我在测哪一版」变成一眼可见：

1. **dev 版本号改用 epoch 秒**（`0.1.0.dev1788073679`）而不是 run number。每次构建都产出一个
   未被占用的版本号，即使误点 re-run 也会真的重新上传，不会被 `skip-existing` 蒙掉。
   已按 PEP 440 的 dev 段规范核过：dev 号是任意长度整数，10 位 epoch 合法，且 `X.Y.Z.devN`
   的排序永远早于 `X.Y.Z`。
2. **`build` 与 `verify` 的日志开头打印版本号 + commit SHA + 提交标题**，`build` 另外写进 run
   的 Step Summary。SHA 认人靠机器、标题认人靠眼睛，两者都要。`verify` 还直接印一行提醒：
   版本号不是刚构建出来的就说明这是 re-run。
3. **工作流注释与 README 写明「推了修复之后要新建 run，不要 Re-run」**，并解释 re-run 的语义
   （重测旧 commit）与「Re-run failed jobs 会复用旧 artifact」这两件事。

**做不到的部分**：无法从工作流里阻止 re-run，也无法在 re-run 时自动换成新 commit——那是
GitHub 的行为。所以这一条终究是靠「打印得足够显眼 + 文档写清」来防，而不是靠机制杜绝。

---

## 4. 三条集成测试自身写错，且从未被执行过

**状态**：已修

### 现象

问题 2 新增的 `test` job 第一次运行，立刻报出三条失败：

```
FAILED tests/test_plugin_session.py::test_dry_run_payload_shape
FAILED tests/test_plugin_session.py::test_marker_filter_is_not_full_inventory
FAILED tests/test_plugin_session.py::test_keyword_filter_is_not_full_inventory
json.decoder.JSONDecodeError: Extra data: line 61 column 1 (char 1276)
```

从 traceback 里能读出**被测对象是好的**：`"protocol_version": "1.0"`、`inventory` 有条目、
`records: []` 都在，`1 failed, 3 passed, 1 skipped` 也正是那份 fixture 的预期结果。错的是
断言。

### 根因

```python
payload = json.loads(result.stdout.split(marker, 1)[1])
```

dry-run 打印完 payload 之后，**pytest 自己还会继续输出测试摘要**（`FAILED …` 行与
`==== 1 failed, 3 passed ====`）。`json.loads` 要求整个字符串恰好是一个 JSON 值，于是报
`Extra data`。

这三条测试从写出来到那一刻**一次都没被执行过**（开发机装不上 pytest，pip 撞企业 CA 的证书链
失败），所以是它们第一次运行就暴露了自己。

### 修法

抽一个 `_dry_run_payload(result)` 辅助函数，三个调用点共用，改用
`json.JSONDecoder().raw_decode()`：它解析第一个完整 JSON 值就停下，后面是什么都不管，正好
对应「stdout 里先是 payload 再是 pytest 摘要」这个事实。

**不按 `====` 之类的分隔符截断**：那种切法依赖 pytest 的输出措辞，换个版本就失效——与问题 2
里把 `verify` 的判据从「读 `--trace-config` 的文本」换成行为判据是同一条理由。

### 后续：开发机终于能跑测试了

pip 撞的是企业 CA 的证书链，用 `--trusted-host pypi.org --trusted-host files.pythonhosted.org`
可以绕过。装上 `pytest` 与 `requests` 之后**19 条全部通过**，包括此前从未执行过的 5 条集成
测试（dry-run payload 形状、`-m`/`-k` 非全量、上报失败不改退出码、`stream=True` 不被桩吃掉）。

这条值得记下来：先前几轮「本地无法验证」的说法过于消极——真正的障碍只是一个 pip 参数。
之后再说「本机跑不了」之前，先花两分钟试证书绕过。

---

## 5. 声明支持 3.9 但只在 3.11 上验证过（潜在缺陷）

**状态**：已修

### 现象

`pyproject.toml` 写 `requires-python = ">=3.9"`，而 CI 固定跑 3.11。「支持 3.9」当时只是
一句声明，从未被执行过。

同时 `classifiers` 里只有 `Programming Language :: Python :: 3`，没有逐版本行——PyPI 页面
靠那些行显示支持范围，缺了的话包能装但页面上看不出下界。

### 根因

这类问题很安静：某天有人把 `X | Y` 写在**非注解位置**（注解位置有
`from __future__ import annotations` 兜着），3.11 的 CI 全绿，而 3.9 的用户装上就
`TypeError: unsupported operand type(s) for |`。

### 修法

1. `verify` 与新增的 `test` 两个 job 都改成 matrix：`["3.9", "3.11", "3.13"]`，
   `fail-fast: false`（只有 3.9 挂时要能一眼看出是下界的问题）。3.9 是声明的下界、3.13 是
   当前上界，中间取 3.11 作代表。
2. `classifiers` 补全 `:: 3.9` ~ `:: 3.13`。三处（`requires-python` / classifiers /
   CI matrix）必须一致，各说一套时声明的下界就又成了没人执行的话。
3. 静态复核了一遍 3.9 兼容性：13 个模块**全部**有 `from __future__ import annotations`；
   实测确认 PEP 563 也覆盖变量注解（`collector.py` 里三行 `ContextVar[str | None]` 存进
   `__annotations__` 的是字符串，运行期不求值）；用 AST 扫过全部 `|` 运算符，确认**无一**
   落在注解之外；没有 `match` / `tomllib` / `datetime.UTC` / `ExceptionGroup` / `Self` /
   `StrEnum` / `dataclass(slots=)` 等 3.10+ 运行期特性。

**保留 3.9 作为下界是产品决定**（用户 2026-08-30 确认）：接入方常常正是那些最不愿意动的老
仓库，而「零改动接入」这条硬指标对它们才最有价值。代价是每个模块都必须带 future import，
CI 因此钉了一档 3.9 来守住它。
