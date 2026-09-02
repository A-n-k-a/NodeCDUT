import { USER_AGENT } from "./cas.js";
import { CookieJar, fetchWithJar } from "../lib/http.js";
import {
  closeOrder,
  dropNulls,
  listPendingOrders,
  type PaymSession,
} from "./paym.js";

/**
 * 电费查询/充值链路 (paym 缴费平台 payEleCostController)。
 *
 * 抓包分析结论 (2026-09, 前端 /mobile/ SPA + 实际请求):
 * - 项目按 factoryCode 分页面流程:
 *   - E016 爱立德电费: 区域硬编码 (芙蓉2/香樟4/银杏3/松林5),
 *     queryBuildingList → queryRoomList → querySydl
 *   - E018 科技园: 同 E016, 区域硬编码 (芙蓉1)
 *   - E017 珙桐园电费: querySchoolList → queryBuildingList → queryRoomList → querySydl
 *   - E034 新开普电费: getRoomInfo op_type=1(区域)→2(楼栋)→3(楼层)→4(房间),
 *     querySydl 用 roomverify (房间复合 id) 而非 roomid
 * - createOrder(buyElectric=表单, projectId): opfare 单位为分 (100*元),
 *   buyerid 为学号, acctype 固定 101
 * - 注意: 请求体的 Content-Type 必须是 application/json, 否则后端无法解析
 *   表单并返回 "系统正在维护中" (messageCode=2) 的误导性响应。
 * - 静态房间映射 (上游 C# Data/Paym/RoomIds.cs) 已被动态查询取代, 不再移植。
 */

const PAYM_BASE = "https://paym.cdut.edu.cn";
const ELE_BASE = "/api/pay/web/payEleCostController";

/** 爱立德 (E016) 前端硬编码区域 */
const ALD_AREAS = [
  { id: "2", name: "芙蓉" },
  { id: "4", name: "香樟" },
  { id: "3", name: "银杏" },
  { id: "5", name: "松林" },
];

/** 科技园 (E018) 前端硬编码区域 (旧版芙蓉专用页) */
const KJY_AREAS = [{ id: "1", name: "芙蓉" }];

export interface ElecProject {
  id: string;
  /** 项目名称 (上游 projectName) */
  name: string;
  factoryCode: ElecFactory;
  /** 是否有楼层级 (由 factoryCode 派生, 仅 E034 为 true) */
  hasFloors: boolean;
  /** 其余上游字段原样透传 (null/缺失字段省略), 如 imgUrl/status/payLimit 等 */
  [key: string]: unknown;
}

/** 列出全部电费项目 (proModelUrl === "electric") */
export async function listElectricityProjects(
  jar: CookieJar,
  session: PaymSession
): Promise<ElecProject[]> {
  const res = await fetchWithJar(
    jar,
    `${PAYM_BASE}/api/pay/project/getAllProjectList`,
    { headers: { "User-Agent": USER_AGENT, "X-Token": session.token } }
  );
  const body = (await res.json()) as PaymResp<
    (Record<string, unknown> & {
      id: string;
      projectName: string;
      proModelUrl?: string | null;
      factoryCode?: string | null;
    })[]
  >;
  if (body.messageCode !== "0" || !Array.isArray(body.data)) {
    throw new Error(`获取项目列表失败: [${body.messageCode}] ${body.message}`);
  }
  // 透传全部上游字段: 省略 null/缺失项, projectName 重命名为 name
  return body.data
    .filter((p) => p.proModelUrl === "electric")
    .map((p) => {
      const { projectName, ...rest } = p;
      const factoryCode = (p.factoryCode ?? "") as ElecFactory;
      return {
        ...dropNulls(rest),
        id: p.id,
        name: projectName,
        factoryCode,
        hasFloors: factoryCode === "E034",
      };
    });
}

export interface ElecOption {
  id: string;
  name: string;
}

export interface ElecBalance {
  /** 剩余电量 (oddl, 单位: 度, 原始字符串; 可能为负) */
  remain: string;
  /** 累计用电量 (suml, 可能为 null; E034 不返回) */
  total?: string;
  canbuy?: string;
}

interface ElecRow {
  schoolid?: string | null;
  schoolname?: string | null;
  buildid?: string | null;
  buildname?: string | null;
  floorid?: string | null;
  floorname?: string | null;
  roomid?: string | null;
  roomname?: string | null;
  oddl?: string | null;
  suml?: string | null;
  canbuy?: string | null;
}

interface ElecRoomInfoRow {
  id?: string | null;
  name?: string | null;
}

interface PaymResp<T> {
  messageCode?: string;
  message?: string;
  data?: T;
}

/** 电费控制器专用 POST: 识别 "系统维护" 误导性响应 */
async function elecPost<T>(
  jar: CookieJar,
  session: PaymSession,
  path: string,
  data: Record<string, unknown>
): Promise<T> {
  const res = await fetchWithJar(jar, `${PAYM_BASE}${ELE_BASE}${path}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "X-Token": session.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const body = (await res.json()) as PaymResp<T>;
  if (body.messageCode !== "0") {
    throw new Error(
      `电费接口${path} 返回错误: [${body.messageCode}] ${body.message}`
    );
  }
  if (body.data === undefined || body.data === null) {
    throw new Error(`电费接口${path} 返回数据为空`);
  }
  return body.data;
}

export type ElecFactory = "E016" | "E017" | "E018" | "E034";

export interface ElecProjectMeta {
  projectId: string;
  factoryCode: ElecFactory;
  /** 是否需要楼层级 (仅 E034 新开普) */
  hasFloors: boolean;
}

const factoryCache = new Map<string, ElecProjectMeta>();

async function resolveFactory(
  jar: CookieJar,
  session: PaymSession,
  projectId: string
): Promise<ElecProjectMeta> {
  const cached = factoryCache.get(projectId);
  if (cached) return cached;
  const res = await fetchWithJar(
    jar,
    `${PAYM_BASE}/api/pay/project/getProjectVoById/${projectId}`,
    { headers: { "User-Agent": USER_AGENT, "X-Token": session.token } }
  );
  const body = (await res.json()) as PaymResp<{ factoryCode?: string | null }>;
  const code = body.data?.factoryCode;
  if (code !== "E016" && code !== "E017" && code !== "E018" && code !== "E034") {
    throw new Error(
      `项目 ${projectId} 不是已支持的电费项目 (factoryCode=${code ?? "null"})`
    );
  }
  const meta: ElecProjectMeta = {
    projectId,
    factoryCode: code,
    hasFloors: code === "E034",
  };
  factoryCache.set(projectId, meta);
  return meta;
}

/** 区域列表: E016/E018 硬编码, E017 querySchoolList, E034 getRoomInfo(op1) */
export async function getElectricityAreas(
  jar: CookieJar,
  session: PaymSession,
  projectId: string
): Promise<ElecOption[]> {
  const meta = await resolveFactory(jar, session, projectId);
  if (meta.factoryCode === "E016") return ALD_AREAS;
  if (meta.factoryCode === "E018") return KJY_AREAS;
  if (meta.factoryCode === "E017") {
    const rows = await elecPost<ElecRow[]>(jar, session, "/querySchoolList", {
      projectId,
    });
    return rows
      .filter((r) => r.schoolid && r.schoolname)
      .map((r) => ({ id: r.schoolid!.trim(), name: r.schoolname!.trim() }));
  }
  const rows = await elecPost<ElecRoomInfoRow[]>(jar, session, "/getRoomInfo", {
    projectId,
    op_type: "1",
  });
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({ id: r.id!.trim(), name: r.name!.trim() }));
}

/** 楼栋列表 */
export async function getElectricityBuildings(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  areaId: string
): Promise<ElecOption[]> {
  const meta = await resolveFactory(jar, session, projectId);
  if (meta.factoryCode === "E034") {
    const rows = await elecPost<ElecRoomInfoRow[]>(
      jar,
      session,
      "/getRoomInfo",
      { projectId, op_type: "2", areaid: areaId }
    );
    return rows
      .filter((r) => r.id && r.name)
      .map((r) => ({ id: r.id!.trim(), name: r.name!.trim() }));
  }
  const rows = await elecPost<ElecRow[]>(jar, session, "/queryBuildingList", {
    projectId,
    areaid: areaId,
  });
  return rows
    .filter((r) => r.buildid && r.buildname)
    .map((r) => ({ id: r.buildid!.trim(), name: r.buildname!.trim() }));
}

/** 楼层列表 (仅 E034 新开普; 其余项目无楼层级, 返回空数组) */
export async function getElectricityFloors(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  areaId: string,
  buildId: string
): Promise<ElecOption[]> {
  const meta = await resolveFactory(jar, session, projectId);
  if (meta.factoryCode !== "E034") return [];
  const rows = await elecPost<ElecRoomInfoRow[]>(jar, session, "/getRoomInfo", {
    projectId,
    op_type: "3",
    areaid: areaId,
    buildid: buildId,
  });
  return rows
    .filter((r) => r.id && r.name)
    .map((r) => ({ id: r.id!.trim(), name: r.name!.trim() }));
}

/** 房间列表; E034 需提供 levelId */
export async function getElectricityRooms(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  areaId: string,
  buildId: string,
  levelId?: string
): Promise<ElecOption[]> {
  const meta = await resolveFactory(jar, session, projectId);
  if (meta.factoryCode === "E034") {
    if (!levelId) throw new Error("新开普电费 (E034) 查询房间必须提供 levelId");
    const rows = await elecPost<ElecRoomInfoRow[]>(
      jar,
      session,
      "/getRoomInfo",
      { projectId, op_type: "4", areaid: areaId, buildid: buildId, levelid: levelId }
    );
    return rows
      .filter((r) => r.id && r.name)
      .map((r) => ({ id: r.id!.trim(), name: r.name!.trim() }));
  }
  const rows = await elecPost<ElecRow[]>(jar, session, "/queryRoomList", {
    projectId,
    areaid: areaId,
    buildid: buildId,
  });
  return rows
    .filter((r) => r.roomid && r.roomname)
    .map((r) => ({ id: r.roomid!.trim(), name: r.roomname!.trim() }));
}

/** 剩余电量/电费查询; E034 的 roomId 即 rooms 接口返回的复合 id (roomverify) */
export async function getElectricityBalance(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  areaId: string,
  buildId: string,
  roomId: string,
  levelId?: string
): Promise<ElecBalance> {
  const meta = await resolveFactory(jar, session, projectId);
  const data =
    meta.factoryCode === "E034"
      ? await elecPost<ElecRow[]>(jar, session, "/querySydl", {
          projectId,
          areaid: areaId,
          buildid: buildId,
          levelid: levelId,
          roomverify: roomId,
        })
      : await elecPost<ElecRow[]>(jar, session, "/querySydl", {
          projectId,
          areaid: areaId,
          buildid: buildId,
          roomid: roomId,
        });
  const first = data[0];
  if (!first || first.oddl === null || first.oddl === undefined) {
    throw new Error("电费接口未返回剩余电量 (oddl)");
  }
  return {
    remain: first.oddl,
    total: first.suml ?? undefined,
    canbuy: first.canbuy ?? undefined,
  };
}

export interface ElectricityOrderParams {
  areaId: string;
  areaName?: string;
  buildId: string;
  buildName?: string;
  /** 仅 E034 */
  levelId?: string;
  levelName?: string;
  roomId: string;
  roomName?: string;
  /** 金额 (元), 会被转换为分 (opfare) */
  amount: number;
  /** 购买人学号 (buyerid) */
  buyerId: string;
  /**
   * 创建前自动关闭本项目下的未完成订单 (默认 false)。
   * 为 false 且存在未完成订单时, 上游返回
   * "[16503] 此项目下存在未完成的订单..." 错误。
   */
  closePrevious?: boolean;
}

export interface ElectricityOrderResult {
  /** 订单 id, 后续支付环节使用 */
  orderId?: string;
  /** 订单号 (orderNo), 支付发起时使用 */
  orderNo?: string;
  /** 订单状态, 如 PENDING_PAYMENT */
  status?: string;
  /** 计划关闭时间, 超时未支付自动关闭 */
  closeTime?: string;
  /** closePrevious=true 时被自动关闭的订单 id 列表 */
  closedOrderIds?: string[];
  raw: unknown;
}

/**
 * 创建电费充值订单 (对应前端 "下一步": createOrder 后跳转支付页)。
 * 注意: 会真实创建待支付订单; 支付本身需在官方渠道完成。
 */
export async function createElectricityOrder(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  params: ElectricityOrderParams
): Promise<ElectricityOrderResult> {
  const meta = await resolveFactory(jar, session, projectId);
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error("amount 必须为正数 (元)");
  }
  const form: Record<string, unknown> = {
    buyerid: params.buyerId,
    acctype: 101,
    areaid: params.areaId,
    areaname: params.areaName ?? "",
    buildid: params.buildId,
    buildname: params.buildName ?? "",
    levelid: params.levelId ?? "",
    levelname: params.levelName ?? "",
    roomid: params.roomId,
    roomname: params.roomName ?? "",
    chooseRadio: "",
    custom: "",
    opfare: Math.round(params.amount * 100),
  };
  if (meta.factoryCode === "E034") {
    form.roomverify = params.roomId;
  }

  const submit = () =>
    elecPost<{
      id?: string;
      orderNo?: string;
      status?: string;
      schdualCloseTime?: string;
    }>(jar, session, "/createOrder", {
      buyElectric: form,
      projectId,
    });

  let data;
  const closedOrderIds: string[] = [];
  try {
    data = await submit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 16503: 此项目下存在未完成的订单
    if (!params.closePrevious || !msg.includes("存在未完成的订单")) {
      throw err;
    }
    const pending = await listPendingOrders(jar, session, projectId);
    for (const o of pending) {
      await closeOrder(jar, session, o.orderId);
      closedOrderIds.push(o.orderId);
    }
    data = await submit(); // 关闭后重试一次; 仍失败则抛出原始错误
  }
  return {
    orderId: data?.id,
    orderNo: data?.orderNo,
    status: data?.status,
    closeTime: data?.schdualCloseTime,
    closedOrderIds: closedOrderIds.length ? closedOrderIds : undefined,
    raw: data,
  };
}

/** 收银台页面链接 (官方前端, 需用户自行完成支付) */
export function buildCashierUrl(projectId: string, orderId: string): string {
  return `https://paym.cdut.edu.cn/mobile/#/person?projectId=${projectId}&orderId=${orderId}`;
}

// ---------- 充值通道路由 (智能选择) ----------

export type ElecUseType = "照明" | "空调";

export const ELEC_PARKS = [
  "榕树园",
  "珙桐园",
  "松林园",
  "银杏园",
  "芙蓉园",
  "香樟园",
] as const;
export type ElecPark = (typeof ELEC_PARKS)[number];

export interface ElecRouteResult {
  park: ElecPark;
  type: ElecUseType;
  buildingNo?: number;
  factoryCode: ElecFactory;
  projectId?: string;
  projectName?: string;
}

/**
 * 宿舍用电类型 → 充值通道路由 (校方规则):
 * 1. 芙蓉园、香樟园照明及空调, 松林园、榕树园和银杏 1/3 栋照明 → 爱立德电费 (E016)
 * 2. 珙桐园照明 → 珙桐园电费 (E017)
 * 3. 银杏 2/4 栋照明及空调, 榕树园、珙桐园、松林园、银杏 1/3 栋空调 → 新开普电费 (E034)
 */
export function routeElectricityChannel(
  park: ElecPark,
  type: ElecUseType,
  buildingNo?: number
): ElecRouteResult {
  let factoryCode: ElecFactory;
  if (park === "芙蓉园" || park === "香樟园") {
    factoryCode = "E016";
  } else if (park === "珙桐园") {
    factoryCode = type === "照明" ? "E017" : "E034";
  } else if (park === "银杏园") {
    if (buildingNo === undefined) {
      throw new Error("银杏园需提供 buildingNo (栋号)");
    }
    if (buildingNo === 1 || buildingNo === 3) {
      factoryCode = type === "照明" ? "E016" : "E034";
    } else if (buildingNo === 2 || buildingNo === 4) {
      factoryCode = "E034";
    } else {
      throw new Error(`银杏园未知栋号: ${buildingNo}`);
    }
  } else {
    // 榕树园 / 松林园: 照明 → 爱立德, 空调 → 新开普
    factoryCode = type === "照明" ? "E016" : "E034";
  }
  return { park, type, buildingNo, factoryCode };
}

// ---------- 一站式房间解析 (园区+楼栋+房间号 → balance/order 全链路 id) ----------

export interface ElecRoomResolveParams {
  park: ElecPark;
  type: ElecUseType;
  /** 楼栋 (栋号): 数字或含数字的字符串, 如 1 / "1栋" / "01" */
  building: string | number;
  /** 房间号, 如 "512"; E034 依此自动推断楼层 (去掉末两位) */
  roomNo: string;
}

/** 解析结果: 字段与 balance / order 接口入参一一对应, 可直接回传 */
export interface ElecRoomResolved extends ElecRouteResult {
  projectId: string;
  projectName: string;
  hasFloors: boolean;
  areaId: string;
  areaName: string;
  buildId: string;
  buildName: string;
  /** 仅 E034, 由 roomNo 自动推断 */
  levelId?: string;
  levelName?: string;
  roomId: string;
  roomName: string;
}

/** 解析栋号: 接受 1 / "1" / "1栋" / "01" 等写法 */
function parseBuildingNo(input: string | number): number {
  const m = String(input).match(/\d+/);
  if (!m) throw new Error(`无法解析栋号: ${String(input)}`);
  return parseInt(m[0], 10);
}

/** 从房间号推断楼层数: 去掉末两位即为楼层 (512→5, 1205→12) */
export function inferFloorFromRoomNo(roomNo: string): number {
  const digits = roomNo.trim();
  if (!/^\d{3,}$/.test(digits)) {
    throw new Error(
      `无法从房间号 "${roomNo}" 推断楼层 (须为不少于 3 位数字, 末两位为房号)`
    );
  }
  return parseInt(digits.slice(0, -2), 10);
}

/** 名称中的数字段是否包含目标编号 ("银杏园01" 含 1, "10层" 含 10) */
function nameHasNumber(name: string, n: number): boolean {
  return name
    .split(/\D+/)
    .some((d) => d !== "" && parseInt(d, 10) === n);
}

/**
 * 在楼栋列表中匹配目标楼栋 (可能多个, 如 E016 银杏1栋分 银杏1-1/1-2 两单元);
 * strict 时要求名称含园区核心名 (跨园区搜索防误配, 如 E034 主分区下含全部园区楼栋),
 * 非 strict 时若能按园区名收敛则收敛 (如在银杏区域中排除 榕树1)。
 */
function matchBuildings(
  buildings: ElecOption[],
  buildingNo: number,
  type: ElecUseType,
  parkCore: string,
  strict: boolean
): ElecOption[] {
  const byPark = buildings.filter((b) => b.name.includes(parkCore));
  let candidates = strict ? byPark : byPark.length ? byPark : buildings;
  // E016 同栋分 照明/空调 两个通道楼栋 (如 "芙蓉1照明"/"芙蓉1空调")
  const typed = candidates.filter((b) => b.name.includes(type));
  if (typed.length) candidates = typed;
  return candidates.filter((b) => nameHasNumber(b.name, buildingNo));
}

/**
 * 在房间列表中按房间号匹配, 策略依次: 精确 → 尾段 ("1-101"/"1-101空调" 尾段 101,
 * "3-A101空调" 尾段 A101) → 数字压平 ("1-01"→101, "3单元101"≈"3-101")
 * → 栋号前缀 (E017 "2101"=2号楼+101, 香樟 "1A101"=1栋+A101)。唯一命中才返回。
 */
function matchRoom(
  rooms: ElecOption[],
  roomNo: string,
  buildingNo?: number
): ElecOption | undefined {
  const rn = roomNo.trim();
  const upper = (s: string) => s.trim().toUpperCase();
  const exact = rooms.find((r) => upper(r.name) === upper(rn));
  if (exact) return exact;
  const digits = (s: string) => s.replace(/\D/g, "");
  const rnDigits = digits(rn) ? String(parseInt(digits(rn), 10)) : null;
  const byTail = rooms.filter((r) => {
    const segs = upper(r.name).split(/[^0-9A-Z]+/).filter(Boolean);
    const tail = segs[segs.length - 1] ?? "";
    return (
      tail === upper(rn) ||
      (rnDigits !== null && /^\d+$/.test(tail) && String(parseInt(tail, 10)) === rnDigits)
    );
  });
  if (byTail.length === 1) return byTail[0];
  const alnum = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (buildingNo !== undefined) {
    // 栋号前缀 (保留字母): 香樟 "1A101"=1栋+A101, E017 "2101"=2号楼+101
    const rnAlnum = alnum(rn);
    const prefixedAlnum = rooms.filter(
      (r) => alnum(r.name) === `${buildingNo}${rnAlnum}`.toUpperCase()
    );
    if (prefixedAlnum.length === 1) return prefixedAlnum[0];
  }
  if (rnDigits !== null) {
    const squashed = rooms.filter(
      (r) =>
        /^\d+$/.test(digits(r.name)) &&
        String(parseInt(digits(r.name), 10)) === rnDigits
    );
    if (squashed.length === 1) return squashed[0];
    if (buildingNo !== undefined) {
      const prefixed = rooms.filter(
        (r) =>
          /^\d+$/.test(digits(r.name)) &&
          String(parseInt(digits(r.name), 10)) === `${buildingNo}${rnDigits}`
      );
      if (prefixed.length === 1) return prefixed[0];
    }
  }
  return undefined;
}

/**
 * 一站式解析: 由 园区+用电类型+楼栋+房间号 完成 通道路由→项目→区域→楼栋
 * →楼层(仅 E034, 自动推断)→房间 全链路, 返回可直接用于 balance/order 的字段。
 */
export async function resolveElectricityRoom(
  jar: CookieJar,
  session: PaymSession,
  params: ElecRoomResolveParams
): Promise<ElecRoomResolved> {
  const buildingNo = parseBuildingNo(params.building);
  const routed = routeElectricityChannel(params.park, params.type, buildingNo);
  const projects = await listElectricityProjects(jar, session);
  const project = projects.find((p) => p.factoryCode === routed.factoryCode);
  if (!project) {
    throw new Error(`项目列表中未找到 ${routed.factoryCode} 电费项目`);
  }
  const parkCore = params.park.replace(/园$/, "");
  const areas = await getElectricityAreas(jar, session, project.id);
  // 优先名称含园区名的区域 (E016 芙蓉/香樟/银杏/松林, E017 珙桐园);
  // 其余区域按楼栋名严格匹配园区 (E034 主分区, 或 E016 中无同名区域的榕树园)
  let area: ElecOption | undefined;
  let candidates: ElecOption[] = [];
  for (const a of areas.filter((x) => x.name.includes(parkCore))) {
    const m = matchBuildings(
      await getElectricityBuildings(jar, session, project.id, a.id),
      buildingNo,
      params.type,
      parkCore,
      false
    );
    if (m.length) {
      area = a;
      candidates = m;
      break;
    }
  }
  if (!area) {
    for (const a of areas.filter((x) => !x.name.includes(parkCore))) {
      const m = matchBuildings(
        await getElectricityBuildings(jar, session, project.id, a.id),
        buildingNo,
        params.type,
        parkCore,
        true
      );
      if (m.length) {
        area = a;
        candidates = m;
        break;
      }
    }
  }
  if (!area || candidates.length === 0) {
    throw new Error(
      `未找到 ${params.park}${buildingNo}栋 (${params.type}) 对应的楼栋`
    );
  }

  // E034: 房间号去掉末两位即为楼层数, 据此在楼层列表中解析 levelId
  const floorNo = project.hasFloors
    ? inferFloorFromRoomNo(params.roomNo)
    : undefined;
  /** 在候选楼栋中解析楼层+房间; pedantic 时抛出具体原因, 否则静默返回 undefined (用于消歧) */
  const tryBuilding = async (b: ElecOption, pedantic: boolean) => {
    let level: ElecOption | undefined;
    if (project.hasFloors) {
      const floors = await getElectricityFloors(
        jar,
        session,
        project.id,
        area!.id,
        b.id
      );
      const byDigits = floors.filter((f) => nameHasNumber(f.name, floorNo!));
      level =
        floors.find((f) => f.name === `${floorNo}层`) ??
        (byDigits.length === 1 ? byDigits[0] : undefined);
      if (!level) {
        if (pedantic) {
          throw new Error(
            `${b.name} 中未找到 ${floorNo} 层 (可用楼层: ${
              floors.map((f) => f.name).join("/") || "无"
            })`
          );
        }
        return undefined;
      }
    }
    const rooms = await getElectricityRooms(
      jar,
      session,
      project.id,
      area!.id,
      b.id,
      level?.id
    );
    const room = matchRoom(rooms, params.roomNo, buildingNo);
    if (!room) {
      if (pedantic) {
        throw new Error(
          `${b.name} 中未找到房间 ${params.roomNo} (该楼栋共 ${rooms.length} 间; ` +
            `若房间带单元/分区前缀请完整提供, 如 "3单元101" 或 "1A101")`
        );
      }
      return undefined;
    }
    return { building: b, level, room };
  };

  // 候选楼栋不唯一时 (如 E016 银杏1栋分 银杏1-1/1-2 两单元) 按房间号消歧
  let hit: { building: ElecOption; level?: ElecOption; room: ElecOption } | undefined;
  if (candidates.length === 1) {
    hit = await tryBuilding(candidates[0], true);
  } else {
    const hits = [];
    for (const b of candidates) {
      const h = await tryBuilding(b, false);
      if (h) hits.push(h);
    }
    if (hits.length === 0) {
      throw new Error(
        `未找到 ${params.park}${buildingNo}栋 (${params.type}) 的房间 ${params.roomNo} ` +
          `(候选楼栋: ${candidates.map((b) => b.name).join("/")})`
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `房间号 ${params.roomNo} 匹配到多栋楼 (${hits
          .map((h) => h.building.name)
          .join("/")}), 请改用 buildings→rooms 逐级查询指定楼栋`
      );
    }
    hit = hits[0];
  }
  const { building, level, room } = hit!;
  return {
    ...routed,
    projectId: project.id,
    projectName: project.name,
    hasFloors: project.hasFloors,
    areaId: area.id,
    areaName: area.name,
    buildId: building.id,
    buildName: building.name,
    levelId: level?.id,
    levelName: level?.name,
    roomId: room.id,
    roomName: room.name,
  };
}
