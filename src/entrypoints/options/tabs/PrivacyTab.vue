<script setup lang="ts">
import { BRAND } from '../../../shared/constants/brand';
</script>

<template>
  <div>
    <div class="card">
      <h2>隐私说明</h2>
      <ul>
        <li>扩展默认只在本地（chrome.storage.local）保存数据，不收集、不出售、不共享任何用户数据。</li>
        <li>当前仅执行本地处理：只在你打开 Bilibili 页面时读取评论与动态 DOM，用于本地标记、折叠和名单管理。</li>
        <li>官方拉黑与举报能力当前均未通过真实账号验证，生产环境不会发送这些请求。</li>
        <li>未来只有在对应能力验证通过且你明确授权后，才可能代表你执行官方操作；举报成功后无法由扩展撤回。</li>
        <li>不向任何第三方服务器发送评论正文、动态内容、Cookie、CSRF Token 或你的任何数据。</li>
        <li>操作日志仅保存 UID、用户名、内容 ID、时间与结果等必要字段，不保存评论正文。</li>
        <li>无遥测、无指纹识别、无广告 SDK、无远程代码。</li>
      </ul>
    </div>

    <div class="card">
      <h2>权限说明</h2>
      <table class="list">
        <thead>
          <tr><th>权限</th><th>用途</th></tr>
        </thead>
        <tbody>
          <tr><td><code>storage</code></td><td>保存设置、规则、名单、队列、日志（全部本地）</td></tr>
          <tr><td><code>alarms</code></td><td>定时唤醒后台队列；官方能力未验证时不会发送请求</td></tr>
          <tr>
            <td><code>https://www.bilibili.com/*</code>（内容脚本注入）</td>
            <td>在 Bilibili 页面执行本地过滤并注入快捷按钮；未来官方能力验证且授权后才可能使用页面登录态</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        未申请 <code>&lt;all_urls&gt;</code>、<code>cookies</code>、<code>webRequest</code>、<code>history</code>、
        <code>downloads</code> 等权限。
      </p>
    </div>

    <div class="card">
      <h2>免责声明</h2>
      <p class="muted">
        {{ BRAND.disclaimer }} 当前生产版本仅提供本地治理；未来若官方能力通过验证并由你启用，请仅对确认违规的账号与内容谨慎操作。
      </p>
    </div>
  </div>
</template>
