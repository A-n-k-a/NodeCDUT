import { Hono, type Context } from "hono";
import {
  authenticateJxpc,
  currentTeachingWeek,
  getJxpcSchedule,
  getTeachingWeeks,
  solveJxpcWaf,
  type JxpcClass,
} from "../services/jxpc.js";
import { atTime, buildIcs, type IcsEvent } from "../lib/ics.js";
import {
  jarFromSession,
  readSession,
  writeSession,
  SESSION_EXPIRED_BODY,
  type SessionData,
} from "../lib/session.js";
import { SessionExpiredError } from "../lib/errors.js";
import type { CookieJar } from "../lib/http.js";

const jxpc = new Hono();

/** 解封会话 → CAS 认证 jxpc → 求解瑞数 WAF; 失败时返回 401/502 Response */
async function authenticate(
  c: Context
): Promise<{ session: SessionData; jar: CookieJar } | Response> {
  const session = readSession(c);
  if (!session) return c.json(SESSION_EXPIRED_BODY, 401);
  const jar = jarFromSession(session);
  try {
    await authenticateJxpc(jar);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return c.json(SESSION_EXPIRED_BODY, 401);
    }
    return c.json(
      {
        error: "jxpc_auth_failed",
        message: `教学评测系统认证失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      502
    );
  }
  try {
    await solveJxpcWaf(jar);
  } catch (err) {
    return c.json(
      {
        error: "jxpc_waf_failed",
        message: `瑞数 WAF 求解失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      502
    );
  }
  return { session, jar };
}

function icsResponse(c: Context, events: IcsEvent[], filename: string) {
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}.ics"`
  );
  return c.body(buildIcs(events));
}

function classesToIcsEvents(
  classes: Array<JxpcClass & { week?: number }>
): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const cl of classes) {
    if (!cl.date || !cl.startTime || !cl.endTime) continue;
    events.push({
      summary: cl.className,
      location: cl.location,
      description:
        `教师: ${cl.teacher}\n教学班: ${cl.scheduleCode}\n节次: 第${
          cl.startSection
        }-${cl.startSection + cl.sectionCount - 1}节` +
        (cl.week ? `\n周次: 第${cl.week}周` : ""),
      start: atTime(new Date(`${cl.date}T00:00:00`), cl.startTime),
      end: atTime(new Date(`${cl.date}T00:00:00`), cl.endTime),
    });
  }
  return events;
}

// ---------- 教学周历 ----------

jxpc.get("/schedule/weeks", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const weeks = await getTeachingWeeks(auth.jar);
  writeSession(c, auth.jar, auth.session);
  return c.json({ current: currentTeachingWeek(weeks), weeks });
});

// ---------- 课表 ----------

jxpc.post("/schedule", async (c) => {
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const body = await c.req
    .json<{ week?: number | "all" }>()
    .catch(() => ({}) as { week?: number | "all" });

  const weeks = await getTeachingWeeks(auth.jar);

  // week="all": 遍历全部教学周, 课程项附带 week 字段
  if (body?.week === "all") {
    const all: Array<JxpcClass & { week: number }> = [];
    for (const wk of weeks) {
      const { classes } = await getJxpcSchedule(auth.jar, wk.week, wk.startDate);
      for (const cl of classes) all.push({ ...cl, week: wk.week });
    }
    writeSession(c, auth.jar, auth.session);
    if (c.req.query("format") === "ics") {
      return icsResponse(c, classesToIcsEvents(all), "jxpc课表-全学期");
    }
    return c.json({
      week: "all",
      weekCount: weeks.length,
      classCount: all.length,
      classes: all,
    });
  }

  const requested = Number(body?.week);
  const week =
    Number.isFinite(requested) && requested > 0
      ? requested
      : currentTeachingWeek(weeks);
  const wk = weeks.find((w) => w.week === week);

  const { week: actualWeek, classes } = await getJxpcSchedule(
    auth.jar,
    week,
    wk?.startDate
  );
  writeSession(c, auth.jar, auth.session);

  if (c.req.query("format") === "ics") {
    return icsResponse(
      c,
      classesToIcsEvents(classes),
      `jxpc课表-第${actualWeek}周`
    );
  }
  return c.json({
    week: actualWeek,
    weekStart: wk?.startDate ?? null,
    weekEnd: wk?.endDate ?? null,
    classCount: classes.length,
    classes,
  });
});

export default jxpc;
