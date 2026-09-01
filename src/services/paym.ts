import { authenticateService, USER_AGENT } from "./cas.js";
import { SessionExpiredError } from "../lib/errors.js";
import {
  CookieJar,
  fetchWithJar,
  fetchWithUpgrade,
} from "../lib/http.js";

const PAYM_BASE = "https://paym.cdut.edu.cn";
const CAS_SERVICE_URL = "http://paym.cdut.edu.cn/casLogin/";

export interface UserInfo {
  id: string;
  studentId: string;
  name: string;
  sex: string;
}

export interface Project {
  id: string;
  name: string;
}

export interface PaymSession {
  token: string;
}

export async function authenticatePaym(
  jar: CookieJar
): Promise<PaymSession> {
  const callbackLink = await authenticateService(jar, CAS_SERVICE_URL);
  if (!callbackLink || !callbackLink.includes("ticket")) {
    throw new SessionExpiredError("CAS 未返回 paym 票据，会话已失效或无权限");
  }

  const ticketResult = await fetchWithUpgrade(jar, callbackLink, {
    headers: { "User-Agent": USER_AGENT },
  });
  const ticketRes = ticketResult.res;
  const secondRet = ticketRes.headers.get("location");
  if (ticketRes.status !== 302 || !secondRet) {
    const body = await ticketRes.text().catch(() => "");
    throw new Error(
      `paym 票据验证失败: status=${ticketRes.status}, location=${secondRet}, upgraded=${ticketResult.upgraded}, fellBack=${ticketResult.fellBack}, body=${body.slice(0, 200)}`
    );
  }

  const actualResult = await fetchWithUpgrade(jar, secondRet, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: callbackLink,
    },
  });
  const actualRes = actualResult.res;
  if (!actualRes.ok) {
    const body = await actualRes.text().catch(() => "");
    throw new Error(
      `paym 登录页获取失败: status=${actualRes.status}, upgraded=${actualResult.upgraded}, fellBack=${actualResult.fellBack}, body=${body.slice(0, 300)}`
    );
  }
  const actualHtml = await actualRes.text();
  const resultMatch = actualHtml.match(
    /window\.location\.href\s*=\s*["']([^"']*)["']/
  );
  if (!resultMatch) {
    throw new Error(
      `无法从 paym 登录页解析跳转地址, html片段: ${actualHtml.slice(0, 500)}`
    );
  }

  const nextUrl = new URL(resultMatch[1], secondRet).toString();

  const tokenResult = await fetchWithUpgrade(jar, nextUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: secondRet,
    },
  });
  const tokenRes = tokenResult.res;
  const tokenLink = tokenRes.headers.get("location");
  if (tokenRes.status !== 302 || !tokenLink) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(
      `paym token 获取失败: status=${tokenRes.status}, location=${tokenLink}, upgraded=${tokenResult.upgraded}, fellBack=${tokenResult.fellBack}, body=${body.slice(0, 300)}`
    );
  }

  const tokenUrl = new URL(tokenLink, nextUrl);
  let token = tokenUrl.searchParams.get("token");
  if (!token && tokenUrl.hash) {
    const hashQuery = tokenUrl.hash.split("?")[1];
    if (hashQuery) {
      const hashParams = new URLSearchParams(hashQuery);
      token = hashParams.get("token");
    }
  }
  if (!token) {
    throw new Error(
      `paym 回调中未找到 token 参数, tokenLink=${tokenLink}, hash=${tokenUrl.hash}, searchParams=${Array.from(tokenUrl.searchParams.entries()).map(([k, v]) => `${k}=${v}`).join("&")}`
    );
  }

  return { token };
}

async function getJson<T>(
  jar: CookieJar,
  token: string,
  path: string
): Promise<T> {
  const res = await fetchWithJar(jar, `${PAYM_BASE}${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      "X-Token": token,
    },
  });
  if (!res.ok) {
    throw new Error(`paym 请求失败 ${path}: status=${res.status}`);
  }
  const body = (await res.json()) as { data?: T };
  if (!body.data) {
    throw new Error(`paym 返回数据为空: ${path}`);
  }
  return body.data;
}

export async function getUserInfo(
  jar: CookieJar,
  session: PaymSession
): Promise<UserInfo> {
  return getJson<{
    id: string;
    idserial: string;
    name: string;
    sex: string;
  }>(jar, session.token, `/api/pay/queryUserInfo/${session.token}`).then(
    (d) => ({
      id: d.id,
      studentId: d.idserial,
      name: d.name,
      sex: d.sex,
    })
  );
}

export async function getAllProjects(
  jar: CookieJar,
  session: PaymSession
): Promise<Project[]> {
  return getJson<{ id: string; projectName: string }[]>(
    jar,
    session.token,
    "/api/pay/project/getAllProjectList"
  ).then((list) => list.map((p) => ({ id: p.id, name: p.projectName })));
}

// ---------- 支付渠道与支付交易 (通用, 非电费专属) ----------

interface PaymResp<T> {
  messageCode?: string;
  message?: string;
  data?: T;
}

async function postJson<T>(
  jar: CookieJar,
  session: PaymSession,
  path: string,
  data: Record<string, unknown>
): Promise<T> {
  const res = await fetchWithJar(jar, `${PAYM_BASE}${path}`, {
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
      `paym 接口${path} 返回错误: [${body.messageCode}] ${body.message}`
    );
  }
  return body.data as T;
}

export interface TradeChannel {
  code: string;
  name: string;
  interfaceType?: string;
  imageUrl?: string;
}

/** 可用支付渠道 (enterType: H5 / wechat 等, 前端缺省 H5) */
export async function getTradeChannels(
  jar: CookieJar,
  session: PaymSession,
  projectId: string,
  enterType = "H5"
): Promise<TradeChannel[]> {
  const res = await fetchWithJar(
    jar,
    `${PAYM_BASE}/api/pay/open/pay/payrouterref/queryTradeChannel/${projectId}/${enterType}`,
    { headers: { "User-Agent": USER_AGENT, "X-Token": session.token } }
  );
  const body = (await res.json()) as PaymResp<
    { code: string; channelName: string; interfaceType?: string; imageUrl?: string }[]
  >;
  if (body.messageCode !== "0" || !Array.isArray(body.data)) {
    throw new Error(`获取支付渠道失败: [${body.messageCode}] ${body.message}`);
  }
  return body.data.map((c) => ({
    code: c.code,
    name: c.channelName,
    interfaceType: c.interfaceType,
    imageUrl: c.imageUrl,
  }));
}

export interface PayTradeResult {
  payType?: string;
  tradeType?: string;
  /** 微信 WAP 支付跳转链接 */
  mwebUrl?: string;
  /** 扫码支付二维码链接 (NATIVE) */
  urlCode?: string;
  /** 网银跳转链接 */
  webUrl?: string;
  /** 自动提交的支付表单 HTML (如建行网银) */
  sbHtml?: string;
  raw: unknown;
}

/**
 * 发起支付交易, 获取支付链接 (对应收银台 "立即支付")。
 * 仅生成支付链接/表单, 用户在对应渠道确认前不发生真实扣款。
 * tradeType: WAP (手机网页, 默认) / NATIVE (扫码) / JSAPI (微信内) / MINI (小程序)。
 */
export async function createPayTrade(
  jar: CookieJar,
  session: PaymSession,
  params: {
    orderNo: string;
    payType: string;
    tradeType?: string;
    returnUrl?: string;
    ip?: string;
  }
): Promise<PayTradeResult> {
  const data = await postJson<{
    payType?: string;
    tradeType?: string;
    mwebUrl?: string;
    urlCode?: string;
    webUrl?: string;
    sbHtml?: string;
  }>(jar, session, "/api/pay/web/third/toPayOrderTrade/", {
    payType: params.payType,
    orderNo: params.orderNo,
    ip: params.ip ?? "127.0.0.1",
    schoolCode: "datalook",
    dataSource: "PAY",
    returnUrl: params.returnUrl ?? "",
    tradeType: params.tradeType ?? "WAP",
  });
  if (!data) throw new Error("发起支付交易失败: 返回数据为空");
  return {
    payType: data.payType,
    tradeType: data.tradeType,
    mwebUrl: data.mwebUrl ?? undefined,
    urlCode: data.urlCode ?? undefined,
    webUrl: data.webUrl ?? undefined,
    sbHtml: data.sbHtml ?? undefined,
    raw: data,
  };
}

// ---------- 订单查询与关闭 ----------

export interface OrderInfo {
  orderId: string;
  orderNo: string;
  /** 金额 (元) */
  amount: number;
  /** 状态, 如 PENDING_PAYMENT / CLOSED / SUCCESS */
  status?: string;
  /** 展示状态码: 101=待支付, 005=已关闭 等 */
  displayStatus?: string;
  createdAt?: string;
  /** 计划关闭时间 (超时未支付自动关闭) */
  closeTime?: string;
  closedAt?: string;
  productDesc?: string;
  tradeChannel?: string;
  projectId?: string;
  projectName?: string;
  raw: unknown;
}

interface OrderRaw {
  id: string;
  orderNo: string;
  amount: number;
  status?: string;
  displayStatus?: string;
  createDate?: string;
  schdualCloseTime?: string;
  actualCloseTime?: string;
  productDesc?: string;
  tradeChannel?: string;
  projectId?: string | null;
  projectName?: string | null;
}

function normalizeOrder(o: OrderRaw): OrderInfo {
  return {
    orderId: o.id,
    orderNo: o.orderNo,
    amount: o.amount / 100,
    status: o.status,
    displayStatus: o.displayStatus,
    createdAt: o.createDate,
    closeTime: o.schdualCloseTime,
    closedAt: o.actualCloseTime,
    productDesc: o.productDesc,
    tradeChannel: o.tradeChannel ?? undefined,
    projectId: o.projectId ?? undefined,
    projectName: o.projectName ?? undefined,
    raw: o,
  };
}

export function isOrderUnpaid(o: Pick<OrderInfo, "status">): boolean {
  return o.status === "PENDING_PAYMENT";
}

export interface OrderListResult {
  pageCurrent: number;
  pageSize: number;
  total: number;
  orders: OrderInfo[];
}

/** 分页订单列表; displayStatus 如 "101" (待支付), 不传则全部 */
export async function listOrders(
  jar: CookieJar,
  session: PaymSession,
  opts: { pageCurrent?: number; pageSize?: number; displayStatus?: string } = {}
): Promise<OrderListResult> {
  const pageCurrent = opts.pageCurrent ?? 1;
  const pageSize = opts.pageSize ?? 10;
  const data = await postJson<{
    records?: OrderRaw[];
    total?: number;
  }>(jar, session, "/api/pay/web/order/pageOrderlist", {
    pageCurrent,
    pageSize,
    schoolCode: "datalook",
    ...(opts.displayStatus ? { displayStatus: opts.displayStatus } : {}),
  });
  return {
    pageCurrent,
    pageSize,
    total: data?.total ?? 0,
    orders: (data?.records ?? []).map(normalizeOrder),
  };
}

/** 订单详情 */
export async function getOrderById(
  jar: CookieJar,
  session: PaymSession,
  orderId: string
): Promise<OrderInfo> {
  const res = await fetchWithJar(
    jar,
    `${PAYM_BASE}/api/pay/pay/orderTrade/getOrderById/${orderId}`,
    { headers: { "User-Agent": USER_AGENT, "X-Token": session.token } }
  );
  const body = (await res.json()) as PaymResp<OrderRaw>;
  if (body.messageCode !== "0" || !body.data) {
    throw new Error(
      `获取订单详情失败: [${body.messageCode}] ${body.message}`
    );
  }
  return normalizeOrder(body.data);
}

/** 关闭 (取消) 订单; 仅未支付订单可关闭 */
export async function closeOrder(
  jar: CookieJar,
  session: PaymSession,
  orderId: string
): Promise<void> {
  await postJson<unknown>(jar, session, `/api/pay/web/order/closeOrderById/${orderId}`, {});
}

/** 列出某项目下所有待支付订单 (供自动关闭逻辑使用) */
export async function listPendingOrders(
  jar: CookieJar,
  session: PaymSession,
  projectId: string
): Promise<OrderInfo[]> {
  const result = await listOrders(jar, session, {
    pageCurrent: 1,
    pageSize: 50,
    displayStatus: "101",
  });
  return result.orders.filter(
    (o) => o.projectId === projectId && isOrderUnpaid(o)
  );
}
