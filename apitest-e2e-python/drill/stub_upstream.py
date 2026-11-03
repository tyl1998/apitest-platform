#!/usr/bin/env python3
"""上游异常演练桩（P9-8）：一个零依赖的假 agent 平台，按 `mode` 制造各类上游异常，
用来验证「断流 / 限流 / ERROR 事件」三类上游故障在平台侧怎么收尾（错误码 + 前端气泡）。

协议形状与 `setup/seed_assistant.py` 里的示例协议一致（`ASSISTANT_PROTOCOL`），
所以只要把 provider 的 `baseUrl` 指到本桩即可，
**不需要动协议配置**：本桩实现那 5 条接口 + `eventType` SSE 方言。

    python3 drill/stub_upstream.py --port 8099            # 起桩（前台，请求日志打在终端）
    curl -sX POST localhost:8099/__mode -d '{"mode":"silent"}'   # 切模式（管家公的）
    curl -s localhost:8099/__mode                          # 看当前模式

模式（`?mode=` 查询参数可**单次覆盖**全局模式——一个桩可同时演多种故障）：
    ok               正常：工具行 ×2 + 心跳 → 逐字 → FINAL_RESULT success:true
    silent           响应头后一个字都不发（→ 聊天腿静默预算，upstream_silent）
    stall_mid        先发两段字再静默（半截回复 + upstream_silent）
    heartbeat_only   只发心跳、永不给结果（证明**心跳重置静默预算**：这条会一直挂着）
    drop             先发两段字再**直接掐断连接**（→ upstream_stream_failed）
    empty            一个事件都不发、干净收尾（→ stream_incomplete）
    error_event      发字后 ERROR 事件（上游自报错，文案原样透出、不带码）
    fail_result      发字后 FINAL_RESULT success:false（只发终态的失败形态）
    ratelimit        发消息腿 429 + Retry-After: 30（→ 429/2007 + 限流文案）
    ratelimit_create 建会话腿 429（→ 新建会话时同一条限流文案）
    http500          发消息腿 500 + JSON message（→ 502/2006，带诊断文案）
    bad_content_type 发消息腿 200 但回 JSON（→ 502/2006，网关错误页形态）

桩按会话记住收到的用户消息，`GET /api/v1/chat/<id>/messages` 回放（含助手回复），
所以「刷新抽屉 → 历史回放」也能对着桩验。
"""
import argparse
import json
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE = {"mode": "ok"}
CONVERSATIONS: dict[str, list[dict]] = {}
LOCK = threading.Lock()

DEFAULT_REPLY = "drill stub: upstream is healthy."
TOOL_INPUT = {"projectId": "00000000-0000-0000-0000-000000000000"}
# 真静默/只发心跳的请求要占住连接很久；给个上限，别让桩永远退不掉。
HOLD_SECONDS = 300


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "apitest-drill-stub/1"

    # ---- 日志（打在终端，用来确认平台真的调过来了）----
    def log_message(self, fmt, *args):
        sys.stdout.write(f"[stub] {fmt % args}\n")
        sys.stdout.flush()

    # ---- 基础读写 ----
    def _request_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _send_json(self, payload: dict, status: int = 200, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _mode(self, query: dict) -> str:
        return (query.get("mode", [None])[0] or STATE["mode"]).strip()

    # ---- SSE（chunked：这样「不发终止块就断」才是真正的截断）----
    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def _chunk(self, text: str) -> None:
        self.wfile.write(f"{len(text.encode()):X}\r\n".encode() + text.encode() + b"\r\n")
        self.wfile.flush()

    def _sse(self, event: dict) -> None:
        self._chunk(f"data: {json.dumps(event, ensure_ascii=False)}\n\n")

    def _end_chunks(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _comment(self, text: str) -> None:
        self._chunk(f": {text}\n\n")

    def _hold(self, seconds: int = HOLD_SECONDS) -> None:
        """占住连接（静默 / 只发心跳）。客户端断开后 write 会炸，出口在调用方。"""
        for _ in range(seconds):
            time.sleep(1)

    # ---- 各模式的 SSE 正文 ----
    def _stream(self, mode: str, conversation_id: str, message: str) -> None:
        self._start_sse()
        if mode == "silent":
            # 响应头已到、一个字都不发。聊天腿的静默预算（60s）在这里兜底。
            self._comment("drill: silent — no events will follow")
            self._hold()
            return
        if mode == "heartbeat_only":
            # 只有心跳：预算被重置（心跳算「活着」），所以**不会**超时——
            # 这条会一直挂着，是设计预期（用户看不到任何东西，可手动断开）。
            for _ in range(HOLD_SECONDS // 5):
                self._sse({"eventType": "HEART_BEAT", "data": {}})
                time.sleep(5)
            return
        if mode == "drop":
            self._sse({"eventType": "MESSAGE", "data": {"text": "drill stub: before the "}})
            self._sse({"eventType": "MESSAGE", "data": {"text": "connection dropped."}})
            # 不发终止块就把连接**掐断**：客户端读到的是「chunked 体截断」。
            # 用 shutdown 而不是 close——不给 handler 收尾留一个「往已关文件写」的
            # 异常口（shutdown 只发 FIN，后续写入是 EPIPE，finish() 会吞掉）。
            self.close_connection = True
            try:
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return
        if mode == "empty":
            # 干净收尾但一个事件都没有 → 引擎合成 stream_incomplete。
            self._end_chunks()
            return

        # 其余模式都先给工具行（门槛 3 的观察点：工具名如实回显）
        self._sse({"eventType": "PROCESSING", "data": {
            "name": "get_project_overview", "type": "TOOL", "status": "EXECUTING", "result": {"input": TOOL_INPUT},
        }})
        self._sse({"eventType": "PROCESSING", "data": {
            "name": "get_project_overview", "type": "TOOL", "status": "FINISHED", "result": {"input": TOOL_INPUT},
        }})
        self._sse({"eventType": "HEART_BEAT", "data": {}})
        token_one, token_two, token_three = "drill stub ", "streaming ", "reply."
        self._sse({"eventType": "MESSAGE", "data": {"text": token_one}})
        self._sse({"eventType": "MESSAGE", "data": {"text": token_two}})
        if mode == "stall_mid":
            self._sse({"eventType": "MESSAGE", "data": {"text": token_three}})
            self._hold()
            return
        self._sse({"eventType": "MESSAGE", "data": {"text": token_three}})
        if mode == "error_event":
            self._sse({"eventType": "ERROR", "data": {"error": "drill stub: upstream reported an error"}})
            self._end_chunks()
            return
        if mode == "fail_result":
            self._sse({"eventType": "FINAL_RESULT", "data": {
                "outputText": "drill stub: the platform refused this request", "success": False,
            }})
            self._end_chunks()
            return
        output = f"{token_one}{token_two}{token_three}"
        self._sse({"eventType": "FINAL_RESULT", "data": {"outputText": output, "success": True}})
        self._end_chunks()
        with LOCK:
            CONVERSATIONS.setdefault(conversation_id, []).append(
                {"id": str(uuid.uuid4()), "role": "assistant", "text": output, "time": now_iso()}
            )

    # ---- 路由 ----
    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        segments = [s for s in parsed.path.split("/") if s]
        if parsed.path == "/__mode":
            self._send_json({"mode": STATE["mode"]})
            return
        # /api/v1/chat/<id>/messages
        if len(segments) == 5 and segments[:3] == ["api", "v1", "chat"] and segments[4] == "messages":
            with LOCK:
                rows = list(CONVERSATIONS.get(segments[3], []))
            self._send_json({"code": "0000", "message": "success", "data": rows})
            return
        self._send_json({"code": "9999", "message": f"drill stub: unknown path {parsed.path}"}, status=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        segments = [s for s in parsed.path.split("/") if s]
        body = self._request_json()
        mode = self._mode(query)

        if parsed.path == "/__mode":
            STATE["mode"] = str(body.get("mode") or "ok").strip()
            self.log_message("mode -> %s", STATE["mode"])
            self._send_json({"mode": STATE["mode"]})
            return

        # /api/v1/chat/conversation/add
        if segments == ["api", "v1", "chat", "conversation", "add"]:
            if mode == "ratelimit_create":
                self._send_json({"message": "drill stub: rate limited (create)"}, status=429, headers={"Retry-After": "30"})
                return
            conversation_id = str(uuid.uuid4())
            with LOCK:
                CONVERSATIONS[conversation_id] = []
            self._send_json({"code": "0000", "message": "success", "data": conversation_id})
            return

        # /api/v1/chat/conversation/<id>/delete
        if len(segments) == 6 and segments[:4] == ["api", "v1", "chat", "conversation"] and segments[5] == "delete":
            with LOCK:
                CONVERSATIONS.pop(segments[4], None)
            self._send_json({"code": "0000", "message": "success", "data": None})
            return

        # /api/v1/chat/<id>/stop
        if len(segments) == 5 and segments[:3] == ["api", "v1", "chat"] and segments[4] == "stop":
            self._send_json({"code": "0000", "message": "success", "data": {"stopped": True}})
            return

        # /api/v1/chat/<id>  （发消息）
        if len(segments) == 4 and segments[:3] == ["api", "v1", "chat"]:
            conversation_id = segments[3]
            message = str(body.get("message") or "")
            with LOCK:
                CONVERSATIONS.setdefault(conversation_id, []).append(
                    {"id": str(uuid.uuid4()), "role": "user", "text": message, "time": now_iso()}
                )
            if mode == "ratelimit":
                self._send_json({"message": "drill stub: rate limited (chat)"}, status=429, headers={"Retry-After": "30"})
                return
            if mode == "http500":
                self._send_json({"message": "drill stub: upstream blew up"}, status=500)
                return
            if mode == "bad_content_type":
                # 200 但回 JSON——网关把错误页当 200 回的形态。
                self._send_json({"message": "drill stub: gateway error page as 200"})
                return
            try:
                self._stream(mode, conversation_id, message)
            except (BrokenPipeError, ConnectionResetError, OSError):
                # 平台侧断开（abort）是正常结局：桩不报错。
                self.log_message("client went away mid-stream (mode=%s)", mode)
            return

        self._send_json({"code": "9999", "message": f"drill stub: unknown path {parsed.path}"}, status=404)


def main() -> None:
    parser = argparse.ArgumentParser(description="P9-8 上游异常演练桩")
    parser.add_argument("--port", type=int, default=8099, help="监听端口（默认 8099）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--mode", default="ok", help="启动时的默认模式（默认 ok）")
    args = parser.parse_args()
    STATE["mode"] = args.mode
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[stub] listening on http://{args.host}:{args.port} mode={args.mode}")
    print(f"[stub] switch: curl -sX POST localhost:{args.port}/__mode -d '{{\"mode\":\"silent\"}}'")
    server.serve_forever()


if __name__ == "__main__":
    main()
