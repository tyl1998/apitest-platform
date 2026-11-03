import { useCallback, useEffect, useRef } from "react";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../stores/authStore";
import { useNotificationsStore } from "../stores/notificationsStore";

/**
 * 站内通知的轮询与弹窗提醒（P9-1，计划 13.3 / 13.0 边界 10、11）。
 *
 * - **未读数轮询 60s + 页面获焦即拉**（边界 11——不做实时推送：通知不是聊天，60s
 *   延迟无感；SSE 推送要把跨项目的用户级通道引进来，为一个计数不值）。
 * - **新通知到达时 antd notification 弹窗**（边界 10）：弹窗给「正在页面上」的即时
 *   感，小红点给「回头再看」的存量感，两者都做。
 * - **首轮不弹**：刚进页面时把存量未读全部弹一遍是打扰不是提醒——基线取「当前最新
 *   一条的 createdAt」，此后才进入「新到达」判定（比基线新且未读）。
 * - 401（token 失效）静默：拦截器已经硬跳登录，继续轮询只会刷一排红。
 *
 * 挂载点：`Root`（登录后恒有、跨壳存活）——两个壳的铃铛与列表页都读
 * notificationsStore，轮询只跑这一份。
 */

const POLL_INTERVAL_MS = 60_000;

export function useNotificationPolling() {
  const { notification } = App.useApp();
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.token);
  const setStore = useNotificationsStore((state) => state.set);
  const lastSeenCreatedAt = useRef<string>();

  const refresh = useCallback(async () => {
    /* 未读数 + 最近 10 条一次拉回：弹窗判定（新到达）需要看行，铃铛下拉本来就要
       最近 10 条，不为弹窗单发一次请求。 */
    try {
      const [count, recent] = await Promise.all([
        api.notificationsUnreadCount(),
        api.notifications({ page: 1, pageSize: 10 }),
      ]);
      const fresh = recent.items.filter(
        (row) => !row.readAt && (!lastSeenCreatedAt.current || row.createdAt > lastSeenCreatedAt.current),
      );
      setStore(count.count, recent.items);
      for (const row of fresh) {
        notification.info({
          message: row.title,
          /* 正文是模版渲染的多行文本（结果/触发/链接/时间…）：pre-wrap 保住换行，
             否则六行被浏览器合并成一长串。 */
          description: row.body || undefined,
          placement: "bottomRight",
          style: { whiteSpace: "pre-wrap", maxWidth: 420 },
          /* 弹窗点走深链（没带 link 的通知没有可去的地方，点了只关弹窗）。 */
          onClick: () => { if (row.link) navigate(row.link); },
        });
      }
      const newest = recent.items[0]?.createdAt;
      if (newest) lastSeenCreatedAt.current = newest;
    } catch {
      /* 轮询失败静默（下一轮再试）：未读数停在旧值，不闪 0。 */
    }
  }, [notification, navigate, setStore]);

  useEffect(() => {
    if (!token) return;
    /* 首轮只定基线不弹窗：先看一眼当前最新一条，再进常规轮询。 */
    void api.notifications({ page: 1, pageSize: 1 })
      .then((result) => { lastSeenCreatedAt.current = result.items[0]?.createdAt; })
      .catch(() => {})
      .then(() => void refresh());
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [token, refresh]);
}
