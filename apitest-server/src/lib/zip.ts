import { inflateRawSync } from "node:zlib";

/**
 * 极简 zip 读取器（P4.5-13 服务端副本，与 apitest-runner 的 report/zip.ts 同一条
 * 零依赖纪律——为一个「读 allure-results 包」的动作引 yauzl/adm-zip 不值）。
 *
 * 只支持写入器产的那个子集：STORE / DEFLATE、UTF-8 文件名、无加密、非 zip64。
 * 扫 central directory 而不是逐个 local header：central directory 是 zip 的目录页，
 * 一遍读完拿到全部条目（名字 / 偏移 / 大小 / 方法），解压按需逐条做。
 *
 * 读取的是**不可信输入**（Runner 传上来的报告包），护栏与 Runner 侧的写入器对齐：
 * 条目数、单条解压后大小、总解压大小三道闸——zip 炸弹在这里挡，不在渲染层挡。
 */

/** 解压后的总字节上限：allure-results（几千 JSON + 截图）的真实量级远小于此。 */
const MAX_TOTAL_UNCOMPRESSED = 512 * 1024 * 1024;

/** 单条目解压后上限：与 Runner 侧单报告文件 64MB 收口同量级。 */
const MAX_ENTRY_UNCOMPRESSED = 128 * 1024 * 1024;

/** 条目数上限：与 Runner 侧 MAX_BUNDLE_FILES 同值。 */
const MAX_ENTRIES = 4096;

export type ZipEntry = {
  name: string;
  /** 未解压的内容（按需 inflate——多数查询只需要名字，读 2 万个 JSON 里的 3 个）。 */
  read(): Buffer;
};

function findCentralDirectory(buffer: Buffer): { offset: number; count: number } {
  /* EOCD 在文件尾 22 字节 + 最多 64KB 注释里倒着找签名 0x06054b50。写入器不写注释，
     但第三方 zip（用户手工传的产物包将来也走这条路）可能有——从尾部扫起。 */
  const minStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= minStart; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buffer.readUInt16LE(i + 10);
    const offset = buffer.readUInt32LE(i + 16);
    /* 磁盘号 / 中央目录磁盘号非零 = 分卷包，子集外。 */
    if (buffer.readUInt16LE(i + 4) !== 0 || buffer.readUInt16LE(i + 6) !== 0) break;
    if (offset + 4 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    return { offset, count };
  }
  throw new Error("not a zip file (central directory not found)");
}

export function readZip(buffer: Buffer): ZipEntry[] {
  const { offset, count } = findCentralDirectory(buffer);
  if (count > MAX_ENTRIES) throw new Error(`zip has too many entries (${count} > ${MAX_ENTRIES})`);

  const entries: ZipEntry[] = [];
  let cursor = offset;
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length) throw new Error("zip central directory truncated");
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("zip central directory corrupted");
    const flags = buffer.readUInt16LE(cursor + 8);
    /* bit 0 = 加密；写入器从不置位，出现即拒——不猜密钥。 */
    if (flags & 0x0001) throw new Error("encrypted zip entries are not supported");
    const method = buffer.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method}`);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) throw new Error(`zip entry too large when decompressed (${uncompressedSize} bytes)`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error("zip total decompressed size exceeds the budget");

    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) throw new Error("zip entry name truncated");
    /* 名字一律按 UTF-8 读（写入器 bit 11 置位；第三方 zip 即使没置位，路径里出现
       非 ASCII 时按 UTF-8 读也是最优猜测——消费方按 `-result.json` 后缀过滤，
       ASCII 文件名不受影响）。 */
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    cursor = nameStart + nameLength + extraLength + commentLength;

    entries.push({
      name,
      read(): Buffer {
        /* local header 的 name/extra 长度可能与 central directory 不同（规范允许），
           偏移以 local header 自己声明为准。 */
        if (localOffset + 30 > buffer.length) throw new Error("zip local header out of range");
        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip local header corrupted");
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) return Buffer.from(data);
        const inflated = inflateRawSync(data, { maxOutputLength: uncompressedSize });
        return inflated;
      },
    });
  }
  return entries;
}
