import type { AnalyticsView } from '../admin-route'

const names: Record<string, string> = { tools: '工具', skills: '技能', knowledge: '知识库', experts: '专家', tasks: '定时任务', todos: '目标与待办', conversation: '会话', creation: '内容创作', authentication: '认证', navigation: '页面访问', succeeded: '成功', failed: '失败', cancelled: '已取消', partial: '部分完成', unknown: '未知', user: '人工', agent: '模型', scheduler: '定时执行', system: '系统' }
Object.assign(names, {
  root: '主会话', subagent: '子代理', 'conversation.model.usage': '模型用量', 'skill.load.completed': '加载技能',
  'page.view': '页面访问', 'feature.view': '功能访问', 'auth.login.succeeded': '登录成功', 'auth.logout': '退出登录', 'conversation.message.accepted': '发送消息',
  'tool.add': '添加工具', 'tool.remove': '移除工具', 'tool.config.save': '保存工具配置', 'tool.connection.test': '测试连接', 'tool.invoke': '调用工具',
  'skill.install': '安装技能', 'skill.update': '更新技能', 'skill.uninstall': '卸载技能', 'skill.source.import': '导入技能', 'skill.source.save': '保存技能', 'skill.source.delete': '删除技能',
  'knowledge.add': '添加知识库', 'knowledge.remove': '移除知识库', 'knowledge.bind': '绑定知识库', 'knowledge.unbind': '解绑知识库', 'knowledge.import': '导入知识', 'knowledge.update': '更新知识', 'knowledge.delete': '删除知识', 'knowledge.query': '检索知识',
  'expert.use': '使用专家', 'expert.create': '创建专家', 'expert.clone': '克隆专家', 'expert.update': '更新专家', 'expert.delete': '删除专家',
  'creation.generate': '生成内容', 'creation.publish': '保存作品', 'creation.export': '导出作品',
  'task.create': '创建任务', 'task.update': '更新任务', 'task.pause': '暂停任务', 'task.resume': '恢复任务', 'task.delete': '删除任务', 'task.run': '执行任务',
  'todo.refresh': '刷新待办', 'todo.suggestion.open': '查看建议',
})
export const label = (value: unknown) => value == null || value === '' ? '—' : names[String(value)] ?? String(value)

export type Row = Record<string, string | number | null>
export type Result = { rows?: Row[]; total?: number; dataThrough?: string | null; asOf?: string; [key: string]: unknown }
export type Column = { key: string; label: string; group: string; numeric: boolean }
const col = (key: string, label: string, group: string, numeric = true): Column => ({ key, label, group, numeric })
export function columnsFor(view: AnalyticsView): Column[] {
  if (view === 'users' || view === 'rankings') return [
    col('displayName','姓名 / 工号','用户',false), col('deptName','部门','用户',false), col('activeDays','活跃天数','活跃情况'), col('interactions','主动操作','活跃情况'), col('successes','成功操作','活跃情况'), col('features','使用功能数','活跃情况'),
    col('messages','对话次数','对话与用量'), col('conversations','会话数','对话与用量'), col('totalTokens','Token','对话与用量'), col('skillLoads','Skill 加载','对话与用量'), col('lastSeen','最近活动时间','最近活动',false),
  ]
  if (view === 'features') return [col('feature','功能','功能',false),col('users','使用人数','用户覆盖'),col('visitors','访问人数','用户覆盖'),col('uses','使用次数','使用情况'),col('successes','成功操作','操作结果'),col('failures','失败操作','操作结果')]
  if (view === 'conversations') return [col('initiator','来源','会话来源',false),col('sessionKind','会话类型','会话来源',false),col('messages','人工消息','对话与步骤'),col('conversations','人工会话','对话与步骤'),col('modelSteps','模型步骤','对话与步骤'),col('missingUsage','用量缺失','对话与步骤'),col('inputTokens','普通输入','输入 Token'),col('cacheReadTokens','缓存读取','输入 Token'),col('cacheWriteTokens','缓存写入','输入 Token'),col('outputTokens','输出','输出 Token'),col('reasoningTokens','其中推理','输出 Token'),col('totalTokens','Token 总量','汇总')]
  if (view === 'skills') return [col('skillName','Skill 名称','技能',false),col('loads','成功加载','加载结果'),col('failures','加载失败','加载结果'),col('users','已识别人数','使用覆盖'),col('installations','安装实例','使用覆盖'),col('conversations','会话数','使用覆盖'),col('explicitLoads','显式加载','加载方式'),col('modelLoads','模型加载','加载方式'),col('userLoads','人工回合加载','来源')]
  if (view === 'health') return [col('code','采集提示','拒收原因',false),col('count','记录数','历史累计')]
  return [col('occurredAt','时间','操作',false),col('displayName','姓名 / 工号','操作',false),col('deptName','部门','操作',false),col('feature','功能','操作',false),col('action','动作','操作',false),col('eventName','阶段','执行情况',false),col('initiator','来源','执行情况',false),col('outcome','结果','执行情况',false),col('durationMs','耗时','执行情况')]
}
export function restoreColumns(view: AnalyticsView, saved: unknown, addDepartment = false): string[] | undefined {
  if (!Array.isArray(saved)) return undefined
  return columnsFor(view).filter((column, index) => index === 0 || saved.includes(column.key) || (addDepartment && column.key === 'deptName')).map(column => column.key)
}
export function defaultColumns(view: AnalyticsView) {
  return columnsFor(view).filter(c => !['users','rankings'].includes(view) || !['features','messages','conversations'].includes(c.key)).map(c => c.key)
}
export function number(value: unknown) { return typeof value === 'number' ? new Intl.NumberFormat('zh-CN').format(value) : value == null ? '—' : String(value) }
export function fullDate(value: unknown) { return value ? new Date(String(value)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '尚无数据' }
export function format(key: string, value: unknown) {
  if (value == null || value === '') return key === 'displayName' ? '未识别用户' : '—'
  if (key === 'occurredAt' || key === 'lastSeen') return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(String(value)))
  if (key === 'durationMs') return Number(value) >= 1000 ? `${(Number(value)/1000).toFixed(2)} s` : `${number(value)} ms`
  if (key === 'eventName') return value === 'operation.accepted' ? '受理' : value === 'operation.finished' ? '完成' : label(value)
  if (typeof value === 'number') return number(value)
  return label(value)
}
export const healthReasons: Record<string,string> = {
  INVALID_EVENT:'事件格式不符合采集协议', EVENT_TIME_OUT_OF_RANGE:'事件时间超出接收范围', EVENT_ID_CONFLICT:'事件标识与已接收内容冲突', OPERATION_CONTEXT_CONFLICT:'操作的受理与完成信息不一致', INSTALLATION_MISMATCH:'安装实例信息不一致', ENVIRONMENT_MISMATCH:'事件环境与批次不一致',
}
