/*
 * 用户级 API 密钥（个人中心设置）——调用平台开放 API 的凭据。
 *
 * 这是「用户调用平台通用 API」的一把个人密钥，不是 SQL 专用密钥：它是凭据本身，谁持有
 * 就能以该用户身份、按该用户的实时权限调用平台对外开放的 API。**当前第一个消费方**是
 * SQL 快速调用（把已保存的 SQL 定义变成一条免登录、可 curl 的地址：地址里的调用描述符用
 * 这把密钥 AES-256-GCM 加密，公开端点用同一把密钥解密，解得开即视为持钥人签发）；以后新增
 * 的开放 API 复用同一把密钥即可，不必每个功能各发一把。
 *
 * 一人一把（PK 落在 user_id 上）：轮换 = 覆盖这一行（明文只在轮换响应里出现一次，与
 * MCP token / ingest token 同纪律）。删除本行 = 吊销，已发出的所有地址立即失效。
 *
 * `key_id` 是**公开**查找标识（进 URL 路径），不是秘密；真正的 32 字节密钥以
 * `secret_encrypted` 存放，用主密钥（DATA_SOURCE_ENCRYPTION_KEY，lib/crypto.ts）再加密
 * 一层——库被脱也拿不到明文密钥。调用时先按 key_id 定位行、解出密钥、再解调用内容。
 *
 * ON DELETE CASCADE：密钥是「这个人的调用凭据」，人没了凭据没有落点。
 *
 * `DROP TABLE IF EXISTS sql_quick_call_keys`：本表原名（同阶段内改名，项目未发布、无历史
 * 数据要保护）——若旧名已被建过，这里顺手清掉，避免遗留一张没人读的空表。
 */
DROP TABLE IF EXISTS sql_quick_call_keys;

CREATE TABLE IF NOT EXISTS api_access_keys (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  /* 公开查找标识，进 URL 路径；唯一保证按 key_id 能定位到唯一一把密钥。 */
  key_id           TEXT NOT NULL UNIQUE,
  /* 32 字节密钥，用主密钥再加密一层存放（nonce|tag|ciphertext，lib/crypto.ts）。 */
  secret_encrypted BYTEA NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
