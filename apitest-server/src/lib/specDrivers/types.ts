import type { BodyType } from "../../models/types.js";

/**
 * 来源驱动的统一出口（P17 边界 1）：两种来源形态（静态 spec URL / 远端平台适配器）
 * 都归一成同一个 `SourceOperation`，创建时搜索→预填只认这一种形状。
 *
 * `path` 是原始路径（可含 `{param}`）；`url` 在路由层归一成 `{{baseUrl}}` + path，
 * 与「路径清单」导入同形——来源只定义「定义在哪」，host 归项目环境变量。
 */
export type SourceOperation = {
  method: string;
  path: string;
  summary: string;
  description: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  bodyType: BodyType;
  body?: unknown;
  tags: string[];
};

/** 驱动取数所需的上下文：地址、已解密的凭据明文、来源配置（驱动私有选项）。 */
export type SpecSourceContext = {
  url: string;
  credential?: string;
  config: Record<string, unknown>;
};

/**
 * 驱动接口：`list()` 拉全量快照（有则本地搜），只有 `search()` 则实时透传。
 * 本期 openapi 提供 `list()`；adapter vendor 另立需求再排（边界 3）。
 */
export interface SpecSourceDriver {
  type: string;
  list?(context: SpecSourceContext): Promise<SourceOperation[]>;
  search?(context: SpecSourceContext, keyword: string): Promise<SourceOperation[]>;
}
