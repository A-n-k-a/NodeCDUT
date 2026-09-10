import { Hono } from "hono";
import { login } from "../services/vle.js";
import { sealSession, SESSION_HEADER } from "../lib/session.js";

const vle = new Hono();

vle.post("/login", async (c) => {
  const body = await c.req
    .json<{ username: string; password: string }>()
    .catch(() => null);
  if (!body?.username || !body?.password) {
    return c.json({ error: "username 和 password 必填" }, 400);
  }
  const result = await login(body.username, body.password);
  if (!result.success) {
    return c.json(
      { success: false, message: result.message ?? "登录失败" },
      401
    );
  }
  const blob = sealSession({ cookies: result.jar.all() });
  c.header(SESSION_HEADER, blob);
  return c.json({
    success: true,
    cookies: result.jar.all(),
    html: result.html,
    session: blob,
  });
});

export default vle;
