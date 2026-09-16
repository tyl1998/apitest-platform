/**
 * 增量 SSE 解析（P9-2）。Node 没有内建 SSE 客户端（EventSource 是浏览器 API），
 * 上游 agent 平台的流式回复要自己按规范切：事件以空行分隔，`data:` 行累加
 * （多行 data 按 spec 用 "\n" 连接），`:…` 注释行丢弃（保活心跳就是这种），其余
 * 字段（event/id/retry）不认识也不需要——归一事件由 adapter 从 data 的 JSON 里
 * 自己判 `eventType`。
 *
 * 切按 `\n` 而不是 `split` 整个 chunk：TCP 分块不看 SSE 语义，一条事件的 JSON
 * 可能从 chunk 中间开始或结束，缓冲区必须跨 chunk 保留半行。
 */
export class SseDataParser {
  private buffer = "";
  private dataLines: string[] = [];

  /** 喂一段解码后的文本，返回这段里凑齐的完整 data 载荷（可能 0 个，也可能多个）。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      /* \r\n 是规范允许的行尾，按行剥 \r，不影响纯 \n 流。 */
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") {
        /* 空行 = 事件结束。没攒到 data 行的空事件（纯注释事件）直接吞掉。 */
        if (this.dataLines.length) {
          payloads.push(this.dataLines.join("\n"));
          this.dataLines = [];
        }
      } else if (line.startsWith("data:")) {
        /* spec：冒号后至多一个前导空格属于分隔符，其余都是载荷。 */
        this.dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      newline = this.buffer.indexOf("\n");
    }
    return payloads;
  }

  /** 流结束时补发缺了结尾空行的最后一个事件（防御性——规范的实现应该有空行）。 */
  flush(): string[] {
    const payloads: string[] = [];
    if (this.dataLines.length) {
      payloads.push(this.dataLines.join("\n"));
      this.dataLines = [];
    }
    this.buffer = "";
    return payloads;
  }
}
