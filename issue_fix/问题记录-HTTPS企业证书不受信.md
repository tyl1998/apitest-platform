# 问题记录：平台请求企业内网 HTTPS 域名报错

日期：2026-08-27

## 现象

在平台上调试请求 `https://gds.store-api-stg.middlelayer.example.net/store/testSendMsg?fohNos=10001`，执行失败；同一地址在终端 `curl` 正常。用户怀疑平台不支持 HTTPS。

执行记录中的错误信息为 `self-signed certificate in certificate chain`（`SELF_SIGNED_CERT_IN_CHAIN`）。

## 根因

平台**支持** HTTPS：执行器 `apitest-server/src/lib/run.ts` 的 `executeRequest` 用 Node 20 内置 `fetch`（undici），对 http/https 无任何限制。失败原因是企业证书信任链：

1. 该 STG 域名解析到内网 IP（10.0.0.10），证书由 `example Corporate Issuing CA 07`（企业内部 CA，向上链到 `example Root CA`）签发，非公共 CA。
2. Node 20 的 `fetch` 只信任内置 Mozilla 公共 CA 列表，不读 macOS 系统钥匙串（`--use-system-ca` 需 Node 22.15+），因此 TLS 握手即失败。
3. 终端 `curl` 走 macOS 系统钥匙串（企业 CA 已由公司 MDM 下发并信任），所以 curl 正常、平台报错，造成「平台不支持 HTTPS」的错觉。

## 修法

启动脚本注入 `NODE_EXTRA_CA_CERTS`，让 Node 信任企业 CA：

1. 从系统钥匙串导出 example 企业 CA（Root + 各 Issuing CA，共 10 张）到 `.dev-certs/example-ca.pem`（gitignore，不入库）：

   ```bash
   security find-certificate -a -c "example" -p /Library/Keychains/System.keychain \
     | awk '/BEGIN CERT/,/END CERT/' > .dev-certs/example-ca.pem
   ```

2. `start.sh` 在启动服务前检测该文件，存在则 `export NODE_EXTRA_CA_CERTS`（api/worker/migrate 均为 Node 进程，全部生效）。
3. 企业 CA 轮换后按 `start.sh` 内注释的命令重新导出即可。

验证：导出前 `node fetch` 报 `SELF_SIGNED_CERT_IN_CHAIN`；设置 `NODE_EXTRA_CA_CERTS` 后同一请求返回 HTTP 200。

## 状态

已修复。重启 api + worker 后生效（`./start.sh --restart api worker`）。
