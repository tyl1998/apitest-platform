import type { SpecSourceDriver } from "./types.js";

/**
 * 来源驱动注册表（P17 边界 1）。照 `lib/adapters/index.ts` 的按需 `import()`：一个来源
 * 类型加载失败只带走它自己，不带崩进程；没有 loader 的类型回答「不支持」而不是抛。
 *
 * - `openapi`：静态文档 URL，`list()` 拉快照本地搜。
 * - `apifox`：Apifox 分享文档，`list()` 读分享的 llms.txt 汇总各接口页 OpenAPI 后归一（快照型）。
 * - `adapter`：通用「远端平台检索适配器」，只有 `search()` 实时透传（远端平台没有统一
 *   检索协议，具体端点/字段由来源 config 描述，见 `adapterConfig.ts`）。
 */
const loaders: Record<string, () => Promise<{ default: SpecSourceDriver }>> = {
  openapi: () => import("./openapi.js"),
  apifox: () => import("./apifox.js"),
  adapter: () => import("./adapter.js"),
};

const cache = new Map<string, SpecSourceDriver>();

export async function getSpecSourceDriver(type: string): Promise<SpecSourceDriver | undefined> {
  const cached = cache.get(type);
  if (cached) return cached;
  const loader = loaders[type];
  if (!loader) return undefined;
  const driver = (await loader()).default;
  if (driver.type !== type) throw new Error(`spec source driver registered for "${type}" declares type "${driver.type}"`);
  cache.set(type, driver);
  return driver;
}

/** 路由层建来源时的同步判断：回答「这个类型真不真」不能加载驱动。 */
export function isSupportedSpecSourceType(type: string): boolean {
  return type in loaders;
}
