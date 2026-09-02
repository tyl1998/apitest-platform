import uuid


def unique_project_name(prefix: str = "e2e") -> str:
    """每个用例新建的项目用独立名字，避免同库重跑冲突。"""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"
