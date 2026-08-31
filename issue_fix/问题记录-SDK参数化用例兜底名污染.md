# 问题记录 — SDK 参数化用例的兜底名被第一个参数污染

## 现象

参数化用例（`@pytest.mark.parametrize`）在树上显示的名称带上了第一个参数的后缀：
`test_create_order[vip_user]`。读起来像「这条用例就是 vip 场景」，而 `[normal_user]`
等其余场景的名字完全消失。

## 根因

`apitrack/plugin.py` 的 `describe()` 里名称兜底取的是 `item.name`——pytest 在参数化时
把它构造成 `函数名[param_id]`。而多个参数化子项共用一个 `case_key`（边界 7：剥掉
`[...]`），`register_case` 只登记第一次、后续只合并标签——于是 collect 顺序里**第一个**
子项的 `item.name`（带着它的参数后缀）成为整条用例的名字，其余子项的名字无处可去。

有 docstring 或 `@case(name=…)` 的用例不受影响（名字在函数级，天然无后缀）；裸函数
用例必现。

## 修法

兜底名从 `item.name` 改为 **case_key 的函数名段**（`key.split("::")[-1]`，`[...]`
已在 `split_nodeid` 里剥掉）：

- 对所有参数化子项一致，正是「一条用例、多个子结果」该有的名字；
- 非参数化用例两者相同（`item.name` 就是函数名），行为不变。

场景维度不塞进名字：它归 records 的 `param_id`（上报记录 run 明细的「场景」列展示，
见 DEVELOPMENT_PLAN.md 7.6.2）。

## 状态

已修（2026-08-30）。新增单测
`test_describe_strips_the_param_suffix_from_the_name_fallback` 锁住该行为；既有三个
`describe` 用例（docstring / 装饰器 / 裸函数兜底）不受影响。
