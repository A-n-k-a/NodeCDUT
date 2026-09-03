/**
 * 教学评测系统 (jxpc.cdut.edu.cn) 课表服务。
 *
 * 与教务系统 (jw.cdut.edu.cn) 的 HTML 解析不同, jxpc 提供 JSON API:
 *   GET /api/v2/common/zcrq              教学周历 (djz=第几周, ksrq/jsrq=起止日期)
 *   GET /api/v2/core/ScheduleList/?week=N  第 N 周课表 (xqj=星期, ksjc=开始节次, kccd=节数)
 *
 * 难点: 整站挂瑞数 v5 WAF, 首次访问返回 412 + JS 挑战, 需执行混淆 VM 脚本
 * 算出动态 cookie 对 (sMLAeTqisZbFO/P) 后才放行。这里用 sdenv (jsdom 补环境框架)
 * 在 Node 中真实执行挑战脚本完成求解。已验证:
 *   - 合法 cookie 下 API 不需要 mGPPWCIf 签名参数;
 *   - WAF cookie 不绑定 TLS/HTTP2/UA 指纹, Node 侧可直接回放;
 *   - P cookie 短效, 因此每次请求按需重新求解 (约 2-4s)。
 *
 * CAS 入口: service=https://jxpc.cdut.edu.cn/base/login/return, 成功后在
 * jxpc.cdut.edu.cn 域种下 token cookie。
 */
import { createRequire } from "node:module";
import {
  CookieJar,
  fetchWithJar,
  followRedirects,
} from "../lib/http.js";
import { SessionExpiredError } from "../lib/errors.js";
import { USER_AGENT } from "./cas.js";
import { getPeriod } from "../data/periods.js";

const JXPC_BASE = "https://jxpc.cdut.edu.cn";
const CAS_LOGIN = `https://cas.paas.cdut.edu.cn/cas/login?service=${encodeURIComponent(
  `${JXPC_BASE}/base/login/return`
)}`;
/** 瑞数环境检测对 UA 敏感, 需与真实浏览器一致 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------- sdenv 懒加载 (原生 addon + jsdom, 仅 jxpc 路由用到) ----------

interface SdenvCookie {
  key: string;
  value: string;
  domain?: string | null;
  path?: string | null;
}

interface SdenvCookieJar {
  setCookieSync(cookie: string, url: string): void;
  getCookiesSync(url: string): SdenvCookie[];
}

interface SdenvWindow {
  document?: { documentElement?: { innerHTML?: string } | null };
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}

interface SdenvModule {
  logger: { level: string };
  jsdomFromUrl(
    url: string,
    options?: Record<string, unknown>
  ): Promise<{ window: SdenvWindow }>;
  jsdom: { CookieJar: new () => SdenvCookieJar };
}

let sdenvModule: SdenvModule | null = null;

function loadSdenv(): SdenvModule {
  if (!sdenvModule) {
    const require = createRequire(import.meta.url);
    const mod = require("sdenv") as SdenvModule;
    mod.logger.level = "off";
    sdenvModule = mod;
  }
  return sdenvModule;
}

// ---------- CAS 认证 ----------

/** 携带统一身份认证 TGT 完成 jxpc 服务认证, 成功后在 jar 中种下 token cookie */
export async function authenticateJxpc(
  jar: CookieJar,
  timeoutMs = 15000
): Promise<void> {
  // 注意: CAS 对无 User-Agent 的请求直接返回 500, 必须携带浏览器 UA
  const res = await followRedirects(jar, CAS_LOGIN, {
    timeoutMs,
    headers: { "User-Agent": USER_AGENT },
  });
  if (new URL(res.finalUrl).pathname.startsWith("/cas/login")) {
    throw new SessionExpiredError();
  }
  const header = jar.cookieHeaderFor(`${JXPC_BASE}/`);
  if (!header.split(";").some((p) => p.trim().startsWith("token="))) {
    throw new Error("教学评测系统认证失败: 未获得 token cookie");
  }
}

// ---------- 瑞数 WAF 求解 ----------

/**
 * 用 sdenv 在 jsdom 中执行瑞数挑战脚本, 求解出的动态 cookie 合并回 jar。
 * 挑战脚本通过 location.replace/assign/href 自跳转, sdenv 以 sdenv:exit 事件
 * 上报 (eventId 含 location.*), 收到即视为求解完成。
 */
export async function solveJxpcWaf(
  jar: CookieJar,
  timeoutMs = 30000
): Promise<void> {
  const sdenv = loadSdenv();
  const targetUrl = `${JXPC_BASE}/api/v2/core/ScheduleList/`;
  const cj = new sdenv.jsdom.CookieJar();
  // 播种 jxpc 域已有 cookie (token 等)
  for (const c of jar.all()) {
    if (
      c.domain === "jxpc.cdut.edu.cn" ||
      c.domain === ".jxpc.cdut.edu.cn"
    ) {
      try {
        cj.setCookieSync(`${c.name}=${c.value}`, `${JXPC_BASE}/`);
      } catch {}
    }
  }

  const dom = await sdenv.jsdomFromUrl(targetUrl, {
    cookieJar: cj,
    userAgent: BROWSER_UA,
  });
  const win = dom.window;
  try {
    const html = win.document?.documentElement?.innerHTML ?? "";
    if (!html.includes("$_ts")) {
      // 未触发挑战 (已有有效 WAF cookie), 直接合并返回
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("瑞数 WAF 求解超时")),
        timeoutMs
      );
      win.addEventListener("sdenv:exit", (ev: unknown) => {
        const id = (ev as { detail?: { eventId?: unknown } })?.detail?.eventId;
        if (
          typeof id === "string" &&
          /location\.(replace|assign|href)/.test(id)
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    win.close();
  }

  for (const c of cj.getCookiesSync(`${JXPC_BASE}/`)) {
    if (!c.key || c.value === undefined) continue;
    jar.setCookie(c.key, c.value, c.domain ?? "jxpc.cdut.edu.cn", c.path ?? "/");
  }
}

// ---------- JSON API ----------

interface JxpcEnvelope<T> {
  message?: string;
  state?: number;
  data?: T;
}

async function jxpcApiGet<T>(
  jar: CookieJar,
  path: string,
  timeoutMs = 15000
): Promise<T> {
  const res = await fetchWithJar(jar, `${JXPC_BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
    timeoutMs,
  });
  const text = await res.text();
  if (res.status === 412 || text.includes('id="_$_')) {
    throw new Error(`瑞数 WAF 校验未通过 (HTTP ${res.status})`);
  }
  let json: JxpcEnvelope<T>;
  try {
    json = JSON.parse(text) as JxpcEnvelope<T>;
  } catch {
    throw new Error(`教学评测系统返回了非 JSON 响应 (HTTP ${res.status})`);
  }
  if (json.state === 2003) {
    // {"state":2003,"message":"您的账号在其他地方登录..."} = 登录态失效
    throw new SessionExpiredError("教学评测系统登录态已失效");
  }
  if (json.data === undefined || json.data === null) {
    throw new Error(
      `教学评测系统接口异常: ${json.message ?? `HTTP ${res.status}`}`
    );
  }
  return json.data;
}

// ---------- 教学周历 ----------

export interface TeachingWeek {
  week: number;
  startDate: string;
  endDate: string;
}

export async function getTeachingWeeks(
  jar: CookieJar
): Promise<TeachingWeek[]> {
  const data = await jxpcApiGet<Array<{ djz: string; ksrq: string; jsrq: string }>>(
    jar,
    "/api/v2/common/zcrq"
  );
  return data
    .map((w) => ({ week: Number(w.djz), startDate: w.ksrq, endDate: w.jsrq }))
    .filter((w) => Number.isFinite(w.week));
}

/** 依据今天日期判断当前教学周; 不在任何周内时回退到第 1 周 */
export function currentTeachingWeek(
  weeks: TeachingWeek[],
  now = new Date()
): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}`;
  const hit = weeks.find((w) => w.startDate <= today && today <= w.endDate);
  return hit?.week ?? weeks[0]?.week ?? 1;
}

// ---------- 课表 ----------

export interface RawScheduleItem {
  id: string;
  kcid: string; // 课程号
  pkbh: string; // 排课编号 (教学班)
  kcmc: string; // 课程名称
  jsxm: string; // 教师姓名
  jsgh: string; // 教师工号
  jxdd: string; // 教学地点
  xqj: number; // 星期几 (1=周一)
  ksjc: number; // 开始节次
  kccd: number; // 课程长度 (节数)
  qsz: number; // 起始周
}

export interface JxpcClass {
  id: string;
  courseId: string;
  scheduleCode: string;
  className: string;
  teacher: string;
  teacherId: string;
  location: string;
  weekday: number;
  date: string | null;
  startSection: number;
  sectionCount: number;
  startTime: string | null;
  endTime: string | null;
  firstWeek: number;
}

/** "2026-08-31" + n 天 → "2026-09-06" (按 UTC 计算避免时区误差) */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(
    dt.getUTCDate()
  )}`;
}

/** 原始排课记录 → 统一结构; weekStart (该周周一) 提供时计算具体日期与上下课时间 */
export function mapJxpcClass(
  raw: RawScheduleItem,
  weekStart?: string
): JxpcClass {
  const startPeriod = getPeriod(raw.ksjc);
  const endPeriod = getPeriod(raw.ksjc + raw.kccd - 1);
  return {
    id: raw.id,
    courseId: raw.kcid,
    scheduleCode: raw.pkbh,
    className: raw.kcmc,
    teacher: raw.jsxm,
    teacherId: raw.jsgh,
    location: raw.jxdd,
    weekday: raw.xqj,
    date: weekStart ? addDays(weekStart, raw.xqj - 1) : null,
    startSection: raw.ksjc,
    sectionCount: raw.kccd,
    startTime: startPeriod?.start ?? null,
    endTime: endPeriod?.end ?? null,
    firstWeek: raw.qsz,
  };
}

/** 拉取指定周课表; 不传 week 时由服务端返回当前周 */
export async function getJxpcSchedule(
  jar: CookieJar,
  week?: number,
  weekStart?: string
): Promise<{ week: number; classes: JxpcClass[] }> {
  const path =
    week !== undefined
      ? `/api/v2/core/ScheduleList/?week=${encodeURIComponent(week)}`
      : "/api/v2/core/ScheduleList/";
  const data = await jxpcApiGet<{ zc: string; wlist: RawScheduleItem[] }>(
    jar,
    path
  );
  return {
    week: Number(data.zc),
    classes: (data.wlist ?? []).map((raw) => mapJxpcClass(raw, weekStart)),
  };
}
