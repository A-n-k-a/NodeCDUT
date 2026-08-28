import crypto from "node:crypto";
import { CookieJar, fetchWithJar } from "../lib/http.js";

const CAS_BASE = "https://cas.paas.cdut.edu.cn/cas";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 Edg/116.0.1938.69";

export interface CasLoginResult {
  success: boolean;
  studentId?: string;
  jar: CookieJar;
  rawLength: number;
  status: number;
}

async function fetchCasLoginPage(
  jar: CookieJar
): Promise<{ execution: string }> {
  const res = await fetchWithJar(jar, `${CAS_BASE}/login`, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
    },
  });
  const html = await res.text();
  const executionMatch = html.match(/execution"\s+value="(.*?)"/);
  if (!executionMatch) {
    throw new Error("无法解析 CAS 登录页 execution 参数");
  }
  return { execution: executionMatch[1] };
}

async function encryptPassword(
  password: string,
  jar: CookieJar
): Promise<string> {
  if (password.startsWith("__RSA__")) return password;
  const res = await fetchWithJar(jar, `${CAS_BASE}/jwt/publicKey`, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
    },
  });
  const publicKeyPem = (await res.text()).trim();
  const key = crypto.createPublicKey(publicKeyPem);
  const encrypted = crypto.publicEncrypt(
    {
      key,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(password, "utf8")
  );
  return `__RSA__${encrypted.toString("base64")}`;
}

function seedWafCookies(jar: CookieJar): void {
  jar.setCookie("HWWAFSESID", "123123", "cas.paas.cdut.edu.cn");
  jar.setCookie("insert_cookie", "1000000", "jw.cdut.edu.cn");
}

export async function loginWithPassword(
  username: string,
  password: string
): Promise<CasLoginResult> {
  const jar = new CookieJar();
  seedWafCookies(jar);
  const { execution } = await fetchCasLoginPage(jar);
  const encryptedPassword = await encryptPassword(password, jar);

  const body = new URLSearchParams({
    username,
    password: encryptedPassword,
    captcha: "",
    rememberMe: "true",
    currentMenu: "1",
    failN: "0",
    mfaState: "",
    execution,
    _eventId: "submit",
    geolocation: "",
    submit1: "Login1",
  });

  const res = await fetchWithJar(jar, `${CAS_BASE}/login`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const result = await res.text();
  const success =
    res.ok && result.includes("successRedirectUrl");
  if (!success) {
    return { success: false, jar, rawLength: result.length, status: res.status };
  }

  const studentIdMatch = result.match(/<strong><span>(.*)<\/span>/);
  return {
    success: true,
    studentId: studentIdMatch?.[1],
    jar,
    rawLength: result.length,
    status: res.status,
  };
}

export async function sendSmsCode(phone: string): Promise<boolean> {
  const jar = new CookieJar();
  seedWafCookies(jar);
  const res = await fetchWithJar(jar, `${CAS_BASE}/passwordlessTokenSend`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: phone }).toString(),
  });
  await res.text().catch(() => {});
  return res.ok;
}

export async function loginWithSmsCode(
  phone: string,
  smsCode: string
): Promise<CasLoginResult> {
  const jar = new CookieJar();
  seedWafCookies(jar);
  const { execution } = await fetchCasLoginPage(jar);

  const body = new URLSearchParams({
    username: phone,
    password: smsCode,
    currentMenu: "2",
    failN: "-1",
    execution,
    _eventId: "submitPasswordlessToken",
    geolocation: "",
    submit: "Login2",
  });

  const res = await fetchWithJar(jar, `${CAS_BASE}/login`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const result = await res.text();
  const success = res.ok && result.includes("successRedirectUrl");
  if (!success) {
    return { success: false, jar, rawLength: result.length, status: res.status };
  }

  const studentIdMatch = result.match(/<strong><span>(.*)<\/span>/);
  return {
    success: true,
    studentId: studentIdMatch?.[1],
    jar,
    rawLength: result.length,
    status: res.status,
  };
}

export async function authenticateService(
  jar: CookieJar,
  serviceUrl: string
): Promise<string | null> {
  const url = `${CAS_BASE}/login?service=${encodeURIComponent(serviceUrl)}`;
  const res = await fetchWithJar(jar, url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: `${CAS_BASE}/login`,
    },
  });
  return res.headers.get("location");
}

export { USER_AGENT };
