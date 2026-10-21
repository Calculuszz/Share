// รันในเครื่อง: npm start → http://localhost:3000
// บน Vercel ไม่ใช้ไฟล์นี้ — หน้าเว็บมาจาก public/ ผ่าน CDN และ /api/* ไปที่ api/index.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleApi, send } from './lib/app.js';
import { isConfigured, GEMINI_MODEL } from './lib/gemini.js';
import { storeKind } from './lib/store.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve('public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ตรงกับ rewrites ใน vercel.json
async function serveStatic(res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel.startsWith('/edit/')) rel = '/index.html';
  else if (rel.startsWith('/b/')) rel = '/bill.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'ไม่พบหน้านี้' });
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return send(res, 404, { error: 'ไม่พบหน้านี้' });
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
  try {
    await serveStatic(res, decodeURIComponent(pathname));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง' });
  }
});

server.listen(PORT, () => {
  console.log(`หารค่าเหล้า → http://localhost:${PORT}`);
  console.log(isConfigured() ? `Gemini: ${GEMINI_MODEL}` : 'Gemini: ยังไม่ได้ตั้ง GEMINI_API_KEY (ใช้แบบพิมพ์เองได้)');
  console.log(`ที่เก็บบิล: ${storeKind.startsWith('redis') ? `Redis (${storeKind})` : 'ไฟล์ใน data/bills/'}`);
});
