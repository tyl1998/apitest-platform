/*
 * 三类凭据 Token 从 scrypt 哈希改为 AES-GCM 可逆加密（2026-09-28，配合「凭据可重新复制」）。
 *
 * 迁移 034 / 036 / 050 的建表语句已就地改成 `secret_encrypted BYTEA`，所以**全新建的库**
 * 直接就是新形状；这个文件是给**已经应用过那几条迁移的开发库**的对齐补丁——`schema_migrations`
 * 里已有 034/036/050 的记录，它们不会再跑，列的变更只能靠一条新迁移送达（forward-only）。
 *
 * 语义：加一列可空 `secret_encrypted`，删掉旧的 `token_hash`。已有的哈希行**无法**转成密文
 * （scrypt 是单向的），删列后它们的明文取不回、也校验不过——这些是开发期的一次性 token，
 * 直接作废即可，不迁数据（AGENTS.md：项目从未上线，无历史数据要保）。列保持可空以避免给
 * 存量行补默认值；应用层每次签发都会写入，读取端 `SELECT secret_encrypted` 解不开即视为无效。
 *
 * 邀请码（`invitations.token_hash`）与用户密码（`users.password_hash`）**不在此列**：它们仍是
 * 单向哈希，只需比对、不该可解密。
 */

ALTER TABLE ingest_tokens ADD COLUMN IF NOT EXISTS secret_encrypted BYTEA;
ALTER TABLE ingest_tokens DROP COLUMN IF EXISTS token_hash;

ALTER TABLE runner_tokens ADD COLUMN IF NOT EXISTS secret_encrypted BYTEA;
ALTER TABLE runner_tokens DROP COLUMN IF EXISTS token_hash;

ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS secret_encrypted BYTEA;
ALTER TABLE mcp_tokens DROP COLUMN IF EXISTS token_hash;
