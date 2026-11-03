"""pytest-xdist 下的进程分工（见文档仓 ``issue_fix/问题记录-P4.5SDK在xdist多进程下重复上报.md``）。

协议 v1.0 有一条没写在纸上的假设：**一次上报 = 一个进程**。records 的幂等键是
``UNIQUE (ingest_run_id, seq)``、批次内从 0 编号，而 ``(repository, commit, ci_run_id)`` 又把
同一次 CI 的多份上报合并进同一行 run。xdist 打破了这条假设：controller 与每个 worker 都是
独立的 pytest 进程，``pytest11`` entry point 在每个进程里都会加载这个插件，于是 N+1 份 payload
各自从 seq 0 开始编号——后到的整批被平台按「重投」``ON CONFLICT DO NOTHING`` 丢掉（36 个用例
的 e2e 只剩 9 条 records），而 controller 那份**空** inventory 还把 ``case_total`` 覆盖成 0 并
触发「空 inventory 跳过对账」。

修法是**把那条假设恢复成事实**，而不是教平台去合并 N 份：worker 把自己采到的东西通过 xdist
自己的 ``workeroutput`` 通道交回 controller，controller 合并成一份、只发一个 ``/ingest``。

三点说明这不是绕路：

- ``workeroutput`` + ``pytest_testnodedown`` 就是 xdist 为「worker 有数据要带回来」提供的机制
  （pytest-cov 用的也是它）。它随 worker 自己的 ``sessionfinish`` 一起送达，而 controller 的
  ``pytest_runtestloop`` 要等到所有节点 down 才退出，所以 controller 在自己的
  ``sessionfinish`` 里必然已经收齐。
- **平台一个字都不用改**：``(run, seq)`` 去重是冻结协议 v1.0 的幂等语义，平台无法区分「同批
  重投」与「另一个进程的巧合同号」——按协议该丢弃的就是该丢弃。
- 合并在 controller 做，于是 ``case_total`` / 通过失败数 / 对账都只被写一次，不需要在平台侧
  发明「非空才覆盖」这类归并规则（那会让重投语义多一个例外）。
"""

from __future__ import annotations

#: worker 交回来的那份数据在 ``workeroutput`` 里的键。带包名前缀是因为这个 dict 是
#: **全仓库共享**的：pytest-cov 等插件也往里写，键名撞了就是互相覆盖。
HANDOFF_KEY = "apitrack"

#: 交接不成时每个进程分到的 seq 段宽度（见 ``seq_offset``）。
#:
#: 1_000_000 远大于 ``APITRACK_MAX_RECORDS`` 的默认值（20 000）与平台侧的硬上限
#: （``INGEST_MAX_RECORDS``，同为 20 000），所以段与段之间不可能交叠。
SEQ_BLOCK = 1_000_000


def worker_id(config) -> str | None:  # noqa: ANN001 - pytest Config
    """当前进程的 xdist worker id（``gw0``、``gw1``…）；不是 worker 则 ``None``。

    **只认 ``config.workerinput``，刻意不读 ``PYTEST_XDIST_WORKER``**。后者看起来是更公开的
    信号，实际是个陷阱：xdist 在 worker 进程里把它写进 ``os.environ``，于是**测试自己起的
    子进程**（起一个 pytest 子进程来验行为、或被测程序里 fork 出的 python）会继承到它，
    而那个子进程根本没有 controller 可以交接。认环境变量的结果就是那种子进程把自己当
    worker、交接失败、然后按降级路径上报——一次本该正常的单进程上报被判成非全量。

    ``workerinput`` 是 xdist 在 ``remote.py`` 里挂到 config 上的，进程内独有、不会被继承，
    正好是这里需要的事实。
    """
    workerinput = getattr(config, "workerinput", None)
    if not isinstance(workerinput, dict):
        return None
    identifier = str(workerinput.get("workerid") or "").strip()
    return identifier or None


def is_controller(config) -> bool:  # noqa: ANN001 - pytest Config
    """distribution 模式下的 controller 进程。

    controller 的特点是**它自己不 collect、不跑用例**（xdist 的 ``pytest_collection`` 直接
    返回 True 短路掉），所以它手上的 inventory 恒为空，全量与否完全取决于 worker 交回来的
    那几份。

    判据是「``dsession`` 这个插件在不在」而不是 ``-n`` / ``--dist`` 的取值：``-n0``、
    ``--dist no``、``--collect-only`` 这几种情况下 xdist 装着但**不分发**，那时这个进程就是
    普通的单进程 pytest，行为必须与没装 xdist 完全一致。xdist 只在真的要分发时才注册
    ``dsession``。

    **只能在 collect 之后调用**：xdist 的 ``pytest_configure`` 是 ``trylast``，比本插件的
    晚跑，所以在 ``pytest_configure`` 里问这个问题会得到 False。
    """
    if worker_id(config) is not None:
        return False
    try:
        return bool(config.pluginmanager.hasplugin("dsession"))
    except Exception:  # noqa: BLE001 - 探测失败一律按「不是 controller」
        return False


def worker_index(identifier: str | None) -> int:
    """``gw7`` → ``7``。取不出数字时回 0。"""
    if not identifier:
        return 0
    digits = "".join(char for char in identifier if char.isdigit())
    try:
        return int(digits)
    except ValueError:
        return 0


def seq_offset(identifier: str | None) -> int:
    """降级路径下这个 worker 的 seq 起点。

    只在**交接不成**时用得上（拿不到 ``workeroutput``）。那时每个 worker 各发一份，seq 必须
    互不重叠，否则平台按 ``UNIQUE (ingest_run_id, seq)`` 把后到的整批静默丢弃——那正是这次
    要修的缺陷。分段而不是随机数：批次内重投仍然幂等（同一个 worker 再发一次得到同样的
    号），进程之间又不会碰撞。
    """
    return worker_index(identifier) * SEQ_BLOCK


def hand_off(config, slice_: dict) -> bool:  # noqa: ANN001 - pytest Config
    """worker 侧：把自己那份挂进 ``workeroutput``，交给 controller。返回是否交接成功。

    必须在 ``pytest_sessionfinish`` 里调用：xdist 的 ``sessionfinish`` 是个 hookwrapper，
    ``yield`` 之后才把 ``workeroutput`` 发回 controller，所以这一刻写进去的东西会被一起带走。

    交接不成（老版本 xdist 没有这个属性、或它不是 dict）返回 False，调用方退回「自己上报」
    的降级路径——**宁可多一份带 seq 偏移的上报，也不要把这个 worker 的结果整份丢掉**。
    """
    channel = getattr(config, "workeroutput", None)
    if not isinstance(channel, dict):
        return False
    try:
        channel[HANDOFF_KEY] = slice_
    except Exception:  # noqa: BLE001 - 上报相关的任何失败都不许影响用例
        return False
    return True


def take_slice(node) -> dict | None:  # noqa: ANN001 - xdist WorkerController
    """controller 侧：取出一个刚结束的 worker 交回来的那份；没有则 ``None``。

    ``None`` 有两种成因，都不该让 controller 那一份声明全量：worker 崩了（``errordown``，
    ``workeroutput`` 根本没送到），或者它走了降级路径自己上报（那份数据已经在平台上，但
    controller 手上没有）。
    """
    output = getattr(node, "workeroutput", None)
    if not isinstance(output, dict):
        return None
    slice_ = output.get(HANDOFF_KEY)
    return slice_ if isinstance(slice_, dict) else None
