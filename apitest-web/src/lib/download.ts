/**
 * Blob 落盘（P7-5 模板下载 / 用例导出共用）：走 axios 拿 Blob（路由要 Bearer
 * 头，`<a href>` 直链触发不了认证），本地 object URL 即用即收。
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
