/*
 * 接口级前置脚本（迁移 080）。
 *
 * 起因：调试页面能发请求，但没有「请求发出前」的位置。真实联调里这一步很常见——
 * 先把 token 换出来放进 header、按最终 body 算签名、给请求补时间戳/流水号。以前
 * 只有用例（`test_cases.pre_request_hooks`）和流程节点（`flows.nodes` 里的
 * `preRequestHooks`）有这一槽，于是「还没保存成用例，只想调一下这个接口」时无处安放。
 *
 * 把钩子挂在接口定义上，与用例同一套形状（`HookConfig[]`，脚本正文还是走 `scripts`
 * 表，随宿主生灭的匿名脚本用 `owner_endpoint_id` 归属）：
 * - 调试执行把这份钩子随 run_spec 内联入队，worker 在变量展开后、请求发出前执行；
 * - 用例仍然保留自己的一份，快照隔离不变——改接口的钩子不会改动已存用例。
 *
 * 形状与 011/012 的 `owner_case_id` / `owner_flow_id` 一致：具名公共脚本归属为空，
 * 匿名私有脚本恰好归属一个宿主。旧行的约束要允许第三个宿主，所以重建整条 check。
 */
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS pre_request_hooks JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS owner_endpoint_id UUID REFERENCES endpoints(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS scripts_owner_endpoint_id_idx ON scripts(owner_endpoint_id) WHERE owner_endpoint_id IS NOT NULL;

ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_ownership_check;
ALTER TABLE scripts ADD CONSTRAINT scripts_ownership_check CHECK (
  (name IS NOT NULL AND owner_case_id IS NULL AND owner_flow_id IS NULL AND owner_endpoint_id IS NULL)
  OR (name IS NULL AND ((owner_case_id IS NOT NULL)::int + (owner_flow_id IS NOT NULL)::int + (owner_endpoint_id IS NOT NULL)::int) = 1)
);
