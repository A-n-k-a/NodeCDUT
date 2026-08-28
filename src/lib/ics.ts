/**
 * 极简 ICS (RFC 5545) 序列化器, 替代 C# 端的 Ical.Net。
 * 与原实现对齐: 本地浮动时间 (不带时区), yyyyMMddTHHmmss。
 */

export interface IcsEvent {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** 本地浮动时间: 20240115T081000 */
function formatLocal(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** UTC 时间 (DTSTAMP): 20240115T001000Z */
function formatUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 按 75 字节折行, 续行以空格开头; 不在 UTF-8 字符中间断开 */
function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    if (bytes + len > 75) {
      out.push(current);
      current = " " + ch;
      bytes = 1 + len;
    } else {
      current += ch;
      bytes += len;
    }
  }
  out.push(current);
  return out.join("\r\n");
}

let uidCounter = 0;

export function buildIcs(events: IcsEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NodeCDUT//CDUniTap//CN",
    "CALSCALE:GREGORIAN",
  ];
  const stamp = formatUtc(new Date());
  for (const ev of events) {
    uidCounter++;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${Date.now()}-${uidCounter}@nodecdut`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${formatLocal(ev.start)}`);
    lines.push(`DTEND:${formatLocal(ev.end)}`);
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** 解析 "yyyy-MM-dd" 为本地 Date (避免时区解析差异) */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map((t) => parseInt(t, 10));
  return new Date(y, m - 1, d);
}

/** 组合日期与 "HH:mm" 时间为本地 Date */
export function atTime(date: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((t) => parseInt(t, 10));
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}
