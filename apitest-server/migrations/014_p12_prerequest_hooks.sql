/*
 * P1-2 收尾：前置脚本（请求签名）+ 脚本库引用 + 结构化变量。
 *
 * 起因是一条真实链路跑不通：生包接口返回一个包号数组，下一个接口要把它整段塞进
 * body，再对最终 body 算一次 AES 签名放进 header。缺两样东西——
 *   1. 变量袋是 Record<string,string>，数组被 JSON.stringify 成字符串再插进 JSON
 *      body，收到的是 "[...]" 而不是 [...]。结构化变量的修法不落库（变量袋一直是
 *      JSONB），只在 resolve.ts 改插值语义，所以这里没有对应 DDL。
 *   2. 没有任何位置能在「变量已展开、请求还没发出」的那一刻改写请求——签名必须签
 *      最终字节，早一步签的是模板，晚一步来不及放进 header。
 *
 * 因此前置钩子挂在节点上（存在 flows.nodes JSONB 里，无需 DDL），本迁移只加三样
 * 库里的东西：脚本用途、脚本库依赖、钩子执行结果。
 */

/*
 * 脚本用途。
 *
 * 断言脚本与前置脚本的契约完全不同：前者 return 真值表示通过，后者改写
 * ctx.request 且返回值无意义。把断言脚本挂到前置槽位上不会报错，只会静默不签名，
 * 所以在数据层就把两者分开，公共脚本选择器也只列出用途匹配的脚本。
 *
 * library 是第三种：不独立执行，被别的脚本引用后拼在前面（SM4 实现、统一
 * 签名算法这类东西不该在每个用例里复制一份）。
 *
 * 现在就加列而不是等真有第二种用途时再加，理由同 workers.mode：事后加列无法
 * 回填历史行的真实用途，而已存在的行确定是断言脚本。
 */
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'assertion'
  CHECK (kind IN ('assertion', 'hook', 'library'));

/* 库的存在意义就是被复用，匿名库无人可引用，只会变成一份跑不到的死代码。 */
ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_library_named_check;
ALTER TABLE scripts ADD CONSTRAINT scripts_library_named_check CHECK (kind <> 'library' OR name IS NOT NULL);

/*
 * 脚本 → 库 的引用。
 *
 * 用关联表而不是 scripts.dependencies UUID[]：数组元素上加不了外键，删库时数组里
 * 会留下指向不存在行的 UUID，而「引用了一个已删除的库」必须由数据库自己保证不会
 * 发生，不能靠应用记得清理。position 决定拼接顺序——库之间可能互相依赖，顺序不
 * 稳定就会出现「有时能跑有时报未定义」。
 *
 * depends_on_id 只允许指向 kind='library' 的脚本，这一条外键表达不了，由
 * lib/scripts.ts 写入时校验。
 */
CREATE TABLE IF NOT EXISTS script_deps (
  /* 引用方：删除引用方时它的依赖声明一起消失。 */
  script_id UUID NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  /*
   * 被引用的库：CASCADE 而非 RESTRICT。删除公共脚本走的是「先扫引用 → 409 带依赖
   * 清单 → ?force=true 二次确认」（对齐 environments 删除语义），RESTRICT 会让
   * force 这条路直接被数据库拒掉，等于没有强制删除。真删掉之后引用方在执行时报
   * 「script library is missing」——一句明确的报错，而不是静默跳过签名。
   */
  depends_on_id UUID NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (script_id, depends_on_id),
  /* 自引用是显然的环，不必等应用层的环检测。 */
  CHECK (script_id <> depends_on_id)
);

CREATE INDEX IF NOT EXISTS script_deps_script_id_idx ON script_deps(script_id, position);
/* 删库前要反查「谁引用了我」。 */
CREATE INDEX IF NOT EXISTS script_deps_depends_on_id_idx ON script_deps(depends_on_id);

/*
 * 前置钩子的执行结果，逐钩子一条。
 *
 * 与 extract_results（013）同级同理由：钩子是**单次请求**的行为，压进 flow_executions
 * 父记录就得再按节点分组，而单接口调试将来挂钩子时根本没有父记录。
 *
 * 里面存钩子名、成败、console 输出、报错，以及脚本用 ctx.debug() 主动记下的中间值
 * ——待签原串就靠这个。平台无法自己猜出「哪个字符串是拿去签名的」，只能由脚本声明；
 * 而签名对不上时，第一件要看的事永远是「我签的到底是哪串字节」。
 */
ALTER TABLE executions ADD COLUMN IF NOT EXISTS hook_results JSONB NOT NULL DEFAULT '[]'::jsonb;
