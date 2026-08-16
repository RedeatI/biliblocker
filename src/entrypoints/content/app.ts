/**
 * ContentApp：内容脚本主编排器。
 *
 * 职责：
 * - 加载设置/规则/名单，缓存当前登录用户；
 * - 驱动页面观察器 → 提取 → 规则引擎 → 隐藏/占位 → 快捷按钮（P1-2 后代扫描）；
 * - 一键拉黑并举报流程（P0-2 能力优先：先过滤官方任务，后检查登录；本地动作独立于登录；
 *   P0-4 倒计时只属于 UI，结束后经 BB_COMMIT_ACTION 在 background 单所有者短事务内原子提交）；
 * - 已确认机器人自动处理（P0-3 证据模型：需账号授权证据 + 独立内容违规证据 + 可取消倒计时）；
 * - 作为后台队列的执行器（EXECUTE_TASK 消息 → Bilibili 适配器 → 结果回传，P1-6 Zod 校验；
 *   派发时对官方任务做登录复查）。
 */
import { browser } from 'wxt/browser';
import { StorageRepository } from '../../storage/repository';
import { chromeStorageBackend } from '../../storage/backend';
import { RuleEngine } from '../../rules/engine';
import { buildActionPlan, BLOCK_ONLY_SIDE_EFFECTS } from '../../rules/evidence';
import { BilibiliAuthStateAdapter } from '../../adapters/bilibili/auth';
import { BilibiliBlockAdapter } from '../../adapters/bilibili/block';
import { BilibiliReportAdapter } from '../../adapters/bilibili/report';
import { extractComment, extractDynamic, findCommentActionAnchor } from '../../adapters/bilibili';
import { buildContext } from '../../adapters/context';
import {
  detectPageScope,
  COMMENT_SELECTORS,
  DYNAMIC_SELECTORS,
} from '../../adapters/bilibili/selectors';
import {
  QuickActionController,
  resolveContentIdAction,
  resolvePrimaryActionKind,
} from '../../ui/quick-action/controller';
import { PlaceholderController } from '../../ui/placeholder/controller';
import { FlagIndicatorController, resolveContentPresentation } from '../../ui/flag/controller';
import { ToastManager } from '../../ui/toast/manager';
import { fmt, STRINGS } from '../../shared/strings';
import { contentHash, shortId } from '../../shared/utils';
import { resolveDefaultReason } from '../../shared/constants/report-reasons';
import {
  canUseOfficialRequest,
  canRefreshOfficialLogin,
  canReportContentType,
  capabilityDenyReason,
  CONTENT_TYPE_CAPABILITY,
  type CapabilityKey,
} from '../../shared/capabilities';
import { parseBackgroundToContent, type TaskInput, type ListMutation } from '../../shared/messages';
import type {
  ActionTask,
  EngineDecision,
  ExtractedContent,
  PageScope,
  Rule,
  Settings,
  TaskResult,
} from '../../shared/types';
import { PageObserver } from './observer';
import { firstSelectorDeep, querySelectorAllDeep } from '../../shared/composed-dom';

/** 内容脚本会话 nonce（P1-6：任务派发时验证发起页面身份，防旧 tabId 复用） */
export function createSessionNonce(): string {
  return shortId('nonce');
}

/** P0-2：一键/自动处理动作计划（ActionExecutionPlan 的本地子集；官方字段由能力门禁决定） */
interface ActionFlowPlan {
  fold: boolean;
  commitLocalBlock: boolean;
  commitVerified: boolean;
  enqueueOfficialBlock: boolean;
  enqueueReport: boolean;
  source: 'one_click' | 'auto_process' | 'manual';
}

export class ContentApp {
  /** P1-1（v0.1.3）：内容脚本只读存储；所有写入经 background 的 StorageCoordinator */
  private repo = new StorageRepository(chromeStorageBackend(), { allowWrites: false });
  private auth = new BilibiliAuthStateAdapter();
  private blockAdapter = new BilibiliBlockAdapter();
  private reportAdapter = new BilibiliReportAdapter();
  private engine!: RuleEngine;

  /** 本页面会话 nonce（P1-6） */
  private readonly frameNonce = createSessionNonce();

  private settings: Settings | null = null;
  private rules: Rule[] = [];
  private blockedSet = new Set<number>();
  private verifiedSet = new Set<number>();
  private whitelistSet = new Set<number>();
  private currentMid: number | null = null;
  private loginOk = false;

  private pageScope: PageScope = 'dynamic_feed';
  private videoAid: string | null = null;
  private dynamicId: string | null = null;

  private decisionCache = new WeakMap<HTMLElement, EngineDecision>();
  private released = new WeakSet<HTMLElement>();
  private autoTriggered = new Set<string>();
  private quick!: QuickActionController;
  private placeholder!: PlaceholderController;
  private flagIndicator!: FlagIndicatorController;
  private observer: PageObserver | null = null;

  async init(): Promise<void> {
    await this.repo.init();
    this.settings = await this.repo.getSettings();
    this.rules = await this.repo.getRules();
    await this.refreshLists();
    // 默认关闭及所有未验证端点下，不探测登录态：/nav 本身也是官方请求。
    // refreshLogin 内部保留门禁，避免未来调用点绕过此契约。
    await this.refreshLogin(true);

    this.engine = new RuleEngine({
      currentMid: this.currentMid,
      onRuleError: (rule) => {
        void this.disableBrokenRule(rule);
      },
    });
    // P1-1：遍历全部变化键并失效缓存（不只处理第一个键）
    browser.storage.onChanged.addListener((changes) => {
      void this.onStorageChanged(changes as Record<string, { newValue?: unknown }>);
    });

    // 注册快捷操作 UI
    this.quick = QuickActionController.init(this.buildQuickCallbacks());
    this.placeholder = new PlaceholderController(this.buildPlaceholderCallbacks());
    this.flagIndicator = new FlagIndicatorController({
      onShowRules: (node) => {
        const entry = this.quick.getContext(node);
        if (entry) this.buildQuickCallbacks().onShowRules(entry.extracted, entry.ctx.matchedRuleNames);
      },
    });

    // 初始化页面
    this.detectPage();

    // 启动观察器
    this.observer = this.buildObserver();
    this.observer.start();

    // 注册后台消息（任务执行 + 状态通知；P1-6 Zod 校验）
    browser.runtime.onMessage.addListener((msg: unknown) => {
      void this.onBackgroundMessage(msg);
    });

    // 通知后台本页面就绪（注册为执行器 + 帧身份）
    this.pingBackground();
  }

  // ---------------- 状态 ----------------

  private async refreshLists(): Promise<void> {
    const [blocked, verified, whitelist] = await Promise.all([
      this.repo.getBlocked(),
      this.repo.getVerified(),
      this.repo.getWhitelist(),
    ]);
    this.blockedSet = new Set(blocked.map((b) => b.uid));
    this.verifiedSet = new Set(verified.map((v) => v.uid));
    this.whitelistSet = new Set(whitelist.map((w) => w.uid));
  }

  private async refreshLogin(force = false): Promise<void> {
    if (!canRefreshOfficialLogin(this.settings)) {
      this.loginOk = false;
      this.currentMid = null;
      this.engine?.setCurrentMid(null);
      return;
    }
    const state = await this.auth.checkLogin(force);
    this.loginOk = state.isLogin;
    this.currentMid = state.mid;
    this.engine?.setCurrentMid(this.currentMid);
  }

  /** P1-1：遍历全部变化键；import/reset/clear（BB_REFRESH_DATA）触发全量刷新 */
  private async onStorageChanged(changes: Record<string, { newValue?: unknown }>): Promise<void> {
    const keys = this.repo.applyExternalChanges(changes);
    for (const key of keys) {
      if (key === 'bb.settings') {
        this.settings = (changes[key]?.newValue as Settings) ?? this.settings;
      } else if (key === 'bb.rules') {
        this.rules = (changes[key]?.newValue as Rule[]) ?? this.rules;
      } else if (key === 'bb.blocked' || key === 'bb.verified' || key === 'bb.whitelist') {
        await this.refreshLists();
      }
    }
    if (
      keys.includes('bb.settings') ||
      keys.includes('bb.rules') ||
      keys.includes('bb.blocked') ||
      keys.includes('bb.verified') ||
      keys.includes('bb.whitelist')
    ) {
      // 设置/规则/名单变化后重新处理当前已注入节点（重新决策折叠/按钮状态）
      this.observer?.rescan();
    }
  }

  private async disableBrokenRule(rule: Rule): Promise<void> {
    const list = this.rules.filter((r) => r.id !== rule.id);
    list.push({ ...rule, enabled: false, updatedAt: Date.now() });
    this.rules = list;
    try {
      // P1-1（v0.1.3）：规则写收归 background（全局写锁 + CAS 拒绝过期覆盖）
      await this.mutate({
        op: 'saveRules',
        rules: list,
        expectedRevision: await this.repo.getRulesRevision(),
      });
    } catch (e) {
      console.warn('[BiliBlocker] 规则自动停用写入失败（并发冲突或 background 不可用）:', e);
    }
    ToastManager.get().show({
      level: 'warning',
      title: '规则已自动停用',
      message: `规则「${rule.name}」执行出错（可能为正则异常），已自动停用以避免影响其他规则。`,
      duration: 6000,
    });
  }

  // ---------------- 页面检测 ----------------

  private detectPage(): void {
    this.pageScope = detectPageScope(location.pathname);
    this.videoAid = null;
    this.dynamicId = null;
    if (this.pageScope === 'video_page') {
      this.videoAid = extractVideoAid();
    } else if (this.pageScope === 'dynamic_detail') {
      this.dynamicId = extractDynamicId(location.pathname);
    }
    // 这里不做登录态探测。refreshLogin 仅在真实官方任务已由运行时能力门禁放行时调用。
  }

  /** 观察器目标选择器（P1-2 后代扫描使用；集中维护于 selectors.ts） */
  private targetSelectors(): string[] {
    return [
      ...COMMENT_SELECTORS.rootItem,
      ...COMMENT_SELECTORS.rootWrapper,
      ...COMMENT_SELECTORS.subItem,
      ...DYNAMIC_SELECTORS.item,
      ...DYNAMIC_SELECTORS.card,
    ];
  }

  private buildObserver(): PageObserver {
    return new PageObserver({
      isTarget: (node) => isTargetNode(node, this.pageScope),
      targetSelectors: this.targetSelectors(),
      onBatch: (nodes) => this.processNodes(nodes),
      onNavigate: (url) => {
        void url;
        this.detectPage();
        // 重新注册帧身份（URL 变化，供后台任务派发校验）
        this.pingBackground();
        // 页面切换时重建 DOM observer（P0-5：路由观察器保持单例，此处仅重建 DOM 部分）
        const obs = this.buildObserver();
        this.observer?.stop();
        this.observer = obs;
        obs.start();
      },
      onInitialScan: () => this.initialScan(),
    });
  }

  private async initialScan(): Promise<void> {
    const nodes: HTMLElement[] = [];
    let selectors: readonly string[] = [];
    if (this.pageScope === 'video_page') {
      selectors = [...COMMENT_SELECTORS.rootItem, ...COMMENT_SELECTORS.subItem];
    } else if (this.pageScope === 'dynamic_feed') {
      selectors = DYNAMIC_SELECTORS.item;
    } else {
      // dynamic_detail：主卡片 + 评论区
      selectors = [
        ...DYNAMIC_SELECTORS.item,
        ...COMMENT_SELECTORS.rootItem,
        ...COMMENT_SELECTORS.subItem,
      ];
    }
    if (selectors.length > 0) {
      for (const el of querySelectorAllDeep<HTMLElement>(document, selectors.join(','))) {
        if (el.isConnected && isTargetNode(el, this.pageScope)) nodes.push(el);
      }
    }
    if (nodes.length > 0) await this.processNodes(nodes);
  }

  private async processNodes(nodes: HTMLElement[]): Promise<void> {
    for (const node of nodes) {
      if (!node.isConnected) continue;
      try {
        this.processOne(node);
      } catch (e) {
        console.warn('[BiliBlocker] 处理节点失败', e);
      }
    }
  }

  private processOne(node: HTMLElement): void {
    // 判断节点类型并提取
    const extracted = this.tryExtract(node);
    if (!extracted) return;
    if (this.released.has(node)) {
      // 仅本次放行：仍注入快捷按钮但不隐藏
      this.flagIndicator.remove(node);
      this.attachQuickAction(extracted, null);
      return;
    }
    void this.evaluateAndApply(extracted);
  }

  private tryExtract(node: HTMLElement): ExtractedContent | null {
    const scope = this.pageScope;
    if (scope === 'video_page') {
      if (
        node.matches(COMMENT_SELECTORS.rootItem.join(',')) ||
        node.matches(COMMENT_SELECTORS.rootWrapper.join(','))
      ) {
        const target = this.normalizeCommentTarget(node);
        const r = extractComment(target, {
          contentType: 'video_comment',
          pageScope: 'video_page',
          videoId: this.videoAid,
        });
        return r.data ?? null;
      }
      if (node.matches(COMMENT_SELECTORS.subItem.join(','))) {
        const r = extractComment(node, {
          contentType: 'video_reply',
          pageScope: 'video_page',
          videoId: this.videoAid,
        });
        return r.data ?? null;
      }
    }
    if (scope === 'dynamic_feed') {
      if (node.matches(DYNAMIC_SELECTORS.item.join(','))) {
        const r = extractDynamic(node, { pageScope: 'dynamic_feed' });
        return r.data ?? null;
      }
      if (
        node.matches(DYNAMIC_SELECTORS.card.join(',')) &&
        !node.closest(DYNAMIC_SELECTORS.item.join(','))
      ) {
        const r = extractDynamic(node, { pageScope: 'dynamic_feed' });
        return r.data ?? null;
      }
    }
    if (scope === 'dynamic_detail') {
      if (node.matches(DYNAMIC_SELECTORS.item.join(','))) {
        const r = extractDynamic(node, { pageScope: 'dynamic_detail' });
        return r.data ?? null;
      }
      if (
        node.matches(DYNAMIC_SELECTORS.card.join(',')) &&
        !node.closest(DYNAMIC_SELECTORS.item.join(','))
      ) {
        const r = extractDynamic(node, { pageScope: 'dynamic_detail' });
        return r.data ?? null;
      }
      if (
        node.matches(COMMENT_SELECTORS.rootItem.join(',')) ||
        node.matches(COMMENT_SELECTORS.rootWrapper.join(','))
      ) {
        const target = this.normalizeCommentTarget(node);
        const r = extractComment(target, {
          contentType: 'dynamic_comment',
          pageScope: 'dynamic_detail',
          videoId: this.dynamicId,
        });
        return r.data ?? null;
      }
      if (node.matches(COMMENT_SELECTORS.subItem.join(','))) {
        const r = extractComment(node, {
          contentType: 'dynamic_comment',
          pageScope: 'dynamic_detail',
          videoId: this.dynamicId,
        });
        return r.data ?? null;
      }
    }
    return null;
  }

  /** 包装层节点归一化到内层 .reply-item（防重复注入与重复折叠） */
  private normalizeCommentTarget(node: HTMLElement): HTMLElement {
    if (node.matches(COMMENT_SELECTORS.rootItem.join(','))) return node;
    const inner = firstSelectorDeep<HTMLElement>(node, COMMENT_SELECTORS.rootItem);
    return inner ?? node;
  }

  private async evaluateAndApply(extracted: ExtractedContent): Promise<void> {
    const settings = this.settings ?? (await this.repo.getSettings());
    // 总开关关闭：不隐藏、不注入快捷按钮（执行器仍独立可用）
    if (!settings.enabled) {
      this.flagIndicator.remove(extracted.node);
      this.placeholder.restore(extracted.node);
      return;
    }
    const uid = extracted.uid;
    const ctx = buildContext(extracted, {
      isLocalBlocked: uid !== null && this.blockedSet.has(uid),
      isWhitelisted: uid !== null && this.whitelistSet.has(uid),
      isVerifiedMachine: uid !== null && this.verifiedSet.has(uid),
    });
    const decision = this.engine.evaluate(ctx, this.rules);
    this.decisionCache.set(extracted.node, decision);

    // ---- 快捷按钮（先注入：占位条构建时需要读取节点上下文判断 canOfficial） ----
    this.attachQuickAction(extracted, decision);

    // ---- 隐藏/折叠/仅标记 ----
    const typeEnabled = extracted.contentType.startsWith('video')
      ? settings.videoCommentsEnabled
      : settings.dynamicsEnabled;
    const ruleNames = RuleEngine.matchedRuleNames(decision);
    const presentation = resolveContentPresentation(
      decision,
      settings.suspiciousHandling,
      typeEnabled,
    );
    if (presentation === 'flag') {
      // flag_only 将原本的隐藏/折叠安全降级为纯本地提示；不把推荐内容冒充违规。
      this.placeholder.restore(extracted.node);
      this.flagIndicator.attachOrUpdate(
        extracted.node,
        ruleNames,
        this.actionMountFor(extracted),
      );
    } else {
      this.flagIndicator.remove(extracted.node);
      if (presentation === 'hide') {
        this.placeholder.hide(extracted.node);
      } else if (presentation === 'collapse') {
        this.placeholder.collapse(extracted.node, { ruleNames });
      } else {
        // 重评估后不再命中、类型关闭或被白名单保护：撤销旧的折叠/隐藏 UI。
        this.placeholder.restore(extracted.node);
      }
    }

    // ---- P0-3：动作计划（证据模型） ----
    const plan = buildActionPlan(decision, ctx, { userConfirmed: false });

    // ---- 自动处理已确认机器人（仅精确 UID 名单 + 独立证据 + 用户授权） ----
    // P0-5（v0.1.4）：本地动作（折叠/本地名单）不依赖缓存登录状态；
    // 登录检查只在存在可执行官方任务时由 runActionFlow 内进行（P0-2 能力过滤后）。
    if (
      settings.enabled &&
      settings.autoProcessVerified &&
      settings.autoReportAuthorized &&
      uid !== null &&
      this.verifiedSet.has(uid) &&
      resolveContentIdAction(extracted.contentId) === 'block_and_report' &&
      (plan.enqueueOfficialBlock || plan.enqueueReport || plan.commitLocalBlock)
    ) {
      const autoKey = `${uid}:${extracted.contentType}:${extracted.contentId?.trim()}`;
      if (!this.autoTriggered.has(autoKey)) {
        this.autoTriggered.add(autoKey);
        void this.autoProcess(extracted, plan);
      }
    }
  }

  private attachQuickAction(extracted: ExtractedContent, decision: EngineDecision | null): void {
    const uid = extracted.uid;
    const mount = this.actionMountFor(extracted);
    this.quick.attachOrUpdate(
      extracted,
      {
        isWhitelisted: uid !== null && this.whitelistSet.has(uid),
        isSelf: uid !== null && this.currentMid !== null && uid === this.currentMid,
        isVerifiedMachine: uid !== null && this.verifiedSet.has(uid),
        officialBlockAvailable: this.canUseOfficialRequest('blockUser'),
        officialReportAvailable:
          this.canUseOfficialRequest(CONTENT_TYPE_CAPABILITY[extracted.contentType]) &&
          canReportContentType(extracted.contentType),
        decision,
        matchedRuleNames: decision ? RuleEngine.matchedRuleNames(decision) : [],
      },
      mount,
    );
  }

  /** 新版评论的可见操作区位于 open Shadow DOM；动态和旧版评论沿用内容节点。 */
  private actionMountFor(extracted: ExtractedContent): HTMLElement {
    // 旧版 light-DOM 评论保持既有直接挂载语义；仅新版 web component 评论需要把
    // host 挂入其 open Shadow DOM 的 #footer，否则 custom element 的 light child 不可见。
    return extracted.contentType !== 'dynamic' && extracted.node.getRootNode() instanceof ShadowRoot
      ? (findCommentActionAnchor(extracted.node) ?? extracted.node)
      : extracted.node;
  }

  // ---------------- 名单变更（P1-1：经 background 串行执行） ----------------

  private async mutate(mutation: ListMutation): Promise<Record<string, unknown>> {
    const res = (await browser.runtime.sendMessage({
      type: 'BB_MUTATE_LIST',
      mutation,
    })) as Record<string, unknown>;
    if (res?.ok !== true) {
      console.error('[BiliBlocker] 名单变更被拒绝:', JSON.stringify(mutation), res);
      throw new Error(String(res?.message ?? '名单变更失败'));
    }
    return res;
  }

  // ---------------- 一键拉黑并举报流程（P0-2 能力优先 + P0-4 原子提交） ----------------

  /**
   * P0-2（v0.1.3）：能力/理由/类型门禁后的可执行官方任务（不触发登录检查）。
   * 登录检查推迟到提交阶段（executableOfficialTasks.length > 0 才 checkLogin）。
   */
  private async resolveExecutableOfficialTasks(
    extracted: ExtractedContent,
    plan: ActionFlowPlan,
  ): Promise<{ tasks: TaskInput[]; skipped: string[]; reportReasonId: number | null }> {
    const tasks: TaskInput[] = [];
    const skipped: string[] = [];
    const uid = extracted.uid;
    if (uid === null) return { tasks, skipped, reportReasonId: null };
    const groupId = shortId('grp');
    const hash = contentHash(extracted.text, uid, extracted.contentId);

    if (plan.enqueueOfficialBlock) {
      if (this.canUseOfficialRequest('blockUser')) {
        // 登录验证推迟到提交阶段（P0-2：先能力过滤，后登录检查）
        tasks.push({
          type: 'block',
          uid,
          username: extracted.username ?? undefined,
          source: plan.source,
          groupId,
          contentHash: hash,
        });
      } else {
        skipped.push(`官方拉黑（${capabilityDenyReason('blockUser') ?? '未验证'}）`);
      }
    }

    let reportReasonId: number | null = null;
    if (plan.enqueueReport) {
      if (
        this.canUseOfficialRequest(CONTENT_TYPE_CAPABILITY[extracted.contentType]) &&
        canReportContentType(extracted.contentType)
      ) {
        const reportContentId = extracted.contentId?.trim() ?? '';
        reportReasonId = resolveDefaultReason(
          extracted.contentType,
          this.settings?.defaultReportReason ?? null,
        );
        if (reportReasonId === null) {
          skipped.push('未配置有效的默认举报理由');
        } else if (reportContentId === '') {
          skipped.push('无法取得内容 ID，无法提交举报');
        } else {
          tasks.push({
            type: 'report',
            uid,
            username: extracted.username ?? undefined,
            contentType: extracted.contentType,
            contentId: reportContentId,
            rootContentId: extracted.rootContentId ?? undefined,
            oid: this.oidFor(extracted),
            reasonId: reportReasonId,
            source: plan.source,
            groupId,
            contentHash: hash,
          });
        }
      } else {
        skipped.push(
          `自动举报（${capabilityDenyReason(CONTENT_TYPE_CAPABILITY[extracted.contentType]) ?? '内容类型能力未验证'}）`,
        );
      }
    }
    return { tasks, skipped, reportReasonId };
  }

  /**
   * 执行动作计划（P0-2/P0-4，v0.1.3）。
   * 顺序：
   *   1. 先做能力/理由/类型过滤 → executableOfficialTasks（不触发登录检查）；
   *   2. hasReversibleSideEffect = fold || commitLocalBlock || commitVerified || officialTasks.length>0
   *      → 决定是否必须显示可取消倒计时（零官方任务也不跳过）；
   *   3. 倒计时结束（或取消）后，存在官方任务时才 checkLogin；
   *   4. BB_COMMIT_ACTION 单次原子提交（本地名单 + 官方队列一次完成；
   *      background 不可用/失败 → 零副作用 + DOM 恢复）。
   */
  private async runActionFlow(extracted: ExtractedContent, plan: ActionFlowPlan): Promise<void> {
    const toast = ToastManager.get();
    const uid = extracted.uid;
    if (uid === null) {
      toast.show({ level: 'error', title: STRINGS.quickAction.noUid, duration: 4000 });
      return;
    }
    if (this.currentMid !== null && uid === this.currentMid) {
      toast.show({ level: 'error', title: STRINGS.quickAction.self, duration: 4000 });
      return;
    }
    if (this.whitelistSet.has(uid)) {
      toast.show({ level: 'warning', title: STRINGS.quickAction.whitelisted, duration: 5000 });
      return;
    }

    // ---- P0-2：先能力过滤，后登录检查 ----
    const {
      tasks: officialTasks,
      skipped,
      reportReasonId,
    } = await this.resolveExecutableOfficialTasks(extracted, plan);
    const nodeWasHandledBefore = this.placeholder.isHandled(extracted.node);

    // ---- P0-4：存在任何可撤销副作用 → 必须提供可取消窗口 ----
    const hasReversibleSideEffect =
      plan.fold || plan.commitLocalBlock || plan.commitVerified || officialTasks.length > 0;

    // 临时视觉预览（取消后完整恢复；不写名单、不入队）
    if (plan.fold) this.placeholder.collapse(extracted.node, {});

    if (!hasReversibleSideEffect) {
      // 仅折叠查看：无本地名单变更、无官方任务 → 不走破坏性倒计时
      if (!nodeWasHandledBefore) {
        toast.show({ level: 'info', title: STRINGS.toast.foldPreviewOnly, duration: 4000 });
      }
      return;
    }

    // ---- 倒计时（P0-4：零官方任务也必须显示，不绕过取消窗口） ----
    const countdownMs = this.settings?.operationDelayMs ?? 3000;
    const label = officialTasks.some((t) => t.type === 'report')
      ? STRINGS.toast.countdownBlockReport
      : officialTasks.length > 0
        ? STRINGS.toast.countdownBlock
        : STRINGS.toast.countdownLocal;
    const outcome = await this.showCountdownDual(
      fmt(label, { n: Math.max(1, Math.ceil(countdownMs / 1000)) }),
      countdownMs,
    );

    if (outcome === 'cancelled_all') {
      // 完整取消：恢复节点显示；未写入任何名单、未入队任何任务
      if (plan.fold && !nodeWasHandledBefore) this.placeholder.restore(extracted.node);
      await this.appendAudit(extracted, plan, { localHidden: false, cancelled: true });
      toast.show({ level: 'info', title: STRINGS.toast.cancelledAll, duration: 3500 });
      return;
    }

    // ---- P0-2：存在可执行官方任务时才检查登录（本地动作完全独立） ----
    let loginOk = true;
    if (officialTasks.length > 0) {
      const login = await this.auth.checkLogin(true);
      loginOk = login.isLogin;
      this.loginOk = loginOk;
      this.currentMid = login.mid;
      if (!loginOk) {
        skipped.push('需要登录（官方任务跳过，本地动作仍完成）');
      }
    }

    // ---- 倒计时结束：BB_COMMIT_ACTION 原子提交（background 单所有者短事务） ----
    const commit = await this.commitViaBackground(extracted, plan, officialTasks, reportReasonId, {
      skipOfficial: outcome === 'cancelled_official_only',
      loginOk,
    });
    if (!commit.ok) {
      // 提交失败：保持零副作用（P0-4：background 不可用不降级写入）
      if (plan.fold && !nodeWasHandledBefore) this.placeholder.restore(extracted.node);
      toast.show({
        level: 'error',
        title: STRINGS.toast.localCommitFailed,
        message: commit.reason,
        duration: 6000,
      });
      return;
    }
    // 更新本地缓存
    if (commit.localBlockedAdded) this.blockedSet.add(uid);
    if (commit.localVerifiedAdded) this.verifiedSet.add(uid);

    // 审计：本地提交/取消官方（由 content 追加；commitAction 本身保持最小副作用）
    await this.appendAudit(extracted, plan, {
      localHidden: plan.commitLocalBlock || plan.commitVerified,
      cancelled: false,
    });

    if (outcome === 'cancelled_official_only') {
      toast.show({ level: 'info', title: STRINGS.toast.cancelledOfficialOnly, duration: 3500 });
      return;
    }

    const allSkipped = officialTasks.length > 0 && commit.enqueued === 0;
    if (officialTasks.length === 0 || allSkipped) {
      // 零官方任务 / 官方任务全部被跳过 → 明确「未发送任何请求」
      const title =
        officialTasks.length === 0
          ? STRINGS.toast.localOnlyDone
          : loginOk
            ? STRINGS.toast.localOnlyDone
            : STRINGS.toast.loginSkipLocalDone;
      toast.show({
        level: 'info',
        title,
        message: skipped.length > 0 ? `（跳过：${skipped.join('；')}）` : undefined,
        duration: 4000,
      });
      return;
    }

    // 官方任务已排队
    toast.show({
      level: 'info',
      title: STRINGS.toast.enqueued,
      message: [
        plan.enqueueReport ? '拉黑与举报任务已加入队列' : '拉黑任务已加入队列',
        ...(skipped.length > 0 ? [`（跳过：${skipped.join('；')}）`] : []),
      ].join(''),
      duration: 4000,
    });
  }

  /**
   * P0-4（v0.1.3）：经 BB_COMMIT_ACTION 在 background 单所有者短事务内原子提交。
   * 不再有跨倒计时长生命周期事务；background 不可用时返回失败（零副作用）。
   */
  private async commitViaBackground(
    extracted: ExtractedContent,
    plan: ActionFlowPlan,
    officialTasks: TaskInput[],
    reportReasonId: number | null,
    opts: { skipOfficial: boolean; loginOk: boolean },
  ): Promise<{
    ok: boolean;
    reason?: string;
    enqueued?: number;
    localBlockedAdded?: boolean;
    localVerifiedAdded?: boolean;
  }> {
    const uid = extracted.uid;
    if (uid === null) return { ok: false, reason: '无法取得 UID' };
    try {
      // 读取当前授权快照（只读；epoch 供 background 校验是否发生撤权）
      const [control, settingsRevision, settings] = await Promise.all([
        this.repo.getQueueControl(),
        this.repo.getSettingsRevision(),
        this.repo.getSettings(),
      ]);
      const capabilityKey = plan.enqueueReport
        ? CONTENT_TYPE_CAPABILITY[extracted.contentType]
        : plan.enqueueOfficialBlock
          ? 'blockUser'
          : null;
      const res = (await browser.runtime.sendMessage({
        type: 'BB_COMMIT_ACTION',
        operationId: shortId('op'),
        uid,
        username: extracted.username ?? undefined,
        contentType: extracted.contentType,
        contentId: extracted.contentId,
        rootContentId: extracted.rootContentId,
        oid: this.oidFor(extracted) ?? null,
        contentHash: contentHash(extracted.text, uid, extracted.contentId),
        source: plan.source,
        localActions: {
          commitLocalBlock: plan.commitLocalBlock,
          commitVerified: plan.commitVerified,
        },
        officialTasks,
        skipOfficial: opts.skipOfficial,
        authorization: {
          epoch: control.authorizationEpoch,
          settingsRevision,
          reasonId: reportReasonId,
          capabilityKey,
          contentType: extracted.contentType,
          source: plan.source,
          // P0-2（v0.1.4）：入队时快照的开关状态（background 派发前逐项比较）
          autoProcessAuthorized: settings.autoProcessVerified,
          reportAuthorized: settings.autoReportAuthorized,
          createdAt: Date.now(),
        },
        frameNonce: this.frameNonce,
        loginOk: opts.loginOk,
        currentMid: this.currentMid,
      })) as {
        ok?: boolean;
        reason?: string;
        message?: string;
        enqueued?: number;
        localBlockedAdded?: boolean;
        localVerifiedAdded?: boolean;
      };
      if (res?.ok !== true) {
        return { ok: false, reason: String(res?.reason ?? res?.message ?? '提交被拒绝') };
      }
      return {
        ok: true,
        enqueued: res.enqueued ?? 0,
        localBlockedAdded: res.localBlockedAdded === true,
        localVerifiedAdded: res.localVerifiedAdded === true,
      };
    } catch (e) {
      // background 不可用：失败并保持无副作用（禁止本地降级写入）
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 审计追加（P1-1：经 background 串行写入） */
  private async appendAudit(
    extracted: ExtractedContent,
    plan: ActionFlowPlan,
    extra: { localHidden: boolean; cancelled?: boolean },
  ): Promise<void> {
    await this.mutate({
      op: 'appendAudit',
      entry: {
        uid: extracted.uid ?? 0,
        username: extracted.username ?? undefined,
        contentType: extracted.contentType,
        contentId: extracted.contentId ?? undefined,
        trigger:
          plan.source === 'auto_process'
            ? 'auto_process'
            : plan.source === 'manual'
              ? 'manual'
              : 'one_click',
        matchedRuleIds: [],
        localHidden: extra.localHidden,
        cancelled: extra.cancelled ?? false,
      },
    }).catch(() => undefined);
  }

  /** 一键拉黑并举报（主按钮；用户确认提供账号+内容双重证据） */
  private onOneClick = (extracted: ExtractedContent): Promise<void> =>
    resolveContentIdAction(extracted.contentId) === 'block_only'
      ? this.onBlockOnly(extracted)
      : this.runActionFlow(extracted, {
          fold: true,
          commitLocalBlock: true,
          commitVerified: true,
          enqueueOfficialBlock: true,
          enqueueReport: true,
          source: 'one_click',
        });

  /** 官方拉黑但不举报（本地/确认副作用由明确常量决定，不隐式加入） */
  private onBlockOnly = (extracted: ExtractedContent): Promise<void> =>
    this.runActionFlow(extracted, {
      fold: true,
      commitLocalBlock: BLOCK_ONLY_SIDE_EFFECTS.commitLocalBlock,
      commitVerified: BLOCK_ONLY_SIDE_EFFECTS.commitVerified,
      enqueueOfficialBlock: true,
      enqueueReport: false,
      source: 'one_click',
    });

  /** 拉黑并自动举报（菜单项，与主按钮等价）；缺内容 ID 时强制安全降级。 */
  private onBlockAndReport = (extracted: ExtractedContent): Promise<void> =>
    resolveContentIdAction(extracted.contentId) === 'block_only'
      ? this.onBlockOnly(extracted)
      : this.runActionFlow(extracted, {
          fold: true,
          commitLocalBlock: true,
          commitVerified: true,
          enqueueOfficialBlock: true,
          enqueueReport: true,
          source: 'one_click',
        });

  /** 自动处理已确认机器人（P0-3：依据动作计划矩阵字段，禁止 official||local 混写） */
  private async autoProcess(
    extracted: ExtractedContent,
    plan: ReturnType<typeof buildActionPlan>,
  ): Promise<void> {
    await this.runActionFlow(extracted, {
      fold: false,
      commitLocalBlock: plan.commitLocalBlock,
      commitVerified: plan.commitVerified,
      enqueueOfficialBlock: plan.enqueueOfficialBlock,
      enqueueReport: plan.enqueueReport,
      source: 'auto_process',
    });
  }

  /** P0-2：倒计时 + 双取消动作 */
  private showCountdownDual(
    message: string,
    ms: number,
  ): Promise<'confirmed' | 'cancelled_all' | 'cancelled_official_only'> {
    return new Promise((resolve) => {
      let settled = false;
      const once = (outcome: 'confirmed' | 'cancelled_all' | 'cancelled_official_only') => {
        if (settled) return;
        settled = true;
        handle?.dismiss();
        resolve(outcome);
      };
      const seconds = Math.max(1, Math.ceil(ms / 1000));
      const handle = ToastManager.get().show({
        level: 'warning',
        title: message,
        message: STRINGS.toast.countdownHint,
        countdown: seconds,
        duration: 0,
        cancelable: false,
        cancelActions: [
          { label: STRINGS.toast.cancelAll, handler: () => once('cancelled_all') },
          {
            label: STRINGS.toast.cancelOfficialOnly,
            handler: () => once('cancelled_official_only'),
          },
        ],
      });
      window.setTimeout(() => once('confirmed'), Math.max(300, ms));
    });
  }

  private oidFor(extracted: ExtractedContent): string | undefined {
    if (extracted.contentType === 'dynamic') return extracted.contentId ?? undefined;
    if (extracted.contentType === 'dynamic_comment') return this.dynamicId ?? undefined;
    return extracted.videoId ?? undefined;
  }

  // ---------------- 菜单动作 ----------------

  private buildQuickCallbacks() {
    return {
      onOneClick: this.onOneClick,
      onHideOnly: (extracted: ExtractedContent) => {
        this.placeholder.hide(extracted.node);
        void this.mutate({
          op: 'appendAudit',
          entry: {
            uid: extracted.uid ?? 0,
            username: extracted.username ?? undefined,
            contentType: extracted.contentType,
            contentId: extracted.contentId ?? undefined,
            trigger: 'manual',
            matchedRuleIds: [],
            localHidden: true,
          },
        }).catch(() => undefined);
        ToastManager.get().show({
          level: 'success',
          title: STRINGS.toast.localHidden,
          duration: 2500,
        });
      },
      onHideAuthorOnPage: async (extracted: ExtractedContent) => {
        const uid = extracted.uid;
        if (uid === null) return;
        await this.mutate({
          op: 'addBlocked',
          uid,
          username: extracted.username ?? undefined,
          reason: STRINGS.quickAction.hideAuthorOnPage,
          source: 'user_action',
        });
        this.blockedSet.add(uid);
        // 隐藏页面内该账号的其他已处理节点
        let count = 0;
        querySelectorAllDeep<HTMLElement>(document, '[data-bb-processed]').forEach((el) => {
          const entry = this.quick.getContext(el);
          if (entry && entry.extracted.uid === uid) {
            this.placeholder.hide(el);
            count++;
          }
        });
        ToastManager.get().show({
          level: 'success',
          title: fmt(STRINGS.toast.hideSimilarDone, { n: count }),
          duration: 3000,
        });
      },
      onWhitelist: async (extracted: ExtractedContent) => {
        const uid = extracted.uid;
        if (uid === null) return;
        await this.mutate({ op: 'addWhitelist', uid, username: extracted.username ?? undefined });
        this.whitelistSet.add(uid);
        this.placeholder.restore(extracted.node);
        ToastManager.get().show({
          level: 'success',
          title: STRINGS.toast.whitelistAdded,
          duration: 2500,
        });
      },
      onMarkVerified: async (extracted: ExtractedContent) => {
        const uid = extracted.uid;
        // 发布不变量：没有可归属的内容 ID 时，不允许把账号升级为“已确认机器人”。
        if (uid === null || resolveContentIdAction(extracted.contentId) === 'block_only') return;
        await this.mutate({
          op: 'addVerified',
          uid,
          username: extracted.username ?? undefined,
          source: 'manual',
        });
        this.verifiedSet.add(uid);
        ToastManager.get().show({
          level: 'success',
          title: STRINGS.toast.verifiedAdded,
          duration: 2500,
        });
      },
      onBlockOnly: this.onBlockOnly,
      onBlockAndReport: this.onBlockAndReport,
      onShowRules: (extracted: ExtractedContent, names: string[]) => {
        const decision = this.decisionCache.get(extracted.node);
        const list =
          names.length > 0 ? names : decision ? RuleEngine.matchedRuleNames(decision) : [];
        ToastManager.get().show({
          level: 'info',
          title:
            list.length > 0
              ? fmt(STRINGS.toast.rulesMatched, { names: list.slice(0, 3).join('、') })
              : STRINGS.toast.noRules,
          duration: 5000,
        });
      },
      onShowLogs: () => {
        void browser.runtime.sendMessage({ type: 'BB_OPEN_OPTIONS' }).catch(() => undefined);
      },
    };
  }

  private buildPlaceholderCallbacks() {
    return {
      onView: (node: HTMLElement) => {
        this.placeholder.restore(node);
      },
      onReleaseOnce: (node: HTMLElement) => {
        this.placeholder.restore(node);
        this.released.add(node);
        const entry = this.quick.getContext(node);
        if (entry) this.attachQuickAction(entry.extracted, entry.ctx.decision ?? null);
      },
      onWhitelist: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        if (entry) void this.buildQuickCallbacks().onWhitelist(entry.extracted);
      },
      onShowRules: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        if (entry)
          this.buildQuickCallbacks().onShowRules(entry.extracted, entry.ctx.matchedRuleNames);
      },
      onOneClick: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        if (entry) void this.onOneClick(entry.extracted);
      },
      onHideSimilar: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        if (entry) void this.buildQuickCallbacks().onHideAuthorOnPage(entry.extracted);
      },
      canOfficial: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        return (
          entry !== null &&
          entry.extracted.uid !== null &&
          (entry.ctx.officialBlockAvailable || entry.ctx.officialReportAvailable)
        );
      },
      primaryAction: (node: HTMLElement) => {
        const entry = this.quick.getContext(node);
        if (!entry || entry.extracted.uid === null) return null;
        const kind = resolvePrimaryActionKind(
          entry.extracted.contentId,
          entry.ctx.officialBlockAvailable,
          entry.ctx.officialReportAvailable,
        );
        if (kind === 'local_only') {
          return {
            label: STRINGS.quickAction.localOnly,
            title: STRINGS.quickAction.localOnlyTitle,
            onClick: () => void this.buildQuickCallbacks().onHideAuthorOnPage(entry.extracted),
          };
        }
        if (kind === 'block_only') {
          return {
            label: STRINGS.quickAction.blockNoReport,
            title:
              resolveContentIdAction(entry.extracted.contentId) === 'block_only'
                ? STRINGS.quickAction.noContentIdBlockOnly
                : STRINGS.quickAction.reportCapabilityUnavailable,
            onClick: () => void this.onBlockOnly(entry.extracted),
          };
        }
        if (kind === 'report_only') {
          return {
            label: STRINGS.quickAction.localAndReport,
            title: STRINGS.quickAction.blockCapabilityUnavailable,
            onClick: () => void this.onOneClick(entry.extracted),
          };
        }
        return {
          label: STRINGS.placeholder.oneClick,
          title: STRINGS.placeholder.oneClick,
          onClick: () => void this.onOneClick(entry.extracted),
        };
      },
    };
  }

  // ---------------- 任务执行器（后台队列的执行方；P1-6 Zod 校验） ----------------

  private async executeTask(task: ActionTask): Promise<TaskResult> {
    switch (task.type) {
      case 'block': {
        if (!this.canUseOfficialRequest('blockUser')) return this.officialRequestDenied('blockUser');
        // P0-5（v0.1.3）：派发时登录复查（页面侧最终防线；本地动作不经过这里）
        const login = await this.auth.checkLogin();
        if (!login.isLogin) {
          return {
            ok: false,
            status: '未登录',
            errorType: 'login_invalid',
            message: '登录状态已失效，无法执行官方拉黑',
          };
        }
        this.loginOk = true;
        this.currentMid = login.mid;
        return this.blockAdapter.block(task.uid);
      }
      case 'unblock':
        if (!this.canUseOfficialRequest('unblockUser')) return this.officialRequestDenied('unblockUser');
        return this.blockAdapter.unblock(task.uid);
      case 'report': {
        if (!task.contentType || !task.contentId || task.reasonId === undefined) {
          return {
            ok: false,
            status: '任务参数缺失',
            errorType: 'validation',
            message: '任务缺少内容类型/内容 ID/举报理由，已停止',
          };
        }
        const capability = CONTENT_TYPE_CAPABILITY[task.contentType];
        if (!this.canUseOfficialRequest(capability)) return this.officialRequestDenied(capability);
        const login = await this.auth.checkLogin();
        if (!login.isLogin) {
          return {
            ok: false,
            status: '未登录',
            errorType: 'login_invalid',
            message: '登录状态已失效，无法执行举报',
          };
        }
        this.loginOk = true;
        this.currentMid = login.mid;
        return this.reportAdapter.report({
          contentType: task.contentType,
          contentId: task.contentId,
          oid: task.oid ?? null,
          uid: task.uid,
          reasonId: task.reasonId,
        });
      }
      default:
        return { ok: false, status: '未知任务类型', errorType: 'validation' };
    }
  }

  /** 单一运行时门禁的拒绝结果；不伪造登录或官方接口成功。 */
  private canUseOfficialRequest(capability: CapabilityKey): boolean {
    return canUseOfficialRequest(this.settings, capability);
  }

  private officialRequestDenied(capability: CapabilityKey): TaskResult {
    return {
      ok: false,
      status: '官方请求已关闭',
      errorType: 'capability_not_verified',
      message: `官方请求未获运行时能力许可（${capability}）；未发送请求`,
    };
  }

  private async onBackgroundMessage(msg: unknown): Promise<void> {
    const parsed = parseBackgroundToContent(msg);
    if (!parsed.ok) return;
    const m = parsed.data;
    switch (m.type) {
      case 'BB_EXECUTE_TASK': {
        const task = m.task;
        const result = await this.executeTask(task);
        // P1-6：原样回传一次性 executionToken（background 校验 taskId/tabId/frameId/nonce/token）
        await browser.runtime.sendMessage({
          type: 'BB_EXECUTE_RESULT',
          taskId: task.id,
          executionToken: m.executionToken,
          result,
        });
        break;
      }
      case 'BB_TASK_DONE': {
        if (m.unknownOutcome) {
          // P0-3：结果未知（SW 中断恢复）：只提示人工核对，绝不宣称已撤销或已成功
          ToastManager.get().show({
            level: 'warning',
            title: STRINGS.toast.outcomeUnknown,
            duration: 8000,
          });
        } else {
          this.showTaskDoneToast(m.result, m.taskType, m.groupId);
        }
        break;
      }
      case 'BB_TASK_CANCELLED': {
        void m.taskId;
        ToastManager.get().show({ level: 'info', title: STRINGS.toast.cancelled, duration: 2500 });
        break;
      }
      case 'BB_QUEUE_PAUSED': {
        ToastManager.get().show({
          level: 'warning',
          title: fmt(STRINGS.toast.queuePaused, { reason: m.reason }),
          duration: 8000,
        });
        break;
      }
      case 'BB_QUEUE_RESUMED': {
        ToastManager.get().show({
          level: 'info',
          title: STRINGS.toast.queueResumed,
          duration: 3000,
        });
        break;
      }
      case 'BB_NOTIFY': {
        ToastManager.get().show({ level: m.level, title: m.message, duration: 5000 });
        break;
      }
      case 'BB_REFRESH_DATA': {
        // P1-1：import/reset/clear 后全量刷新
        this.settings = await this.repo.getSettings();
        this.rules = await this.repo.getRules();
        await this.refreshLists();
        this.observer?.rescan();
        break;
      }
      default:
        break;
    }
  }

  private showTaskDoneToast(result: TaskResult, taskType: string, groupId: string): void {
    void groupId;
    const toast = ToastManager.get();
    if (result.ok) {
      if (taskType === 'report') {
        toast.show({ level: 'success', title: STRINGS.toast.reportSubmitted, duration: 6000 });
      } else if (taskType === 'block') {
        toast.show({ level: 'success', title: STRINGS.toast.blocked, duration: 4000 });
      } else {
        toast.show({ level: 'success', title: STRINGS.toast.unblocked, duration: 4000 });
      }
    } else {
      let title = fmt(STRINGS.toast.blockFailed, { msg: result.message ?? result.status });
      if (taskType === 'report') {
        title =
          result.errorType === 'invalid_reason'
            ? STRINGS.toast.reportInvalidReason
            : fmt(STRINGS.toast.reportFailed, { msg: result.message ?? result.status });
      }
      toast.show({ level: 'error', title, duration: 8000 });
    }
  }

  private pingBackground(): void {
    // 注册帧身份（P1-6）：tabId/frameId 由 background 从 sender 推导
    void browser.runtime
      .sendMessage({
        type: 'BB_PING',
        pageScope: this.pageScope,
        frameNonce: this.frameNonce,
        url: location.href,
      })
      .catch(() => undefined);
  }
}

// ---------------- 工具函数 ----------------

function isTargetNode(node: HTMLElement, scope: PageScope): boolean {
  if (scope === 'video_page') {
    return (
      node.matches(COMMENT_SELECTORS.rootItem.join(',')) ||
      node.matches(COMMENT_SELECTORS.rootWrapper.join(',')) ||
      node.matches(COMMENT_SELECTORS.subItem.join(','))
    );
  }
  if (scope === 'dynamic_feed') {
    return node.matches(DYNAMIC_SELECTORS.item.join(','));
  }
  if (scope === 'dynamic_detail') {
    return (
      node.matches(DYNAMIC_SELECTORS.item.join(',')) ||
      node.matches(COMMENT_SELECTORS.rootItem.join(',')) ||
      node.matches(COMMENT_SELECTORS.rootWrapper.join(',')) ||
      node.matches(COMMENT_SELECTORS.subItem.join(','))
    );
  }
  return false;
}

/** 从 window.__INITIAL_STATE__ 提取视频 aid（oid）。UNVERIFIED：页面结构变更时需人工核验。 */
export function extractVideoAid(): string | null {
  try {
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent ?? '';
      const idx = text.indexOf('window.__INITIAL_STATE__=');
      if (idx < 0) continue;
      const jsonStr = extractJsonObject(text, idx + 'window.__INITIAL_STATE__='.length);
      if (!jsonStr) continue;
      const state = JSON.parse(jsonStr) as { aid?: number; videoData?: { aid?: number } };
      if (state.videoData?.aid) return String(state.videoData.aid);
      if (state.aid) return String(state.aid);
      return null;
    }
  } catch {
    // 解析失败按无 aid 处理
  }
  return null;
}

/** 从 start 处开始做花括号配对，返回第一个完整的 JSON 对象文本（对后缀内容健壮） */
function extractJsonObject(text: string, startIdx: number): string | null {
  const start = text.indexOf('{', startIdx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 从 /dynamic/{id} 或 /opus/{id} 提取动态 ID */
export function extractDynamicId(pathname: string): string | null {
  const m = pathname.match(/(?:dynamic|opus)\/(\d+)/);
  return m?.[1] ?? null;
}
