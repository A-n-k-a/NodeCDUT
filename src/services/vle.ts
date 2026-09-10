import { CookieJar, fetchWithJar } from "../lib/http.js";
import { USER_AGENT } from "./cas.js";

// 中英学生网站 (VLE, Drupal)。独立于 CAS 认证, 直接表单登录拿 SSESS* cookie。
export const VLE_BASE = process.env.VLE_BASE_URL ?? "https://vle.zycdut.net";

export interface VleLoginResult {
  success: boolean;
  jar: CookieJar;
  status: number;
  /** 登录成功后 frontpage-alt 页面的 HTML */
  html?: string;
  /** 失败时上游给出的错误信息 */
  message?: string;
}

/** 从 Drupal 登录失败页提取 messages 区域的错误文本 */
function extractErrorMessage(html: string): string | null {
  const match = html.match(
    /<div[^>]*class="[^"]*messages[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  // 去掉 Drupal 的 "Error message" 前缀
  return text.replace(/^Error message\s*/i, "");
}

export async function login(
  username: string,
  password: string
): Promise<VleLoginResult> {
  const jar = new CookieJar();
  const loginUrl = `${VLE_BASE}/user?destination=frontpage-alt`;
  const res = await fetchWithJar(jar, loginUrl, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${VLE_BASE}/user`,
    },
    body: new URLSearchParams({
      name: username,
      pass: password,
      form_id: "user_login",
      op: "Log in",
    }).toString(),
  });

  // 登录成功: 302 跳转 frontpage-alt, Set-Cookie 已入 jar
  if (res.status === 302) {
    const location = res.headers.get("location") ?? `${VLE_BASE}/frontpage-alt`;
    const target = new URL(location, VLE_BASE).toString();
    const page = await fetchWithJar(jar, target, {
      headers: { "User-Agent": USER_AGENT },
    });
    const html = await page.text();
    return { success: true, jar, status: res.status, html };
  }

  const text = await res.text();
  const message =
    extractErrorMessage(text) ?? `登录失败 (HTTP ${res.status})`;
  return { success: false, jar, status: res.status, message };
}
