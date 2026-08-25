import { create } from "zustand";
import { api, type PlatformLimits } from "../api";

/**
 * 兜底值，与 `apitest-server` 的默认值一致（`lib/flow.ts`、`models/types.ts`）。
 *
 * 存在的理由不是「省一次请求」，而是**读不到预算不该让编辑器打不开**：网络抖一下就把
 * 流程画布变成不能填数字的页面，比短暂显示一个可能偏大的上限糟得多——真超限时服务端
 * 仍然会拒，那是最后一道，不是唯一一道。
 */
const FALLBACK: PlatformLimits = {
  flowParallelism: 4,
  suiteLeafBudget: 8,
  suiteMaxConcurrency: 10,
  maxLoopIterations: 100,
  maxLoopConcurrency: 10,
  maxWaitMs: 30_000,
  suiteMaxMembers: 200,
};

type LimitsState = {
  limits: PlatformLimits;
  loaded: boolean;
  load: () => Promise<void>;
};

/**
 * 平台级预算，一个会话读一次。
 *
 * 刻意不放进 `projectStore`：这些数与项目无关，跟着项目切换重置会让同一个数被反复请求，
 * 而它在进程生命周期里根本不变（改了环境变量要重启服务）。
 */
export const useLimitsStore = create<LimitsState>((set, get) => ({
  limits: FALLBACK,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      set({ limits: await api.systemLimits(), loaded: true });
    } catch {
      /* 保持兜底值。这里不弹提示：用户没有主动做这件事，一个说不清后果的报错只会打扰他。 */
    }
  },
}));
