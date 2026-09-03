import { sealSession, openSession, jarFromSession } from "./src/lib/session.js";
import { buildIcs, parseLocalDate, atTime } from "./src/lib/ics.js";
import {
  parseSchedule,
  parseExamInfos,
  parseLegacySchedule,
} from "./src/services/jw.js";
import { CookieJar } from "./src/lib/http.js";
import {
  routeElectricityChannel,
  buildCashierUrl,
  inferFloorFromRoomNo,
} from "./src/services/elec.js";
import {
  addDays,
  currentTeachingWeek,
  mapJxpcClass,
  type RawScheduleItem,
} from "./src/services/jxpc.js";

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

// 6. 电费通道路由 (校方规则)
check("elec-route-芙蓉照明", routeElectricityChannel("芙蓉园", "照明").factoryCode === "E016");
check("elec-route-芙蓉空调", routeElectricityChannel("芙蓉园", "空调").factoryCode === "E016");
check("elec-route-香樟空调", routeElectricityChannel("香樟园", "空调").factoryCode === "E016");
check("elec-route-珙桐照明", routeElectricityChannel("珙桐园", "照明").factoryCode === "E017");
check("elec-route-珙桐空调", routeElectricityChannel("珙桐园", "空调").factoryCode === "E034");
check("elec-route-榕树照明", routeElectricityChannel("榕树园", "照明").factoryCode === "E016");
check("elec-route-榕树空调", routeElectricityChannel("榕树园", "空调").factoryCode === "E034");
check("elec-route-松林照明", routeElectricityChannel("松林园", "照明").factoryCode === "E016");
check("elec-route-松林空调", routeElectricityChannel("松林园", "空调").factoryCode === "E034");
check("elec-route-银杏1照明", routeElectricityChannel("银杏园", "照明", 1).factoryCode === "E016");
check("elec-route-银杏3照明", routeElectricityChannel("银杏园", "照明", 3).factoryCode === "E016");
check("elec-route-银杏1空调", routeElectricityChannel("银杏园", "空调", 1).factoryCode === "E034");
check("elec-route-银杏2照明", routeElectricityChannel("银杏园", "照明", 2).factoryCode === "E034");
check("elec-route-银杏4空调", routeElectricityChannel("银杏园", "空调", 4).factoryCode === "E034");
{
  let threw = false;
  try {
    routeElectricityChannel("银杏园", "照明");
  } catch {
    threw = true;
  }
  check("elec-route-银杏缺栋号报错", threw);
}
check(
  "elec-cashier-url",
  buildCashierUrl("PROJ", "ORDER") ===
    "https://paym.cdut.edu.cn/mobile/#/person?projectId=PROJ&orderId=ORDER"
);

// 7. E034 楼层推断 (房间号去掉末两位)
check("elec-infer-floor-512", inferFloorFromRoomNo("512") === 5);
check("elec-infer-floor-1205", inferFloorFromRoomNo("1205") === 12);
check("elec-infer-floor-101", inferFloorFromRoomNo("101") === 1);
check("elec-infer-floor-带空格", inferFloorFromRoomNo(" 512 ") === 5);
for (const bad of ["12", "5", "abc", ""]) {
  let threw = false;
  try {
    inferFloorFromRoomNo(bad);
  } catch {
    threw = true;
  }
  check(`elec-infer-floor-非法输入"${bad}"报错`, threw);
}

// 8. jxpc 课表映射 (瑞数 WAF 后的 JSON API)
check("jxpc-addDays-周内", addDays("2026-08-31", 6) === "2026-09-06");
check("jxpc-addDays-跨月", addDays("2026-08-31", 1) === "2026-09-01");
const jxpcWeeks = [
  { week: 1, startDate: "2026-08-31", endDate: "2026-09-06" },
  { week: 2, startDate: "2026-09-07", endDate: "2026-09-13" },
];
check(
  "jxpc-当前周判定",
  currentTeachingWeek(jxpcWeeks, new Date("2026-09-04T12:00:00+08:00")) === 1 &&
    currentTeachingWeek(jxpcWeeks, new Date("2026-09-08T12:00:00+08:00")) === 2 &&
    currentTeachingWeek(jxpcWeeks, new Date("2027-01-01T12:00:00+08:00")) === 1
);
const rawItem: RawScheduleItem = {
  id: "7c9fb5710bde0284a7569d9c0af6f107",
  kcid: "RX131012",
  pkbh: "202620271000492",
  kcmc: "日本影视名作鉴赏",
  jsxm: "姜宇灵",
  jsgh: "10201402127",
  jxdd: "6A110",
  xqj: 7,
  ksjc: 9,
  kccd: 3,
  qsz: 1,
};
const mapped = mapJxpcClass(rawItem, "2026-08-31");
check(
  "jxpc-课表映射",
  mapped.date === "2026-09-06" &&
    mapped.startTime === "19:10" &&
    mapped.endTime === "21:35" &&
    mapped.weekday === 7 &&
    mapped.startSection === 9 &&
    mapped.sectionCount === 3,
  mapped
);
check("jxpc-无周一时date为null", mapJxpcClass(rawItem).date === null);

process.exit(failures ? 1 : 0);


