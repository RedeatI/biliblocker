/**
 * E2E fixture 静态服务器（零依赖）。
 * 服务 tests/fixtures/pages/ 下的 HTML，用于 Playwright 加载扩展内容脚本。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const pagesDir = resolve(root, 'tests/fixtures/pages');
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    // SPA 路由 fixture（A-04）：/dynamic/{id} 与 /opus/{id} 均渲染动态详情页
    if (/^\/dynamic\/\d+$/.test(pathname)) pathname = '/dynamic-detail.html';
    else if (/^\/opus\/\d+$/.test(pathname)) pathname = '/dynamic-detail-opus.html';
    // 防目录穿越
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const file = resolve(pagesDir, rel);
    if (!file.startsWith(pagesDir) || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + String(err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fixtures] http://127.0.0.1:${PORT} (dir: ${pagesDir})`);
});

// 供子进程工具使用
export { pagesDir };
