// ทดสอบที่เก็บแบบ REDIS_URL (TCP) ด้วย Redis ปลอมที่พูดโปรโตคอล RESP จริง
// และทดสอบว่าเจอตัวแปรที่มี prefix (เช่น STORAGE_REDIS_URL)
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const db = new Map();
const seen = new Set();

function reply(v) {
  if (v === null) return '$-1\r\n';
  if (typeof v === 'number') return `:${v}\r\n`;
  if (v instanceof Error) return `-${v.message}\r\n`;
  if (v === 'OK' || v === 'PONG') return `+${v}\r\n`;
  const b = Buffer.from(String(v));
  return `$${b.length}\r\n${b}\r\n`;
}

function exec([cmd, ...a]) {
  const c = cmd.toUpperCase();
  seen.add(c);
  switch (c) {
    case 'PING': return 'PONG';
    case 'CLIENT': case 'SELECT': return 'OK';
    case 'GET': return db.get(a[0]) ?? null;
    case 'SET': {
      if (a.slice(2).some((x) => x.toUpperCase() === 'NX') && db.has(a[0])) return null;
      db.set(a[0], a[1]);
      return 'OK';
    }
    case 'DEL': return db.delete(a[0]) ? 1 : 0;
    case 'EVAL': { // CAS ของ store.js: EVAL script 1 key expected next
      const [, , key, expected, next] = a;
      if (db.get(key) !== expected) return 0;
      db.set(key, next);
      return 1;
    }
    default: return new Error(`ERR unknown command '${cmd}'`);
  }
}

// อ่านคำสั่งแบบ RESP array of bulk strings
function parse(buf) {
  const out = [];
  let i = 0;
  const line = () => { const j = buf.indexOf('\r\n', i); if (j < 0) return null; const s = buf.toString('utf8', i, j); i = j + 2; return s; };
  while (i < buf.length) {
    const start = i;
    const head = line();
    if (head === null || head[0] !== '*') { i = start; break; }
    const n = Number(head.slice(1));
    const args = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const len = line();
      if (len === null) { ok = false; break; }
      const L = Number(len.slice(1));
      if (i + L + 2 > buf.length) { ok = false; break; }
      args.push(buf.toString('utf8', i, i + L));
      i += L + 2;
    }
    if (!ok) { i = start; break; }
    out.push(args);
  }
  return { cmds: out, rest: buf.subarray(i) };
}

const server = net.createServer((sock) => {
  let pending = Buffer.alloc(0);
  sock.on('data', (d) => {
    const { cmds, rest } = parse(Buffer.concat([pending, d]));
    pending = rest;
    for (const c of cmds) sock.write(reply(exec(c)));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.REDIS_URL;
// แบบที่ Vercel ใส่ prefix ให้
process.env.STORAGE_REDIS_URL = `redis://127.0.0.1:${server.address().port}`;
const store = await import('../lib/store.js');

test.after(() => { server.close(); setTimeout(() => process.exit(0), 50); });

test('เจอ REDIS_URL ที่มี prefix แล้วใช้แบบ TCP', () => {
  assert.equal(store.storeKind, 'redis-tcp');
});

test('สร้าง อ่าน แก้บิล (มีภาษาไทย)', async () => {
  const bill = await store.createBill({ name: 'จิ้มจุ่มหม้อดิน', n: 0 });
  const next = await store.updateBill(bill.id, (b) => ({ ...b, n: 1 }));
  assert.equal(next.version, 2);
  assert.deepEqual(await store.getBill(bill.id), next);
});

test('แก้พร้อมกัน 25 ครั้ง ไม่หาย', async () => {
  const bill = await store.createBill({ hits: [] });
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.updateBill(bill.id, (b) => ({ ...b, hits: [...b.hits, i] }))));
  assert.equal((await store.getBill(bill.id)).hits.length, 25);
  assert.ok(seen.has('EVAL'));
});

test('รูป QR อ่านกลับได้ตรงทุก byte', async () => {
  const buf = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
  await store.saveQr('qrqrqrqr', buf);
  assert.deepEqual(await store.readQr('qrqrqrqr'), buf);
});
