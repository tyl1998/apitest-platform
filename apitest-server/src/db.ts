import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://apitest:apitest@localhost:5432/apitest",
  /**
   * 泄漏事务的兜底闸门。
   *
   * 一条忘记 COMMIT 的事务会被 `client.release()` 原样还回池子（pg 不会替你回滚），
   * 之后所有复用这条连接的语句都跑在那个事务里：写入对外不可见，它持有的行锁则会
   * 把用户请求永久堵死。让 Postgres 自己收掉这种连接，比指望每一处事务代码都不
   * 写错更可靠。
   *
   * 只对**空闲在事务中**（等客户端下一条语句）的会话生效，正在执行或正在等锁的
   * 语句都不受影响，所以它不会误杀慢查询，也不会打断合法的等锁等待。
   */
  options: "-c idle_in_transaction_session_timeout=30s",
});
