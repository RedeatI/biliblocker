<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { state, updateSettings } from '../store';
import { getReasonsFor } from '../../../shared/constants/report-reasons';
import { BRAND } from '../../../shared/constants/brand';
import {
  isCapabilityEnabled,
  listUnverifiedCapabilities,
  capabilityDenyReason,
  canReportContentType,
} from '../../../shared/capabilities';

const showAuth = ref(false);
const authReason = ref<number | null>(null);
const showFirstEnable = ref(false);

const reasons = computed(() => getReasonsFor('video_comment'));

// P0-4：真实能力硬门禁 —— 未验证能力禁用授权/开关并显示原因
const unverified = computed(() => listUnverifiedCapabilities());
const blockVerified = computed(() => isCapabilityEnabled('blockUser'));
const reportVerified = computed(() => canReportContentType('video_comment'));
const blockDenyReason = computed(() => capabilityDenyReason('blockUser'));
const reportDenyReason = computed(() => capabilityDenyReason('reportVideoComment'));

async function authorize(): Promise<void> {
  if (authReason.value === null) return;
  await updateSettings({
    autoReportAuthorized: true,
    defaultReportReason: authReason.value,
  });
  showAuth.value = false;
}

async function revoke(): Promise<void> {
  await updateSettings({ autoReportAuthorized: false, defaultReportReason: null, autoProcessVerified: false });
}

async function setReason(id: number): Promise<void> {
  await updateSettings({ defaultReportReason: id });
}

function requestEnable(checked: boolean): void {
  if (!checked) {
    void updateSettings({ enabled: false });
    return;
  }
  showFirstEnable.value = true;
}

async function finishFirstEnable(suspiciousHandling: 'flag_only' | 'collapse'): Promise<void> {
  await updateSettings({ enabled: true, suspiciousHandling });
  showFirstEnable.value = false;
  if (location.hash.replace(/^#\/?/, '') === 'welcome') location.hash = '#overview';
}

onMounted(() => {
  if (location.hash.replace(/^#\/?/, '') === 'welcome' && !state.settings.enabled) {
    showFirstEnable.value = true;
  }
});

const ruleCount = computed(() => state.rules.filter((r) => r.enabled).length);
</script>

<template>
  <div>
    <div class="card">
      <h2>总开关</h2>
      <div class="row">
        <label class="switch">
          <input
            type="checkbox"
            :checked="state.settings.enabled"
            @change="requestEnable(($event.target as HTMLInputElement).checked)"
          />
          <span class="slider"></span>
        </label>
        <span>启用 BiliBlocker（关闭后停止隐藏与注入快捷按钮）</span>
      </div>
      <div class="row">
        <label class="switch">
          <input
            type="checkbox"
            :checked="state.settings.videoCommentsEnabled"
            @change="updateSettings({ videoCommentsEnabled: ($event.target as HTMLInputElement).checked })"
          />
          <span class="slider"></span>
        </label>
        <span>视频评论区（含楼中楼）</span>
      </div>
      <div class="row">
        <label class="switch">
          <input
            type="checkbox"
            :checked="state.settings.dynamicsEnabled"
            @change="updateSettings({ dynamicsEnabled: ($event.target as HTMLInputElement).checked })"
          />
          <span class="slider"></span>
        </label>
        <span>动态（首页卡片 / 详情 / 动态评论）</span>
      </div>
    </div>

    <div class="card">
      <h2>疑似内容处理</h2>
      <div class="row">
        <label>处理方式</label>
        <select
          :value="state.settings.suspiciousHandling"
          @change="updateSettings({ suspiciousHandling: ($event.target as HTMLSelectElement).value as never })"
        >
          <option value="collapse">折叠为占位条（推荐）</option>
          <option value="hide">完全隐藏</option>
          <option value="flag_only">仅标记提示</option>
        </select>
      </div>
      <div class="row">
        <label>快捷按钮显示</label>
        <select
          :value="state.settings.quickActionDisplay"
          @change="updateSettings({ quickActionDisplay: ($event.target as HTMLSelectElement).value as never })"
        >
          <option value="hover">悬停/聚焦时显示</option>
          <option value="always">始终显示</option>
        </select>
      </div>
      <div class="row">
        <label>官方操作倒计时（毫秒）</label>
        <input
          type="number"
          min="0"
          max="60000"
          step="500"
          :value="state.settings.operationDelayMs"
          @change="updateSettings({ operationDelayMs: Number(($event.target as HTMLInputElement).value) })"
          style="width: 120px"
        />
        <span class="muted">执行拉黑/举报前的可取消倒计时</span>
      </div>
    </div>

    <div class="card">
      <h2>自动举报</h2>
      <!-- P0-4：未验证能力门禁 -->
      <div v-if="unverified.length > 0" class="tip" style="border: 1px dashed #d97706">
        <strong>⚠️ 真实能力验证状态：</strong>以下能力尚未通过真实账号人工验证
        （证据编号为空），生产环境中不会发送任何真实请求：
        <ul style="margin: 6px 0 0; padding-left: 18px">
          <li v-for="u in unverified" :key="u.key">
            {{ u.key }}：{{ u.reason }}
          </li>
        </ul>
        <div class="muted" style="margin-top: 6px">
          验证流程见 docs/REAL-ACCOUNT-VALIDATION-RECORD.md 与 docs/manual-test.md；验证通过前请勿提交商店。
        </div>
      </div>
      <template v-if="!reportVerified">
        <div class="tip">
          自动举报需要真实能力验证通过后才能启用（当前：{{ reportDenyReason ?? '举报能力未验证' }}）。
          已确认机器人自动处理与官方拉黑同理（{{ blockDenyReason ?? '拉黑能力未验证' }}）。
        </div>
        <button class="btn primary" disabled title="能力未验证，暂不可启用">查看授权说明并启用自动举报（不可用）</button>
      </template>
      <template v-else-if="!state.settings.autoReportAuthorized">
        <div class="tip">
          自动举报未授权。启用后插件将代表你（使用你当前登录的 Bilibili 账号）提交举报。
          <br />
          举报提交成功后无法由插件撤回。
        </div>
        <button class="btn primary" @click="showAuth = true">查看授权说明并启用自动举报</button>
      </template>
      <template v-else>
        <div class="row">
          <span class="badge success">已授权自动举报</span>
          <button class="btn" @click="revoke()">撤销授权</button>
        </div>
        <div class="row">
          <label>默认举报理由</label>
          <select
            :value="state.settings.defaultReportReason ?? ''"
            @change="setReason(Number(($event.target as HTMLSelectElement).value))"
          >
            <option value="" disabled>请选择</option>
            <option v-for="r in reasons" :key="r.id" :value="r.id">{{ r.label }}</option>
          </select>
        </div>
        <div class="row">
          <label class="switch">
            <input
              type="checkbox"
              :disabled="!blockVerified"
              :checked="state.settings.autoProcessVerified"
              @change="updateSettings({ autoProcessVerified: ($event.target as HTMLInputElement).checked })"
            />
            <span class="slider"></span>
          </label>
          <span>
            对已确认机器人自动处理（默认关闭）
            <span class="muted">：仅对精确 UID 名单且内容命中广告/垃圾规则时，带倒计时自动拉黑并举报</span>
          </span>
        </div>
        <div v-if="!blockVerified" class="muted" style="margin-top: 4px">
          自动处理需要官方拉黑能力验证（{{ blockDenyReason ?? '未验证' }}），开关已禁用。
        </div>
      </template>
    </div>

    <div class="card">
      <h2>统计</h2>
      <div class="row">
        <span class="badge info">启用规则 {{ ruleCount }}/{{ state.rules.length }}</span>
        <span class="badge warn">本地黑名单 {{ state.blocked.length }}</span>
        <span class="badge danger">已确认机器人 {{ state.verified.length }}</span>
        <span class="badge success">白名单 {{ state.whitelist.length }}</span>
      </div>
    </div>

    <div v-if="showAuth" class="modal-mask" @click.self="showAuth = false">
      <div class="modal">
        <h3>自动举报授权</h3>
        <div class="tip">
          请仔细阅读以下说明：
          <ul style="margin: 8px 0; padding-left: 18px">
            <li>插件将代表你提交 Bilibili 举报，举报使用你当前登录的 Bilibili 账号。</li>
            <li>举报成功后通常无法由插件撤回。</li>
            <li>插件不会上传 Cookie 或登录凭据，不会向第三方服务器发送评论或动态内容。</li>
            <li>错误举报可能影响其他用户，请仅在确认内容违规时使用。</li>
            <li>自动举报只应用于你确认的账号，或精确 UID 名单 + 内容违规 + 你开启自动处理的情况。</li>
          </ul>
        </div>
        <div class="row">
          <label>默认举报理由（首次启用时选择）</label>
          <select v-model="authReason">
            <option :value="null" disabled>请选择</option>
            <option v-for="r in reasons" :key="r.id" :value="r.id">{{ r.label }}</option>
          </select>
        </div>
        <div class="actions">
          <button class="btn" @click="showAuth = false">取消</button>
          <button class="btn primary" :disabled="authReason === null" @click="authorize()">
            同意并启用
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="showFirstEnable"
      class="modal-mask"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-enable-title"
      @click.self="showFirstEnable = false"
    >
      <div class="modal">
        <h3 id="first-enable-title">启用前确认</h3>
        <div class="tip">
          <p>
            启用后，BiliBlocker 只会在 Bilibili 的<strong>评论与动态页面 DOM</strong>中识别和提示疑似广告/垃圾内容。
          </p>
          <ul style="margin: 8px 0; padding-left: 18px">
            <li>匹配结果、名单和操作日志仅保存在此浏览器本地。</li>
            <li>默认不会代表你发送官方拉黑或举报请求；自动举报仍需单独授权。</li>
            <li>不新增权限，也不会在此步骤访问或触发任何真实账号操作。</li>
          </ul>
        </div>
        <div class="actions">
          <button class="btn primary" @click="finishFirstEnable('flag_only')">仅标记（推荐）</button>
          <button class="btn" @click="finishFirstEnable('collapse')">自动折叠</button>
          <button class="btn" @click="showFirstEnable = false">暂不启用</button>
        </div>
      </div>
    </div>

    <p class="muted" style="margin-top: 24px">{{ BRAND.disclaimer }}</p>
  </div>
</template>
