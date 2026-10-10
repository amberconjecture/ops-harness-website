# 运营统计部署

## WeLink 资料更新（2026-10-10）

先安装本仓库锁定的 `@dsh-ops/tracking-contract` 纯契约制品，执行 check/build 并重启官网，再更新工作助手。旧官网无法接收新资料字段；仅替换依赖而不重启进程也不生效。事件/批次版本仍为 1，目录版本为 4。启动自动把 SQLite v1/v2 事务迁移到 v3，保留用户、事实与事件；升级前按下文要求备份整个 analyticsDirectory。

工作助手在每次已有的 WeLink 登录状态查询后获取姓名与部门，随事件携带成功查询时间。官网按该时间保留最新资料；旧终端、空字段和旧缓存不覆盖已知值。资料查询失败仍可按工号上报，姓名未提供时显示工号。用户数、操作归属与历史匿名记录的处理不变；详情显示最新资料，不表示事件发生时的历史部门。

“用户明细、活跃排名、操作明细”显示姓名、工号与最小部门。悬浮部门或用 Tab 聚焦可查看完整部门，Escape 关闭；点击用户可在详情顶部查看一级部门和完整部门。首次升级自动在原列偏好中加入部门，之后可在“列设置”隐藏，刷新后保留。搜索仍按姓名/工号，部门列不排序。

以下资料只保存在受管理员鉴权保护的运营数据库及既有原始事件中，不进入普通服务日志。官网不读取工作助手 DSH_HOME，也不访问 WeLink 通讯录。

使用 Node 24 和 pnpm 11.19.0。运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build`。管理员配置保持原规则。升级配置时删除 trackingDevelopment，只保留 trackingEnabled；旧字段不再接受，需从实际加载的完整配置中移除。

| 配置字段 | 默认值 / 用途 |
| --- | --- |
| analyticsDirectory | ../.runtime/website-analytics，相对 config 文件目录 |
| trackingEnabled | 缺省 false；true 接收本机/远程 Host，false 关闭；仓库配置为 true |

本地联调直接运行 `pnpm dev`，地址为 `http://127.0.0.1:4173`。产品仓库 `pnpm local:start` 的开发 overlay 已指向此地址，并使用 development 环境。两端无需配置上传 Token、安装凭据数组或 SSO 变量。安装 ID 自动生成，作为批次字段上传，不需要人工登记。

接收批次为 `{schemaVersion:1, installationId, environment, events}`；environment 可为 production/development/test，逐条核对事件安装 ID 与环境。沿用历史 tenant=development 作为单租户命名空间，不改变已有工号/去重记录，与事件环境无关。无需 Authorization，拒绝浏览器 Origin/Fetch-Metadata；每分钟最多 120 次采集请求，限制大小、并发、有效时间与重复 ID。

当前用户直接按终端左下角的 WeLink 登录工号归属，无需额外 SSO；没有工号的事件仍匿名，安装数不能替代用户人数。旧 identity-sessions 不开放。部署官网的完整配置中设置 `"trackingEnabled": true`，构建后正常 `pnpm start` 即可接收远程工作助手；工作助手保持 environment=production，并把 collectionOrigin 设为实际官网 HTTP/HTTPS origin（无页面/API 路径）。修改配置后重启官网和工作助手。采集认证后续实现，管理员鉴权不变。缺少 trackingEnabled 或配置为 false 时，任何启动方式均关闭采集（503 TRACKING_NOT_ENABLED）；true 时接收所有环境的本机/远程 Host 上报。

事件 API 只允许 Host 上传，开发上报无需密码；管理查询必须先通过现有 `/api/admin/login`。管理员进入 `/admin` → “运营统计”。`pnpm dev`（--dev）默认开发，`pnpm start` 默认生产，与采集开关无关；手动选择保留为浏览器 UI 偏好，开发/测试仍可通过筛选明确切换。页面通过认证保护的 `/api/admin/analytics/context` 获取默认值，不根据浏览器域名猜测。DAU 覆盖的是已接入的主动业务事件；页面访问与系统调度单独计数。当前已覆盖官方 Web 人工消息，未知入口/后台及子代理不增加人工次数。

页面为空先核对环境、日期和版本筛选。采集状态有匿名事件时，可在操作明细、对话与 Token、Skill 使用查看次数；人数为零时检查新事件是否携带工号；没有工号的历史事件不追归当前账号。开发服务重启会使内存管理员会话失效，需要重新登录。

后台可直接使用 `/admin#analytics/users` 打开用户明细，`/admin#analytics/overview` 打开总览。日期、环境、版本、搜索、排序、分页与选中用户会写入 `#` 后的参数，刷新或重新登录后保持当前页面，浏览器前进/后退可恢复查询。文档编辑也会保留选中的文档，例如 `/admin#guides/installation`。链接可能包含搜索工号，分享前按需要清除。

用户明细支持姓名/工号搜索、点击表头排序、每页 10/25/50/100 条以及列设置；搜索和排序针对完整查询结果执行，然后分页。搜索只影响列表，上方指标仍是当前日期、环境与版本的全部用户；活跃排名保持既有排名规则。点击姓名或“查看”进入个人操作明细，“返回用户列表”恢复之前的筛选和分页；直接打开个人链接时返回当前范围的用户列表。列设置只保存在当前浏览器。

存储为单机本地盘 SQLite，不能多个官网实例共用网络盘。数据处理在 Worker 中，最多 64 个待执行请求；采集 HTTP 最多 32 并发，接收每分钟 120 请求，每批100事件/256KiB。数据库故障返回 503，终端保留队列重试。

明细90天、去重120天、轻量事实与日汇总400天；补传最多30天，未来偏差最多5分钟。每小时维护。停服后备份整个 analyticsDirectory（包含可能存在的 WAL/SHM），或使用 SQLite 官方在线备份；运行时不能只复制主数据库。恢复整套数据库后重启，终端可能重传，由幂等表去重。

当前不提供按员工绩效评分、在线时长、自动数据导出或员工账号管理。生产采集认证、真实 Windows 客户端后续在对应环境验收。验收使用独立临时目录，覆盖 production/development/test 分类；不向实际部署站点上传测试数据。

## 对话与 Skill 统计

升级 tracking-contract vendor 制品并安装依赖后需重启官网进程，再启动新客户端；`tsx watch` 不保证监视 node_modules 的制品替换。协议目录版本4仍使用批次schemaVersion1。旧进程拒收新事件时先核对制品与运行进程，不清空幂等表/终端游标或重造ID。

进入“对话与 Token”查看人工消息次数、去重会话数、模型步骤、缺失用量和四桶 Token。推理 Token 已包含在输出中，不再次相加；总量包含匿名与后台来源，表格分列来源及主会话/子代理。“Skill 使用”按运行时名称列出成功/失败、显式/模型加载、用户/安装实例/会话覆盖。加载不等于业务完成，同名不同版本或来源暂合并。

用户明细增加对话次数、会话数、Token、Skill 加载数；点姓名后切换视图，可查看该用户明细。新事件自动附加当前 WeLink 工号，官网按工号跨设备去重；无需配置新的 SSO 接口。旧匿名数据不会追归后来的登录者。

schema v1→v2 在启动时自动事务迁移，不清空旧数据。runtime_facts 与事件幂等接收同事务写入，保留400天；原始事件90天过期后仍能查询用量和Skill统计。旧版空属性人工消息保留次数，因缺少会话标识不补造会话数。SDK 仅观察实时追加，旧会话不回填；崩溃前未结束步骤、辅助模型请求及隐藏重试不保证覆盖。

环境支持“全部环境 / 生产 / 开发 / 测试”，全部环境会在事实层统一去重；平台筛选已移除，默认合并所有平台。登录用户数统计所选期间有登录工号且有前台活动的用户，主动使用人数/DAU/MAU只统计人工业务使用。采集状态按所选日期、环境、版本统计事件和安装数。

## 部署后无数据

先检查官网启动日志中的 `[tracking] collection=enabled scope=host`，再检查工作助手 backend 日志中的 `ops-tracking upload-started`，应显示实际官网地址。首次上报失败会记录 HTTP 状态、错误码、积压和重试时间，恢复后显示 upload-recovered。

- TRACKING_NOT_ENABLED：实际加载的配置没有开启 trackingEnabled，或官网未重启。
- LOCAL_UPLOAD_REQUIRED / PRODUCTION_TRACKING_NOT_IMPLEMENTED：官网仍使用旧实现，需要更新构建并重启。
- HTTP_404 / INVALID_ACK：代理未把 `/api/tracking/v1/events:batch` 交给官网 Node 服务，或运行了错误站点。
- ECONNREFUSED / ENOTFOUND / UPLOAD_TIMEOUT：地址、监听网卡、DNS、代理或连接异常。
- EVENTS_REJECTED：查看安全拒收原因；EVENT_TIME_OUT_OF_RANGE 是超过30天/时钟偏差，INVALID_EVENT 需核对协议版本。

旧客户端的 production-upload-pending 不会发出请求，需更新客户端代码/安装包。本次接收修复也要更新并重启官网；仅改 environment 无法修复旧版本。原文件和 checkpoint 保留，升级后自动补传有效窗口内的事件。官网选择“生产”或“全部环境”；有次数但没有用户时再检查工号归属。此次事件契约未变，官网 tracking vendor 不需要替换。
