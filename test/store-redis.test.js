// ทดสอบที่เก็บแบบ Redis โดยจำลอง REST API ของ Upstash (ไม่ต้องมีฐานข้อมูลจริง)
// ใช้ client @upstash/redis ตัวจริง แค่ดัก fetch ไว้
import test from 'node:test';
import assert from 'node:assert/strict';

const db = new Map();
const seen = [];
function run([cmd, ...args]) {
  seen.push(cmd.toUpperCase());
  switch (cmd.toUpperCase()) {
    case 'GET': return db.get(args[0]) ?? null;
    case 'SET': {
      const nx = args.slice(2).map((a) => String(a).toUpperCase()).includes('NX');
      if (nx && db.has(args[0])) return null;
      db.set(args[0], String(args[1]));
      return 'OK';
    }
    case 'DEL': return db.delete(args[0]) ? 1 : 0;
    case 'EVAL': {
      // สคริปต์ compare-and-set ใน store.js: KEYS[1], ARGV[1]=ค่าเดิม, ARGV[2]=ค่าใหม่
      const [, , key, expected, next] = args;
      if (db.get(key) !== expected) return 0;
      db.set(key, next);
      return 1;
    }
    default: throw new Error(`mock ไม่รองรับคำสั่ง ${cmd}`);
  }
}

process.env.KV_REST_API_URL = 'https://mock.upstash.test';
process.env.KV_REST_API_TOKEN = 'test-token';
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  // หน่วงเล็กน้อยแบบสุ่ม ให้คำขอพร้อมกันสลับลำดับกันจริง
  await new Promise((r) => setTimeout(r, Math.random() * 5));
  // Upstash จริงเข้ารหัส string ในผลลัพธ์เป็น base64 เมื่อ client ส่ง header นี้มา
  const b64 = init.headers?.['Upstash-Encoding'] === 'base64';
  const enc = (v) => (b64 && typeof v === 'string' ? Buffer.from(v, 'utf8').toString('base64') : v);
  const result = String(url).endsWith('/pipeline') || String(url).endsWith('/multi-exec')
    ? body.map((c) => ({ result: enc(run(c)) }))
    : { result: enc(run(body)) };
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const store = await import('../lib/store.js');

test('เลือกใช้ Redis เมื่อมี KV_REST_API_URL/TOKEN', () => {
  assert.equal(store.storeKind, 'redis');
});

test('สร้าง อ่าน แก้บิล', async () => {
  const bill = await store.createBill({ items: [], people: [], count: 0 });
  assert.equal(bill.version, 1);
  assert.deepEqual((await store.getBill(bill.id)).count, 0);
  const next = await store.updateBill(bill.id, (b) => ({ ...b, count: 1 }));
  assert.equal(next.version, 2);
  assert.equal((await store.getBill(bill.id)).count, 1);
  assert.equal(await store.getBill('nope!!'), null);
});

test('หลายคนแก้พร้อมกัน 25 ครั้ง ไม่มีครั้งไหนหาย', async () => {
  const bill = await store.createBill({ hits: [] });
  await Promise.all(Array.from({ length: 25 }, (_, i) =>
    store.updateBill(bill.id, (b) => ({ ...b, hits: [...b.hits, i] }))));
  const final = await store.getBill(bill.id);
  assert.equal(final.hits.length, 25);
  assert.deepEqual([...final.hits].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
  assert.equal(final.version, 26);
  assert.ok(seen.includes('EVAL'));
});

test('รูป QR เก็บและอ่านกลับได้ตรงทุก byte', async () => {
  const buf = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
  await store.saveQr('abcdefgh', buf);
  assert.deepEqual(await store.readQr('abcdefgh'), buf);
  await store.deleteQr('abcdefgh');
  assert.equal(await store.readQr('abcdefgh'), null);
});

test('บิลที่ไม่มี → 404', async () => {
  await assert.rejects(store.updateBill('zzzzzzzz', (b) => b), (e) => e.status === 404);
});
