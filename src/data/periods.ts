/**
 * 教学评测系统 (jxpc) 节次 → 时间表。
 * 优先读取项目根目录 config/schedule.json, 读取失败时回退到内置默认 (与 2026-2027-1 学期一致)。
 */
import fs from "node:fs";
import path from "node:path";

export interface Period {
  section: number;
  start: string;
  end: string;
}

const FALLBACK: Record<number, Period> = {
  1: { section: 1, start: "08:10", end: "08:55" },
  2: { section: 2, start: "09:00", end: "09:45" },
  3: { section: 3, start: "10:15", end: "11:00" },
  4: { section: 4, start: "11:05", end: "11:50" },
  5: { section: 5, start: "14:30", end: "15:15" },
  6: { section: 6, start: "15:20", end: "16:05" },
  7: { section: 7, start: "16:25", end: "17:10" },
  8: { section: 8, start: "17:15", end: "18:00" },
  9: { section: 9, start: "19:10", end: "19:55" },
  10: { section: 10, start: "20:00", end: "20:45" },
  11: { section: 11, start: "20:50", end: "21:35" },
};

let cached: Record<number, Period> | null = null;

export function getPeriods(): Record<number, Period> {
  if (cached) return cached;
  try {
    const file = path.join(process.cwd(), "config", "schedule.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const periods =
      json?.schedules?.[json?.defaultSchedule ?? "main"]?.periods;
    if (!Array.isArray(periods) || periods.length === 0) {
      throw new Error("schedule.json 中无节次数据");
    }
    const map: Record<number, Period> = {};
    for (const p of periods) {
      if (p?.section && p?.start && p?.end) {
        map[p.section] = { section: p.section, start: p.start, end: p.end };
      }
    }
    cached = Object.keys(map).length > 0 ? map : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}

export function getPeriod(section: number): Period | null {
  return getPeriods()[section] ?? null;
}
