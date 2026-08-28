import { sealSession, openSession, jarFromSession } from "./src/lib/session.js";
import { buildIcs, parseLocalDate, atTime } from "./src/lib/ics.js";
import {
  parseSchedule,
  parseExamInfos,
  parseLegacySchedule,
} from "./src/services/jw.js";
import { CookieJar } from "./src/lib/http.js";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}`, extra ?? "");
  }
}

// 1. session round trip
const blob = sealSession({
  cookies: [
    { name: "TGC", value: "abc==", domain: "cas.paas.cdut.edu.cn", path: "/cas" },
  ],
  studentId: "2020000000",
  paymToken: "tok123",
});
const opened = openSession(blob);
check("session-roundtrip", opened?.studentId === "2020000000" && opened.paymToken === "tok123" && opened.cookies.length === 1);
check("session-tamper-rejected", openSession(blob.slice(0, -4) + "AAAA") === null);
const jar = jarFromSession(opened!);
check(
  "jar-rebuilt",
  jar.cookieHeaderFor("https://cas.paas.cdut.edu.cn/cas/login") === "TGC=abc=="
);

// 2. ICS output
const ics = buildIcs([
  {
    summary: "高等数学, 考试; 测试",
    description: "老师\n备注",
    location: "6A-101",
    start: atTime(parseLocalDate("2024-09-02"), "08:10"),
    end: atTime(parseLocalDate("2024-09-02"), "09:45"),
  },
]);
check("ics-structure", ics.startsWith("BEGIN:VCALENDAR") && ics.includes("END:VCALENDAR") && ics.includes("DTSTART:20240902T081000") && ics.includes("DTEND:20240902T094500"));
check("ics-escape", ics.includes("高等数学\\, 考试\\; 测试") && ics.includes("老师\\n备注"));
check("ics-crlf", ics.includes("\r\n") && !ics.replace(/\r\n/g, "").includes("\n"));
const longLine = ics.split("\r\n").find((l) => l.startsWith("SUMMARY"));
check("ics-fold-75", ics.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75), longLine);

// 3. parseSchedule with week date
const cellTpl = (i: number) =>
  `<td align="left">\r\n\r\n<span onmouseover='kbtc(this)' onmouseout='kbot(this)' class='box' style='x'><p>t</p><p>教师${i}</p><span class='text'>1-16周</span></span><div class='item-box' ><p>课程${i}</p><div class='tch-name'><span>教师X</span><span>学分：3</span><span>01~02节</span></div><div><span><img src='/jsxsd/assets_v1/images/item1.png'>6A101</span></div></div>\r\n\r\n</td>`;
const scheduleHtml = Array.from({ length: 42 }, (_, i) => (i === 0 || i === 8 ? cellTpl(i) : `<td align="left">\r\n\r\n\r\n\r\n</td>`)).join("\n");
const classes = parseSchedule(scheduleHtml, "2024-09-02");
check("parseSchedule-count", classes.length === 2, classes.length);
check(
  "parseSchedule-slots",
  classes[0]?.date === "2024-09-02" && classes[0]?.indexInDay === 0 &&
    classes[1]?.date === "2024-09-03" && classes[1]?.indexInDay === 1,
  classes.map((c) => [c.date, c.indexInDay])
);
check("parseSchedule-fields", classes[0]?.className === "课程0" && classes[0]?.teacher === "教师0" && classes[0]?.location === "6A101");

// 4. parseExamInfos
const examHtml = `<table><tr>\n<td>1</td>\n<td>2</td>\n<td >3</td>\n<td >EXAM01</td>\n<td >CUR01</td>\n<td >操作系统</td>\n<td >张老师</td>\n<td>2024-12-30 14:00~16:00</td>\n<td >6A-201</td>\n<td>12</td></tr></table>`;
const exams = parseExamInfos(examHtml);
check("parseExamInfos-count", exams.length === 1, exams.length);
check(
  "parseExamInfos-fields",
  exams[0]?.name === "操作系统" &&
    exams[0]?.startTime === "2024-12-30 14:00:00" &&
    exams[0]?.endTime === "2024-12-30 16:00:00" &&
    exams[0]?.classroom === "6A-201" &&
    exams[0]?.examId === "EXAM01",
  exams[0]
);

// 5. parseLegacySchedule
const legacyCell = (i: number) =>
  `<td width="123" height="28" align="center" valign='top'>\n<font onmouseover='kbtc(this)' onmouseout='kbot(this)' >大学物理<br/>A</font><font title='教师' onmouseover='kbtc(this)' onmouseout='kbot(this)' >李师</font><font title='周次(节次)' onmouseover='kbtc(this)' onmouseout='kbot(this)' >1-16周[1-2节]</font><font title='教学楼' name='jxlmc' style='display:none;' onmouseover='kbtc(this)' onmouseout='kbot(this)' >6教</font><font title='教室' onmouseover='kbtc(this)' onmouseout='kbot(this)' >6A101</font>\n</td>`;
const legacyHtml = legacyCell(0) + legacyCell(1);
const legacy = parseLegacySchedule(legacyHtml, parseLocalDate("2024-09-02"));
check("parseLegacy-count", legacy.length === 2, legacy.length);
check(
  "parseLegacy-fields",
  legacy[0]?.className === "大学物理A" &&
    legacy[0]?.teacher === "李师" &&
    legacy[0]?.classWeek === "1-16周" &&
    legacy[0]?.classSchedule === "1-2节" &&
    legacy[0]?.location === "6教 - 6A101" &&
    legacy[0]?.date === "2024-09-02" &&
    legacy[0]?.indexInDay === 0 &&
    legacy[1]?.date === "2024-09-03" &&
    legacy[1]?.indexInDay === 0,
  legacy[0]
);

process.exit(failures ? 1 : 0);
