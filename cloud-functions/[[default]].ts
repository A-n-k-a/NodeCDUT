// EdgeOne Makers Node.js Cloud Function 入口 (Handler 模式)
// 文件路由: cloud-functions/[[default]].ts -> 多级动态路由, 接管站点所有路径,
// 统一交由 Hono app 分发。无需启动 HTTP Server。
// 参考: https://pages.edgeone.ai/zh/document/node-functions
import app from "../src/app.js";

export function onRequest(context: {
  request: Request;
}): Response | Promise<Response> {
  return app.fetch(context.request);
}
