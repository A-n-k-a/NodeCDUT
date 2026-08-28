import { USER_AGENT } from "./cas.js";
import { SessionExpiredError } from "../lib/errors.js";
import {
  CookieJar,
  fetchWithJar,
  followRedirects,
} from "../lib/http.js";

const JW_BASE = "https://jw.cdut.edu.cn";

export interface CurriculumPreInfo {
  sjmsValue: string;
  xqids: string[];
  availableWeeks: Record<string, string>;
}

export async function authenticateJw(jar: CookieJar): Promise<void> {
  const result = await followRedirects(jar, `${JW_BASE}/sso/login.jsp`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (result.steps >= 15) {
    throw new Error("教务系统认证重定向次数过多");
  }
  if (result.finalUrl.includes("cas.paas.cdut.edu.cn/cas/login")) {
    throw new SessionExpiredError();
  }
}

export async function getCurriculumPreInfo(
  jar: CookieJar
): Promise<CurriculumPreInfo> {
  const res = await fetchWithJar(
    jar,
    `${JW_BASE}/jsxsd/framework/xsMainV_new.htmlx?t1=1`,
    {
      headers: { "User-Agent": USER_AGENT },
    }
  );
  const html = await res.text();

  const sjmsMatch = html.match(/data-value="(.*)" name="kbjcmsid"/);
  const sjmsValue = sjmsMatch?.[1] ?? "";

  const xqids: string[] = [];
  const xqidRegex = /<option value="">([\d-]*)<\/option>/g;
  let m: RegExpExecArray | null;
  while ((m = xqidRegex.exec(html)) !== null) {
    if (m[1]) xqids.push(m[1]);
  }

  const availableWeeks: Record<string, string> = {};
  const weekRegex = /<option value="([\d-]+)"(?:.*)>(.*)<\/option>/g;
  while ((m = weekRegex.exec(html)) !== null) {
    availableWeeks[m[2]] = m[1];
  }

  return { sjmsValue, xqids, availableWeeks };
}

export async function getWeekScheduleRaw(
  jar: CookieJar,
  sjms: string,
  xqid: string,
  weekId: string
): Promise<string> {
  const url = `${JW_BASE}/jsxsd/framework/mainV_index_loadkb.htmlx?rq=${encodeURIComponent(
    weekId
  )}&sjmsValue=${encodeURIComponent(sjms)}&xnxqid=${encodeURIComponent(
    xqid
  )}&xswk=true`;
  const res = await fetchWithJar(jar, url, {
    headers: { "User-Agent": USER_AGENT },
  });
  return res.text();
}

export interface ClassInfo {
  className: string;
  teacher: string;
  score?: string;
  location: string;
  classWeek: string;
  classSchedule: string;
  /** 所在日期 (本地, yyyy-MM-dd); 仅传入 startDate 时填充 */
  date?: string;
  /** 当天节次序号 (对应 TIMETABLE 键); 仅传入 startDate 时填充 */
  indexInDay?: number;
}

/**
 * 解析新版课表 HTML。weekId 即该周周一日期 (rq 参数, yyyy-MM-dd)。
 * 6 节 x 7 天 = 42 格, 空格跳过, 格序号决定 date / indexInDay。
 */
export function parseSchedule(rawHtml: string, weekId?: string): ClassInfo[] {
  const cellRegex =
    /<td align="left">([\s\S]*?)<\/td>/g;
  const cells: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = cellRegex.exec(rawHtml)) !== null) {
    cells.push(m[1]);
  }

  let monday: Date | null = null;
  if (weekId) {
    const [y, mo, d] = weekId.split("-").map((t) => parseInt(t, 10));
    if (y && mo && d) monday = new Date(y, mo - 1, d);
  }

  const results: ClassInfo[] = [];
  const infoPattern =
    /<span onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)' class='box' style='[^']*'><p>[^<]*<\/p><p>([^<]*)<\/p><span class='text'>([^<]*)<\/span><\/span><div class='item-box' ><p>(\S*)<\/p><div class='tch-name'>([\s\S]*?)<\/div><div><span><img src='\/jsxsd\/assets_v1\/images\/item1.png'>([^<]*)/;

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    if (!cell.trim()) continue;
    const match = cell.match(infoPattern);
    if (!match) continue;
        // tch-name 内不定长 span: 现行为 [教师, 学分:N, NN~NN节], 旧版可能少一项
    const spans = Array.from(match[4].matchAll(/<span>([^<]*)<\/span>/g)).map(
      (s) => s[1]
    );
    const info: ClassInfo = {
      className: match[3],
      teacher: match[1],
      score: spans.find((s) => s.includes("学分")),
      classWeek: match[2],
      classSchedule:
        spans.find((s) => /节/.test(s)) ?? spans[spans.length - 1] ?? "",
      location: match[5],
    };
    if (monday) {
      const date = new Date(monday);
      date.setDate(date.getDate() + (index % 7));
      const p = (n: number) => n.toString().padStart(2, "0");
      info.date = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
      info.indexInDay = Math.floor(index / 7);
    }
    results.push(info);
  }
  return results;
}

// ---------- 考试信息 ----------

export interface ExamInfo {
  name: string;
  /** 本地时间, "yyyy-MM-dd HH:mm:ss" */
  startTime: string;
  endTime: string;
  classroom: string;
  seat: string;
  teacher: string;
  examId: string;
  curriculumId: string;
}

/** 可选学年学期列表 (xsksap_query 页中以 "2" 开头的选项 value) */
export async function getExamSemesters(jar: CookieJar): Promise<string[]> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xsks/xsksap_query`, {
    headers: { "User-Agent": USER_AGENT },
  });
  const html = await res.text();
  const regex = /<option\s\S*\s*value="([^"]*)">2/g;
  const semesters: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    semesters.push(m[1]);
  }
  return semesters;
}

export async function getExamInfosRaw(
  jar: CookieJar,
  xnxqid: string
): Promise<string> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xsks/xsksap_list`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: new URLSearchParams({ xnxqid }).toString(),
  });
  return res.text();
}

const EXAM_ROW_REGEX =
  /<tr>\s*<td\s?>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s?\S*>(.*)<\/td>\s*<td\s*\S*>(.*)<\/td>\s*<td\s*\S*>(.*)<\/td>\s*<td>(.*)<\/td>/g;

export function parseExamInfos(rawHtml: string): ExamInfo[] {
  const results: ExamInfo[] = [];
  let m: RegExpExecArray | null;
  EXAM_ROW_REGEX.lastIndex = 0;
  while ((m = EXAM_ROW_REGEX.exec(rawHtml)) !== null) {
    // m[8]: "yyyy-MM-dd HH:mm~HH:mm"
    const dtMatch = m[8].match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})/);
    if (!dtMatch) continue;
    results.push({
      name: m[6],
      startTime: `${dtMatch[1]} ${dtMatch[2]}:00`,
      endTime: `${dtMatch[1]} ${dtMatch[3]}:00`,
      classroom: m[9],
      seat: m[10],
      teacher: m[7],
      examId: m[4],
      curriculumId: m[5],
    });
  }
  return results;
}

// ---------- 学生查询 ----------

export interface StudentInfo {
  id: string;
  name: string;
}

export async function searchStudents(
  jar: CookieJar,
  name: string
): Promise<StudentInfo[]> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xskb/cxxs`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: new URLSearchParams({ xsmc: name, maxRow: "100" }).toString(),
  });
  const body = (await res.json()) as {
    result?: boolean;
    list?: { xh: string; xsmc: string }[];
  };
  if (!body.result || !Array.isArray(body.list)) return [];
  return body.list.map((t) => ({ id: t.xh, name: t.xsmc }));
}

// ---------- 旧版课表 (xskb_list.do) ----------

export interface LegacyCurriculumPreInfo {
  xqids: string[];
  /** "第 N 周" → N; 旧表接口只接受周序号, 日期由调用方提供 */
  weeks: number[];
}

export async function getLegacyCurriculumPreInfo(
  jar: CookieJar
): Promise<LegacyCurriculumPreInfo> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xskb/xskb_list.do`, {
    headers: { "User-Agent": USER_AGENT },
  });
  const html = await res.text();
  const regex = /<option value="(20\S*)".*>20/g;
  const xqids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    xqids.push(m[1]);
  }
  return { xqids, weeks: Array.from({ length: 30 }, (_, i) => i + 1) };
}

export async function getLegacyCurriculumsRaw(
  jar: CookieJar,
  xqid: string,
  zc: string
): Promise<string> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xskb/xskb_list.do`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      cj0701id: "",
      xnxq01id: xqid,
      sfFD: "1",
      wkbkc: "1",
      zc,
    }).toString(),
  });
  return res.text();
}

/**
 * 解析旧版课表 HTML。startDate 为该周周一 (本地 Date)。
 * 单元格顺序: 每天 6 格, 共 7 天; 格序号 → date = startDate + index%7 天,
 * indexInDay = floor(index/7)。
 */
export function parseLegacySchedule(
  rawHtml: string,
  startDate: Date
): ClassInfo[] {
  const cellRegex =
    /<td width="123" height="28" align="center" valign='top'\s*>\s*([\s\S]*?)\s*<\/td>/g;
  const results: ClassInfo[] = [];
  let m: RegExpExecArray | null;
  let index = -1;
  const p = (n: number) => n.toString().padStart(2, "0");
  while ((m = cellRegex.exec(rawHtml)) !== null) {
    index++;
    const cell = m[1];
    const className = cell
      .match(
        /<font onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)'\s*>(.*?)<\/font>/
      )?.[1]
      ?.replace(/<br\/>/g, "");
    if (!className) continue;
    const teacher =
      cell.match(
        /<font title='教师' onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)'\s*>(.*?)<\/font>/
      )?.[1] ?? "";
    const weekMatch = cell.match(
      /<font title='周次\(节次\)' onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)'\s*>(.*?)\[(.*?)\]<\/font>/
    );
    const building =
      cell.match(
        /<font title='教学楼' name='jxlmc' style='display:none;'\s*onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)'\s*>(.*?)<\/font>/
      )?.[1] ?? "";
    const room =
      cell.match(
        /<font title='教室' onmouseover='kbtc\(this\)' onmouseout='kbot\(this\)'\s*>(.*?)<\/font>/
      )?.[1] ?? "";
    const date = new Date(startDate);
    date.setDate(date.getDate() + (index % 7));
    results.push({
      className,
      teacher,
      classWeek: weekMatch?.[1] ?? "",
      classSchedule: weekMatch?.[2] ?? "",
      location: `${building} - ${room}`,
      date: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
      indexInDay: Math.floor(index / 7),
    });
  }
  return results;
}

// ---------- 选课计划 ----------

export interface ElectiveProject {
  id: string;
  name: string;
  semester: string;
  time: string;
}

export async function getElectiveProjects(
  jar: CookieJar
): Promise<ElectiveProject[]> {
  const res = await fetchWithJar(jar, `${JW_BASE}/jsxsd/xsxk/xklc_list`, {
    headers: { "User-Agent": USER_AGENT },
  });
  const html = await res.text();
  const regex =
    /<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>[\s]*<td>\s*.*toxk\('(.*)'\)"/g;
  const projects: ElectiveProject[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    projects.push({
      semester: m[1],
      name: m[2],
      time: m[3],
      id: m[4],
    });
  }
  return projects;
}
