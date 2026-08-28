import crypto from "node:crypto";
import type { Context } from "hono";
import { CookieJar, type Cookie } from "./http.js";

/**
 * 无状态会话载体: CookieJar + 子系统令牌, AES-256-GCM 密封后经
 * X-Auth-Cookies 头在客户端与服务端之间往返。服务端零存储。
 */
export interface SessionData {
  cookies: Cookie[];
  studentId?: string;
  paymToken?: string;
}

export const SESSION_HEADER = "X-Auth-Cookies";

const DEV_SECRET = "nodecdut-insecure-dev-secret";

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      console.warn(
        "[session] SESSION_SECRET 未设置, 正在使用内置开发密钥, 会话 blob 可被伪造!"
      );
    }
    return crypto.createHash("sha256").update(DEV_SECRET).digest();
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function sealSession(data: SessionData): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function openSession(raw: string): SessionData | null {
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const data = JSON.parse(plaintext.toString("utf8")) as SessionData;
    if (!Array.isArray(data.cookies)) return null;
    return data;
  } catch {
    return null;
  }
}

export function jarFromSession(data: SessionData): CookieJar {
  const jar = new CookieJar();
  for (const c of data.cookies) {
    if (c?.name && c.value !== undefined && c.domain && c.path) {
      jar.setCookie(c.name, c.value, c.domain, c.path);
    }
  }
  return jar;
}

/** 从请求头解封会话; 失败返回 null */
export function readSession(c: Context): SessionData | null {
  const raw = c.req.header(SESSION_HEADER);
  if (!raw) return null;
  return openSession(raw);
}

/**
 * 将(可能被认证链增量修改过的) jar 重新密封下放, 客户端语义为收到即替换。
 * prev 中的 studentId / paymToken 默认保留。
 */
export function writeSession(
  c: Context,
  jar: CookieJar,
  prev: SessionData,
  patch: Partial<SessionData> = {}
): void {
  const next: SessionData = {
    ...prev,
    ...patch,
    cookies: jar.all(),
  };
  c.header(SESSION_HEADER, sealSession(next));
}

export const SESSION_EXPIRED_BODY = {
  error: "session_expired",
  message: "会话缺失或已失效, 请重新调用 /auth/login 并在 X-Auth-Cookies 头中携带会话凭证",
} as const;
