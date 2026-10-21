// ที่เก็บบิล มี 2 แบบ เลือกอัตโนมัติ:
// - Redis (Upstash) — ใช้บน Vercel เพราะ function ไม่มีดิสก์ถาวร และรันหลายตัวพร้อมกันได้
// - ไฟล์ JSON ใน data/bills/ — ใช้ตอนรันในเครื่องโดยไม่ตั้ง Redis
//
// กันหลายคนแก้บิลเดียวกันพร้อมกันแล้วทับกัน (req 8):
// - Redis: อ่าน → แก้ → เขียนแบบ compare-and-set (Lua) ถ้ามีคนเขียนก่อนให้อ่านใหม่แล้วลองอีกรอบ
// - ไฟล์: ต่อคิวการเขียนต่อบิลใน process เดียว
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Redis } from '@upstash/redis';

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
export const newId = (bytes = 6) => randomBytes(bytes).toString('base64url');
export const isValidId = (id) => ID_RE.test(id);

class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ชื่อตัวแปรต่างกันตามผู้ให้บริการ/วิธีต่อ:
// - Upstash ผ่าน Vercel Marketplace: KV_REST_API_URL + KV_REST_API_TOKEN (ถ้าตั้ง Custom Prefix จะเป็น <PREFIX>_KV_REST_API_URL)
// - Upstash console: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// - Redis แบบอื่น (เช่น Redis Cloud บน Marketplace): REDIS_URL (redis:// หรือ rediss://) ต่อแบบ TCP
const env = (name) => process.env[name]
  || Object.entries(process.env).find(([k, v]) => k.endsWith(`_${name}`) && v)?.[1];
const REST_URL = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
const REST_TOKEN = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
const TCP_URL = [env('REDIS_URL'), env('KV_URL')].find((u) => /^rediss?:\/\//.test(u || ''));

export const storeKind = REST_URL && REST_TOKEN ? 'redis'
  : TCP_URL ? 'redis-tcp'
    : process.env.VERCEL ? 'missing' : 'file';

// ---------- Redis ----------
// ทั้ง 2 แบบห่อให้มีคำสั่งชุดเดียวกัน: get / setNX / set / del / cas
// cas = เขียนเฉพาะเมื่อค่าเดิมยังเป็นอันที่เราอ่านมา (ทำใน Redis ทีเดียว ไม่มีใครแทรกได้)
const CAS = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 else return 0 end`;

function restClient() {
  const r = new Redis({ url: REST_URL, token: REST_TOKEN, automaticDeserialization: false });
  return {
    get: (k) => r.get(k),
    setNX: async (k, v) => Boolean(await r.set(k, v, { nx: true })),
    set: (k, v) => r.set(k, v),
    del: (k) => r.del(k),
    cas: async (k, expected, next) => Number(await r.eval(CAS, [k], [expected, next])) === 1,
  };
}

function tcpClient() {
  // ต่อครั้งเดียวแล้วใช้ซ้ำข้ามคำขอ (Vercel fluid compute ใช้ instance เดิมซ้ำ)
  let ready;
  const conn = () => (ready ??= (async () => {
    const { createClient } = await import('redis');
    const c = createClient({ url: TCP_URL });
    c.on('error', (e) => console.error('Redis error', e.message));
    await c.connect();
    return c;
  })().catch((e) => { ready = undefined; throw e; }));
  return {
    get: async (k) => (await conn()).get(k),
    setNX: async (k, v) => (await (await conn()).set(k, v, { condition: 'NX' })) === 'OK',
    set: async (k, v) => (await conn()).set(k, v),
    del: async (k) => (await conn()).del(k),
    cas: async (k, expected, next) => Number(await (await conn()).eval(CAS, { keys: [k], arguments: [expected, next] })) === 1,
  };
}

const redis = storeKind === 'redis' ? restClient() : storeKind === 'redis-tcp' ? tcpClient() : null;
const billKey = (id) => `bill:${id}`;
const qrKey = (id) => `qr:${id}`;

const redisBackend = {
  async get(id) {
    const raw = await redis.get(billKey(id));
    return raw ? JSON.parse(raw) : null;
  },
  async create(bill) {
    const ok = await redis.setNX(billKey(bill.id), JSON.stringify(bill));
    if (!ok) throw new StoreError(409, 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง');
  },
  async update(id, mutate) {
    // ถ้ามีคนเขียนแทรก ลองใหม่ เว้นระยะห่างขึ้นเรื่อย ๆ แบบสุ่ม (สูงสุด ~0.5 วิ) จะได้ไม่ชนกันซ้ำ
    for (let attempt = 0; attempt < 30; attempt++) {
      const raw = await redis.get(billKey(id));
      if (!raw) throw new StoreError(404, 'ไม่พบบิลนี้');
      const next = stamp(JSON.parse(raw), await mutate(JSON.parse(raw)));
      if (await redis.cas(billKey(id), raw, JSON.stringify(next))) return next;
      const cap = Math.min(500, 20 * 1.5 ** attempt);
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
    throw new StoreError(409, 'ตอนนี้มีคนแก้พร้อมกันเยอะ ลองใหม่อีกครั้ง');
  },
  saveQr: (id, buf) => redis.set(qrKey(id), buf.toString('base64')),
  deleteQr: (id) => redis.del(qrKey(id)),
  async readQr(id) {
    const b64 = await redis.get(qrKey(id));
    return b64 ? Buffer.from(b64, 'base64') : null;
  },
};

// ---------- ไฟล์ ----------
const DATA_DIR = process.env.DATA_DIR || path.resolve('data', 'bills');
const file = (id) => path.join(DATA_DIR, `${id}.json`);
const qrFile = (id) => path.join(DATA_DIR, `${id}.qr`);
const queues = new Map();
let dirReady;
const ensureDir = () => (dirReady ??= mkdir(DATA_DIR, { recursive: true }));

async function writeJson(bill) {
  await ensureDir();
  const tmp = `${file(bill.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(bill, null, 2));
  await rename(tmp, file(bill.id));
}

const fileBackend = {
  async get(id) {
    try {
      return JSON.parse(await readFile(file(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  },
  create: writeJson,
  update(id, mutate) {
    const prev = queues.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const bill = await fileBackend.get(id);
      if (!bill) throw new StoreError(404, 'ไม่พบบิลนี้');
      const next = stamp(bill, await mutate(bill));
      await writeJson(next);
      return next;
    });
    queues.set(id, run);
    run.finally(() => { if (queues.get(id) === run) queues.delete(id); }).catch(() => {});
    return run;
  },
  saveQr: async (id, buf) => { await ensureDir(); await writeFile(qrFile(id), buf); },
  deleteQr: (id) => rm(qrFile(id), { force: true }),
  async readQr(id) {
    try { return await readFile(qrFile(id)); } catch { return null; }
  },
};

// บน Vercel แต่ยังไม่ได้ต่อ Redis — ดิสก์ของ function เขียนไม่ได้ จึงบอกให้ชัดแทนการพังเงียบ ๆ
const missing = () => {
  // บอกชื่อตัวแปรที่เจอ (ไม่บอกค่า) จะได้รู้ว่าต่อแล้วแต่ชื่อไม่ตรง หรือยังไม่ได้ต่อเลย
  const names = Object.keys(process.env).filter((k) => /REDIS|KV_|UPSTASH/i.test(k));
  console.error(`ยังไม่ได้ต่อ Redis: ต้องมี KV_REST_API_URL+KV_REST_API_TOKEN หรือ REDIS_URL แล้ว redeploy (ตัวแปรที่เจอ: ${names.join(', ') || 'ไม่มี'})`);
  throw new StoreError(503, 'ตอนนี้เปิดบิลไม่ได้ ลองใหม่อีกสักพัก');
};
const missingBackend = { get: missing, create: missing, update: missing, saveQr: missing, deleteQr: missing, readQr: missing };

const backend = { redis: redisBackend, 'redis-tcp': redisBackend, file: fileBackend, missing: missingBackend }[storeKind];

function stamp(prev, next) {
  next.version = (prev.version || 0) + 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

// ---------- API ที่ server ใช้ ----------
export const getBill = (id) => (isValidId(id) ? backend.get(id) : null);
/** อ่าน → แก้ → เขียน; mutate คืน bill ใหม่ หรือ throw */
export const updateBill = (id, mutate) => backend.update(id, mutate);
export const saveQr = (id, buf) => backend.saveQr(id, buf);
export const deleteQr = (id) => backend.deleteQr(id);
export const readQr = (id) => backend.readQr(id);

export async function createBill(bill) {
  bill.id = newId();
  bill.version = 1;
  bill.createdAt = bill.updatedAt = new Date().toISOString();
  await backend.create(bill);
  return bill;
}
