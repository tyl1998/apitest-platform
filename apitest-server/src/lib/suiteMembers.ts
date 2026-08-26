import type { PoolClient } from "pg";

/**
 * 套件手动成员的反向清理（P2-4.5 修订）。
 *
 * 原先的规则是「`?force=true` 之后引用允许悬空」：套件配置页把解析不到的成员显示成
 * 一行「已不存在」。走查后改掉这条——**一个已经不存在的用例/流程不该出现在成员列表里**。
 * 悬空行除了解释自己为什么在那儿之外没有任何用途：它不能运行、不能打开、不能修，
 * 唯一的合理操作就是删掉它，而那件事这里可以直接做完。
 *
 * 所以删用例/流程时，把它从每个引用它的 manual 套件里摘掉，和 DELETE 在同一个事务里：
 * 两步分开做会留下「用例已删、成员还在」的中间态，而那正是悬空行的来源。
 *
 * `jsonb_agg(... ORDER BY ord)` 不能省：成员顺序就是执行与报告的阅读顺序
 * （`resolveMembers` 按声明顺序返回），不排序的聚合会把剩下的成员重新洗一遍。
 * 摘空了就写 `[]` 而不是 NULL——`jsonb_agg` 在没有行时返回 NULL，写进去会让
 * `normalizeSuiteSelection` 读到一个缺 members 键的手动选择。
 *
 * tag/all 不在扫描范围内：它们按条件现算，本来就不持有引用（边界决策 6）。
 */
export async function detachSuiteMember(
  client: PoolClient,
  projectId: string,
  type: "case" | "flow",
  id: string,
): Promise<{ id: string; name: string }[]> {
  const member = JSON.stringify({ type, id });
  const containment = JSON.stringify({ members: [{ type, id }] });
  const result = await client.query(
    `UPDATE test_suites SET
       selection_config = jsonb_set(
         selection_config, '{members}',
         COALESCE((
           SELECT jsonb_agg(entry.member ORDER BY entry.ord)
             FROM jsonb_array_elements(selection_config->'members')
                  WITH ORDINALITY AS entry(member, ord)
            WHERE NOT (entry.member @> $3::jsonb)
         ), '[]'::jsonb)
       ),
       updated_at = now()
     WHERE project_id = $1
       AND selection_type = 'manual'
       AND selection_config @> $2::jsonb
     RETURNING id, name`,
    [projectId, containment, member],
  );
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}
