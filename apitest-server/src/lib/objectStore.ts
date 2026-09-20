import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * 对象存储抽象（P4.5-7，计划 8.4；从 P6 10.1 提前，只服务 artifacts）。
 *
 * 硬约束：**平台永不代理大文件流**（边界 14）。Runner 先 `POST …/artifacts` 申请一个
 * 上传目标（s3: pre-signed PUT；fs: 带一次性 HMAC token 的平台上传地址），然后直传；
 * 浏览器下载走 `presignGet` 直链。让 API 进程转发一个 200MB 的 allure 报告，等于让
 * 一次下载占住一个 Node 进程。
 *
 * 两个驱动：
 * - `fs`（dev 默认）：本地目录。presign PUT/GET 退化为带一次性 HMAC token 的平台
 *   地址——「知道路径就能传」等于开一个匿名上传口，token 必须绑 `artifact_id` 与
 *   过期时间（计划 8.4 的原话）。
 * - `s3`（MinIO / S3，生产）：`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`，
 *   **按需 `import()`、不进启动路径**（照 P2-7 边界 8 的形状，lib/adapters/index.ts
 *   同款）。没配 s3 的部署不为此付一个依赖加载。
 */

/**
 * 平台对外根地址（fs 直传地址、产物下载直链、JobSpec 的 `APITRACK_URL` 三处共用）。
 *
 * 缺省必须取 **Host 头原样**（带端口）：Fastify 的 `request.hostname` 刻意剥掉端口，
 * `http://localhost` 会拨 80 端口，而本地开发的 API 在 3000 上——产物直传会以
 * `ECONNREFUSED` 静默失败，申请到的 artifacts 行永远停在 `uploaded_at IS NULL`。
 * 部署在反代后面时用 `PUBLIC_BASE_URL` 显式盖掉，别猜拨号来源。
 */
export function requestBaseUrl(request: FastifyRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return `${request.protocol}://${request.headers.host ?? request.hostname}`;
}

export type StorageDriverName = "fs" | "s3";

/** `presignPut` 的返回：调用方把它塞进 artifacts 路由的响应体。 */
export type PutTarget = {
  /** 上传目标 URL（s3 是带签名的对象地址；fs 是平台自己的上传端点）。 */
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  expiresAt: string;
};

export interface ObjectStore {
  readonly driver: StorageDriverName;
  presignPut(artifactId: string, opts: { contentType: string; sizeBytes: number }): Promise<PutTarget>;
  presignGet(key: string, opts: { expiresSeconds: number; downloadName?: string }): Promise<string>;
  /** fs 驱动校验一次性上传 token；s3 驱动无此动作（签名在 URL 里），恒 true。 */
  verifyUploadToken(artifactId: string, token: string): boolean;
  /**
   * 对象是否已在存储里。上传确认（`POST /runner/artifacts/:id/uploaded`）用它把
   * 「Runner 说传完了」落到 `uploaded_at`：fs 的 PUT 端点自己回写、无需确认，s3 的
   * pre-signed PUT 只有存储侧知道结果——不核一下，`uploaded_at IS NULL` 的行会
   * 把报告装载与产物列表一起饿死。存在性查询是元数据级（HeadObject），不碰字节流。
   */
  objectExists(key: string): Promise<boolean>;
  /**
   * 服务端直接写一个对象（P10-1，大响应体转存）。
   *
   * 这不违反「平台永不代理大文件流」：那条约束禁的是把浏览器 / Runner 的字节流经
   * API 进程中转；这里的字节是 worker 自己 `fetch` 回来、已经整段在内存里的响应正文，
   * 除了它没有第二个持有者。key 由调用方定（带前缀，如 `executions/<id>/response`），
   * 同 key 重写即覆盖——调用方以此保证幂等。
   */
  putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;
  /**
   * 删一个对象（P10-2，归档清理）。
   *
   * **只在行被真正删除的那一刻调**（2026-09-20 用户拍板）：已脱离的归档分区里行还在，
   * 对象就得还在，两者同生命周期；只有 `dropArchivedPartition` 把表 DROP 掉时才删对象。
   *
   * **不存在不是错**：清理是可重入的（删到一半崩了要能重跑），而且合法的「无全量」有四种
   * （历史行 / 项目关闭转存 / 超上限 / 写入失败，见 065），对象本来就可能没写成。所以
   * 两个驱动都把 404 咽掉，只有真的删不掉才抛。
   */
  deleteObject(key: string): Promise<void>;
}

/* ── fs 驱动 ─────────────────────────────────────────────────────────────────── */

/**
 * fs 驱动的 token 有效期。上传 URL 与下载直链共用这个数：上传侧 Runner 拿到就立刻
 * 用（30 分钟对慢网络已宽裕），下载侧前端跳转前刚拿到。s3 侧 presign 的过期同此值，
 * 两个驱动对「直链能活多久」给出同一个答案，别让使用方按驱动写分支。
 */
export const FS_URL_EXPIRES_SECONDS = 30 * 60;

/**
 * 一次性 token 的签名密钥：独立于 `DATA_SOURCE_ENCRYPTION_KEY`（那是可逆加密的密钥，
 * 这里只需要完整性），缺省派生自 JWT_SECRET——dev 零配置起得来，生产显式配一个。
 */
function fsTokenKeyInternal(): Buffer {
  const raw = process.env.ARTIFACT_FS_TOKEN_SECRET?.trim();
  if (raw) return Buffer.from(raw, "utf8");
  return createHmac("sha256", process.env.JWT_SECRET ?? "apitest-local-artifact-key").update("artifact-fs-token").digest();
}

/** token 绑 `artifact_id` + 过期时间：一个 token 只能给一个产物用一次窗，见 8.4。 */
function signFsToken(artifactId: string, expiresAtSeconds: number): string {
  return createHmac("sha256", fsTokenKeyInternal()).update(`${artifactId}.${expiresAtSeconds}`).digest("base64url");
}

/** 下载直链的签名密钥（与上传 token 同一把）：routes/runners.ts 校验时用，见下。 */
export function fsTokenKey(): Buffer {
  return fsTokenKeyInternal();
}

function fsTokenValid(artifactId: string, token: string): boolean {
  const separator = token.lastIndexOf(".");
  if (separator < 0) return false;
  const payload = token.slice(0, separator);
  const digest = token.slice(separator + 1);
  const expected = signFsToken(artifactId, Number(payload));
  const a = Buffer.from(digest);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyFsUploadToken(artifactId: string, token: string): boolean {
  if (!fsTokenValid(artifactId, token)) return false;
  /* 过期校验在签名校验之后：先比签名，未签名的 payload 数字不值得信。 */
  const separator = token.lastIndexOf(".");
  return Number(token.slice(0, separator)) > Math.floor(Date.now() / 1000);
}

/**
 * fs 驱动的存储根目录。绝对路径；容器部署把它指到卷上（与 Runner 的 dataDir 同一条
 * 运维语义）。存储键在驱动内是相对路径，拼装只在 `fsPutObject`（路由侧）发生。
 */
export function fsStorageRoot(): string {
  return process.env.ARTIFACT_FS_ROOT?.trim() || "data/artifacts";
}

export function fsUploadPath(artifactId: string): string {
  return `/runner/artifacts/${artifactId}/upload`;
}

/* ── s3 驱动（按需加载，零静态 import）───────────────────────────────────────── */

type S3Deps = {
  client: import("@aws-sdk/client-s3").S3Client;
  presigner: typeof import("@aws-sdk/s3-request-presigner");
  bucket: string;
};

let s3Deps: S3Deps | undefined;

async function loadS3(): Promise<S3Deps> {
  if (s3Deps) return s3Deps;
  const endpoint = process.env.ARTIFACT_S3_ENDPOINT?.trim();
  const region = process.env.ARTIFACT_S3_REGION?.trim() || "us-east-1";
  const bucket = process.env.ARTIFACT_S3_BUCKET?.trim();
  if (!bucket) throw new Error("ARTIFACT_S3_BUCKET is required when ARTIFACT_STORAGE_DRIVER=s3");
  const [{ S3Client }, presigner] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]);
  /* MinIO / 自建 S3 必须带 endpoint + path-style；AWS 原生两个都不给。凭证走默认链
     （env / 文件 / IAM），平台不为它发明第二种配置方式。 */
  s3Deps = {
    client: new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    }),
    presigner,
    bucket,
  };
  return s3Deps;
}

/* ── 统一入口 ────────────────────────────────────────────────────────────────── */

let cachedStore: ObjectStore | undefined;

export function storageDriverName(): StorageDriverName {
  const raw = process.env.ARTIFACT_STORAGE_DRIVER?.trim();
  return raw === "s3" ? "s3" : "fs";
}

/** 平台对外根地址（fs 驱动拼上传地址用；与 jobSpec.ts 的 APITRACK_URL 同一条纪律）。 */
function publicBaseUrl(fallbackHost: string): string {
  return (process.env.PUBLIC_BASE_URL?.trim() || fallbackHost).replace(/\/+$/, "");
}

export async function getObjectStore(baseUrlFallback: string): Promise<ObjectStore> {
  const driver = storageDriverName();
  const base = publicBaseUrl(baseUrlFallback);
  if (driver === "fs") {
    const store: ObjectStore = {
      driver: "fs",
      async presignPut(artifactId) {
        const expiresAt = Math.floor(Date.now() / 1000) + FS_URL_EXPIRES_SECONDS;
        const token = `${expiresAt}.${signFsToken(artifactId, expiresAt)}`;
        return {
          uploadUrl: `${base}${fsUploadPath(artifactId)}`,
          method: "PUT",
          /* content-type 必须由这里下发（Runner 原样转发 headers）：直传端点只为
             `application/octet-stream` 注册了解析器，发别的（或不发）会 415。产物的
             逻辑类型（application/zip 等）记在 artifacts 表，不上线路。 */
          headers: {
            "x-apitrack-upload-token": token,
            "content-type": "application/octet-stream",
          },
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        };
      },
      async presignGet(key, opts) {
        const expiresAt = Math.floor(Date.now() / 1000) + opts.expiresSeconds;
        const token = `${expiresAt}.${signFsToken(key, expiresAt)}`;
        const name = opts.downloadName ? `&name=${encodeURIComponent(opts.downloadName)}` : "";
        return `${base}/runner/artifacts/${encodeURIComponent(key)}/download?expires=${expiresAt}&token=${encodeURIComponent(token)}${name}`;
      },
      verifyUploadToken: (artifactId, token) => verifyFsUploadToken(artifactId, token),
      async objectExists(key) {
        const { stat } = await import("node:fs/promises");
        return stat(`${fsStorageRoot()}/${key}`).then((s) => s.isFile()).catch(() => false);
      },
      async putObject(key, body) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname, join, resolve } = await import("node:path");
        /* 与 routes/runners.ts 的落盘 / 下载同一条越界防线：key 是调用方拼的相对路径，
           解析后必须仍在存储根之下。 */
        const root = resolve(fsStorageRoot());
        const file = resolve(join(root, key));
        if (!file.startsWith(root + "/") && !file.startsWith(root + "\\")) {
          throw new Error("object key escapes the storage root");
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
      },
      async deleteObject(key) {
        const { rm } = await import("node:fs/promises");
        const { join, resolve } = await import("node:path");
        /* 与 putObject 同一条越界防线：删除比写入更不能容忍「key 解析到根目录之外」。 */
        const root = resolve(fsStorageRoot());
        const file = resolve(join(root, key));
        if (!file.startsWith(root + "/") && !file.startsWith(root + "\\")) {
          throw new Error("object key escapes the storage root");
        }
        /* `force` 咽掉 ENOENT（见接口注释）；其它 IO 错误照常抛给调用方。 */
        await rm(file, { force: true });
      },
    };
    return store;
  }

  const s3 = await loadS3();
  const { PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const store: ObjectStore = {
    driver: "s3",
    async presignPut(artifactId, opts) {
      const command = new PutObjectCommand({
        Bucket: s3.bucket,
        Key: artifactId,
        ContentType: opts.contentType,
      });
      const url = await s3.presigner.getSignedUrl(s3.client, command, { expiresIn: FS_URL_EXPIRES_SECONDS });
      return {
        uploadUrl: url,
        method: "PUT",
        headers: { "content-type": opts.contentType },
        expiresAt: new Date(Date.now() + FS_URL_EXPIRES_SECONDS * 1000).toISOString(),
      };
    },
    async presignGet(key, opts) {
      const command = new GetObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        ...(opts.downloadName ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/[^\w.\-]+/g, "_")}"` } : {}),
      });
      return s3.presigner.getSignedUrl(s3.client, command, { expiresIn: opts.expiresSeconds });
    },
    verifyUploadToken: () => true,
    async objectExists(key) {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      try {
        await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
        return true;
      } catch (error) {
        const name = (error as { name?: string }).name ?? "";
        if (name === "NotFound" || name === "404" || name === "NoSuchKey") return false;
        throw error;
      }
    },
    async putObject(key, body, opts) {
      await s3.client.send(new PutObjectCommand({
        Bucket: s3.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        ContentLength: body.length,
      }));
    },
    async deleteObject(key) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      /* S3 的 DeleteObject 对不存在的 key 本来就返回成功，不需要像 fs 那样吞 ENOENT。 */
      await s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
    },
  };
  return store;
}

/** 缓存策略：fs 无状态可缓存；s3 的 client 建连昂贵，memoize 在模块层。 */
export async function getSharedObjectStore(baseUrlFallback: string): Promise<ObjectStore> {
  if (cachedStore) return cachedStore;
  cachedStore = await getObjectStore(baseUrlFallback);
  return cachedStore;
}

/**
 * 只写不签 URL 的调用方（worker 里的 `settleExecution` 转存大响应体，P10-1）取 store。
 *
 * worker / scheduler 进程手里没有 FastifyRequest，拿不到 `requestBaseUrl`；而 `putObject`
 * 根本不用 base URL。但不能拿一个空 base 去喂 `getSharedObjectStore`：那个 memo 不带
 * key，先到者的 base 会固化进之后每一条 fs 直链——万一哪天写路径进了 API 进程，
 * 就把产物下载直链全签成 `/runner/artifacts/...` 这种没有 host 的相对地址。
 * 所以：fs 驱动无状态、构造零开销，每次现造一个；s3 驱动的 client 才是要复用的东西，
 * 而 s3 的 presign 从不用 base，共享它是安全的。
 */
export async function getWriterObjectStore(): Promise<ObjectStore> {
  if (storageDriverName() === "fs") return getObjectStore(publicBaseUrl(""));
  return getSharedObjectStore("");
}
