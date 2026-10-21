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

// ชื่อตัวแปรที่ Vercel Marketplace (Upstash) ใส่ให้ หรือที่ตั้งเองจาก console ของ Upstash
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const storeKind = REDIS_URL && REDIS_TOKEN ? 'redis' : process.env.VERCEL ? 'missing' : 'file';

// ---------- Redis ----------
const redis = storeKind === 'redis' ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN, automaticDeserialization: false }) : null;
const billKey = (id) => `bill:${id}`;
const qrKey = (id) => `qr:${id}`;
// เขียนเฉพาะเมื่อค่าเดิมยังเป็นอันที่เราอ่านมา
const CAS = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 else return 0 end`;

const redisBackend = {
  async get(id) {
    const raw = await redis.get(billKey(id));
    return raw ? JSON.parse(raw) : null;
  },
  async create(bill) {
    const ok = await redis.set(billKey(bill.id), JSON.stringify(bill), { nx: true });
    if (!ok) throw new StoreError(409, 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง');
  },
  async update(id, mutate) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await redis.get(billKey(id));
      if (!raw) throw new StoreError(404, 'ไม่พบบิลนี้');
      const next = stamp(JSON.parse(raw), await mutate(JSON.parse(raw)));
      const ok = await redis.eval(CAS, [billKey(id)], [raw, JSON.stringify(next)]);
      if (Number(ok) === 1) return next;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
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
  console.error('ยังไม่ได้ต่อ Redis: ตั้ง KV_REST_API_URL/KV_REST_API_TOKEN (Vercel Marketplace → Upstash) แล้ว redeploy');
  throw new StoreError(503, 'ตอนนี้เปิดบิลไม่ได้ ลองใหม่อีกสักพัก');
};
const missingBackend = { get: missing, create: missing, update: missing, saveQr: missing, deleteQr: missing, readQr: missing };

const backend = { redis: redisBackend, file: fileBackend, missing: missingBackend }[storeKind];

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
