// โมเดลหลักไม่ว่าง/โควตาหมด → ลองโมเดลสำรอง; ข้อความที่ผู้ใช้เห็นตรงกับสาเหตุจริง
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-3.8-flash';
delete process.env.GEMINI_FALLBACK_MODEL;

const calls = [];
let plan = []; // แต่ละครั้งที่เรียก: { status, message } = error, หรือ 'ok'
const ok = { status: 'completed', output_text: JSON.stringify({ store: null, date: null, time: null, table: null, subtotal: 99, total: 99, notes: null, items: [{ qty: 1, name: '(C4) ข้าวผัด', total: 99, uncertain: false }] }) };

// จำลอง SDK: ไม่ต้องต่อ Google จริง
const sdk = await import('@google/genai');
const { scanReceipt } = await import('../lib/gemini.js');
const origCreate = Object.getOwnPropertyDescriptor(sdk.GoogleGenAI.prototype, 'interactions');

function install(fakeCreate) {
  Object.defineProperty(sdk.GoogleGenAI.prototype, 'interactions', { configurable: true, get() { return { create: fakeCreate }; } });
}
install(async (params) => {
  calls.push(params.model);
  const step = plan.shift();
  if (step === 'ok') return ok;
  const e = new Error(step.message); e.status = step.status; e.body = JSON.stringify({ error: { message: step.message } });
  throw e;
});
test.after(() => { if (origCreate) Object.defineProperty(sdk.GoogleGenAI.prototype, 'interactions', origCreate); });

const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

test('โมเดลหลักไม่ว่าง (503) → ใช้โมเดลสำรองแล้วอ่านได้', async () => {
  calls.length = 0; plan = [{ status: 503, message: 'high demand' }, 'ok'];
  const r = await quiet(() => scanReceipt('aGVsbG8=', 'image/jpeg'));
  assert.deepEqual(calls, ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.equal(r.items[0].name, 'ข้าวผัด');
});

test('ทั้ง 2 รุ่นไม่ว่าง → บอกว่าคนใช้เยอะ ไม่ใช่ "อ่านบิลไม่ออก"', async () => {
  calls.length = 0; plan = [{ status: 503, message: 'high demand' }, { status: 503, message: 'high demand' }];
  await assert.rejects(quiet(() => scanReceipt('aGVsbG8=', 'image/jpeg')), (e) => /คนใช้เยอะ/.test(e.message));
  assert.equal(calls.length, 2);
});

test('โควตารายวันหมดทั้งคู่ → บอกว่าวันนี้ครบแล้ว', async () => {
  calls.length = 0; plan = [{ status: 429, message: 'limit: 20 requests per day' }, { status: 429, message: 'limit: 20 requests per day' }];
  await assert.rejects(quiet(() => scanReceipt('aGVsbG8=', 'image/jpeg')), (e) => /วันนี้ถ่ายบิลครบ/.test(e.message) && e.status === 429);
});

test('key ผิด (400) → ไม่ลองรุ่นอื่น เพราะลองไปก็ไม่ช่วย', async () => {
  calls.length = 0; plan = [{ status: 400, message: 'API key not valid' }];
  await assert.rejects(quiet(() => scanReceipt('aGVsbG8=', 'image/jpeg')), (e) => /ตอนนี้ถ่ายบิลไม่ได้/.test(e.message));
  assert.equal(calls.length, 1);
});
