"""上报配置：环境变量 + CI 元数据探测（P4-10，计划 7.4）。

设计约束只有一条，但它决定了整个文件的形状：**`APITRACK_TOKEN` 缺失则完全 no-op，
连桩都不打**。本地开发跑测试时 SDK 等于不存在——否则第一个在自己机器上跑全量的人就会
误报一次「全量快照」并触发平台侧的删除对账。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field

#: 环境变量前缀与包名一致（计划 7.4）。刻意**不做** ``APITEST_*`` 的兼容读取：这个包
#: 一次都还没发出去，没有存量用户需要兼容。
PREFIX = "APITRACK_"

#: 请求体默认不传（边界 13）。默认不传就不需要为「测试数据被搬进平台」做合规审批。
BODY_CAPTURE_ENV = f"{PREFIX}BODY_CAPTURE"

#: 上报超时与重试（边界 6）：**最后那一次上报也不动退出码**，失败只 warning。
DEFAULT_TIMEOUT_SECONDS = 5.0

#: 单次上报的记录上限。超出后 collector 停止收集并在 warnings 里说明——平台侧还有一道
#: 413，但本地先截断能省掉一次注定失败的大请求。
DEFAULT_MAX_RECORDS = 20_000

#: body 捕获开启时每条的截断长度。
BODY_LIMIT = 2048


def _run_git(*args: str) -> str:
    """读一条 git 信息，失败一律返回空串。

    CI 里的浅克隆、detached HEAD、甚至根本没有 git 都是常态，任何一种都不该让上报中断。
    """
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def detect_git_url() -> str:
    return os.environ.get(f"{PREFIX}GIT_URL", "").strip() or _run_git("config", "--get", "remote.origin.url")


def detect_commit() -> str:
    """commit sha：CI 变量优先于 git 命令。

    CI 上的 ``HEAD`` 经常是一个 merge commit（GitHub Actions 的 pull_request 事件就是
    这样），而幂等键要认的是「被测的那一版」，所以平台侧看到的必须与 CI 认为自己在跑的
    那个 sha 一致。
    """
    for key in (f"{PREFIX}COMMIT", "GITHUB_SHA", "CI_COMMIT_SHA", "BUILD_VCS_NUMBER"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return _run_git("rev-parse", "HEAD")


def detect_branch() -> str:
    """分支名。

    它决定平台侧**会不会执行删除对账**（边界 11 的第二道闸门），所以取错的后果不对称：
    取空只是不对账，取成 ``HEAD``（detached 时 ``rev-parse --abbrev-ref`` 的返回值）
    则是拿一个不存在的分支名去比对，同样不会对账——两种都安全，因此这里宁可返回空串也
    不猜。
    """
    for key in (f"{PREFIX}BRANCH", "GITHUB_HEAD_REF", "GITHUB_REF_NAME", "CI_COMMIT_REF_NAME", "BRANCH_NAME"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    name = _run_git("rev-parse", "--abbrev-ref", "HEAD")
    return "" if name == "HEAD" else name


def detect_ci_run() -> tuple[str, str]:
    """``(ci_run_id, ci_run_url)``。id 参与幂等键，所以本地跑时留空串（不是 None）。"""
    run_id = ""
    for key in (f"{PREFIX}CI_RUN_ID", "GITHUB_RUN_ID", "CI_PIPELINE_ID", "BUILD_NUMBER"):
        value = os.environ.get(key, "").strip()
        if value:
            run_id = value
            break
    url = os.environ.get(f"{PREFIX}CI_RUN_URL", "").strip() or os.environ.get("CI_PIPELINE_URL", "").strip()
    if not url and run_id and os.environ.get("GITHUB_SERVER_URL") and os.environ.get("GITHUB_REPOSITORY"):
        url = f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run_id}"
    return run_id, url


@dataclass
class Config:
    url: str = ""
    token: str = ""
    capture_body: bool = False
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    max_records: int = DEFAULT_MAX_RECORDS
    git_url: str = field(default="")
    commit: str = field(default="")
    branch: str = field(default="")
    ci_run_id: str = field(default="")
    ci_run_url: str = field(default="")

    @property
    def enabled(self) -> bool:
        """两个变量缺一个就整体停用（计划 7.4）。

        只有 URL 没有 token 的话，上报必然 401——那时候「装了但不生效」比「每次跑完打一条
        401 警告」更接近用户的意图。
        """
        return bool(self.url and self.token)

    @property
    def ingest_endpoint(self) -> str:
        """平台的唯一上报入口。

        ``APITRACK_URL`` 允许写平台根地址或直接写到 ``/ingest``：两种都是人会写出来的
        形状，而在这里多一行判断远比让接入方在 CI 日志里读一个 404 便宜。
        """
        base = self.url.rstrip("/")
        return base if base.endswith("/ingest") else f"{base}/ingest"


def load() -> Config:
    def flag(name: str) -> bool:
        return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}

    def number(name: str, fallback: float) -> float:
        raw = os.environ.get(name, "").strip()
        try:
            return float(raw) if raw else fallback
        except ValueError:
            return fallback

    token = os.environ.get(f"{PREFIX}TOKEN", "").strip()
    url = os.environ.get(f"{PREFIX}URL", "").strip()
    config = Config(
        url=url,
        token=token,
        capture_body=flag(BODY_CAPTURE_ENV),
        timeout=number(f"{PREFIX}TIMEOUT", DEFAULT_TIMEOUT_SECONDS),
        max_records=int(number(f"{PREFIX}MAX_RECORDS", DEFAULT_MAX_RECORDS)),
    )
    # git 探测只在启用时做：停用状态下连一次 `git config` 子进程都不该起——那会在每个
    # 本地 pytest 启动时多花几十毫秒，而结果不会被任何人读。
    if config.enabled:
        config.git_url = detect_git_url()
        config.commit = detect_commit()
        config.branch = detect_branch()
        config.ci_run_id, config.ci_run_url = detect_ci_run()
    return config
