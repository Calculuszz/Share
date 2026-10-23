// รหัสคนจ่าย: ตั้งตอนสร้าง, ปลดล็อกจากเครื่องอื่น, ผิดเกิน 5 ครั้งล็อก
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'hkl-'));
delete process.env.VERCEL;
delete process.env.KV_REST_API_URL;
const { handleApi } = await import('../lib/app.js');

async function call(method, p, body, key) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url: p, headers: key ? { 'x-edit-key': key } : {}, async *[Symbol.asyncIterator]() { yield* chunks; } };
  const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = String(b ?? ''); } };
  await handleApi(req, res, p);
  return { status: res.status, data: res.body ? JSON.parse(res.body) : null };
}

const draft = { subtotal: 100, payerId: 'payerAAA', people: [{ id: 'payerAAA', name: 'เอ' }], items: [{ id: 'itemAAAA', qty: 1, name: 'เบียร์', total: 100 }] };

test('สร้างบิลต้องตั้งรหัส 4–6 หลัก', async () => {
  assert.equal((await call('POST', '/api/bills', draft)).status, 400);
  assert.equal((await call('POST', '/api/bills', { ...draft, pin: '12' })).status, 400);
  assert.equal((await call('POST', '/api/bills', { ...draft, pin: 'abcd' })).status, 400);
  const r = await call('POST', '/api/bills', { ...draft, pin: '4821' });
  assert.equal(r.status, 201);
  assert.equal(r.data.bill.hasPin, true);
  assert.equal(r.data.bill.pin, undefined);
  // ไฟล์ที่เก็บไม่มีตัวเลขรหัสจริง
  const raw = await readFile(path.join(process.env.DATA_DIR, `${r.data.bill.id}.json`), 'utf8');
  assert.ok(!raw.includes('4821'));
});

test('ใส่รหัสถูก → ได้กุญแจแก้บิล ใช้ปิดบิลได้', async () => {
  const c = await call('POST', '/api/bills', { ...draft, pin: '4821' });
  const id = c.data.bill.id;
  const u = await call('POST', `/api/bills/${id}/unlock`, { pin: '4821' });
  assert.equal(u.status, 200);
  assert.equal(u.data.editKey, c.data.editKey);
  assert.equal((await call('PUT', `/api/bills/${id}/closed`, { closed: true }, u.data.editKey)).status, 200);
});

test('ใส่ผิดบอกจำนวนครั้งที่เหลือ ผิดครบ 5 ครั้งล็อก (รหัสถูกก็เข้าไม่ได้)', async () => {
  const c = await call('POST', '/api/bills', { ...draft, pin: '4821' });
  const id = c.data.bill.id;
  const w1 = await call('POST', `/api/bills/${id}/unlock`, { pin: '0000' });
  assert.equal(w1.status, 403);
  assert.equal(w1.data.error, 'รหัสไม่ถูก ใส่ได้อีก 4 ครั้ง');
  for (let i = 0; i < 3; i++) await call('POST', `/api/bills/${id}/unlock`, { pin: '0000' });
  const w5 = await call('POST', `/api/bills/${id}/unlock`, { pin: '0000' });
  assert.equal(w5.status, 429);
  const right = await call('POST', `/api/bills/${id}/unlock`, { pin: '4821' });
  assert.equal(right.status, 429);
  assert.match(right.data.error, /รออีก \d+ นาที/);
});

test('ใส่ถูกแล้วนับผิดใหม่ตั้งแต่ศูนย์', async () => {
  const c = await call('POST', '/api/bills', { ...draft, pin: '123456' });
  const id = c.data.bill.id;
  for (let i = 0; i < 4; i++) await call('POST', `/api/bills/${id}/unlock`, { pin: '999999' });
  assert.equal((await call('POST', `/api/bills/${id}/unlock`, { pin: '123456' })).status, 200);
  assert.equal((await call('POST', `/api/bills/${id}/unlock`, { pin: '999999' })).data.error, 'รหัสไม่ถูก ใส่ได้อีก 4 ครั้ง');
});

test('บิลเก่าไม่มีรหัส: ตั้งได้ด้วยกุญแจ, ไม่มีกุญแจตั้งไม่ได้', async () => {
  const c = await call('POST', '/api/bills', { ...draft, pin: '4821' });
  const id = c.data.bill.id;
  assert.equal((await call('PUT', `/api/bills/${id}/pin`, { pin: '5555' })).status, 403);
  assert.equal((await call('PUT', `/api/bills/${id}/pin`, { pin: '5555' }, c.data.editKey)).status, 200);
  assert.equal((await call('POST', `/api/bills/${id}/unlock`, { pin: '4821' })).status, 403);
  assert.equal((await call('POST', `/api/bills/${id}/unlock`, { pin: '5555' })).status, 200);
});
