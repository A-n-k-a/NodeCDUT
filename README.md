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

运维: `GET /health` · `GET /diag` (上游连通性探测)

错误语义: `401 session_expired` (未携带/TGT 失效, 需重登) · `502` 上游结构变化或认证链失败 · `504` 上游超时。

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

## 未移植 (上游 C# 端亦未完成)

电费充值楼栋/房间映射 (`ConvertDomInfoToQuery` 抛 `NotImplementedException`)、实际选课提交 (`ChooseInProject` 为空方法)。相关映射数据留存于 C# 源仓库 `Data/Paym/RoomIds.cs`, 待上游补齐后可移植。

## Licence

GPL-3.0-or-later, 见 [LICENSE](LICENSE)。
