import { useEffect } from "react";
import { usePageContextStore, type PageContext } from "../stores/pageContextStore";

/**
 * 页面注册自己的助手上下文（P9-4c）：挂载写入、卸载清空（路由切换即清——上下文
 * 是「这一刻站在哪」的快照，过期即失效）。
 *
 * 内容序列化后才进依赖：组件每轮渲染都是新对象，拿引用当依赖会把 store 刷成
 * 无意义的高频写；JSON 比较让「内容真的变了」才写。
 */
export function usePageContext(context: PageContext | undefined) {
  const set = usePageContextStore((state) => state.set);
  const serialized = context ? JSON.stringify(context) : "";
  useEffect(() => {
    set(serialized ? (JSON.parse(serialized) as PageContext) : undefined);
    return () => set(undefined);
  }, [serialized, set]);
}
