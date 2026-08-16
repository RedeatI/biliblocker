/**
 * 内容脚本 UI 文案（简体中文）集中管理，为后续国际化预留结构。
 * options/popup 页面文案在 Vue 组件内（v1 简体中文），同样遵循可替换原则。
 */

export const STRINGS = {
  quickAction: {
    oneClick: '一键拉黑并举报',
    blockNoReport: '拉黑（不举报）',
    localOnly: '加入本地黑名单并隐藏本页内容',
    localAndReport: '加入本地黑名单并举报',
    more: '更多操作',
    hideOnly: '仅隐藏此条',
    hideAuthorOnPage: '加入本地黑名单并隐藏本页内容',
    whitelist: '加入白名单',
    markVerified: '标记为已确认机器人',
    blockOnly: '官方拉黑但不举报',
    blockAndReport: '拉黑并自动举报',
    showRules: '查看命中规则',
    showLogs: '查看本地操作记录',
    noUid: '无法取得该账号 UID，仅可隐藏内容；不能加入白名单或标记为已确认机器人',
    noContentId: '无法取得内容 ID，无法提交举报',
    noContentIdBlockOnly: '无法取得内容 ID：将只执行拉黑（不举报），不会提交举报',
    localOnlyTitle: '当前官方能力尚未通过真实账号验证；仅写入本地黑名单并隐藏本页内容，不发送任何请求',
    blockCapabilityUnavailable: '官方拉黑能力尚未通过真实账号验证，当前不可用',
    reportCapabilityUnavailable: '官方举报能力尚未通过真实账号验证，当前不可用',
    whitelisted: '该账号在白名单中，主按钮已禁用；请先在设置中移出白名单',
    self: '这是你自己的内容',
    processing: '处理中…',
    menuTitle: 'BiliBlocker 操作',
  },
  placeholder: {
    collapsedByRules: '此内容已被规则折叠',
    hiddenByRules: '此内容已被规则隐藏',
    view: '临时查看',
    releaseOnce: '仅本次放行',
    whitelist: '加入白名单',
    rules: '查看触发规则',
    oneClick: '一键拉黑并举报',
    hideSimilar: '隐藏本页同类内容',
    reasons: '查看原因',
  },
  flag: {
    label: '疑似内容',
    showRules: '查看命中原因：{names}',
    showRulesGeneric: '查看命中原因',
  },
  toast: {
    countdownBlockReport: '将在 {n} 秒后拉黑并举报',
    countdownBlock: '将在 {n} 秒后拉黑',
    countdownReport: '将在 {n} 秒后举报',
    /** P1-2（v0.1.3）：零官方任务（能力未验证/未登录）时的本地处理倒计时 */
    countdownLocal: '将在 {n} 秒后完成本地处理',
    cancel: '取消',
    /** P0-2：取消全部操作（回滚本地名单与 UI，不入队） */
    cancelAll: '取消全部操作',
    /** P0-2：仅取消尚未发送的官方任务（保留本地记录与折叠） */
    cancelOfficialOnly: '仅取消官方任务',
    cancelled: '已取消',
    cancelledAll: '已取消全部操作：未写入名单、未发送任何请求',
    cancelledOfficialOnly: '已保留本地记录，未发送官方任务',
    countdownHint: '倒计时结束前可选择：',
    localHidden: '已隐藏该内容',
    /** P1-2（v0.1.3）：仅临时折叠（尚未提交，可随时恢复） */
    foldPreviewOnly: '已临时折叠（尚未提交，可随时恢复）',
    blocked: '官方拉黑成功',
    unblocked: '已解除拉黑',
    blockFailed: '官方拉黑失败：{msg}',
    reportSubmitted: '举报已提交（无法由扩展撤回）',
    reportFailed: '举报失败：{msg}',
    reportInvalidReason: '举报理由已失效，请在设置页重新选择',
    loginRequired: '请先登录 Bilibili',
    loginExpired: '登录状态已失效，自动操作已暂停',
    riskControl: '检测到验证码/风控，自动操作已暂停',
    queuePaused: '操作队列已暂停：{reason}',
    queueResumed: '操作队列已恢复',
    whitelistAdded: '已加入白名单',
    verifiedAdded: '已标记为已确认机器人',
    blockedLocal: '已加入本地黑名单',
    enqueued: '已加入操作队列',
    /** P0-2：零官方任务时的提示（不得显示「已加入队列」） */
    localOnlyDone: '仅本地处理完成；官方能力尚未验证，本次未发送任何请求',
    /** P1-2（v0.1.3）：需要登录导致官方任务被跳过（本地动作仍完成） */
    loginSkipLocalDone: '本地处理完成；官方任务因未登录被跳过，本次未发送任何请求',
    /** P0-3：结果未知（SW 崩溃恢复）提示 */
    outcomeUnknown: '当前请求结果可能未知（SW 中断恢复），已请求人工核对，未自动重发',
    /** P1-2（v0.1.3）：因撤权被跳过 */
    revokeSkipped: '任务已取消：{reason}',
    /** P1-2（v0.1.3）：请求已派发 */
    dispatched: '请求已派发',
    /** P1-2（v0.1.3）：提交被 background 拒绝 */
    commitRejected: '操作未执行：{reason}',
    rulesMatched: '命中规则：{names}',
    noRules: '未命中任何规则',
    notNow: '本次已放行',
    hideSimilarDone: '已隐藏本页该账号的 {n} 条内容',
    /** P0-4：能力未验证提示 */
    capabilityNotVerified: '真实能力未验证：{detail}',
    /** P1-2（v0.1.3）：本地提交失败（保持零副作用） */
    localCommitFailed: '本地提交失败，已恢复原状，未写入任何数据',
  },
  status: {
    pending: '等待执行',
    success: '成功',
    failed: '失败',
  },
} as const;

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    vars[key] !== undefined ? String(vars[key]) : `{${key}}`,
  );
}
