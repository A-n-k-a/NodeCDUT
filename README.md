# NodeCDUT

成都理工大学校园系统统一接口服务 — [CDUniTap](https://github.com/kengwang/CDUniTap) (C# CLI) 的 Node.js 无状态 API 移植, 面向 Vercel Serverless 部署。

## 架构

- **无状态会话**: 登录后服务端将 CookieJar (+ paym token) 用 AES-256-GCM 密封为 opaque blob, 经 `X-Auth-Cookies` 响应头与响应体 `session` 字段下发; 后续请求由客户端在同一头中带回。响应若带回同名头, 客户端须替换本地副本 (子系统认证会增量刷新)。服务端零存储。
- **传输**: 按 origin 池化的 HTTP/2 会话, 不支持时回退 undici; `*.cdut.edu.cn` 自动 http→https 升级并在网络错误时回退。
- 运行时: Vercel Node.js (>= 20), 单函数入口 `src/index.ts`, `maxDuration: 60`。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SESSION_SECRET` | 生产必填 | 会话 blob 加密密钥 (任意长随机串); 未设置时使用内置开发密钥并告警 |
| `CORS_ORIGIN` | 否 | 允许的跨域来源, 默认 `*` |

## 端点

认证: `POST /auth/login` `{username, password}` · `POST /auth/sms/send` `{phone}` · `POST /auth/sms/login` `{phone, code}`

教务 (均需 `X-Auth-Cookies`):
- `GET /jw/schedule/meta` 学期/周次选项
- `POST /jw/schedule` `{xqid?, week?}` 新版课表, `?format=ics` 导出日历
- `GET /jw/schedule/legacy/meta` · `POST /jw/schedule/legacy` `{xqid, week, startDate}` 旧版课表
- `GET /jw/exams/meta` · `POST /jw/exams` `{xnxqid}` 考试信息, `?format=ics` 导出
- `POST /jw/students` `{name}` 学生查询
- `GET /jw/elective/projects` 选课计划列表

支付: `GET /paym/userinfo` · `GET /paym/projects`

电费: `GET /paym/electricity/projects` · `POST .../route` · `.../areas` · `.../buildings` · `.../floors` · `.../rooms` · `.../balance` · `.../order`

订单: `GET /paym/orders` · `GET /paym/orders/{orderId}` · `POST /paym/orders/{orderId}/pay` · `POST /paym/orders/{orderId}/close`

详细参数与调用示例见下文 [电费接口详解](#电费接口详解) 与 [订单接口详解](#订单接口详解)。

通道路由规则 (校方):
1. 芙蓉园、香樟园照明及空调, 松林园、榕树园和银杏 1/3 栋照明 → 爱立德电费
2. 珙桐园照明 → 珙桐园电费
3. 银杏 2/4 栋照明及空调, 榕树园、珙桐园、松林园、银杏 1/3 栋空调 → 新开普电费

运维: `GET /health` · `GET /diag` (上游连通性探测)

错误语义: `401 session_expired` (未携带/TGT 失效, 需重登) · `400` 参数错误 · `502` 上游结构变化、认证链失败或上游业务错误 (message 中携带原始错误码, 如 `[16503]`) · `504` 上游超时。

## 电费接口详解

所有电费接口均需请求头 `X-Auth-Cookies: <session blob>` (由 `/auth/login` 获取; 响应若带回同名头须替换本地副本)。下文示例中 `$BASE` 为部署地址, `$SESSION` 为会话 blob。

### 调用流程

```
route (可选, 智能选通道) → projects (选项目) → areas (选区域) → buildings (选楼栋)
    → floors (选楼层, 仅新开普 E034) → rooms (选房间) → balance (查余额)
    → order (下单) → cashierUrl 交予用户支付, 或 orders/{orderId}/pay 生成支付链接
```

### 电费项目与 factoryCode

`GET /paym/electricity/projects` 返回全部电费项目, 不同 `factoryCode` 的选房间流程不同:

| 项目 | projectId | factoryCode | 流程差异 |
|---|---|---|---|
| 爱立德电费 | `2595a1f7c8cf17410c85f9e05f9cc7c3` | E016 | 区域固定 4 个 (接口直接返回), 无楼层 |
| 珙桐园电费 | `bb62312911b282f57d03568c998776e2` | E017 | 区域动态查询, 无楼层 |
| 新开普电费 | `7a99ede5475b55a03adb936454463994` | E034 | **有楼层级**, rooms/balance 必须带 levelId; 房间 id 为复合串 (如 `99-9--101-101`) |
| 科技园 | `71b85ee43146666e2b832a714b57edc1` | E018 | 区域固定 1 个, 无楼层 |

响应示例:

```json
{
  "count": 4,
  "projects": [
    { "id": "2595a1f7c8cf17410c85f9e05f9cc7c3", "name": "爱立德电费", "factoryCode": "E016", "hasFloors": false }
  ]
}
```

### POST /paym/electricity/route — 充值通道路由 (智能选择)

按校方规则, 由 园区+用电类型 推荐充值通道, 免去手动选择项目。

| 参数 | 必填 | 允许取值 | 说明 |
|---|---|---|---|
| `park` | 是 | `榕树园` / `珙桐园` / `松林园` / `银杏园` / `芙蓉园` / `香樟园` | 园区 |
| `type` | 是 | `照明` / `空调` | 用电类型 |
| `buildingNo` | 银杏园必填 | `1` / `2` / `3` / `4` | 栋号 (仅银杏园用于区分通道) |

```bash
curl -X POST "$BASE/paym/electricity/route" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"park":"银杏园","type":"空调","buildingNo":2}'
```

```json
{ "park": "银杏园", "type": "空调", "buildingNo": 2, "factoryCode": "E034",
  "projectId": "7a99ede5475b55a03adb936454463994", "projectName": "新开普电费" }
```

### POST /paym/electricity/areas — 区域列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |

返回 `areas: [{id, name}]`。各项目实测区域: E016 → 芙蓉`2`/香樟`4`/银杏`3`/松林`5`; E017 → 珙桐园`1`; E018 → 芙蓉`1`; E034 → 主分区`99`。

```bash
curl -X POST "$BASE/paym/electricity/areas" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3"}'
```

```json
{ "count": 4, "areas": [ {"id":"2","name":"芙蓉"}, {"id":"4","name":"香樟"},
  {"id":"3","name":"银杏"}, {"id":"5","name":"松林"} ] }
```

### POST /paym/electricity/buildings — 楼栋列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | areas 返回的 `id` |

```bash
curl -X POST "$BASE/paym/electricity/buildings" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2"}'
```

```json
{ "count": 18, "buildings": [ {"id":"1","name":"芙蓉1照明"}, {"id":"10","name":"芙蓉1空调"}, ... ] }
```

### POST /paym/electricity/floors — 楼层列表 (仅 E034)

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | 区域 id |
| `buildId` | 是 | 楼栋 id |

其他项目调用返回空数组 `{"count":0,"floors":[]}`。

```bash
curl -X POST "$BASE/paym/electricity/floors" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"7a99ede5475b55a03adb936454463994","areaId":"99","buildId":"9"}'
```

```json
{ "count": 6, "floors": [ {"id":"101","name":"1层"}, {"id":"102","name":"2层"}, ... ] }
```

### POST /paym/electricity/rooms — 房间列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | 区域 id |
| `buildId` | 是 | 楼栋 id |
| `levelId` | E034 必填 | floors 返回的 `id` |

```bash
# E016 (爱立德) 示例
curl -X POST "$BASE/paym/electricity/rooms" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2","buildId":"1"}'

# E034 (新开普) 示例
curl -X POST "$BASE/paym/electricity/rooms" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"7a99ede5475b55a03adb936454463994","areaId":"99","buildId":"9","levelId":"101"}'
```

```json
{ "count": 108, "rooms": [ {"id":"1","name":"1-101"}, {"id":"10","name":"1-110"}, ... ] }
```

E034 的房间 `id` 为复合串 (如 `99-9--101-101`), 后续 balance/order 直接回传即可。

### POST /paym/electricity/balance — 剩余电量查询

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | 区域 id |
| `buildId` | 是 | 楼栋 id |
| `roomId` | 是 | rooms 返回的 `id` |
| `levelId` | E034 必填 | 楼层 id |

```bash
curl -X POST "$BASE/paym/electricity/balance" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2","buildId":"1","roomId":"1"}'
```

```json
{ "remain": "36.93", "total": "1487.60", "unit": "度" }
```

> ⚠️ `remain` / `total` 单位为 **度 (kWh)**, 并非人民币元; 原始字符串返回 (可能为负数, 表示透支)。

### POST /paym/electricity/order — 创建充值订单

| 参数 | 必填 | 允许取值 / 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | 区域 id |
| `buildId` | 是 | 楼栋 id |
| `roomId` | 是 | rooms 返回的 `id` |
| `amount` | 是 | 正数, 单位 **元** (如 `50` 或 `0.01`; 内部转换为分) |
| `levelId` | E034 必填 | 楼层 id |
| `areaName` / `buildName` / `levelName` / `roomName` | 否 | 名称快照, 建议照抄选择结果, 缺省为空串 |
| `buyerId` | 否 | 购买人学号, 缺省取会话中的 studentId |
| `closePrevious` | 否 | `true` = 创建前自动关闭本项目下的未完成订单; **默认 `false`**, 此时若存在未完成订单返回 `[16503] 此项目下存在未完成的订单...` 错误 |
| `withPayLink` | 否 | `true` 时额外返回 `payLink` 支付链接 (默认 `false`) |
| `payType` | 否 | 支付渠道代码, 缺省取项目首个 H5 渠道 (实测当前仅 `08` = 建行网银支付); 配合 `withPayLink` 使用 |
| `tradeType` | 否 | `WAP` (默认, 手机网页) / `NATIVE` (扫码) / `JSAPI` (微信内) / `MINI` (小程序) |

> ⚠️ 会**真实创建待支付订单** (约 15 分钟未支付自动关闭); `payLink` 仅为支付跳转链接/表单, 用户在渠道确认前不发生扣款。

```bash
curl -X POST "$BASE/paym/electricity/order" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2","areaName":"芙蓉",
       "buildId":"1","buildName":"芙蓉1照明","roomId":"1","roomName":"1-101",
       "amount":0.01,"closePrevious":true,"withPayLink":true}'
```

```json
{
  "orderId": "f8301f2e2633e32f389749b2765ae4a4",
  "orderNo": "26090122524334924915",
  "status": "PENDING_PAYMENT",
  "closeTime": "2026-09-01 23:07:43",
  "closedOrderIds": ["4d39bf1abda0c833787a0769e9b0498d"],
  "cashierUrl": "https://paym.cdut.edu.cn/mobile/#/person?projectId=2595a1f7c8cf17410c85f9e05f9cc7c3&orderId=f8301f2e2633e32f389749b2765ae4a4",
  "payLink": { "payType": "08", "tradeType": "WAP", "sbHtml": "<script>...</form>" }
}
```

- `cashierUrl`: 官方收银台页面 (需在已登录的浏览器环境打开)
- `payLink`: 直连渠道支付信息, 按渠道不同返回 `mwebUrl` (微信 WAP) / `urlCode` (扫码) / `webUrl` (网银) / `sbHtml` (自动提交表单)
- `closedOrderIds`: 仅 `closePrevious: true` 且确实关闭了订单时出现

## 订单接口详解

通用订单接口 (不限于电费订单), 均需 `X-Auth-Cookies`。

### GET /paym/orders — 分页订单列表

| Query 参数 | 必填 | 允许取值 / 说明 |
|---|---|---|
| `pageCurrent` | 否 | 正整数, 默认 `1` |
| `pageSize` | 否 | 正整数, 默认 `10`, 最大 `100` |
| `displayStatus` | 否 | 订单状态过滤, 见下表; 不传返回全部 |

`displayStatus` 允许的值及对应含义:

| 值 | 含义 |
|---|---|
| `101` | 待支付 |
| `102` | 支付中 |
| `103` | 支付成功 |
| `104` | 支付失败 |
| `107` | 部分退款 |
| `108` | 全额退款 |
| `005` | 已过期 |
| `006` | 已取消 |

```bash
curl "$BASE/paym/orders?pageCurrent=1&pageSize=10&displayStatus=101" \
  -H "X-Auth-Cookies: $SESSION"
```

```json
{
  "pageCurrent": 1, "pageSize": 10, "total": 1,
  "orders": [
    { "orderId": "f8301f2e2633e32f389749b2765ae4a4", "orderNo": "26090122524334924915",
      "amount": 0.01, "status": "PENDING_PAYMENT", "displayStatus": "101",
      "projectName": "爱立德电费", "createdAt": "2026-09-01 22:52:43",
      "closeTime": "2026-09-01 23:07:43", "projectId": "2595a1f7c8cf17410c85f9e05f9cc7c3" }
  ]
}
```

> `amount` 单位为元 (已从分转换); `status` 为上游原始状态 (`PENDING_PAYMENT` / `CLOSED` / `COMPLETED` 等)。

### GET /paym/orders/{orderId} — 订单详情

```bash
curl "$BASE/paym/orders/f8301f2e2633e32f389749b2765ae4a4" \
  -H "X-Auth-Cookies: $SESSION"
```

```json
{
  "orderId": "f8301f2e2633e32f389749b2765ae4a4",
  "orderNo": "26090122524334924915",
  "amount": 0.01,
  "status": "PENDING_PAYMENT",
  "displayStatus": "101",
  "createdAt": "2026-09-01 22:52:43",
  "closeTime": "2026-09-01 23:07:43",
  "productDesc": "爱立德电费,",
  "unpaid": true,
  "actions": ["pay", "close"]
}
```

- `unpaid: true` (即 `status === "PENDING_PAYMENT"`) 时附带 `actions: ["pay", "close"]`, 否则为 `[]`
- 注意: 详情接口上游不一定返回 `projectId`, 如需去支付请自行保存下单时的 projectId

### POST /paym/orders/{orderId}/pay — 去支付

仅未支付订单可用; 生成支付链接, **用户在渠道确认前不发生扣款**。

| 参数 | 必填 | 允许取值 / 说明 |
|---|---|---|
| `projectId` | 视情况 | 缺省 `payType` 时必填 (用于查询项目可用渠道) |
| `payType` | 否 | 支付渠道代码 (如 `08` = 建行网银), 缺省取该项目首个 H5 渠道 |
| `tradeType` | 否 | `WAP` (默认) / `NATIVE` / `JSAPI` / `MINI` |

```bash
curl -X POST "$BASE/paym/orders/f8301f2e2633e32f389749b2765ae4a4/pay" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3"}'
```

```json
{ "payType": "08", "tradeType": "WAP", "sbHtml": "<script>...自动提交建行网银表单...</form>" }
```

订单非待支付状态时返回错误: `订单当前状态为 CLOSED, 不可支付`。

### POST /paym/orders/{orderId}/close — 关闭订单

仅未支付订单可用, 无请求体。

```bash
curl -X POST "$BASE/paym/orders/f8301f2e2633e32f389749b2765ae4a4/close" \
  -H "X-Auth-Cookies: $SESSION"
```

```json
{ "closed": true, "orderId": "f8301f2e2633e32f389749b2765ae4a4" }
```

## 开发

```bash
npm install
npm run dev        # tsx watch, :3000
npm run smoke      # 离线行为检查 (会话密封/ICS/解析器)
npm run typecheck
```

## 部署

```bash
vercel env add SESSION_SECRET   # 生产密钥
vercel deploy
```

## 电费链路说明 (抓包分析)

上游 C# 端未完成的电费功能已通过抓包补齐: 楼栋/房间/余额均改为**动态接口查询** (`payEleCostController`), 取代了 C# 端静态的 `RoomIds` 映射表与未完成的 `ConvertDomInfoToQuery` 智能转换, 数据不再有过期风险。注意: 该控制器要求请求体 `Content-Type: application/json`, 否则后端返回误导性的 "系统正在维护中" (messageCode=2)。

## 未移植

实际选课提交 (上游 C# 端 `ChooseInProject` 为空方法, 亦未实现)。

## Licence

[LICENSE](LICENSE)
