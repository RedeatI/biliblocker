import { defineContentScript } from '#imports';
import { ContentApp } from './app';

export default defineContentScript({
  matches: ['https://www.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    const app = new ContentApp();
    void app.init();
  },
});
