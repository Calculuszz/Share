// ส่วนรับคำขอ /api/* — ใช้ร่วมกันทั้ง Vercel (api/index.js) และตอนรันในเครื่อง (server.js)
import { timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { createBill, getBill, updateBill, newId, isValidId, saveQr, readQr, deleteQr, storeKind } from './store.js';
import { scanReceipt, isConfigured, GEMINI_MODEL } from './gemini.js';
import { promptPayPayload, normalizePromptPayId } from './promptpay.js';
import { computeBill, shareOf, maxShareFor, cleanMenuName } from '../public/calc.js';

const MAX_JSON = 64 * 1024;
// Vercel รับ request ได้ไม่เกิน 4.5MB — หน้าเว็บย่อรูปให้ต่ำกว่านั้นก่อนส่ง
const MAX_SCAN = 4.5 * 1024 * 1024;
const MAX_QR = 3 * 1024 * 1024;
const QR_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true };
const IMAGE_TYPES =new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
  // บน Vercel มี req.body ที่ parse JSON ไว้ให้แล้ว (ขนาดถูกจำกัดที่ 4.5MB โดย Vercel อยู่แล้ว)
  if (process.env.VERCEL) {
    try {
      const body = req.body;
      if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
      if (typeof body === 'string' || Buffer.isBuffer(body)) return JSON.parse(String(body) || '{}');
    } catch {
      throw new HttpError(400, 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง');
    }
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'รูปใหญ่เกินไป ลองรูปที่เล็กลง');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง');
  }
}

// ---------- ตรวจข้อมูลที่ส่งเข้ามา ----------
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 10_000_000) throw new HttpError(400, 'ตัวเลขราคาไม่ถูกต้อง');
  return Math.round(n * 100) / 100;
};
const share = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'จำนวนไม่ถูกต้อง');
  return n;
};
const optId = (v) => (typeof v === 'string' && isValidId(v) ? v : newId());

function cleanDraft(body) {
  const people = (Array.isArray(body.people) ? body.people : []).slice(0, 40).map((p) => ({
    id: optId(p?.id),
    name: text(p?.name, 30),
    mode: p?.mode === 'pick' ? 'pick' : 'normal',
  })).filter((p) => p.name);
  if (people.length === 0) throw new HttpError(400, 'ใส่ชื่อคนในวงก่อน');
  if (new Set(people.map((p) => p.name)).size !== people.length) throw new HttpError(400, 'ชื่อคนในวงซ้ำกัน');

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 300).map((it) => ({
    id: optId(it?.id),
    qty: money(it?.qty ?? 1),
    name: text(it?.name, 120) || 'ไม่มีชื่อ',
    total: money(it?.total ?? 0),
  }));

  const payerId = people.some((p) => p.id === body.payerId) ? body.payerId : people[0].id;
  const sub = body.subtotal === null || body.subtotal === '' || body.subtotal === undefined ? null : money(body.subtotal);
  return {
    store: text(body.store, 120),
    date: text(body.date, 10),
    time: text(body.time, 5),
    table: text(body.table, 20),
    subtotal: sub,
    people, payerId, items,
  };
}

// ไม่ส่งกุญแจแก้บิลและรหัสคนจ่ายออกไป บอกแค่ว่าตั้งรหัสไว้หรือยัง
const publicBill = ({ editKey, pin, pinFails, ...rest }) => ({ ...rest, hasPin: Boolean(pin) });

// ---------- รหัสคนจ่าย ----------
// localStorage จำแยกเบราว์เซอร์และหายได้ (LINE, โหมดส่วนตัว, Safari ลบเอง) — รหัสทำให้คนจ่ายกลับมาได้จากเครื่องไหนก็ได้
const PIN_RE = /^\d{4,6}$/;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 10 * 60 * 1000;
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(pin, salt, 32).toString('hex') };
}
function pinMatches(stored, pin) {
  const a = Buffer.from(stored.hash, 'hex');
  const b = scryptSync(String(pin), stored.salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cleanPin(v) {
  const pin = String(v ?? '').trim();
  if (!PIN_RE.test(pin)) throw new HttpError(400, 'รหัสคนจ่ายต้องเป็นตัวเลข 4–6 หลัก');
  return pin;
}

// ---------- บันทึกการแก้ (req 4.5: กันแกล้งด้วยความโปร่งใส) ----------
const MAX_LOG = 500;
const logEntry = (e) => ({ at: new Date().toISOString(), ...e });
function addLog(bill, e) {
  bill.log = [...(bill.log || []), logEntry(e)].slice(-MAX_LOG);
}
/** คนที่กดแก้ — ไม่มี login จึงเชื่อชื่อที่เครื่องนั้นเลือกไว้ (ถ้าไม่รู้ = null) */
const actorOf = (bill, body) => (bill.people.some((p) => p.id === body.actorId) ? body.actorId : null);

function checkKey(bill, key) {
  const a = Buffer.from(String(bill.editKey));
  const b = Buffer.from(String(key || ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'แก้ได้เฉพาะคนที่สร้างบิล');
}

function assertOpen(bill) {
  if (bill.closed) throw new HttpError(423, 'บิลนี้ปิดแล้ว ให้คนจ่ายเปิดก่อนถึงจะแก้ได้');
}

// ---------- API ----------
async function api(req, res, parts) {
  const method = req.method;

  if (parts[0] === 'config' && method === 'GET') {
    return send(res, 200, { scanEnabled: isConfigured(), model: GEMINI_MODEL, storage: storeKind });
  }

  if (parts[0] === 'scan' && method === 'POST') {
    const body = await readJson(req, MAX_SCAN);
    const mimeType = String(body.mimeType || '');
    if (!IMAGE_TYPES.has(mimeType)) throw new HttpError(400, 'ใช้ได้แค่ไฟล์รูป');
    if (typeof body.image !== 'string' || body.image.length < 100) throw new HttpError(400, 'ไม่มีรูปบิล');
    const result = await scanReceipt(body.image.replace(/^data:[^,]+,/, ''), mimeType);
    return send(res, 200, result);
  }

  if (parts[0] !== 'bills') throw new HttpError(404, 'ไม่พบ');

  if (parts.length === 1 && method === 'POST') {
    const body = await readJson(req, MAX_JSON * 4);
    const draft = cleanDraft(body);
    const pin = hashPin(cleanPin(body.pin));
    const editKey = newId(16);
    const bill = await createBill({
      ...draft,
      items: draft.items.map((it) => ({ ...it, overrides: {} })),
      editKey, pin, closed: false,
    });
    return send(res, 201, { bill: publicBill(bill), editKey });
  }

  const id = parts[1];
  if (!isValidId(id)) throw new HttpError(404, 'ไม่พบบิลนี้');

  if (parts.length === 2 && method === 'GET') {
    const bill = await getBill(id);
    if (!bill) throw new HttpError(404, 'ไม่พบบิลนี้');
    return send(res, 200, { bill: publicBill(bill) });
  }

  const key = req.headers['x-edit-key'];

  // คนจ่ายแก้รายการ/คน — เก็บการติ๊กของเพื่อนไว้ตาม id รายการ
  if (parts.length === 2 && method === 'PUT') {
    const body = await readJson(req, MAX_JSON * 4);
    const draft = cleanDraft(body);
    // ชื่อที่หน้าแก้บิลรู้จักตอนเปิด — เพื่อนที่เพิ่มชื่อตัวเองเข้ามาทีหลังต้องไม่หายตอนคนจ่ายกดบันทึก
    const known = Array.isArray(body.knownPeople) ? new Set(body.knownPeople.filter((x) => typeof x === 'string')) : null;
    const bill = await updateBill(id, (b) => {
      checkKey(b, key);
      assertOpen(b);
      const oldItems = new Map(b.items.map((it) => [it.id, it]));
      const oldModes = new Map(b.people.map((p) => [p.id, p.mode]));
      const draftIds = new Set(draft.people.map((p) => p.id));
      const draftNames = new Set(draft.people.map((p) => p.name));
      const joinedLater = known
        ? b.people.filter((p) => !known.has(p.id) && !draftIds.has(p.id) && !draftNames.has(p.name))
        : [];
      const people = [
        // โหมดเป็นของเพื่อนแต่ละคน ไม่ให้หน้าแก้ของคนจ่ายทับ
        ...draft.people.map((p) => ({ ...p, mode: oldModes.get(p.id) ?? p.mode })),
        ...joinedLater,
      ];
      const personIds = new Set(people.map((p) => p.id));
      const paid = Object.fromEntries(Object.entries(b.paid || {}).filter(([pid]) => personIds.has(pid)));
      const done = Object.fromEntries(Object.entries(b.done || {}).filter(([pid]) => personIds.has(pid)));
      return {
        ...b, ...draft, paid, done,
        people,
        items: draft.items.map((it) => {
          const prev = oldItems.get(it.id)?.overrides ?? {};
          const overrides = Object.fromEntries(Object.entries(prev).filter(([pid]) => personIds.has(pid)));
          return { ...it, overrides };
        }),
        log: [...(b.log || []), logEntry({ kind: 'items', by: draft.payerId })].slice(-MAX_LOG),
      };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  // ติ๊ก/ใส่ส่วนทีละรายการ — ส่งเฉพาะสิ่งที่เปลี่ยน จึงไม่ทับคนอื่น
  // แก้แทนคนอื่นได้ (req 4.5: ไม่ล็อก) แต่ทุกครั้งถูกบันทึกว่าใครแก้ เพื่อให้ทุกคนเห็นและแก้คืนได้
  if (parts[2] === 'share' && method === 'PATCH') {
    const body = await readJson(req, MAX_JSON);
    const bill = await updateBill(id, (b) => {
      assertOpen(b);
      const person = b.people.find((p) => p.id === body.personId);
      if (!person) throw new HttpError(400, 'ไม่พบชื่อนี้ในวง');
      const item = b.items.find((it) => it.id === body.itemId);
      if (!item) throw new HttpError(409, 'รายการนี้ถูกลบไปแล้ว');
      const before = shareOf(item, person);
      // เพิ่มเกิน 1 ส่วนได้แค่ถึงจำนวนที่สั่ง (ทุกคนรวมกัน) — กันกดเกินจากหน้าเว็บหรือยิงคำขอตรง
      if (body.share !== null) {
        const want = share(body.share);
        const max = maxShareFor(item);
        if (want > 1 && want > before && want > max) {
          throw new HttpError(400, `${cleanMenuName(item.name)} สั่งมา ${item.qty} ใส่ได้สูงสุด ${max}`);
        }
      }
      item.overrides = { ...item.overrides };
      if (body.share === null) delete item.overrides[body.personId];
      else item.overrides[body.personId] = share(body.share);
      const after = shareOf(item, person);
      if (before !== after) {
        addLog(b, { kind: 'share', by: actorOf(b, body), person: person.id, item: item.id, itemName: item.name, from: before, to: after });
      }
      return b;
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  // เพื่อนเพิ่มชื่อตัวเองจากลิงก์ (คนจ่ายไม่ต้องพิมพ์ชื่อทุกคน) — ไม่มี login เหมือนการติ๊ก แต่บันทึกให้ทุกคนเห็น
  if (parts[2] === 'people' && method === 'POST') {
    const body = await readJson(req, MAX_JSON);
    const name = text(body.name, 30);
    if (!name) throw new HttpError(400, 'พิมพ์ชื่อก่อนนะ');
    let personId;
    const bill = await updateBill(id, (b) => {
      assertOpen(b);
      if (b.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `มีชื่อ "${name}" อยู่แล้ว กดที่ชื่อนั้นได้เลย`);
      if (b.people.length >= 40) throw new HttpError(400, 'คนในวงเยอะเกินไปแล้ว');
      personId = newId();
      b.people.push({ id: personId, name, mode: 'normal' });
      addLog(b, { kind: 'join', by: personId, person: personId });
      return b;
    });
    return send(res, 201, { bill: publicBill(bill), personId });
  }

  // "โอนแล้ว" — จำยอด ณ ตอนกดไว้ ถ้าเปิดบิลแก้แล้วยอดเปลี่ยน จะรู้ว่ายังขาดเท่าไร
  if (parts[2] === 'paid' && method === 'PATCH') {
    const body = await readJson(req, MAX_JSON);
    const bill = await updateBill(id, (b) => {
      if (!b.closed) throw new HttpError(409, 'รอคนจ่ายปิดบิลก่อนถึงจะโอนได้');
      const p = b.people.find((x) => x.id === body.personId);
      if (!p) throw new HttpError(400, 'ไม่พบชื่อนี้ในวง');
      if (p.id === b.payerId) throw new HttpError(400, 'คนจ่ายไม่ต้องโอน');
      const paid = { ...(b.paid || {}) };
      const by = actorOf(b, body);
      if (body.paid) {
        const amount = computeBill(b).perPerson[p.id].pay;
        paid[p.id] = { at: new Date().toISOString(), amount, by };
        addLog(b, { kind: 'paid', by, person: p.id, amount });
      } else if (paid[p.id]) {
        delete paid[p.id];
        addLog(b, { kind: 'unpaid', by, person: p.id });
      }
      return { ...b, paid };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  // "เลือกเสร็จแล้ว" — คนจ่ายเห็นได้เร็วว่าใครเลือกเสร็จ รอใครอยู่ (แก้ต่อได้จนกว่าจะปิดบิล)
  if (parts[2] === 'done' && method === 'PATCH') {
    const body = await readJson(req, MAX_JSON);
    const bill = await updateBill(id, (b) => {
      assertOpen(b);
      const p = b.people.find((x) => x.id === body.personId);
      if (!p) throw new HttpError(400, 'ไม่พบชื่อนี้ในวง');
      const done = { ...(b.done || {}) };
      const by = actorOf(b, body);
      if (body.done && !done[p.id]) {
        done[p.id] = new Date().toISOString();
        addLog(b, { kind: 'done', by, person: p.id });
      } else if (!body.done && done[p.id]) {
        delete done[p.id];
        addLog(b, { kind: 'undone', by, person: p.id });
      }
      return { ...b, done };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  // ใส่รหัสคนจ่ายจากเครื่องอื่น → ได้กุญแจแก้บิลกลับไป
  if (parts[2] === 'unlock' && method === 'POST') {
    const body = await readJson(req, MAX_JSON);
    const pin = String(body.pin ?? '').trim();
    let ok = false;
    const bill = await updateBill(id, (b) => {
      if (!b.pin) throw new HttpError(409, 'บิลนี้ยังไม่ได้ตั้งรหัสคนจ่าย เปิดจากเครื่องที่สร้างบิลแทนนะ');
      const now = Date.now();
      const fails = b.pinFails || { n: 0, until: 0 };
      if (fails.until > now) {
        throw new HttpError(429, `ใส่รหัสผิดหลายครั้ง รออีก ${Math.ceil((fails.until - now) / 60000)} นาที`);
      }
      ok = PIN_RE.test(pin) && pinMatches(b.pin, pin);
      if (ok) return { ...b, pinFails: { n: 0, until: 0 } };
      const n = fails.n + 1;
      return { ...b, pinFails: n >= PIN_MAX_FAILS ? { n: 0, until: now + PIN_LOCK_MS } : { n, until: 0 } };
    });
    if (ok) return send(res, 200, { editKey: bill.editKey, bill: publicBill(bill) });
    if (bill.pinFails.until) throw new HttpError(429, 'ใส่รหัสผิดหลายครั้ง รออีก 10 นาที');
    throw new HttpError(403, `รหัสไม่ถูก ใส่ได้อีก ${PIN_MAX_FAILS - bill.pinFails.n} ครั้ง`);
  }

  // ตั้ง/เปลี่ยนรหัสคนจ่าย (บิลเก่าที่ยังไม่มีรหัส) — ต้องมีกุญแจแก้บิล
  if (parts[2] === 'pin' && method === 'PUT') {
    const body = await readJson(req, MAX_JSON);
    const pin = hashPin(cleanPin(body.pin));
    const bill = await updateBill(id, (b) => {
      checkKey(b, key);
      return { ...b, pin, pinFails: { n: 0, until: 0 } };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  if (parts[2] === 'mode' && method === 'PATCH') {
    const body = await readJson(req, MAX_JSON);
    const bill = await updateBill(id, (b) => {
      assertOpen(b);
      const p = b.people.find((x) => x.id === body.personId);
      if (!p) throw new HttpError(400, 'ไม่พบชื่อนี้ในวง');
      const mode = body.mode === 'pick' ? 'pick' : 'normal';
      if (p.mode !== mode) addLog(b, { kind: 'mode', by: actorOf(b, body), person: p.id, to: mode });
      p.mode = mode;
      return b;
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  if (parts[2] === 'closed' && method === 'PUT') {
    const body = await readJson(req, MAX_JSON);
    const bill = await updateBill(id, (b) => {
      checkKey(b, key);
      addLog(b, { kind: body.closed ? 'close' : 'reopen', by: b.payerId });
      return { ...b, closed: Boolean(body.closed) };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  // ---------- QR รับเงินของคนจ่าย ----------
  // เปลี่ยนได้เฉพาะคนสร้างบิล — ปลายทางเงินต้องล็อก ไม่งั้นแกล้งเปลี่ยน QR แล้วเงินไปผิดคน
  if (parts[2] === 'payment' && method === 'PUT') {
    const body = await readJson(req, MAX_QR);
    const current = await getBill(id);
    if (!current) throw new HttpError(404, 'ไม่พบบิลนี้');
    checkKey(current, key);

    let qrType;
    if (body.qr && typeof body.qr === 'object') {
      if (!QR_TYPES[body.qr.mimeType]) throw new HttpError(400, 'ใช้ได้แค่ไฟล์รูป');
      const buf = Buffer.from(String(body.qr.image || ''), 'base64');
      if (buf.length < 100) throw new HttpError(400, 'ไม่มีรูป QR');
      await saveQr(id, buf);
      qrType = body.qr.mimeType;
    } else if (body.qr === null) {
      await deleteQr(id);
      qrType = null;
    }

    let promptpay;
    if (body.promptpay !== undefined) {
      if (body.promptpay === null || String(body.promptpay).trim() === '') promptpay = null;
      else if (!(promptpay = normalizePromptPayId(body.promptpay))) {
        throw new HttpError(400, 'เลขพร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก');
      }
    }

    const bill = await updateBill(id, (b) => {
      const pay = { ...(b.payment || {}) };
      if (qrType !== undefined) { pay.qrType = qrType; pay.qrVersion = qrType ? (pay.qrVersion || 0) + 1 : 0; }
      if (promptpay !== undefined) pay.promptpay = promptpay;
      pay.name = text(body.name ?? pay.name ?? '', 60);
      addLog(b, { kind: 'payment', by: b.payerId });
      return { ...b, payment: pay };
    });
    return send(res, 200, { bill: publicBill(bill) });
  }

  if (parts[2] === 'qr' && method === 'GET') {
    const bill = await getBill(id);
    const buf = bill?.payment?.qrType && await readQr(id);
    if (!buf) throw new HttpError(404, 'ยังไม่มี QR');
    res.writeHead(200, { 'Content-Type': bill.payment.qrType, 'Cache-Control': 'private, max-age=31536000', 'X-Content-Type-Options': 'nosniff' });
    return res.end(buf);
  }

  // QR PromptPay ของแต่ละคน ใส่ยอดที่ต้องโอนให้เลย — ยอดคำนวณที่ server ไม่เชื่อตัวเลขจากหน้าเว็บ
  if (parts[2] === 'promptpay' && parts[3] && method === 'GET') {
    const bill = await getBill(id);
    if (!bill?.payment?.promptpay) throw new HttpError(404, 'ยังไม่ได้ใส่เลขพร้อมเพย์');
    // โอนได้หลังปิดบิลเท่านั้น — ยอดจะไม่เปลี่ยนหลังเพื่อนโอนไปแล้ว
    if (!bill.closed) throw new HttpError(409, 'รอคนจ่ายปิดบิลก่อนถึงจะโอนได้');
    const r = computeBill(bill);
    const pp = r.perPerson[parts[3]];
    if (!pp) throw new HttpError(404, 'ไม่พบชื่อนี้ในวง');
    // โอนไปแล้วบางส่วน (ยอดเพิ่มหลังเปิดบิลแก้) → QR ใส่เฉพาะส่วนที่ขาด
    const already = bill.paid?.[parts[3]]?.amount || 0;
    const due = Math.max(0, pp.pay - already);
    const svg = await QRCode.toString(promptPayPayload(bill.payment.promptpay, due), {
      type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#141414', light: '#ffffff' },
    });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  throw new HttpError(404, 'ไม่พบ');
}

/** จัดการคำขอ /api/... หนึ่งครั้ง */
export async function handleApi(req, res, pathname) {
  try {
    await api(req, res, pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง' : e.message });
    else res.end();
  }
}
