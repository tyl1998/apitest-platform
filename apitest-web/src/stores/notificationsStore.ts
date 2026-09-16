import { create } from "zustand";
import { api, type UserNotification } from "../api";

/**
 * 站内通知的共享状态（P9-1）：未读数 + 最近 10 条（铃铛下拉用）。
 *
 * zustand 而不是组件 state：铃铛挂在两个壳（全局层顶栏、项目壳顶栏）+ 列表页 /
 * 弹窗提醒都要读同一份未读数——「两个壳各自轮询两份计数」既是浪费也是读数漂移。
 * 轮询与弹窗在 hooks/useNotifications.ts，这里只有状态。
 */
type NotificationsState = {
  unread: number;
  recent: UserNotification[];
  /** 首轮拉取完成后置 true（铃铛在数据未到时不显示 0，显示「—」态）。 */
  loaded: boolean;
  set: (unread: number, recent: UserNotification[]) => void;
  setUnread: (unread: number) => void;
};

export const useNotificationsStore = create<NotificationsState>((set) => ({
  unread: 0,
  recent: [],
  loaded: false,
  set: (unread, recent) => set({ unread, recent, loaded: true }),
  setUnread: (unread) => set({ unread }),
}));
