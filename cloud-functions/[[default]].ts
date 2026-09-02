// EdgeOne Makers Node.js Cloud Function 入口 (框架模式)
// 文件路由: cloud-functions/[[default]].ts -> 多级动态路由, 接管站点所有路径。
// 构建器检测到 hono 框架后要求导出框架实例 (export default app),
// 由平台包装层将请求转换为标准 Request 后调用 app.fetch()。
// 注意: 不要使用 Handler 模式 (export function onRequest) — 构建器会递归检测
// src/app.ts 中的 new Hono() 并强制按框架模式包装, Handler 导出会导致
// "stdin_default is not defined" 运行时错误。
// 参考: https://pages.edgeone.ai/zh/document/node-functions
import app from "../src/app.js";

export default app;
