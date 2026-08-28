import { Hono, type Context } from "hono";
import {
  authenticatePaym,
  getAllProjects,
  getUserInfo,
  type PaymSession,
} from "../services/paym.js";
import {
  jarFromSession,
  readSession,
  writeSession,
  SESSION_EXPIRED_BODY,
  type SessionData,
} from "../lib/session.js";
import type { CookieJar } from "../lib/http.js";
import { SessionExpiredError } from "../lib/errors.js";

const paym = new Hono();

/**
 * 解封会话并确保 paym token 可用: 优先复用 blob 中缓存的 token,
 * 调用失败则重跑 CAS 票据链刷新一次。
 */
async function withPaym<T>(
  c: Context,
  fn: (jar: CookieJar, session: PaymSession) => Promise<T>
): Promise<T | Response> {
  const session = readSession(c);
  if (!session) return c.json(SESSION_EXPIRED_BODY, 401);
  const jar = jarFromSession(session);

  if (session.paymToken) {
    try {
      const result = await fn(jar, { token: session.paymToken });
      writeSession(c, jar, session);
      return result;
    } catch {
      // token 失效, 走下方重新认证
    }
  }

  try {
    const paymSession = await authenticatePaym(jar);
    const result = await fn(jar, paymSession);
    writeSession(c, jar, session, { paymToken: paymSession.token });
    return result;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return c.json(SESSION_EXPIRED_BODY, 401);
    }
    return c.json(
      {
        error: "paym_auth_failed",
        message: `统一支付平台认证或数据获取失败: ${err instanceof Error ? err.message : String(err)}`,
      },
      502
    );
  }
}

paym.get("/userinfo", async (c) => {
  const result = await withPaym(c, getUserInfo);
  if (result instanceof Response) return result;
  return c.json(result);
});

paym.get("/projects", async (c) => {
  const result = await withPaym(c, getAllProjects);
  if (result instanceof Response) return result;
  return c.json({ count: result.length, projects: result });
});

export default paym;
