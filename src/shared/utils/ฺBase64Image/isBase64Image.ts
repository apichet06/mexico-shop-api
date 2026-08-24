export function isBase64Image(src: string): boolean {
  return typeof src === "string" && src.startsWith("data:image/");
}
// 2) เช็คว่าอันไหนเป็น base64 / path
export function isLocalUploadPath(src: string): boolean {
  return src.includes("/uploads/editor/");
}