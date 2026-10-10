# ADR 0019：独立运营事件接收与统计

状态：已接受。2026-09-20 用户批准产品 shared/logger-tracking 与官网运营统计的编码。

官网新增机器采集 API `/api/tracking/v1/events:batch` 和管理员 `/api/admin/analytics/*`。普通 logger 保持原实现，官网不访问终端 DSH_HOME。

## 2026-10-10：WeLink 姓名与部门资料

- 工号仍按 `tenant + source + employeeId` 唯一归属。工作助手在读取 WeLink 登录状态后查询个人资料，事件的 `employee` 可选携带 `chineseName`、`departmentName`、`deptL1Name`、`deptName` 与成功查询时间 `profileUpdatedAt`；不接收完整通讯录响应，不将姓名或部门解释为权限。既有工号事件和匿名事件继续兼容。
- 产品契约独立为只依赖 zod 的 `@dsh-ops/tracking-contract`；官网仅安装该纯包的精确 vendor 制品。按产品 DSH 升级计划 K16，不再从含 Host 私有 workspace 依赖的 tracking 插件打包官网依赖。目录版本 4，事件和批次 schemaVersion 仍为 1。
- SQLite v3 在事务中为用户添加四项资料及查询时间，保留既有身份和事实。只在通过事件及操作上下文检查后接受较新的资料时间；缺失字段、旧客户端、较旧缓存和离线补传均不清空已知资料。时间规范化为 UTC；没有资料时间的字段仅留在原始事件，不替换当前用户资料。历史记录继续按原工号归属，管理台展示该工号最新收到的有效资料，不回填历史匿名事件。
- 操作开始时冻结完整 employee 快照，完成时沿用；官网保持现有上下文匹配与幂等摘要。资料更新不会改变进行中操作的身份。拒收的上下文冲突不能改写当前资料。
- 用户明细、排名、操作明细默认显示姓名、工号与最小部门；部门悬浮或键盘聚焦显示完整部门，Escape 关闭。个人详情同时显示一级部门和完整部门。部门不加入排序或筛选协议。列偏好从 v1 到 v2 只迁移一次，保留原选择并补入默认部门列，此后允许隐藏。
- 部署先更新并重启官网，再发布/重启工作助手。旧官网严格契约会永久拒收新增资料字段，因此不能先更新终端，也不能靠清空队列重试。

2026-09-21 配置收敛：移除 trackingDevelopment 及仅本机开发兼容分支，采集仅由 trackingEnabled 控制（缺省 false，仓库示例 true），与启动方式/批次环境无关。统计查询默认环境由既有 --dev 启动参数决定（development/production），不增加配置项；显式环境筛选与浏览器偏好保持有效。外部部署配置须删除旧 trackingDevelopment 字段，配置继续严格校验未知键，不做静默忽略或隐式开启。

2026-09-21 部署修正（替代下述仅本机开发限制）：新增 trackingEnabled，显式 true 时正常 pnpm start 即可接收远程 Host 的 production/development/test 批次，无须 Token，生产采集认证按用户要求后续实现；显式 false 关闭采集。字段缺省时关闭采集，不再保留本机开发特例。配置示例显式 true，服务启动打印采集开关。environment 只用于统计分类，不再决定上传资格。继续拒绝浏览器来源，保留管理员鉴权、逐条校验、限流、大小/并发边界和去重。既有 tenant=development 是历史单租户命名空间，继续复用以保持工号、幂等记录的连续性，与事件 environment 无关。未改协议/数据库 schema，不需要同步新的 vendor 制品。受控部署的采集尚无身份认证，不将员工自报字段解释为管理权限。

- 事件协议源码在产品仓库 `packages/shared/tracking-contract`，通过 `@dsh-ops/tracking-contract` 的精确 vendor tarball 分发。纯契约只依赖 zod，不导入 DSH 或 Cordis；官网不安装或运行终端插件。
- 历史实现（2026-09-21 已修正）：2026-09-20 用户调整范围：开发调试免认证，生产验证暂不实现。仅 `--dev` 且 `trackingDevelopment: true` 开放本机 Host POST；不配置 Token 或凭据环境变量。批次自报 installationId/environment，服务端固定开发 tenant，拒绝 production、浏览器 Origin/Fetch-Metadata 与非 loopback 连接，仍限制大小、频率和并发。正常生产启动关闭采集入口。
- 按用户最新决定，直接采用工作助手左下角登录工号的同源 Host 字段（WeLink auth.accountLabel）；无需额外 SSO。事件可选携带 employee.source=welink 与规范化 employeeId，官网按 tenant + source + 工号跨安装去重。只用于统计归属，不用于管理员或生产上传鉴权。旧 identityRef 保留兼容，二者互斥；历史匿名记录不追归当前工号。identity-sessions 仍不开放。
- SQLite 单机本地盘，独立 analyticsDirectory，由有界 Worker 串行处理；WAL、FULL 同步、参数化查询与版本表。事件、去重、受影响日期汇总同一事务提交后确认。唯一 eventId 防重传，operationId 防重复终态。
- 终态可早于受理到达：暂挂起统计，等受理身份匹配后归属。身份快照绑定安装和发生时间，切号后不能重分配旧事件。
- 原始明细 90 天，幂等索引 120 天，轻量 activity_facts 与用户日汇总 400 天；补传限 30 天。facts 保留用户及动作去重键，支持平台/版本切片后的精确人数。每小时清理到期数据，不存消息/文档正文或凭据。
- 管理查询沿用现有管理员会话和 Host 检查，只读、分页、no-store。后台提供总览、用户明细/个人操作、活跃排名、功能使用、操作明细和采集状态。
- 默认环境由认证保护的 `GET /api/admin/analytics/context` 返回：由 --dev 启动时为 development，其余为 production，与 trackingEnabled 无关；省略 environment 的管理查询采用同一默认值。页面先取配置，再应用浏览器中保存的有效手动选择，避免开发数据被默认生产筛选隐藏。空态仅描述当前环境与筛选范围，匿名次数与实名人数保持区分。
- DAU 是已识别用户的人工业务受理，MAU 是截至日近30天去重，不累计 DAU。自动任务、匿名设备、页面访问、自动登录不增加 DAU。

产品新增公开会话事件适配：当前官方 Web 消息以 user + rpcId + clientTimeZone 组合识别，其他入口保留 unknown，子代理单列 agent；不把所有 user-role 消息计为人工。仅上报标识摘要、计数与白名单属性，不传消息/Skill 正文。日常联调直连本地 website；自动化验证使用隔离 fixture，不生成伪造生产用户统计。配置与恢复步骤见 [运营统计部署](../runbooks/operational-tracking.md)。

2026-09-20 增加 conversations / skills 管理查询与视图，用户明细增加对话、Token、Skill 加载指标。SQLite schema v2 事务新增 runtime_facts，保留400天并跟随 activity_facts 级联清理，兼容旧消息事件。Token 按每个已结束步骤的最新报告统计；总量四桶相加，推理为输出子集；缺失用量独立展示。Skill 以成功加载指令为使用事实，按运行时名称聚合，区分显式/模型及失败；不等同于工作流完成，不把全部会话用量重复归到每个技能。匿名次数与用量可见，用户人数按当前登录工号归属。

2026-09-20 增加 environment=all 查询和“全部环境”选项，各指标从事实行统一去重，不相加各环境人数。页面移除平台筛选并合并平台数据；协议仍保留平台字段用于兼容与诊断。采集状态遵守日期/环境/版本筛选并按事实中的安装 ID 去重，避免安装表仅保存最近环境造成错数。metricVersion 升为3：登录用户数为有工号/身份的前台活动用户去重，主动使用人数和 DAU/MAU仍仅人工业务行为。用户、功能、Token、Skill、明细与排名均支持工号归属和全部环境。
