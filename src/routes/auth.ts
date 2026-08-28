import { Hono } from "hono";
import {
  loginWithPassword,
  loginWithSmsCode,
  sendSmsCode,
} from "../services/cas.js";
import { sealSession, SESSION_HEADER } from "../lib/session.js";

const auth = new Hono();

auth.post("/login", async (c) => {
  const body = await c.req
    .json<{ username: string; password: string }>()
    .catch(() => null);
  if (!body?.username || !body?.password) {
    return c.json({ error: "username 和 password 必填" }, 400);
  }
  const result = await loginWithPassword(body.username, body.password);
  if (!result.success) {
    return c.json(
      { success: false, message: "登录失败，请检查账号密码或验证码" },
      401
    );
  }
  const blob = sealSession({
    cookies: result.jar.all(),
    studentId: result.studentId,
  });
  c.header(SESSION_HEADER, blob);
  return c.json({ success: true, studentId: result.studentId, session: blob });
});

auth.post("/sms/send", async (c) => {
  const body = await c.req.json<{ phone: string }>().catch(() => null);
  if (!body?.phone) {
    return c.json({ error: "phone 必填" }, 400);
  }
  const ok = await sendSmsCode(body.phone);
  if (!ok) {
    return c.json({ success: false, message: "验证码发送失败, 请重试" }, 502);
  }
  return c.json({ success: true });
});

auth.post("/sms/login", async (c) => {
  const body = await c.req
    .json<{ phone: string; code: string }>()
    .catch(() => null);
  if (!body?.phone || !body?.code) {
    return c.json({ error: "phone 和 code 必填" }, 400);
  }
  const result = await loginWithSmsCode(body.phone, body.code);
  if (!result.success) {
    return c.json(
      { success: false, message: "登录失败，请检查手机号或验证码" },
      401
    );
  }
  const blob = sealSession({
    cookies: result.jar.all(),
    studentId: result.studentId,
  });
  c.header(SESSION_HEADER, blob);
  return c.json({ success: true, studentId: result.studentId, session: blob });
});

export default auth;
