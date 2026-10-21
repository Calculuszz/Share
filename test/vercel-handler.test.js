// จำลองการเรียก api/index.js แบบที่ Vercel ทำ (URL ถูก rewrite เป็น /api?__path=...)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'hkl-'));
delete process.env.VERCEL;
delete process.env.KV_REST_API_URL;
const { default: handler } = await import('../api/index.js');

const server = http.createServer((req, res) => {
  // แบบเดียวกับ rewrite ใน vercel.json: /api/:path* → /api?__path=:path*
  const u = new URL(req.url, 'http://x');
  const rest = u.pathname.replace(/^\/api\/?/, '');
  u.searchParams.set('__path', rest);
  req.url = `/api?${u.searchParams}`;
  handler(req, res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

const call = async (p, opts = {}) => {
  const r = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers }, body: opts.body && JSON.stringify(opts.body) });
  return { status: r.status, type: r.headers.get('content-type'), data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
};

test('ทั้ง flow ผ่าน URL ที่ถูก rewrite', async () => {
  const created = await call('/api/bills', { method: 'POST', body: {
    subtotal: 300, people: [{ id: 'aaaaaaaa', name: 'เอ' }, { id: 'bbbbbbbb', name: 'บี' }], payerId: 'aaaaaaaa',
    items: [{ id: 'item0001', qty: 3, name: '(D40) เบียร์', total: 300 }],
  } });
  assert.equal(created.status, 201);
  const id = created.data.bill.id;
  const key = created.data.editKey;

  const share = await call(`/api/bills/${id}/share`, { method: 'PATCH', body: { personId: 'bbbbbbbb', itemId: 'item0001', share: 2, actorId: 'bbbbbbbb' } });
  assert.equal(share.status, 200);
  // สั่ง 3: เอ 1 + บี 2 = ครบแล้ว บีเพิ่มเป็น 3 ไม่ได้
  const over = await call(`/api/bills/${id}/share`, { method: 'PATCH', body: { personId: 'bbbbbbbb', itemId: 'item0001', share: 3, actorId: 'bbbbbbbb' } });
  assert.equal(over.status, 400);
  assert.equal(over.data.error, 'เบียร์ สั่งมา 3 ใส่ได้สูงสุด 2');
  // แต่เอ "กินด้วย" 1 ส่วนยังได้เสมอ (ลองเอาออกแล้วใส่กลับ)
  assert.equal((await call(`/api/bills/${id}/share`, { method: 'PATCH', body: { personId: 'aaaaaaaa', itemId: 'item0001', share: 0 } })).status, 200);
  assert.equal((await call(`/api/bills/${id}/share`, { method: 'PATCH', body: { personId: 'aaaaaaaa', itemId: 'item0001', share: null } })).status, 200);

  const pay = await call(`/api/bills/${id}/payment`, { method: 'PUT', headers: { 'X-Edit-Key': key }, body: { promptpay: '0812345678' } });
  assert.equal(pay.status, 200);

  const svg = await call(`/api/bills/${id}/promptpay/bbbbbbbb`);
  assert.equal(svg.status, 200);
  assert.match(svg.type, /svg/);

  const got = await call(`/api/bills/${id}`);
  assert.equal(got.data.bill.items[0].overrides.bbbbbbbb, 2);
  assert.equal(got.data.bill.editKey, undefined);
  assert.equal((await call('/api/bills/xx')).status, 404);
});
