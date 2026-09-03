import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "./routes/auth.js";
import jw from "./routes/jw.js";
import jxpc from "./routes/jxpc.js";
import paym from "./routes/paym.js";
import { SESSION_HEADER } from "./lib/session.js";
import { SessionExpiredError } from "./lib/errors.js";

const app = new Hono();

app.onError((err, c) => {
  console.error("[NodeCDUT] unhandled error:", err);
  if (err instanceof SessionExpiredError) {
    return c.json(
      {
        error: "session_expired",
        message: "会话缺失或已失效, 请重新调用 /auth/login 并在 X-Auth-Cookies 头中携带会话凭证",
      },
      401
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout =
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError");
  return c.json(
    { error: isTimeout ? "upstream_timeout" : "internal_server_error", message },
    isTimeout ? 504 : 500
  );
});

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "*",
    allowHeaders: ["Content-Type", SESSION_HEADER],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: [SESSION_HEADER],
    maxAge: 86400,
  })
);

app.get("/", (c) =>
  c.json({
    name: "NodeCDUT",
    description: "成都理工大学校园系统统一接口服务 (CDUniTap Node.js 移植)",
    endpoints: [
      "POST /auth/login",
      "POST /auth/sms/send",
      "POST /auth/sms/login",
      "GET  /jw/schedule/meta",
      "POST /jw/schedule (?format=ics)",
      "GET  /jw/schedule/legacy/meta",
      "POST /jw/schedule/legacy (?format=ics)",
      "GET  /jw/exams/meta",
      "POST /jw/exams (?format=ics)",
      "POST /jw/students",
      "GET  /jw/elective/projects",
      "GET  /jxpc/schedule/weeks",
      "POST /jxpc/schedule (?format=ics)",
      "GET  /paym/userinfo",
      "GET  /paym/projects",
      "GET  /paym/electricity/projects",
      "POST /paym/electricity/areas",
      "POST /paym/electricity/buildings",
      "POST /paym/electricity/floors",
      "POST /paym/electricity/rooms",
      "POST /paym/electricity/balance",
      "POST /paym/electricity/route",
      "POST /paym/electricity/order",
      "GET  /paym/orders",
      "GET  /paym/orders/:orderId",
      "POST /paym/orders/:orderId/pay",
      "POST /paym/orders/:orderId/close",
      "GET  /health",
      "GET  /diag",
    ],
    authFlow: [
      "POST /auth/login (或 /auth/sms/send + /auth/sms/login) 获取会话",
      `响应头与响应体中的 session 字段为加密会话凭证`,
      `后续请求在 ${SESSION_HEADER} 头中携带; 响应若带回同名头则需替换本地副本`,
    ],
  })
);

app.get("/health", (c) =>
  c.json({ ok: true, ts: Date.now(), node: process.version })
);

app.get("/diag", async (c) => {
  const results: Record<string, unknown> = {};
  const targets = [
    { name: "cas", url: "https://cas.paas.cdut.edu.cn/cas/login" },
    { name: "jw-sso", url: "https://jw.cdut.edu.cn/sso/login.jsp" },
    {
      name: "jw-jsxsd",
      url: "https://jw.cdut.edu.cn/jsxsd/framework/xsMainV_new.htmlx?t1=1",
    },
    { name: "paym-casLogin", url: "https://paym.cdut.edu.cn/casLogin/" },
    {
      name: "paym-api",
      url: "https://paym.cdut.edu.cn/api/pay/project/getAllProjectList",
    },
  ];
  for (const t of targets) {
    const start = Date.now();
    try {
      const res = await fetch(t.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.69",
        },
      });
      results[t.name] = {
        ok: res.ok || res.status === 302,
        status: res.status,
        location: res.headers.get("location"),
        ms: Date.now() - start,
      };
    } catch (err) {
      results[t.name] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - start,
      };
    }
  }
  return c.json(results);
});

app.route("/auth", auth);
app.route("/jw", jw);
app.route("/jxpc", jxpc);
app.route("/paym", paym);

export default app;
