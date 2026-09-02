import { Hono, type Context } from "hono";
import {
  authenticatePaym,
  closeOrder,
  createPayTrade,
  getAllProjects,
  getOrderById,
  getTradeChannels,
  getUserInfo,
  isOrderUnpaid,
  listOrders,
  type PaymSession,
} from "../services/paym.js";
import {
  buildCashierUrl,
  createElectricityOrder,
  getElectricityAreas,
  getElectricityBalance,
  getElectricityBuildings,
  getElectricityFloors,
  getElectricityRooms,
  listElectricityProjects,
  resolveElectricityRoom,
  routeElectricityChannel,
  ELEC_PARKS,
  type ElecPark,
  type ElecUseType,
} from "../services/elec.js";
import {
  jarFromSession,
  readSession,
  writeSession,
  SESSION_EXPIRED_BODY,
  type SessionData,
} from "../lib/session.js";
import type { CookieJar } from "../lib/http.js";
import { SessionExpiredError } from "../lib/errors.js";

const paym = new Hono();

/**
 * 解封会话并确保 paym token 可用: 优先复用 blob 中缓存的 token,
 * 调用失败则重跑 CAS 票据链刷新一次。
 */
async function withPaym<T>(
  c: Context,
  fn: (jar: CookieJar, session: PaymSession, data: SessionData) => Promise<T>
): Promise<T | Response> {
  const session = readSession(c);
  if (!session) return c.json(SESSION_EXPIRED_BODY, 401);
  const jar = jarFromSession(session);

  if (session.paymToken) {
    try {
      const result = await fn(jar, { token: session.paymToken }, session);
      writeSession(c, jar, session);
      return result;
    } catch {
      // token 失效, 走下方重新认证
    }
  }

  try {
    const paymSession = await authenticatePaym(jar);
    const result = await fn(jar, paymSession, session);
    writeSession(c, jar, session, { paymToken: paymSession.token });
    return result;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      return c.json(SESSION_EXPIRED_BODY, 401);
    }
    return c.json(
      {
        error: "paym_auth_failed",
        message: `统一支付平台认证或数据获取失败: ${err instanceof Error ? err.message : String(err)}`,
      },
      502
    );
  }
}

paym.get("/userinfo", async (c) => {
  const result = await withPaym(c, getUserInfo);
  if (result instanceof Response) return result;
  return c.json(result);
});

paym.get("/projects", async (c) => {
  const result = await withPaym(c, getAllProjects);
  if (result instanceof Response) return result;
  return c.json({ count: result.length, projects: result });
});

// ---------- 电费 (payEleCostController) ----------

paym.get("/electricity/projects", async (c) => {
  const result = await withPaym(c, listElectricityProjects);
  if (result instanceof Response) return result;
  return c.json({ count: result.length, projects: result });
});

async function jsonBody<T>(c: Context): Promise<T | null> {
  return c.req.json<T>().catch(() => null);
}

paym.post("/electricity/areas", async (c) => {
  const body = await jsonBody<{ projectId: string }>(c);
  if (!body?.projectId) return c.json({ error: "projectId 必填" }, 400);
  const result = await withPaym(c, (jar, s) =>
    getElectricityAreas(jar, s, body.projectId)
  );
  if (result instanceof Response) return result;
  return c.json({ count: result.length, areas: result });
});

paym.post("/electricity/buildings", async (c) => {
  const body = await jsonBody<{ projectId: string; areaId: string }>(c);
  if (!body?.projectId || !body?.areaId) {
    return c.json({ error: "projectId 和 areaId 必填" }, 400);
  }
  const result = await withPaym(c, (jar, s) =>
    getElectricityBuildings(jar, s, body.projectId, body.areaId)
  );
  if (result instanceof Response) return result;
  return c.json({ count: result.length, buildings: result });
});

paym.post("/electricity/floors", async (c) => {
  const body = await jsonBody<{
    projectId: string;
    areaId: string;
    buildId: string;
  }>(c);
  if (!body?.projectId || !body?.areaId || !body?.buildId) {
    return c.json({ error: "projectId, areaId 和 buildId 必填" }, 400);
  }
  const result = await withPaym(c, (jar, s) =>
    getElectricityFloors(jar, s, body.projectId, body.areaId, body.buildId)
  );
  if (result instanceof Response) return result;
  return c.json({ count: result.length, floors: result });
});

paym.post("/electricity/rooms", async (c) => {
  const body = await jsonBody<{
    projectId: string;
    areaId: string;
    buildId: string;
    levelId?: string;
  }>(c);
  if (!body?.projectId || !body?.areaId || !body?.buildId) {
    return c.json({ error: "projectId, areaId 和 buildId 必填" }, 400);
  }
  const result = await withPaym(c, (jar, s) =>
    getElectricityRooms(
      jar,
      s,
      body.projectId,
      body.areaId,
      body.buildId,
      body.levelId
    )
  );
  if (result instanceof Response) return result;
  return c.json({ count: result.length, rooms: result });
});

paym.post("/electricity/balance", async (c) => {
  const body = await jsonBody<{
    projectId: string;
    areaId: string;
    buildId: string;
    roomId: string;
    levelId?: string;
  }>(c);
  if (!body?.projectId || !body?.areaId || !body?.buildId || !body?.roomId) {
    return c.json(
      { error: "projectId, areaId, buildId 和 roomId 必填 (E034 另需 levelId)" },
      400
    );
  }
  const result = await withPaym(c, (jar, s) =>
    getElectricityBalance(
      jar,
      s,
      body.projectId,
      body.areaId,
      body.buildId,
      body.roomId,
      body.levelId
    )
  );
  if (result instanceof Response) return result;
  return c.json(result);
});

/**
 * 充值通道路由 (智能选择): 按校方规则根据 园区/用电类型(/栋号)
 * 推荐充值通道, 返回 projectId 供后续 areas/buildings/rooms/balance/order 使用。
 *
 * 一站式模式: 额外提供 building (栋号) 与 roomNo (房间号) 时, 自动完成
 * 区域→楼栋→楼层(仅 E034, 由房间号去掉末两位推断 levelId)→房间 全链路解析,
 * 返回可直接用于 balance / order 的全套字段。
 */
paym.post("/electricity/route", async (c) => {
  const body = await jsonBody<{
    park: ElecPark;
    type: ElecUseType;
    buildingNo?: number;
    /** 栋号 (亦可写作 area): 1 / "1栋" / "01" 均可 */
    building?: string | number;
    area?: string | number;
    /** 房间号, 如 "512"; E034 依此自动推断 levelId */
    roomNo?: string;
  }>(c);
  if (!body?.park || !body?.type) {
    return c.json(
      {
        error: `park (${ELEC_PARKS.join("/")}) 和 type (照明/空调) 必填; 银杏园另需 buildingNo`,
      },
      400
    );
  }
  if (!ELEC_PARKS.includes(body.park)) {
    return c.json({ error: `park 须为: ${ELEC_PARKS.join("/")}` }, 400);
  }
  if (body.type !== "照明" && body.type !== "空调") {
    return c.json({ error: "type 须为 照明 或 空调" }, 400);
  }

  // 一站式模式: 提供 building (或 area) + roomNo 时解析到房间级
  const buildingInput = body.building ?? body.area;
  if (buildingInput !== undefined || body.roomNo !== undefined) {
    if (buildingInput === undefined || !body.roomNo) {
      return c.json(
        { error: "一站式解析需同时提供 building (栋号) 和 roomNo (房间号)" },
        400
      );
    }
    const result = await withPaym(c, (jar, s) =>
      resolveElectricityRoom(jar, s, {
        park: body.park,
        type: body.type,
        building: buildingInput,
        roomNo: String(body.roomNo),
      })
    );
    if (result instanceof Response) return result;
    return c.json(result);
  }

  let routed;
  try {
    routed = routeElectricityChannel(body.park, body.type, body.buildingNo);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      400
    );
  }
  const result = await withPaym(c, (jar, s) => listElectricityProjects(jar, s));
  if (result instanceof Response) return result;
  const project = result.find((p) => p.factoryCode === routed.factoryCode);
  return c.json({
    ...routed,
    projectId: project?.id,
    projectName: project?.name,
  });
});

/**
 * 创建电费充值订单 (会真实创建待支付订单, 超时未支付自动关闭)。
 * amount 单位为元; buyerId 缺省取会话中的 studentId。
 * closePrevious=true 时先自动关闭本项目下的未完成订单再创建;
 * 默认 false, 存在未完成订单时返回 16503 错误。
 * 返回 cashierUrl (官方收银台链接); 传 withPayLink=true 时
 * 额外调用 toPayOrderTrade 生成支付链接 (payType 缺省取首个 H5 渠道)。
 */
paym.post("/electricity/order", async (c) => {
  const body = await jsonBody<{
    projectId: string;
    areaId: string;
    areaName?: string;
    buildId: string;
    buildName?: string;
    levelId?: string;
    levelName?: string;
    roomId: string;
    roomName?: string;
    amount: number;
    buyerId?: string;
    closePrevious?: boolean;
    withPayLink?: boolean;
    payType?: string;
    tradeType?: string;
  }>(c);
  if (
    !body?.projectId ||
    !body?.areaId ||
    !body?.buildId ||
    !body?.roomId ||
    typeof body?.amount !== "number"
  ) {
    return c.json(
      { error: "projectId, areaId, buildId, roomId 和 amount (元) 必填" },
      400
    );
  }
  const result = await withPaym(c, async (jar, s, session) => {
    const buyerId = body.buyerId ?? session.studentId;
    if (!buyerId) throw new Error("buyerId 缺失且会话中无 studentId");
    const order = await createElectricityOrder(jar, s, body.projectId, {
      ...body,
      buyerId,
    });
    if (!order.orderId) {
      throw new Error(`创建订单失败: ${JSON.stringify(order.raw)}`);
    }
    const response: Record<string, unknown> = {
      ...order,
      cashierUrl: buildCashierUrl(body.projectId, order.orderId),
    };
    if (body.withPayLink) {
      if (!order.orderNo) {
        throw new Error("订单缺少 orderNo, 无法生成支付链接");
      }
      const payType =
        body.payType ??
        (await getTradeChannels(jar, s, body.projectId))[0]?.code;
      if (!payType) throw new Error("该项目无可用支付渠道");
      response.payLink = await createPayTrade(jar, s, {
        orderNo: order.orderNo,
        payType,
        tradeType: body.tradeType,
      });
    }
    return response;
  });
  if (result instanceof Response) return result;
  return c.json(result);
});

// ---------- 订单 (通用) ----------

/** 分页订单列表: ?pageCurrent=&pageSize=&displayStatus= (101=待支付) */
paym.get("/orders", async (c) => {
  const pageCurrent = parseInt(c.req.query("pageCurrent") ?? "1", 10);
  const pageSize = parseInt(c.req.query("pageSize") ?? "10", 10);
  const displayStatus = c.req.query("displayStatus");
  if (
    !Number.isFinite(pageCurrent) ||
    !Number.isFinite(pageSize) ||
    pageCurrent < 1 ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return c.json({ error: "pageCurrent/pageSize 须为正整数, pageSize ≤ 100" }, 400);
  }
  const result = await withPaym(c, (jar, s) =>
    listOrders(jar, s, { pageCurrent, pageSize, displayStatus })
  );
  if (result instanceof Response) return result;
  return c.json(result);
});

/** 订单详情; 未支付订单附带可用操作 actions: ["pay", "close"] */
paym.get("/orders/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  const result = await withPaym(c, (jar, s) => getOrderById(jar, s, orderId));
  if (result instanceof Response) return result;
  return c.json({
    ...result,
    unpaid: isOrderUnpaid(result),
    actions: isOrderUnpaid(result) ? ["pay", "close"] : [],
  });
});

/**
 * 去支付 (仅未支付订单): 生成支付链接, 用户确认前不扣款。
 * body: { projectId?, payType?, tradeType? }; payType 缺省时
 * 用 projectId 查询首个 H5 渠道 (订单详情中 projectId 可能为空, 需调用方提供)。
 */
paym.post("/orders/:orderId/pay", async (c) => {
  const orderId = c.req.param("orderId");
  const body = await jsonBody<{
    projectId?: string;
    payType?: string;
    tradeType?: string;
  }>(c);
  const result = await withPaym(c, async (jar, s) => {
    const order = await getOrderById(jar, s, orderId);
    if (!isOrderUnpaid(order)) {
      throw new Error(`订单当前状态为 ${order.status ?? "未知"}, 不可支付`);
    }
    let payType = body?.payType;
    if (!payType) {
      const projectId = body?.projectId ?? order.projectId;
      if (!projectId) {
        throw new Error("缺省 payType 时需提供 projectId 以查询支付渠道");
      }
      payType = (await getTradeChannels(jar, s, projectId))[0]?.code;
      if (!payType) throw new Error("该项目无可用支付渠道");
    }
    return createPayTrade(jar, s, {
      orderNo: order.orderNo,
      payType,
      tradeType: body?.tradeType,
    });
  });
  if (result instanceof Response) return result;
  return c.json(result);
});

/** 关闭 (取消) 订单, 仅未支付订单可关闭 */
paym.post("/orders/:orderId/close", async (c) => {
  const orderId = c.req.param("orderId");
  const result = await withPaym(c, async (jar, s) => {
    const order = await getOrderById(jar, s, orderId);
    if (!isOrderUnpaid(order)) {
      throw new Error(`订单当前状态为 ${order.status ?? "未知"}, 不可关闭`);
    }
    await closeOrder(jar, s, orderId);
    return { closed: true, orderId };
  });
  if (result instanceof Response) return result;
  return c.json(result);
});

export default paym;
