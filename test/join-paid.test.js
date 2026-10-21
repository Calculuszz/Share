// เพื่อนเพิ่มชื่อตัวเอง, กด "โอนแล้ว", และหน้าแก้บิลของคนจ่ายไม่ลบชื่อที่เพิ่มเข้ามาทีหลัง
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'hkl-'));
delete process.env.VERCEL;
delete process.env.KV_REST_API_URL;
const { handleApi } = await import('../lib/app.js');
const { computeBill, paidStatus } = await import('../public/calc.js');

// เรียก API ตรง ๆ ด้วย req/res จำลอง
async function call(method, p, body, key) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url: p, headers: key ? { 'x-edit-key': key } : {}, async *[Symbol.asyncIterator]() { yield* chunks; } };
  const res = { status: 0, body: '', headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(b) { this.body = String(b ?? ''); } };
  await handleApi(req, res, p);
  return { status: res.status, data: res.body ? JSON.parse(res.body) : null };
}

const items = [{ id: 'itemAAAA', qty: 1, name: 'เบียร์', total: 300 }];
const created = await call('POST', '/api/bills', { subtotal: 300, people: [{ id: 'payerAAA', name: 'เอ' }], payerId: 'payerAAA', items });
const id = created.data.bill.id;
const key = created.data.editKey;

test('เพื่อนเพิ่มชื่อตัวเองได้ และกินทุกอย่างโดยปริยาย', async () => {
  const r = await call('POST', `/api/bills/${id}/people`, { name: 'บี' });
  assert.equal(r.status, 201);
  assert.ok(r.data.personId);
  const bill = r.data.bill;
  assert.equal(bill.people.length, 2);
  assert.equal(computeBill(bill).perPerson[r.data.personId].exact, 150);
  assert.equal(bill.log.at(-1).kind, 'join');
  const dup = await call('POST', `/api/bills/${id}/people`, { name: 'บี' });
  assert.equal(dup.status, 409);
  assert.equal((await call('POST', `/api/bills/${id}/people`, { name: '  ' })).status, 400);
});

test('คนจ่ายบันทึกหน้าแก้บิล (ที่เปิดไว้ก่อนเพื่อนเข้ามา) ไม่ลบชื่อเพื่อน', async () => {
  const before = (await call('GET', `/api/bills/${id}`)).data.bill;
  const known = before.people.map((p) => p.id); // เอ, บี
  await call('POST', `/api/bills/${id}/people`, { name: 'ซี' }); // ซีเข้ามาระหว่างที่คนจ่ายแก้อยู่
  const put = await call('PUT', `/api/bills/${id}`, {
    subtotal: 300, payerId: 'payerAAA', items, knownPeople: known,
    people: before.people.filter((p) => p.name !== 'บี'), // คนจ่ายลบบีออกเอง
  }, key);
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.bill.people.map((p) => p.name), ['เอ', 'ซี']);
});

test('โอนแล้ว: ได้หลังปิดบิล, จำยอดไว้, ยอดเพิ่มทีหลังรู้ว่าขาด', async () => {
  const bill0 = (await call('GET', `/api/bills/${id}`)).data.bill;
  const c = bill0.people.find((p) => p.name === 'ซี').id;
  assert.equal((await call('PATCH', `/api/bills/${id}/paid`, { personId: c, paid: true })).status, 409); // ยังไม่ปิดบิล
  await call('PUT', `/api/bills/${id}/closed`, { closed: true }, key);
  assert.equal((await call('PATCH', `/api/bills/${id}/paid`, { personId: 'payerAAA', paid: true })).status, 400); // คนจ่ายไม่ต้องโอน
  const r = await call('PATCH', `/api/bills/${id}/paid`, { personId: c, paid: true, actorId: c });
  assert.equal(r.status, 200);
  let st = paidStatus(r.data.bill, computeBill(r.data.bill), c);
  assert.deepEqual([st.paid, st.amount, st.short], [true, 150, 0]);
  // คนจ่ายเปิดบิล เพิ่มรายการ แล้วปิดใหม่ → ซีโอนไป 150 แต่ยอดใหม่ 200
  await call('PUT', `/api/bills/${id}/closed`, { closed: false }, key);
  const people = (await call('GET', `/api/bills/${id}`)).data.bill.people;
  await call('PUT', `/api/bills/${id}`, { subtotal: 400, payerId: 'payerAAA', people, knownPeople: people.map((p) => p.id),
    items: [...items, { id: 'itemBBBB', qty: 1, name: 'ถั่ว', total: 100 }] }, key);
  await call('PUT', `/api/bills/${id}/closed`, { closed: true }, key);
  const after = (await call('GET', `/api/bills/${id}`)).data.bill;
  st = paidStatus(after, computeBill(after), c);
  assert.deepEqual([st.paid, st.pay, st.short], [false, 200, 50]);
  const un = await call('PATCH', `/api/bills/${id}/paid`, { personId: c, paid: false });
  assert.equal(un.data.bill.paid[c], undefined);
  assert.equal(un.data.bill.log.at(-1).kind, 'unpaid');
});
