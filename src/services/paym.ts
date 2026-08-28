import { authenticateService, USER_AGENT } from "./cas.js";
import { SessionExpiredError } from "../lib/errors.js";
import {
  CookieJar,
  fetchWithJar,
  fetchWithUpgrade,
} from "../lib/http.js";

const PAYM_BASE = "https://paym.cdut.edu.cn";
const CAS_SERVICE_URL = "http://paym.cdut.edu.cn/casLogin/";

export interface UserInfo {
  id: string;
  studentId: string;
  name: string;
  sex: string;
}

export interface Project {
  id: string;
  name: string;
}

export interface PaymSession {
  token: string;
}

export async function authenticatePaym(
  jar: CookieJar
): Promise<PaymSession> {
  const callbackLink = await authenticateService(jar, CAS_SERVICE_URL);
  if (!callbackLink || !callbackLink.includes("ticket")) {
    throw new SessionExpiredError("CAS 未返回 paym 票据，会话已失效或无权限");
  }

  const ticketResult = await fetchWithUpgrade(jar, callbackLink, {
    headers: { "User-Agent": USER_AGENT },
  });
  const ticketRes = ticketResult.res;
  const secondRet = ticketRes.headers.get("location");
  if (ticketRes.status !== 302 || !secondRet) {
    const body = await ticketRes.text().catch(() => "");
    throw new Error(
      `paym 票据验证失败: status=${ticketRes.status}, location=${secondRet}, upgraded=${ticketResult.upgraded}, fellBack=${ticketResult.fellBack}, body=${body.slice(0, 200)}`
    );
  }

  const actualResult = await fetchWithUpgrade(jar, secondRet, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: callbackLink,
    },
  });
  const actualRes = actualResult.res;
  if (!actualRes.ok) {
    const body = await actualRes.text().catch(() => "");
    throw new Error(
      `paym 登录页获取失败: status=${actualRes.status}, upgraded=${actualResult.upgraded}, fellBack=${actualResult.fellBack}, body=${body.slice(0, 300)}`
    );
  }
  const actualHtml = await actualRes.text();
  const resultMatch = actualHtml.match(
    /window\.location\.href\s*=\s*["']([^"']*)["']/
  );
  if (!resultMatch) {
    throw new Error(
      `无法从 paym 登录页解析跳转地址, html片段: ${actualHtml.slice(0, 500)}`
    );
  }

  const nextUrl = new URL(resultMatch[1], secondRet).toString();

  const tokenResult = await fetchWithUpgrade(jar, nextUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: secondRet,
    },
  });
  const tokenRes = tokenResult.res;
  const tokenLink = tokenRes.headers.get("location");
  if (tokenRes.status !== 302 || !tokenLink) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `paym token 获取失败: status=${tokenRes.status}, location=${tokenLink}, upgraded=${tokenResult.upgraded}, fellBack=${tokenResult.fellBack}, body=${body.slice(0, 300)}`
    );
  }

  const tokenUrl = new URL(tokenLink, nextUrl);
  let token = tokenUrl.searchParams.get("token");
  if (!token && tokenUrl.hash) {
    const hashQuery = tokenUrl.hash.split("?")[1];
    if (hashQuery) {
      const hashParams = new URLSearchParams(hashQuery);
      token = hashParams.get("token");
    }
  }
  if (!token) {
    throw new Error(
      `paym 回调中未找到 token 参数, tokenLink=${tokenLink}, hash=${tokenUrl.hash}, searchParams=${Array.from(tokenUrl.searchParams.entries()).map(([k, v]) => `${k}=${v}`).join("&")}`
    );
  }

  return { token };
}

async function getJson<T>(
  jar: CookieJar,
  token: string,
  path: string
): Promise<T> {
  const res = await fetchWithJar(jar, `${PAYM_BASE}${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      "X-Token": token,
    },
  });
  if (!res.ok) {
    throw new Error(`paym 请求失败 ${path}: status=${res.status}`);
  }
  const body = (await res.json()) as { data?: T };
  if (!body.data) {
    throw new Error(`paym 返回数据为空: ${path}`);
  }
  return body.data;
}

export async function getUserInfo(
  jar: CookieJar,
  session: PaymSession
): Promise<UserInfo> {
  return getJson<{
    id: string;
    idserial: string;
    name: string;
    sex: string;
  }>(jar, session.token, `/api/pay/queryUserInfo/${session.token}`).then(
    (d) => ({
      id: d.id,
      studentId: d.idserial,
      name: d.name,
      sex: d.sex,
    })
  );
}

export async function getAllProjects(
  jar: CookieJar,
  session: PaymSession
): Promise<Project[]> {
  return getJson<{ id: string; projectName: string }[]>(
    jar,
    session.token,
    "/api/pay/project/getAllProjectList"
  ).then((list) => list.map((p) => ({ id: p.id, name: p.projectName })));
}
