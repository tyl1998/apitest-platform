import { useEffect, useState } from "react";

/** 顶部工具卡在此视口下默认收缩：宽 ≤ 1470 且 高 ≤ 800 时，展开态读数和筛选行会把
    正文列表压得只剩几行，默认收起来给列表腾空间。含 1470×800 本身——用户正是在这个
    尺寸验证的（实测 `innerWidth` 恰好 1470，`max-width:1469px` 会漏掉）。 */
export const COMPACT_QUERY = "(max-width: 1470px) and (max-height: 800px)";

/** 跟踪是否落在紧凑视口（宽 ≤ 1470 且 高 ≤ 800）。返回 true 时顶部工具卡默认收缩。 */
export function useCompactViewport() {
  const [compact, setCompact] = useState(() => (typeof window !== "undefined" ? window.matchMedia(COMPACT_QUERY).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(COMPACT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return compact;
}