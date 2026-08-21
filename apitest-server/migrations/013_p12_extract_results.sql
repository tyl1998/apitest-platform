/*
 * P1-2 收尾：提取结果可诊断 + 单步调试也跑提取。
 *
 * 原实现把提取失败压成一句 `could not extract: a, b`，用户只知道"有值没取到"，
 * 不知道是路径写错、响应不是 JSON、还是那个字段真的是 null——三种原因的修法完全
 * 不同。所以逐条提取的结果单独落库，和 assertion_results 同级：断言有逐条结果，
 * 提取没有理由没有。
 *
 * 存在 executions 上而不是 flow_executions 上：提取是**节点**的行为，一次流程里
 * 每个节点各有各的提取结果，压进父记录就得再自己按节点分组。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS extract_results JSONB NOT NULL DEFAULT '[]'::jsonb;
