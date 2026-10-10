<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, guideApi } from '../guide-api'
import Icon from '../Icon.vue'
import WebsiteDialog from '../WebsiteDialog.vue'
import DepartmentLabel from './DepartmentLabel.vue'
import { analyticsViews, type AnalyticsView } from '../admin-route'
import { userSortKeys, type UserSortKey } from '../../shared/analytics'
import { analyticsQuery, readAnalyticsState, today, validDates, validEnvironment, type AnalyticsState } from './state'
import { columnsFor, defaultColumns, restoreColumns, format, fullDate, healthReasons, number, type Row, type Result } from './presentation'

const props = defineProps<{ view: AnalyticsView; query: string }>()
const emit = defineEmits<{ error: [error: unknown]; navigate: [view: AnalyticsView, query: string, replace?: boolean] }>()
const state = ref(readAnalyticsState(props.query))
const filters = ref({ ...state.value }), search = ref(state.value.search)
const busy = ref(false), error = ref(''), data = ref<Result>(), health = ref<Result>(), overview = ref<Result>(), profile = ref<Row>()
const trend = ref<Row[]>([]), tableRegion = ref<HTMLElement>(), columnsOpen = ref(false), columnDraft = ref<string[]>([])
const pageSizeMenu = ref<HTMLDetailsElement>()
const selectedColumns = ref<Partial<Record<AnalyticsView,string[]>>>({})
const returnTo = ref<{view: AnalyticsView; query: string; scroll: number}>()
let restoreScroll: number | undefined
let controller: AbortController | undefined
const environmentPreference = 'analytics.environment.v1'
const title = computed(() => analyticsViews.find(item => item.id === props.view)!.label)
const isUsers = computed(() => props.view === 'users' || props.view === 'rankings')
const paginated = computed(() => ['users','rankings','operations','skills'].includes(props.view))
const offset = computed(() => (state.value.page-1)*state.value.limit)
const rows = computed(() => data.value?.rows ?? [])
const allColumns = computed(() => columnsFor(props.view))
const columns = computed(() => allColumns.value.filter(c => (selectedColumns.value[props.view] ?? defaultColumns(props.view)).includes(c.key)))
const groups = computed(() => {
  const result: {label:string;span:number}[] = []
  for (const column of columns.value) {
    const last = result.at(-1)
    if (last?.label === column.group) last.span++
    else result.push({label:column.group,span:1})
  }
  return result
})
const totalPages = computed(() => data.value?.total == null ? undefined : Math.max(1,Math.ceil(data.value.total/state.value.limit)))
const pages = computed(() => {
  if (!totalPages.value) return [state.value.page]
  const start = Math.max(1,Math.min(state.value.page-2,totalPages.value-4))
  return Array.from({length:Math.min(5,totalPages.value)},(_,i)=>start+i)
})
const canNext = computed(() => !busy.value && offset.value+state.value.limit<=100000 && (totalPages.value ? state.value.page<totalPages.value : rows.value.length===state.value.limit))
const filtersChanged = computed(() => ['from','to','environment','appVersion'].some(key => filters.value[key as keyof AnalyticsState] !== state.value[key as keyof AnalyticsState]))
const lastReceived = computed(() => data.value?.dataThrough ? format('lastSeen', data.value.dataThrough) : '尚无数据')
const userName = computed(() => String(profile.value?.displayName ?? profile.value?.account ?? '所选用户'))
const metricSource = computed(() => isUsers.value ? overview.value : data.value)
const metrics = computed(() => {
  const d = metricSource.value
  if(props.view==='conversations')return [
    ['人工对话次数',d?.messages,'实际进入处理流程的 Web 用户消息数'],['人工会话数',d?.conversations,'所选期间有人工消息的会话去重'],['已报告 Token',d?.totalTokens,'所有来源，含缓存；推理不重复相加'],
    ['模型步骤',d?.modelSteps,'一次模型步骤可能请求多个工具'],['未报告用量',d?.missingUsage,'步骤数；缺失不等于零消耗'],['匿名 Token',d?.anonymousTokens,'未记录工号，仍计入总量'],
  ]
  if(props.view==='skills')return [['加载成功',d?.loads,'指令已提供给模型，不代表任务完成'],['显式加载',d?.explicitLoads,'通过 /技能名进入处理流程'],['模型加载',d?.modelLoads,'模型调用 Skill 工具成功'],['加载失败',d?.failures,'有明确结果的加载失败'],['已识别人数',d?.users,'成功加载的登录工号去重'],['使用会话数',d?.conversations,'成功加载的会话去重，含子代理']]
  if(props.view==='health')return [['所选范围事件',d?.collected,'按事件 ID 去重，不代表完整采集率'],['安装实例',d?.installations,'与用户人数分别统计'],['匿名事件',d?.anonymousEvents,'未归入用户活跃指标']]
  const core = [['登录用户数',d?.loginUsers,'所选期间有前台活动的登录工号去重'],['主动使用人数',d?.activeUsers,'所选期间发起业务操作或对话的用户'],['当日活跃',d?.dau,`${state.value.to} 的人工业务使用人数`],['成功操作数',d?.successes,'人工操作；变更类需实际生效']]
  return props.view==='overview'?[...core,['MAU',d?.mau,'截至所选日，近 30 天去重'],['DAU / MAU',d?.stickiness==null?'—':`${(Number(d.stickiness)*100).toFixed(1)}%`,'同一截至日的活跃比率']]:isUsers.value?core:[]
})
const description = computed(() => ({overview:'了解用户活跃与功能使用，按登录工号跨设备去重。',users:'查看和比较各用户的使用情况，了解用户活跃与功能使用。',rankings:'按活跃天数、成功操作数、使用功能数依次排序。',features:'区分功能访问与实际使用，了解各功能的使用覆盖。',conversations:'查看人工对话和模型报告的用量，区分来源与会话类型。',skills:'了解 Skill 指令的加载与使用覆盖，加载成功不代表任务完成。',operations:'查看操作的受理、完成与执行结果，明细保留 90 天。',health:'查看采集记录与拒收提示，了解当前数据的覆盖情况。'})[props.view])
const scopeNote = computed(() => ({overview:'DAU 只计已识别用户的人工业务受理，后台轮询与自动执行不计入。',users:'用户按工号跨设备去重；匿名记录不计入用户人数。',rankings:'排名仅描述产品使用情况，不代表工作质量或绩效。',features:'访问人数与使用人数分别统计，浏览页面不等于实际使用。',conversations:'Token = 普通输入 + 缓存读取 + 缓存写入 + 输出；推理已包含在输出中。',skills:'匿名加载计次数，不计用户人数；同名 Skill 暂不按版本与来源拆分。',operations:'受理与完成分别展示；同一操作在聚合统计中只计一次。',health:'上方指标遵循当前筛选；下方拒收原因是服务历史累计，不按日期或用户筛选。'})[props.view])
const chart = computed(() => {
  const count=Math.round((Date.parse(state.value.to)-Date.parse(state.value.from))/86400000)+1
  const reported=new Map(trend.value.map(row=>[String(row.day),Number(row.dau)]))
  const values=Array.from({length:count},(_,index)=>{const day=new Date(Date.parse(state.value.from)+index*86400000).toISOString().slice(0,10);return {day,value:reported.get(day)}})
  return {values,peak:Math.max(3,Math.ceil(Math.max(0,...trend.value.map(row=>Number(row.dau)))/3)*3)}
})
function navigate(patch: Partial<AnalyticsState> = {}, view = props.view, replace = false) {
  const next={...state.value,...patch}
  emit('navigate',view,analyticsQuery(next),replace)
}
function apply() {
  if (!validDates(filters.value.from,filters.value.to)) { error.value='请选择不超过 400 天、且不晚于今天的有效日期范围。'; return }
  if(filters.value.appVersion && !/^[0-9][a-zA-Z0-9.+-]{0,63}$/.test(filters.value.appVersion)){error.value='请输入有效的应用版本号。';return}
  try{localStorage.setItem(environmentPreference,filters.value.environment)}catch{}
  navigate({from:filters.value.from,to:filters.value.to,environment:filters.value.environment,appVersion:filters.value.appVersion.trim(),page:1})
  if(!filtersChanged.value)void load()
}
function applySearch(){navigate({search:search.value.trim(),page:1})}
function sortBy(key:string){if(props.view!=='users'||!userSortKeys.includes(key as UserSortKey))return;navigate({sort:key as UserSortKey,direction:state.value.sort===key&&state.value.direction==='desc'?'asc':'desc',page:1})}
function sortable(key:string){return props.view==='users'&&userSortKeys.includes(key as UserSortKey)}
function ariaSort(key:string):'ascending'|'descending'|'none'|undefined{return sortable(key)?state.value.sort===key?state.value.direction==='asc'?'ascending':'descending':'none':undefined}
function inspect(row:Row){returnTo.value={view:props.view,query:props.query,scroll:tableRegion.value?.scrollTop??0};navigate({user:String(row.userId),page:1,search:'',sort:''},'operations')}
function returnUsers(){const previous=returnTo.value;returnTo.value=undefined;if(previous){restoreScroll=previous.scroll;emit('navigate',previous.view,previous.query)}else navigate({user:'',page:1,search:'',sort:''},'users')}
function openColumns(){columnDraft.value=columns.value.map(c=>c.key);columnsOpen.value=true}
function saveColumns(){selectedColumns.value={...selectedColumns.value,[props.view]:allColumns.value.filter((c,i)=>i===0||columnDraft.value.includes(c.key)).map(c=>c.key)};columnsOpen.value=false;try{localStorage.setItem('analytics.columns.v2',JSON.stringify(selectedColumns.value))}catch{}}
function closePageSize(){if(pageSizeMenu.value){pageSizeMenu.value.open=false;pageSizeMenu.value.querySelector('summary')?.focus()}}
function changePageSize(limit:number){closePageSize();navigate({limit,page:1})}
async function load(){
  controller?.abort();const request=new AbortController();controller=request;busy.value=true;error.value=''
  try{
    if(validEnvironment(state.value.environment)&&props.query!==analyticsQuery(state.value)){navigate({},props.view,true);return}
    if(!validEnvironment(state.value.environment)){
      const context=await guideApi<{defaultEnvironment:string}>('/api/admin/analytics/context',{signal:request.signal})
      if(request.signal.aborted)return
      let saved:string|null=null;try{saved=localStorage.getItem(environmentPreference)}catch{}
      const environment=validEnvironment(saved)?saved:context.defaultEnvironment
      if(!validEnvironment(environment))throw new Error('INVALID_ANALYTICS_CONTEXT')
      navigate({environment},props.view,true);return
    }
    const q=new URLSearchParams({from:state.value.from,to:state.value.to,environment:state.value.environment,offset:String(offset.value),limit:String(state.value.limit)})
    if(state.value.appVersion)q.set('appVersion',state.value.appVersion)
    if(state.value.user)q.set('userId',state.value.user)
    const call=(kind:string,extra:Record<string,string>={})=>guideApi<Result>(`/api/admin/analytics/${kind}?${new URLSearchParams({...Object.fromEntries(q),...extra})}`,{signal:request.signal})
    const extra:Record<string,string>={}
    if(isUsers.value&&state.value.search)extra.search=state.value.search
    if(props.view==='users'&&state.value.sort){extra.sort=state.value.sort;extra.direction=state.value.direction}
    const [result,healthResult,overviewResult,trends,userResult]=await Promise.all([
      call(props.view,extra),props.view==='health'?Promise.resolve(undefined):call('health'),isUsers.value?call('overview'):Promise.resolve(undefined),props.view==='overview'?call('trends'):Promise.resolve(undefined),state.value.user?call(`users/${state.value.user}`,{offset:'0'}):Promise.resolve(undefined),
    ])
    if(request.signal.aborted)return
    data.value=result;health.value=healthResult??result;overview.value=overviewResult;trend.value=trends?.rows??[];profile.value=userResult?.rows?.[0]
    if(result.total!=null&&state.value.page>1&&offset.value>=result.total){navigate({page:Math.max(1,Math.ceil(result.total/state.value.limit))},props.view,true);return}
    await nextTick();if(restoreScroll!==undefined&&tableRegion.value){tableRegion.value.scrollTop=restoreScroll;restoreScroll=undefined}
  }catch(e){if(request.signal.aborted)return;error.value='统计暂时无法读取，请重试。已显示的数据可能不是最新。';if(e instanceof ApiError&&['AUTH_REQUIRED','CSRF_REJECTED'].includes(e.code))emit('error',e)}
  finally{if(controller===request)busy.value=false}
}
watch(()=>[props.view,props.query],()=>{state.value=readAnalyticsState(props.query);filters.value={...state.value};search.value=state.value.search;data.value=undefined;overview.value=undefined;health.value=undefined;profile.value=undefined;columnsOpen.value=false;void load()})
onMounted(()=>{try{const current=localStorage.getItem('analytics.columns.v2');const saved=JSON.parse(current??localStorage.getItem('analytics.columns.v1')??'{}');for(const entry of analyticsViews){const keys=restoreColumns(entry.id,saved[entry.id],current===null);if(keys)selectedColumns.value[entry.id]=keys}if(current===null)localStorage.setItem('analytics.columns.v2',JSON.stringify(selectedColumns.value))}catch{}void load()})
onBeforeUnmount(()=>controller?.abort())
</script>

<template>
  <section class="analytics" aria-label="运营统计" :aria-busy="busy">
    <div class="analytics-topline"><div class="analytics-breadcrumb">运营统计 <span>/</span> <strong>{{title}}</strong></div><div class="analytics-freshness"><span :title="fullDate(data?.dataThrough)">最近收到数据 <span class="freshness-time">{{lastReceived}}</span><span class="freshness-zone"> · 北京时间</span></span><button class="button secondary" :disabled="busy" @click="load">{{busy?'正在更新…':'刷新数据'}}</button></div></div>
    <header class="analytics-heading"><h1>{{view==='users'?'用户使用明细':title}}</h1><p>{{description}}</p></header>
    <form class="analytics-filters" @submit.prevent="apply">
      <label>开始日期<input v-model="filters.from" type="date" :max="today()" required /></label><label>结束日期<input v-model="filters.to" type="date" :max="today()" required /></label>
      <label>应用版本<input v-model="filters.appVersion" placeholder="全部版本" maxlength="64" pattern="[0-9][a-zA-Z0-9.+-]{0,63}" /></label>
      <fieldset><legend>环境</legend><label v-for="option in [['all','全部环境'],['production','生产环境'],['development','开发环境'],['test','测试环境']]" :key="option[0]"><input v-model="filters.environment" type="radio" name="analytics-environment" :value="option[0]" />{{option[1]}}</label></fieldset>
      <button class="button primary" :disabled="busy">应用筛选</button>
    </form>
    <p v-if="filtersChanged" class="analytics-pending" role="status">筛选条件已修改，应用后更新数据。</p>
    <div v-if="state.user" class="analytics-user"><div class="analytics-user-profile"><span>当前用户 <strong>{{userName}}</strong><span v-if="profile?.account && profile.account!==userName" class="analytics-user-account">{{profile.account}}</span></span><dl><div><dt>部门</dt><dd><DepartmentLabel :name="profile?.deptName" :full-name="profile?.departmentName" /></dd></div><div><dt>一级部门</dt><dd>{{profile?.deptL1Name || '—'}}</dd></div><div class="analytics-full-department"><dt>完整部门</dt><dd>{{profile?.departmentName || '—'}}</dd></div></dl><small>沿用当前日期、环境与版本</small></div><button class="button secondary" @click="returnUsers">返回用户列表</button></div>
    <div v-if="error" class="analytics-error" role="alert">{{error}}<button class="text-button" :disabled="busy" @click="load">重试</button></div>
    <p v-if="busy&&!data" class="analytics-loading" role="status">正在读取统计数据…</p>
    <template v-if="data">
      <div v-if="metrics.length" class="analytics-metrics" :class="{'six-metrics':metrics.length===6}"><article v-for="metric in metrics" :key="String(metric[0])"><span class="metric-help" tabindex="0" :aria-label="`${metric[0]}：${metric[2]}`">{{metric[0]}}<span role="tooltip">{{metric[2]}}</span></span><strong>{{number(metric[1])}}</strong></article></div>
      <p v-if="health&&!Number(health.collected)" class="analytics-empty">当前环境与筛选范围暂无采集记录。可调整日期或环境后重试。</p>
      <p v-else-if="health&&!Number(health.identifiedEvents)" class="analytics-notice">当前范围的 {{number(health.anonymousEvents)}} 条事件未记录登录工号。仍可查看操作、对话与 Skill 次数；历史匿名记录不归入当前账号。</p>
      <div v-if="view==='overview'" class="analytics-chart"><div class="analytics-block-heading"><div><h2>每日主动活跃用户</h2><p>按北京时间统计 · {{state.from}} 至 {{state.to}}</p></div><span class="chart-legend">主动使用人数</span></div>
        <p v-if="!trend.length" class="analytics-empty">所选范围暂无已识别用户的主动行为。</p>
        <template v-else><div class="analytics-chart-scroll"><svg :viewBox="`0 0 ${Math.max(800,chart.values.length*12)} 250`" role="img" aria-label="每日主动活跃用户柱状图；详细数值见下方每日数据"><g v-for="n in [0,1,2,3]" :key="n"><line x1="36" :x2="Math.max(800,chart.values.length*12)-12" :y1="210-n*60" :y2="210-n*60" stroke="var(--border-subtle)"/><text x="28" :y="214-n*60" text-anchor="end" fill="var(--text-secondary)" font-size="11">{{number(Math.ceil(chart.peak*n/3))}}</text></g><g v-for="(point,index) in chart.values" :key="point.day"><rect :x="42+index*(Math.max(800,chart.values.length*12)-60)/chart.values.length" :y="point.value==null?207:210-point.value/chart.peak*180" :width="Math.max(3,(Math.max(800,chart.values.length*12)-60)/chart.values.length*.65)" :height="point.value==null?3:Math.max(2,point.value/chart.peak*180)" :fill="point.value==null?'var(--border-default)':'var(--accent-primary)'" rx="2"><title>{{point.day}}：{{point.value==null?'无已识别用户记录':`${point.value} 人`}}</title></rect><text v-if="index%Math.max(1,Math.ceil(chart.values.length/8))===0" :x="42+index*(Math.max(800,chart.values.length*12)-60)/chart.values.length" y="238" fill="var(--text-secondary)" font-size="11">{{point.day.slice(5)}}</text></g></svg></div><p class="analytics-caption">浅灰标记表示当日没有已识别用户记录，不能据此判断采集是否完整；当天数据尚未结束。</p><details class="analytics-definitions"><summary>查看每日数据</summary><div class="daily-data"><p v-for="point in chart.values" :key="point.day"><time>{{point.day}}</time><span>{{point.value==null?'无已识别记录':`${number(point.value)} 人`}}</span></p></div></details></template>
      </div>
      <section v-else class="analytics-data" :aria-label="title">
        <div class="analytics-table-toolbar"><h2>{{title}}<span v-if="data.total!=null">（{{number(data.total)}} {{isUsers?'人':'项'}}）</span></h2><div class="analytics-table-tools"><form v-if="isUsers" class="analytics-search" role="search" @submit.prevent="applySearch"><input v-model="search" type="search" aria-label="搜索姓名或工号" placeholder="搜索姓名 / 工号" maxlength="80" /><button type="submit" :disabled="busy">搜索</button></form><button class="button secondary" @click="openColumns"><Icon name="grid" :size="15" />列设置</button></div></div>
        <p v-if="state.search&&isUsers" class="analytics-search-note">搜索“{{state.search}}”的结果 <button class="text-button" @click="navigate({search:'',page:1})">清除搜索</button><span> · 上方指标为当前时段的全部用户</span></p>
        <div v-if="rows.length" ref="tableRegion" class="analytics-table" role="region" :aria-label="`${title}表格，可横向滚动查看完整字段`" tabindex="0"><table>
          <thead><tr class="analytics-group-row"><th v-if="view==='rankings'" rowspan="2" scope="col" class="rank-column">排名</th><th v-for="(group,index) in groups" :key="`${group.label}-${index}`" scope="colgroup" :colspan="group.span">{{group.label}}</th><th v-if="isUsers" rowspan="2" scope="col" class="detail-column"><span class="sr-only">查看用户详情</span></th></tr>
            <tr><th v-for="(column,index) in columns" :key="column.key" scope="col" :aria-sort="ariaSort(column.key)" :class="{numeric:column.numeric,'identity-column':index===0}"><button v-if="sortable(column.key)" class="analytics-sort" :disabled="busy" @click="sortBy(column.key)">{{column.label}}<Icon name="chevron" :size="11" :class="['sort-indicator',state.sort===column.key?state.direction:'inactive']" /></button><template v-else>{{column.label}}</template></th></tr>
          </thead><tbody><tr v-for="(row,index) in rows" :key="String(row.userId??row.eventId??row.skillName??row.feature??row.code??`${row.initiator}:${row.sessionKind}`)"><td v-if="view==='rankings'" class="rank-column">{{offset+index+1}}</td><td v-for="(column,columnIndex) in columns" :key="column.key" :class="{numeric:column.numeric,'identity-column':columnIndex===0}">
              <button v-if="column.key==='displayName'&&isUsers" class="analytics-identity" @click="inspect(row)"><strong>{{row.displayName||row.account||'未提供姓名'}}</strong><small>{{row.displayName===row.account?'姓名未提供':row.account}}</small></button>
              <span v-else-if="column.key==='displayName'" class="analytics-identity"><strong>{{row.displayName||row.account||'未识别用户'}}</strong><small v-if="row.account && row.account!==row.displayName">{{row.account}}</small></span>
              <DepartmentLabel v-else-if="column.key==='deptName'" :name="row.deptName" :full-name="row.departmentName" />
              <span v-else-if="column.key==='outcome'" class="analytics-status" :class="String(row.outcome??'unknown')">{{format(column.key,row[column.key])}}</span>
              <span v-else-if="column.key==='code'" class="analytics-health-reason">{{healthReasons[String(row.code)]??'其他采集提示'}}<small>{{row.code}}</small></span>
              <span v-else :title="['lastSeen','occurredAt'].includes(column.key)?fullDate(row[column.key]):undefined">{{format(column.key,row[column.key])}}</span>
            </td><td v-if="isUsers" class="detail-column"><button class="analytics-view-user" :aria-label="`查看 ${row.displayName||row.account} 的使用明细`" @click="inspect(row)">查看<Icon name="chevron" :size="15" /></button></td></tr></tbody>
        </table></div>
        <div v-else class="analytics-empty"><strong>{{view==='health'?'暂无拒收记录':'没有符合筛选条件的记录'}}</strong><p>{{view==='health'?'服务尚未记录被拒收的事件。':state.search?'试试其他姓名或工号，或清除搜索条件。':state.user?'所选用户在当前范围内没有此类记录。':'可调整上方日期、环境或版本。'}}</p><button v-if="state.search" class="button secondary" @click="navigate({search:'',page:1})">清除搜索</button></div>
        <div v-if="paginated" class="analytics-pagination"><span>{{rows.length?`${number(offset+1)}–${number(offset+rows.length)}`:'0'}}<template v-if="data.total!=null"> / {{number(data.total)}}</template> {{isUsers?'人':view==='skills'?'项':'条记录'}}</span><div><button :disabled="busy||state.page===1" aria-label="上一页" @click="navigate({page:state.page-1})"><Icon class="previous-icon" name="chevron" :size="15" /></button><button v-for="page in pages" :key="page" :aria-current="state.page===page?'page':undefined" :disabled="busy" :aria-label="`第 ${page} 页`" @click="navigate({page})">{{page}}</button><button :disabled="!canNext" aria-label="下一页" @click="navigate({page:state.page+1})"><Icon name="chevron" :size="15" /></button><details ref="pageSizeMenu" class="analytics-page-size" @keydown.esc.prevent="closePageSize"><summary>{{state.limit}} 条 / 页</summary><div><button v-for="limit in [10,25,50,100]" :key="limit" :disabled="busy" @click="changePageSize(limit)">{{limit}} 条 / 页</button></div></details></div></div>
      </section>
      <div class="analytics-footer"><p>{{scopeNote}}</p><details class="analytics-definitions"><summary>统计口径</summary><p>所有时间为北京时间。用户以当前上报的登录工号跨设备去重，历史匿名事件不会追归之后登录的用户。人工对话仅覆盖官方 Web 消息入口；未知来源和子代理单独统计。</p><p v-if="view==='conversations'">仅统计已结束步骤报告的 Token。缺失用量不估算为零；模型重试、辅助模型请求和未结束步骤可能未覆盖。推理为输出的子集，不重复计入总量。</p><p v-if="view==='skills'">成功加载表示 Skill 指令已提供给模型，不等于任务完成。安装、目录浏览和未执行的点击不计为使用；同名技能暂不按版本或来源拆分。</p><p>统计生成时间：{{fullDate(data.asOf)}}。最后收到数据：{{fullDate(data.dataThrough)}}。</p></details></div>
    </template>
    <WebsiteDialog v-if="columnsOpen" title="设置显示列" message="保留身份列，选择需要比较的指标。设置仅保存在当前浏览器。" confirm-label="应用" @cancel="columnsOpen=false" @confirm="saveColumns"><fieldset class="analytics-column-choices"><legend class="sr-only">显示的字段</legend><label v-for="(column,index) in allColumns" :key="column.key"><input v-model="columnDraft" type="checkbox" :value="column.key" :disabled="index===0" />{{column.label}}<small>{{column.group}}</small></label></fieldset><button class="text-button" @click="columnDraft=defaultColumns(view)">恢复默认列</button></WebsiteDialog>
  </section>
</template>
<style src="./analytics.css"></style>
