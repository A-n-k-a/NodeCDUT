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

`GET /paym/userinfo` 响应示例 (`idserial` 重命名为 `studentId`; 其余上游字段原样透传, 为 null 的字段省略):

```json
{ "id": "5d7e17e5561f402589b39dcfc6c23683", "studentId": "202318020101", "name": "张三",
  "sex": "MALE", "userType": "IN_SCHOOL", "identityType": "02" }
```

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
    → order (下单, 默认继续生成支付信息 payLink, 含建行聚合支付扫码内容 urlCode)
```

> 快捷方式: `route` 携带 `building` + `roomNo` 可一步解析到房间 (含 E034 自动推断 levelId),
> 返回字段直接用于 `balance` / `order`, 省去中间的 projects→areas→buildings→floors→rooms 逐级查询。

### 电费项目与 factoryCode

`GET /paym/electricity/projects` 返回全部电费项目, 不同 `factoryCode` 的选房间流程不同:

| 项目 | projectId | factoryCode | 流程差异 |
|---|---|---|---|
| 爱立德电费 | `2595a1f7c8cf17410c85f9e05f9cc7c3` | E016 | 区域固定 4 个 (接口直接返回), 无楼层 |
| 珙桐园电费 | `bb62312911b282f57d03568c998776e2` | E017 | 区域动态查询, 无楼层 |
| 新开普电费 | `7a99ede5475b55a03adb936454463994` | E034 | **有楼层级**, rooms/balance 必须带 levelId; 房间 id 为复合串 (如 `99-9--101-101`) |
| 科技园 | `71b85ee43146666e2b832a714b57edc1` | E018 | 区域固定 1 个, 无楼层 |

响应示例 (`projectName` 重命名为 `name`; 其余上游字段如 `imgUrl`/`status`/`payLimit` 等原样透传, 为 null 的字段省略):

```json
{
  "count": 4,
  "projects": [
    { "id": "2595a1f7c8cf17410c85f9e05f9cc7c3", "name": "爱立德电费", "factoryCode": "E016", "hasFloors": false, "...": "..." }
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

#### 一站式模式 (推荐): 直接解析到房间

额外提供 `building` (栋号) 与 `roomNo` (房间号) 时, 自动完成 区域→楼栋→楼层→房间
全链路解析, 返回字段与 balance / order 入参一一对应, 可直接回传。
E034 (新开普) 虽强制要求 levelId, 但房间号去掉末两位即为楼层数, 服务端自动推断, 无需手动查询楼层。

| 参数 | 必填 | 允许取值 | 说明 |
|---|---|---|---|
| `park` | 是 | `榕树园` / `珙桐园` / `松林园` / `银杏园` / `芙蓉园` / `香樟园` | 园区 |
| `type` | 是 | `照明` / `空调` | 用电类型 |
| `building` | 是 | 正整数栋号 (范围见下表); 写法不限: `1` / `"1"` / `"1栋"` / `"01"` 均可 (键名亦可写作 `area`) | 栋号 |
| `roomNo` | 是 | 房间号 (各通道命名风格见下表); **E034 通道须为 ≥3 位纯数字** (末两位为房号, 其余为楼层数, 用于推断 levelId) | 房间号, 须为楼栋内真实存在的房间 |

各园区 `building` 取值范围 (2026-09 实测):

| 园区 | 栋号 | 通道说明 |
|---|---|---|
| 芙蓉园 | `1`–`9` | 照明/空调均走 E016, 同栋分两个通道楼栋, 按 `type` 自动区分 |
| 香樟园 | `1`–`6` | 均走 E016; 注意 **2 栋无空调通道** |
| 银杏园 | `1`–`4` | 1/3 栋照明走 E016 (1 栋分 1-1/1-2 两单元, 按房间号自动消歧); 其余走 E034 |
| 松林园 | `1`–`2` | 照明走 E016, 空调走 E034 |
| 珙桐园 | `1`–`7` | 照明走 E017, 空调走 E034 (**04/05 栋无 1 层**, 房间号从 2 层起) |
| 榕树园 | 照明仅 `1`; 空调 `5`–`12` | 照明走 E016 (整园合并为通道楼栋 "榕树1"); 空调走 E034 |

各通道 `roomNo` 命名风格 (实测; 匹配时自动兼容全名, 按以下简写提供即可):

| 通道 | 实测房间名示例 | 推荐 `roomNo` 写法 |
|---|---|---|
| E034 新开普 | `101` | `"101"` (纯数字 ≥3 位) |
| E016 芙蓉/银杏/松林 | `1-101` / `Y3-101` / `1-101空调` | `"101"` |
| E016 香樟 | `1A101` / `3-A101空调` | `"A101"` 或 `"1A101"` (须带分区字母) |
| E016 榕树园 | `3单元101` | `"3单元101"` 或 `"3-101"` (须带单元号) |
| E017 珙桐园 | `1101` (=1号楼101) | `"1101"` 或 `"101"` (自动补栋号前缀) |

> 峨眉校区英才楼等 E034 特殊楼栋无栋号, 无法按 园区+栋号 定位, 请走 buildings→rooms 逐级查询。
> 解析失败 (楼栋/楼层/房间不存在或不唯一) 时响应会携带具体原因, 如 `榕树1 中未找到房间 101 (该楼栋共 228 间; 若房间带单元/分区前缀请完整提供...)`。

```bash
curl -X POST "$BASE/paym/electricity/route" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"park":"银杏园","type":"空调","building":1,"roomNo":"512"}'
```

```json
{ "park": "银杏园", "type": "空调", "buildingNo": 1, "factoryCode": "E034",
  "projectId": "7a99ede5475b55a03adb936454463994", "projectName": "新开普电费",
  "hasFloors": true, "areaId": "99", "areaName": "主分区",
  "buildId": "9", "buildName": "银杏园01",
  "levelId": "105", "levelName": "5层",
  "roomId": "99-9--105-512", "roomName": "512" }
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

E034 (新开普) 示例: 区域固定为主分区 `99`, 楼栋按园区命名 (实测共 22 栋, 含峨眉校区英才楼):

```bash
curl -X POST "$BASE/paym/electricity/buildings" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"7a99ede5475b55a03adb936454463994","areaId":"99"}'
```

```json
{ "count": 22, "buildings": [ {"id":"9","name":"银杏园01"}, {"id":"13","name":"珙桐园01"},
  {"id":"1","name":"榕树园05"}, {"id":"20","name":"松林园01"}, {"id":"22","name":"峨眉校区英才楼"}, ... ] }
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

E034 的房间 `id` 为复合串 (如 `99-9--101-101`), `name` 仅为房间号, 后续 balance/order 直接回传 `id` 即可:

```json
{ "count": 75, "rooms": [ {"id":"99-9--101-101","name":"101"}, {"id":"99-9--101-102","name":"102"}, ... ] }
```

> 缺省 `levelId` 调用 E034 rooms 会报错: `新开普电费 (E034) 查询房间必须提供 levelId`。

### POST /paym/electricity/balance — 剩余电量查询

| 参数 | 必填 | 说明 |
|---|---|---|
| `projectId` | 是 | 电费项目 id |
| `areaId` | 是 | 区域 id |
| `buildId` | 是 | 楼栋 id |
| `roomId` | 是 | rooms 返回的 `id` |
| `levelId` | E034 建议携带 | 楼层 id (实测 E034 仅凭 roomId 复合串即可定位, 省略也可查询) |

```bash
# E016 (爱立德) 示例
curl -X POST "$BASE/paym/electricity/balance" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2","buildId":"1","roomId":"1"}'

# E034 (新开普) 示例: roomId 回传 rooms 返回的复合 id
curl -X POST "$BASE/paym/electricity/balance" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"7a99ede5475b55a03adb936454463994","areaId":"99","buildId":"9",
       "levelId":"101","roomId":"99-9--101-101"}'
```

```json
{ "remain": "36.93", "total": "1487.60" }
```

E034 响应示例 (无 `total`, 多 `canbuy` 是否可充值标识):

```json
{ "remain": "49.02", "canbuy": "1" }
```

> 数值单位为度 (kWh), 原始字符串返回, 可能为负数表示透支。

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
| `withPayLink` | 否 | **默认 `true`**: 下单后自动继续调用 `toPayOrderTrade` 生成支付信息 (`payLink`); 传 `false` 跳过 |
| `payType` | 否 | 支付渠道代码, **默认 `41`** (建行聚合支付, 实测电费收银台唯一可用支付方式) |
| `tradeType` | 否 | **默认 `NATIVE`** (扫码, 返回 `urlCode`); 建行聚合支付仅支持 NATIVE, 传 `WAP` 会报 "支付类型不存在" |

> ⚠️ 会**真实创建待支付订单** (约 15 分钟未支付自动关闭); `payLink` 仅为支付信息 (二维码内容/跳转链接), 用户在渠道确认前不发生扣款。

```bash
curl -X POST "$BASE/paym/electricity/order" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"2595a1f7c8cf17410c85f9e05f9cc7c3","areaId":"2","areaName":"芙蓉",
       "buildId":"1","buildName":"芙蓉1照明","roomId":"1","roomName":"1-101",
       "amount":0.01,"closePrevious":true}'

# E034 (新开普) 示例: 需带 levelId/levelName, roomId 为复合串
curl -X POST "$BASE/paym/electricity/order" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" \
  -d '{"projectId":"7a99ede5475b55a03adb936454463994","areaId":"99","areaName":"主分区",
       "buildId":"9","buildName":"银杏园01","levelId":"101","levelName":"1层",
       "roomId":"99-9--101-101","roomName":"101","amount":0.01,"closePrevious":true}'
```

```json
{
  "orderId": "de2e34ade010f0b11f2c9934e072fe91",
  "orderNo": "26090300021465165606",
  "status": "PENDING_PAYMENT",
  "closeTime": "2026-09-03 00:17:14",
  "closedOrderIds": ["ac972d4ae70b4a6df1fad3d3cd8159b2"],
  "cashierUrl": "https://paym.cdut.edu.cn/mobile/#/person?projectId=2595a1f7c8cf17410c85f9e05f9cc7c3&orderId=de2e34ade010f0b11f2c9934e072fe91",
  "payLink": {
    "orderNo": "26090300021465165606",
    "amount": 1,
    "payType": "41",
    "tradeType": "NATIVE",
    "urlCode": "https://ibsbjstar.ccb.com.cn/CCBIS/QR?QRCODE=CCB9980109685620343432814"
  }
}
```

- `cashierUrl`: 官方收银台页面 (需在已登录的浏览器环境打开)
- `payLink`: `toPayOrderTrade` 上游响应中有值的字段原样透传 (为 null 的字段省略)。
  其中 `urlCode` 为建行聚合支付二维码内容 (官方前端用 JS 据此渲染二维码, 本项目不做处理,
  调用方可自行生成二维码展示); 其余渠道可能返回 `mwebUrl` / `webUrl` / `sbHtml` 等
- `payLink.amount` 单位为分 (上游原始值)
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

### POST /paym/orders/{orderId}/pay — 去支付

仅未支付订单可用; 生成支付信息, **用户在渠道确认前不发生扣款**。

| 参数 | 必填 | 允许取值 / 说明 |
|---|---|---|
| `payType` | 否 | 支付渠道代码, **默认 `41`** (建行聚合支付, 实测电费收银台唯一可用) |
| `tradeType` | 否 | **默认 `NATIVE`** (扫码, 返回 `urlCode`); 建行聚合支付仅支持 NATIVE |

```bash
curl -X POST "$BASE/paym/orders/f8301f2e2633e32f389749b2765ae4a4/pay" \
  -H "X-Auth-Cookies: $SESSION" -H "Content-Type: application/json" -d '{}'
```

```json
{ "payType": "41", "tradeType": "NATIVE", "orderNo": "26090122524334924915",
  "urlCode": "https://ibsbjstar.ccb.com.cn/CCBIS/QR?QRCODE=CCB99801..." }
```

响应为上游有值字段的原样透传; `urlCode` 为建行聚合支付二维码内容, 调用方可自行渲染为二维码。

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

### 腾讯云 EdgeOne Makers

仓库已内置 `edgeone.json` 与 `cloud-functions/[[default]].ts` (Node.js Cloud Function, 全路径接管)。导入 Git 仓库时框架预设选 **Hono** 即可 (构建/输出配置由 `edgeone.json` 覆盖), 并在「环境变量」中配置 `SESSION_SECRET`。

## 电费链路说明 (抓包分析)

上游 C# 端未完成的电费功能已通过抓包补齐: 楼栋/房间/余额均改为**动态接口查询** (`payEleCostController`), 取代了 C# 端静态的 `RoomIds` 映射表与未完成的 `ConvertDomInfoToQuery` 智能转换, 数据不再有过期风险。注意: 该控制器要求请求体 `Content-Type: application/json`, 否则后端返回误导性的 "系统正在维护中" (messageCode=2)。

## 未移植

实际选课提交 (上游 C# 端 `ChooseInProject` 为空方法, 亦未实现)。

## Licence

[LICENSE](LICENSE)
