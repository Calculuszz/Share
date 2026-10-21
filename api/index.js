// จุดเข้าของ Vercel Function สำหรับ /api/*
// vercel.json เขียน /api/<path> ใหม่เป็น /api?__path=<path> จึงต้องประกอบ path เดิมกลับมาก่อน
import { handleApi } from '../lib/app.js';

export default function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const rewritten = url.searchParams.get('__path');
  const pathname = rewritten !== null ? `/api/${rewritten}` : url.pathname;
  return handleApi(req, res, pathname);
}
