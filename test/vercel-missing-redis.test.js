// บน Vercel แต่ยังไม่ได้ต่อ Redis: ต้องตอบข้อความที่ผู้ใช้อ่านรู้เรื่อง ไม่พังเงียบ
// และใช้ req.body ที่ Vercel parse ไว้ให้ได้
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL = '1';
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
const { default: handler } = await import('../api/index.js');
const { storeKind } = await import('../lib/store.js');

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; res.headersSent = true; };
  res.end = (b) => { res.body = String(b ?? ''); };
  return res;
}

test('ยังไม่ต่อ Redis → 503 พร้อมข้อความสำหรับผู้ใช้', async () => {
  assert.equal(storeKind, 'missing');
  const origError = console.error;
  console.error = () => {}; // ข้อความสำหรับ dev ถูกพิมพ์ลง log — ไม่ต้องแสดงในเทสต์
  const res = fakeRes();
  // Vercel ใส่ body ที่ parse แล้วไว้ที่ req.body
  const req = { method: 'POST', url: '/api?__path=bills', headers: {}, body: {
    people: [{ name: 'เอ' }], items: [{ name: 'เบียร์', total: 100 }], subtotal: 100,
  } };
  await handler(req, res);
  console.error = origError;
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).error, 'ตอนนี้เปิดบิลไม่ได้ ลองใหม่อีกสักพัก');
});

test('ใช้ req.body ของ Vercel: ข้อมูลผิดถูกตรวจเจอก่อนถึงที่เก็บ', async () => {
  const res = fakeRes();
  await handler({ method: 'POST', url: '/api?__path=bills', headers: {}, body: { people: [], items: [] } }, res);
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error, 'ใส่ชื่อคนในวงก่อน');
});

test('config ยังตอบได้แม้ไม่มี Redis', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api?__path=config', headers: {} }, res);
  assert.equal(res.status, 200);
});
