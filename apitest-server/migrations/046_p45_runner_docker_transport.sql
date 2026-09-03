/*
 * Runner 容器档通道自报（2026-09-03，验收反馈：命令模式 / socket 模式要可选）。
 *
 * 通道是 Runner 的部署属性（APITRACK_RUNNER_DOCKER_TRANSPORT=cli|api，选的是「这台
 * 机器怎么连它本地的 daemon」），不是任务属性——任务不知道也不该知道 Runner 的宿主
 * 形状。所以它落在 runners 行上随注册刷新，面板据此显示「命令模式 / Socket 模式」；
 * 签发 token 时的部署命令里带同名的 export，选择就发生在部署那一刻。
 *
 * TEXT 而不是 CHECK 枚举：协议是公开的（Runner 是别人写的客户端也行），未知值读作
 * 「未识别的通道」而不是整行注册被拒。空串 = 这台机器没自报（进程档 only，或旧版
 * Runner）。
 */
ALTER TABLE runners ADD COLUMN IF NOT EXISTS docker_transport TEXT NOT NULL DEFAULT '';
