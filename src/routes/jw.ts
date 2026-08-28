import { Hono, type Context } from "hono";
import {
  authenticateJw,
  getCurriculumPreInfo,
  getElectiveProjects,
  getExamInfosRaw,
  getExamSemesters,
  getLegacyCurriculumPreInfo,
  getLegacyCurriculumsRaw,
  getWeekScheduleRaw,
  parseExamInfos,
  parseLegacySchedule,
  parseSchedule,
  searchStudents,
  type ClassInfo,
  type ExamInfo,
} from "../services/jw.js";
import { TIMETABLE } from "../data/timetable.js";
import { atTime, buildIcs, parseLocalDate, type IcsEvent } from "../lib/ics.js";
import {
  jarFromSession,
  readSession,
  writeSession,
  SESSION_EXPIRED_BODY,
  type SessionData,
} from "../lib/session.js";
import { SessionExpiredError } from "../lib/errors.js";
import type { CookieJar } from "../lib/http.js";

const jw = new Hono();

/** 解封会话并完成教务 SSO 认证; 失败时返回 401/502 Response */
async function authenticate(
  c: Context
): Promise<{ session: SessionData; jar: CookieJar } | Response> {
  const session = readSession(c);
  if (!session) return c.json(SESSION_EXPIRED_BODY, 401);
  const jar = jarFromSession(session);
  try {
    await authenticateJw(jar);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return c.json(SESSION_EXPIRED_BODY, 401);
    }
    return c.json(
      {
        error: "jw_auth_failed",
        message: `教务系统认证失败: ${err instanceof Error ? err.message : String(err)}`,
      },
      502
    );
  }
  return { session, jar };
}

function classesToIcsEvents(classes: ClassInfo[]): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const cl of classes) {
    if (!cl.date || cl.indexInDay === undefined) continue;
    const slot = TIMETABLE[cl.indexInDay];
    if (!slot) continue;
    const day = parseLocalDate(cl.date);
    events.push({
      summary: cl.className,
      description: [cl.teacher, cl.score, cl.classWeek, cl.classSchedule]
        .filter(Boolean)
        .join("\n"),
      location: cl.location,
      start: atTime(day, slot[0]),
      end: atTime(day, slot[1]),
    });
  }
  return events;
}

function examsToIcsEvents(exams: ExamInfo[]): IcsEvent[] {
  return exams.map((e) => {
    const [datePart, timePart] = e.startTime.split(" ");
    const [, endTimePart] = e.endTime.split(" ");
    const day = parseLocalDate(datePart);
    return {
      summary: `[考试] ${e.name}`,
      description: `${e.name}(${e.curriculumId})\n${e.classroom} - ${e.seat}\n${e.teacher}\n${e.examId}`,
      location: `${e.classroom} - ${e.seat}`,
      start: atTime(day, timePart.slice(0, 5)),
      end: atTime(day, endTimePart.slice(0, 5)),
    };
  });
}

function icsResponse(c: Context, events: IcsEvent[], filename: string) {
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}.ics"`
  );
  return c.body(buildIcs(events));
}

// ---------- 课表 (新版) ----------

jw.get("/schedule/meta", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const preInfo = await getCurriculumPreInfo(auth.jar);
  writeSession(c, auth.jar, auth.session);
  return c.json(preInfo);
});

jw.post("/schedule", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req
    .json<{ xqid?: string; week?: string }>()
    .catch((): { xqid?: string; week?: string } => ({}));

  const preInfo = await getCurriculumPreInfo(auth.jar);
  if (preInfo.xqids.length === 0 || !preInfo.sjmsValue) {
    return c.json(
      { error: "无法获取课表基础信息，可能是教务系统页面结构变化" },
      502
    );
  }

  const xqid = body.xqid ?? preInfo.xqids[0];
  const weekEntries = Object.entries(preInfo.availableWeeks);
  const weekEntry = body.week
    ? weekEntries.find(([name]) => name === body.week)
    : weekEntries[0];
  if (!weekEntry) {
    return c.json(
      { error: "未找到指定周次", availableWeeks: preInfo.availableWeeks },
      400
    );
  }

  const raw = await getWeekScheduleRaw(
    auth.jar,
    preInfo.sjmsValue,
    xqid,
    weekEntry[1]
  );
  const classes = parseSchedule(raw, weekEntry[1]);
  writeSession(c, auth.jar, auth.session);

  if (c.req.query("format") === "ics") {
    return icsResponse(c, classesToIcsEvents(classes), `课表-${weekEntry[0]}`);
  }
  return c.json({
    semester: xqid,
    week: weekEntry[0],
    weekStart: weekEntry[1],
    classCount: classes.length,
    classes,
  });
});

// ---------- 课表 (旧版, 需调用方提供第一周周一日期) ----------

jw.get("/schedule/legacy/meta", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const preInfo = await getLegacyCurriculumPreInfo(auth.jar);
  writeSession(c, auth.jar, auth.session);
  return c.json(preInfo);
});

jw.post("/schedule/legacy", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req
    .json<{ xqid: string; week: number; startDate: string }>()
    .catch(() => null);
  if (!body?.xqid || !body?.week || !body?.startDate) {
    return c.json(
      { error: "xqid, week (周序号), startDate (第一周周一, yyyy-MM-dd) 必填" },
      400
    );
  }
  const firstMonday = parseLocalDate(body.startDate);
  if (isNaN(firstMonday.getTime())) {
    return c.json({ error: "startDate 格式应为 yyyy-MM-dd" }, 400);
  }
  const weekMonday = new Date(firstMonday);
  weekMonday.setDate(weekMonday.getDate() + (body.week - 1) * 7);

  const raw = await getLegacyCurriculumsRaw(
    auth.jar,
    body.xqid,
    String(body.week)
  );
  const classes = parseLegacySchedule(raw, weekMonday);
  writeSession(c, auth.jar, auth.session);

  if (c.req.query("format") === "ics") {
    return icsResponse(c, classesToIcsEvents(classes), `课表-第${body.week}周`);
  }
  return c.json({
    semester: body.xqid,
    week: body.week,
    classCount: classes.length,
    classes,
  });
});

// ---------- 考试信息 ----------

jw.get("/exams/meta", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const semesters = await getExamSemesters(auth.jar);
  writeSession(c, auth.jar, auth.session);
  return c.json({ semesters });
});

jw.post("/exams", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json<{ xnxqid: string }>().catch(() => null);
  if (!body?.xnxqid) {
    return c.json({ error: "xnxqid (学年学期, 见 /jw/exams/meta) 必填" }, 400);
  }
  const raw = await getExamInfosRaw(auth.jar, body.xnxqid);
  const exams = parseExamInfos(raw);
  writeSession(c, auth.jar, auth.session);

  if (c.req.query("format") === "ics") {
    return icsResponse(c, examsToIcsEvents(exams), `考试-${body.xnxqid}`);
  }
  return c.json({ semester: body.xnxqid, examCount: exams.length, exams });
});

// ---------- 学生查询 ----------

jw.post("/students", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req.json<{ name: string }>().catch(() => null);
  if (!body?.name) {
    return c.json({ error: "name (学生姓名或学号) 必填" }, 400);
  }
  const students = await searchStudents(auth.jar, body.name);
  writeSession(c, auth.jar, auth.session);
  return c.json({ count: students.length, students });
});

// ---------- 选课计划 ----------

jw.get("/elective/projects", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const projects = await getElectiveProjects(auth.jar);
  writeSession(c, auth.jar, auth.session);
  return c.json({ count: projects.length, projects });
});

export default jw;
