/**
 * Background Service Worker：队列编排中枢 + 唯一写协调器宿主。
 *
 * - 启动时恢复持久化队列与控制状态（SW 被回收后任务不丢失；风控暂停跨重启保持）；
 * - 拉黑/举报任务串行执行，任务通过 tabs.sendMessage 派发回发起页面的内容脚本执行
 *   （内容脚本以页面同源上下文调用 Bilibili 接口，携带登录态且无需 cookies 权限）；
 * - P0-5（v0.1.4）：SW 重启后任务派发前等待内容脚本重新注册帧身份（宽限期）；
 *   页面关闭/nonce 变化才进入明确终态；不在旧页面上执行。
 * - 审计日志在任务完成时写入（经 StorageCoordinator）；unknown_outcome 写独立持久证据。
 * - 登录失效/风控暂停队列（await pause，crash-safe）；alarms 每分钟 kick() 兜底推进。
 * - P1-1（v0.1.3）：所有写（名单/设置/规则/审计/队列/去重/导入/reset/clear/一键提交）
 *   统一经 StorageCoordinator 在全局写锁内串行执行；content/popup/options 只读。
 * - P0-1（v0.1.4）：coordinator 持有显式 WriteLease；队列 writer 由 coordinator 注入
 *   （锁内直接写 / 锁外 execute 排队）；不再有共享 inLock 布尔。
 * - P0-4（v0.1.4）：BB_COMMIT_ACTION 单次原子提交（名单+队列一次写入）+
 *   operationId 幂等；paused（风控/撤权）拒绝创建官方任务。
 * - 5.3（v0.1.4）：BB_ENQUEUE 已删除——官方任务只能经 BB_COMMIT_ACTION 创建
 *   （完整授权/证据/epoch/pause/白名单门禁）。
 * - P1-6：所有 runtime message 经 Zod discriminated union 校验；
 *   任务派发前验证 tab 存在、URL 为 Bilibili、frame 会话 nonce 匹配。
 *
 * ⚠️ MV3 关键约束：消息监听器必须在顶层**同步**注册（不能在 async init 之后），
 * 否则 SW 冷启动时到达的消息会丢失。
 */
import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import type { ActionTask, ContentType, TaskResult } from '../../shared/types';
import { StorageRepository } from '../../storage/repository';
import { chromeStorageBackend } from '../../storage/backend';
import { StorageCoordinator } from '../../storage/coordinator';
import { DeduplicationRegistry } from '../../actions/dedup';
import { ActionQueue } from '../../actions/queue';
import { FrameRegistry } from './frame-registry';
import { parseContentToBackground } from '../../shared/messages';
import { decideOptionsNavigation } from '../../shared/options-navigation';
import { validateExecuteResult } from '../../shared/execute-result-validation';
import { NEW_INSTALL_SETTINGS, QUEUE } from '../../shared/constants/defaults';
import { isE2EMode } from '../../shared/capabilities';
import { shortId } from '../../shared/utils';
import { chromeStorageSessionLatch, chromeStorageLocalLatch, compositeSafetyLatch } from '../../storage/safety-latch';

/** E2E/Mock 构建常量（编译隔离） */
const E2E_FORCED = isE2EMode();

export default defineBackground(() => {
  // settings 不存在时直接播种安全默认值；只读上下文只有在这一步完成后才会继续，
  // 因而不会观察到 enabled=true/collapse 的短暂中间态。已有设置（含升级）不被覆盖。
  const repo = new StorageRepository(chromeStorageBackend(), {
    seedSettings: NEW_INSTALL_SETTINGS,
  });
  let queue: ActionQueue | null = null;
  let coordinator: StorageCoordinator | null = null;
  let initPromise: Promise<void> | null = null;
  const frames = new FrameRegistry(500, () => Date.now(), (url) => {
    const isBilibili = /^https:\/\/www\.bilibili\.com\//.test(url);
    const isE2eFixture =
      E2E_FORCED && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
    return isBilibili || isE2eFixture;
  });

  // 等待内容脚本执行结果：taskId -> { resolve, timer, token, tabId, frameId, frameNonce }
  const pendingExec = new Map<
    string,
    {
      resolve: (r: TaskResult) => void;
      timer: ReturnType<typeof setTimeout>;
      executionToken: string;
      tabId: number;
      frameId: number;
      frameNonce?: string;
    }
  >();
  /** 任务 → 发起页面映射（BB_EXECUTE_RESULT 归属校验用） */
  const queueTasks = new Map<string, ActionTask>();

  // ---- 顶层同步注册（SW 冷启动消息不丢失） ----
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void handleMessage(msg, sender, sendResponse);
    return true; // 异步响应
  });
  browser.runtime.onMessageExternal.addListener(() => {
    return false; // 拒绝任何外部消息来源
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'bb-kick') {
      void queue?.kick();
    }
  });

  function init(): Promise<void> {
    initPromise ??= doInit();
    return initPromise;
  }

  async function doInit(): Promise<void> {
    await repo.init();
    // P0-1（v0.1.4）：先建 coordinator（writer 立即可用），dedup/queue 注入
    // coordinator.writer（锁内显式 lease 直接写 / 锁外 execute 排队），再 attachQueue。
    coordinator = new StorageCoordinator(repo, null, null, {
      onDataChanged: () => void notifyRefreshAll(),
    });
    const dedup = new DeduplicationRegistry(repo, coordinator.writer);
    let latch: ReturnType<typeof compositeSafetyLatch> | undefined;
    try {
      // P0-3（v0.1.5）：安全暂停 latch（session 覆盖 SW 重启 + local 持久覆盖浏览器完全重启）；
      // 非扩展环境（如单元测试/探针）不可用时不注入（测试注入内存实现）。
      latch = compositeSafetyLatch(chromeStorageSessionLatch(), chromeStorageLocalLatch());
    } catch {
      latch = undefined;
    }
    queue = new ActionQueue({
      repo,
      dedup,
      writer: coordinator.writer,
      latch,
      executor: { execute: (task) => executeViaContent(task) },
      onTaskDone: (task) => {
        void handleTaskDone(task);
      },
    });
    coordinator.attachQueue(queue);

    await queue.start();

    // P1-1（v0.1.3）：任何上下文直写 storage 都会使 SW 仓库缓存过期
    // （如 E2E presetStorage、旧代码路径）；onChanged 全键失效保证协调器
    // handleSettingsTransition 的 before 快照读到最新设置。
    browser.storage.onChanged.addListener((changes) => {
      repo.invalidate(Object.keys(changes));
    });

    // 定时唤醒：即使没有新事件也能推进退避中的队列
    browser.alarms.create('bb-kick', { periodInMinutes: 1 });
  }

  /** 消息分发（Zod 校验 + 确保初始化完成 + 业务处理） */
  async function handleMessage(
    msg: unknown,
    sender: { tab?: { id?: number }; url?: string; frameId?: number },
    sendResponse: (response?: unknown) => void,
  ): Promise<void> {
    try {
      const frameId = sender.frameId ?? 0;
      const parsed = parseContentToBackground(msg, sender);
      if (!parsed.ok) {
        console.warn('[BiliBlocker:bg] 消息校验失败:', parsed.error);
        sendResponse({ ok: false, message: parsed.error });
        return;
      }
      const m = parsed.data;
      await init();
      switch (m.type) {
        case 'BB_PING': {
          if (sender.tab?.id !== undefined) {
            frames.register(sender.tab.id, frameId, m.frameNonce, m.url ?? sender.url ?? '');
          }
          sendResponse({ ok: true });
          return;
        }
        case 'BB_LOGIN': {
          if (m.isLogin) {
            await coordinator?.execute({ kind: 'resumeQueue', mode: 'login_restored' });
          } else {
            await coordinator?.execute({
              kind: 'setQueuePaused',
              reason: '登录状态已失效，请重新登录 Bilibili 后继续',
              pauseKind: 'login',
              requiresExplicitResume: false,
            });
          }
          sendResponse({ ok: true });
          return;
        }
        case 'BB_LOGIN_RESTORED': {
          await coordinator?.execute({ kind: 'resumeQueue', mode: 'login_restored' });
          sendResponse({ ok: true });
          return;
        }
        case 'BB_COMMIT_ACTION': {
          // P0-4：原子提交（名单+队列单次写入）；tabId/frameId 由 sender 推导（不信任消息内容）
          const res = await coordinator?.execute({
            kind: 'commitAction',
            request: m,
            origin: { tabId: sender.tab?.id, frameId },
          });
          sendResponse({ ok: res?.ok === true, ...(res ?? {}) });
          return;
        }
        case 'BB_CANCEL_TASKS': {
          await coordinator?.execute({ kind: 'cancelTasks', taskIds: m.taskIds });
          sendResponse({ ok: true });
          return;
        }
        case 'BB_CANCEL_ALL_PENDING': {
          // P0-5：用户显式「取消全部待执行官方操作」→ 统一撤权流程
          await coordinator?.execute({
            kind: 'revoke',
            reason: m.reason ?? '用户取消全部待执行官方操作',
            pause: false,
          });
          sendResponse({ ok: true });
          return;
        }
        case 'BB_QUEUE_RESUME': {
          await coordinator?.execute({ kind: 'resumeQueue', mode: m.mode });
          sendResponse({ ok: true });
          return;
        }
        case 'BB_EXECUTE_RESULT': {
          const entry = pendingExec.get(m.taskId);
          const identity = entry
            ? frames.identityFor(entry.tabId, entry.frameId)
            : undefined;
          const verdict = validateExecuteResult(entry, m, sender, identity);
          if (!verdict.ok) {
            sendResponse({ ok: false, message: verdict.message });
            return;
          }
          const e = entry!;
          clearTimeout(e.timer);
          pendingExec.delete(m.taskId);
          queueTasks.delete(m.taskId);
          e.resolve(m.result);
          sendResponse({ ok: true });
          return;
        }
        case 'BB_QUEUE_STATUS_REQ': {
          sendResponse(queue?.getStatus() ?? null);
          return;
        }
        case 'BB_OPEN_OPTIONS': {
          const navigation = decideOptionsNavigation(m.target);
          if (navigation.kind === 'registered-options') {
            await browser.runtime.openOptionsPage();
          } else {
            // tabs.create 创建 extension 自身 URL 无需 "tabs" 权限；Options App 会读取 #logs。
            await browser.tabs.create({ url: browser.runtime.getURL(navigation.path) });
          }
          sendResponse({ ok: true });
          return;
        }
        case 'BB_MUTATE_LIST': {
          const result = await coordinator?.execute({ kind: 'mutation', mutation: m.mutation });
          sendResponse(result ?? { ok: false, message: '协调器未就绪' });
          return;
        }
        default: {
          sendResponse({ ok: false, message: '未知消息类型' });
        }
      }
    } catch (e) {
      console.warn('[BiliBlocker:bg] 消息处理异常:', e instanceof Error ? e.message : String(e));
      sendResponse({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * P0-5（v0.1.4）：恢复/派发前验证发起页面身份。
   * - not_registered：等待内容脚本重新 PING（宽限期），不立即终态失败；
   * - nonce_mismatch / not_bilibili / tab 不存在：明确终态。
   */
  async function verifyFrame(task: ActionTask): Promise<{ ok: true } | { ok: false; result: TaskResult }> {
    const tabId = task.tabId;
    if (tabId === undefined) {
      return { ok: false, result: { ok: false, status: '页面已关闭', errorType: 'tab_closed', message: '任务未关联页面' } };
    }
    try {
      await browser.tabs.get(tabId);
    } catch {
      return { ok: false, result: { ok: false, status: '页面已关闭', errorType: 'tab_closed', message: '发起任务的标签页已关闭' } };
    }
    const verdict = frames.verify(task);
    if (!verdict.ok) {
      return { ok: false, result: { ok: false, status: verdict.reason === 'not_registered' ? '页面未重新注册' : '页面会话失效', errorType: 'tab_closed', message: verdict.message } };
    }
    return { ok: true };
  }

  /** 派发任务到发起页面执行；身份校验失败/页面不可达时返回 tab_closed */
  async function executeViaContent(task: ActionTask): Promise<TaskResult> {
    queueTasks.set(task.id, task);
    // P0-5：宽限期——SW 重启后内容脚本尚未重新 PING 时等待重试
    const graceStart = Date.now();
    for (;;) {
      const verdict = await verifyFrame(task);
      if (verdict.ok) break;
      const isGraceWaitable = verdict.result.errorType === 'tab_closed' && verdict.result.status === '页面未重新注册';
      if (!isGraceWaitable) {
        queueTasks.delete(task.id);
        return verdict.result;
      }
      if (Date.now() - graceStart > QUEUE.FRAME_REGISTRATION_GRACE_MS) {
        queueTasks.delete(task.id);
        return {
          ok: false,
          status: '页面未重新注册',
          errorType: 'tab_closed',
          message: '发起任务的页面在宽限期内未重新注册（已关闭或刷新），任务未执行',
        };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const tabId = task.tabId!;
    const frameId = task.frameId ?? 0;
    return new Promise<TaskResult>((resolve) => {
      const timer = setTimeout(() => {
        pendingExec.delete(task.id);
        queueTasks.delete(task.id);
        resolve({
          ok: false,
          status: '页面已关闭',
          errorType: 'tab_closed',
          message: '执行超时（页面可能已关闭）',
        });
      }, QUEUE.EXECUTE_TIMEOUT_MS);
      const executionToken = shortId('tok');
      pendingExec.set(task.id, { resolve, timer, executionToken, tabId, frameId, frameNonce: task.frameNonce });

      void browser.tabs
        .sendMessage(tabId, { type: 'BB_EXECUTE_TASK', task, executionToken }, { frameId })
        .catch(() => {
          clearTimeout(timer);
          pendingExec.delete(task.id);
          queueTasks.delete(task.id);
          resolve({
            ok: false,
            status: '页面不可达',
            errorType: 'tab_closed',
            message: '无法连接发起任务的页面（已刷新或关闭）',
          });
        });
    });
  }

  /** P1-1：import/reset/clear 后通知所有内容脚本刷新 */
  async function notifyRefreshAll(): Promise<void> {
    let tabs: { id?: number }[] = [];
    try {
      tabs = await browser.tabs.query({});
    } catch {
      return;
    }
    for (const t of tabs) {
      if (t.id === undefined) continue;
      void browser.tabs
        .sendMessage(t.id, { type: 'BB_REFRESH_DATA' })
        .catch(() => undefined);
    }
  }

  async function handleTaskDone(task: {
    id: string;
    groupId?: string;
    uid: number;
    username?: string;
    contentType?: ContentType;
    contentId?: string;
    source: string;
    type: string;
    tabId?: number;
    result?: TaskResult;
    status?: string;
    skipReason?: string;
  }): Promise<void> {
    const result = task.result;
    queueTasks.delete(task.id);
    const outcomeUnknown = task.status === 'unknown_outcome';
    // P0-3：unknown_outcome 任务写审计（提示人工核对），绝不登记为已成功举报；
    // 持久证据（bb.unknownOutcomes）由队列在转换时写入（幂等）。
    await coordinator?.execute({
      kind: 'mutation',
      mutation: {
        op: 'appendAudit',
        entry: {
          uid: task.uid,
          username: task.username,
          contentType: task.contentType,
          contentId: task.contentId,
          trigger:
            task.source === 'auto_process'
              ? 'auto_process'
              : task.source === 'manual'
                ? 'manual'
                : 'one_click',
          matchedRuleIds: [],
          localHidden: task.type === 'block',
          blockResult: task.type === 'block' || task.type === 'unblock' ? result : undefined,
          reportResult: task.type === 'report' ? result : undefined,
          failureReason: result && !result.ok ? result.message : undefined,
          cancelled: result?.errorType === 'cancelled',
          outcomeUnknown,
          skipReason: task.skipReason,
        },
      },
    });

    // 通知发起页面（Toast 状态展示）
    if (task.tabId !== undefined) {
      void browser.tabs
        .sendMessage(task.tabId, {
          type: 'BB_TASK_DONE',
          taskId: task.id,
          groupId: task.groupId ?? task.id,
          result,
          taskType: task.type,
          unknownOutcome: outcomeUnknown,
        })
        .catch(() => undefined);
      if (
        result &&
        !result.ok &&
        (result.errorType === 'login_invalid' || result.errorType === 'risk_control')
      ) {
        void browser.tabs
          .sendMessage(task.tabId, {
            type: 'BB_QUEUE_PAUSED',
            reason: result.errorType === 'login_invalid' ? '登录状态已失效' : '检测到验证码/风控',
          })
          .catch(() => undefined);
      }
    }
  }

  void init();
});
