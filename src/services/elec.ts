import { USER_AGENT } from "./cas.js";
import { CookieJar, fetchWithJar } from "../lib/http.js";
import {
  closeOrder,
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
  name: string;
  factoryCode: ElecFactory;
  hasFloors: boolean;
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
    { id: string; projectName: string; proModelUrl?: string | null; factoryCode?: string | null }[]
  >;
  if (body.messageCode !== "0" || !Array.isArray(body.data)) {
    throw new Error(`获取项目列表失败: [${body.messageCode}] ${body.message}`);
  }
  return body.data
    .filter((p) => p.proModelUrl === "electric")
    .map((p) => ({
      id: p.id,
      name: p.projectName,
      factoryCode: (p.factoryCode ?? "") as ElecFactory,
      hasFloors: p.factoryCode === "E034",
    }));
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
