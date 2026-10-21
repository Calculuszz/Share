// เก็บบิลเป็นไฟล์ JSON ทีละบิล (data/bills/<id>.json) — พอสำหรับใช้ในกลุ่มเพื่อน
// การเขียนแต่ละบิลถูกต่อคิวกัน เพื่อไม่ให้หลายคนติ๊กพร้อมกันแล้วทับกัน (req 8)
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data', 'bills');
await mkdir(DATA_DIR, { recursive: true });

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
export const newId = (bytes = 6) => randomBytes(bytes).toString('base64url');
export const isValidId = (id) => ID_RE.test(id);

const file = (id) => path.join(DATA_DIR, `${id}.json`);

export async function getBill(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await readFile(file(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeBill(bill) {
  const tmp = `${file(bill.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(bill, null, 2));
  await rename(tmp, file(bill.id));
}

const queues = new Map();
/** อ่าน → แก้ → เขียน แบบต่อคิวต่อบิล; mutate คืน bill ใหม่ หรือ throw */
export function updateBill(id, mutate) {
  const prev = queues.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const bill = await getBill(id);
    if (!bill) {
      const err = new Error('ไม่พบบิลนี้');
      err.status = 404;
      throw err;
    }
    const next = await mutate(bill);
    next.version = (bill.version || 0) + 1;
    next.updatedAt = new Date().toISOString();
    await writeBill(next);
    return next;
  });
  queues.set(id, run);
  run.finally(() => { if (queues.get(id) === run) queues.delete(id); }).catch(() => {});
  return run;
}

// รูป QR รับเงินแยกเป็นไฟล์ ไม่ยัดใน JSON (หน้าเพื่อนดึงบิลทุก 4 วิ)
const qrFile = (id) => path.join(DATA_DIR, `${id}.qr`);
export const saveQr = (id, buf) => writeFile(qrFile(id), buf);
export const deleteQr = (id) => rm(qrFile(id), { force: true });
export async function readQr(id) {
  try { return await readFile(qrFile(id)); } catch { return null; }
}

export async function createBill(bill) {
  bill.id = newId();
  bill.version = 1;
  bill.createdAt = bill.updatedAt = new Date().toISOString();
  await writeBill(bill);
  return bill;
}
