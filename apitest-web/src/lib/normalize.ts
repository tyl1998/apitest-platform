/**
 * 全角标点 → 半角（2026-09-26 缺陷修复）。
 *
 * 中文输入法下敲 `{{lane：prod}}` 会打出全角冒号 `：`（U+FF1A），这个字符会被原样写进
 * 请求头/参数值，而 `fetch` 的 header 只接受 Latin-1 字节——非 ASCII 字符会抛
 * 「Cannot convert argument to a ByteString…」的运行时错误。请求值里的全角符号既不是
 * 用户本意，也不该让一次请求崩掉，所以在**输入时**归一成半角。
 *
 * 只替换可变宽度区的全角标点（U+FF01–U+FF5E 一一对应到 U+0021–U+007E），`：`/`（）`等
 * 中文标点习惯在这里。空格与全角字母数字不在此列（值里可能有真的全角内容，比如故意
 * 打进 body 的文本）。
 */
const FULL_WIDTH_START = 0xFF01;
const FULL_WIDTH_END = 0xFF5E;
const ASCII_START = 0x21;

/** 把字符串里的全角标点替换成对应的半角字符；其余字符原样保留。 */
export function normalizeFullWidthPunct(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= FULL_WIDTH_START && code <= FULL_WIDTH_END) {
      out += String.fromCharCode(ASCII_START + (code - FULL_WIDTH_START));
    } else {
      out += ch;
    }
  }
  return out;
}