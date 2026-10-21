// อ่านบิลจากรูปด้วย Gemini (req 5.3) — เรียกจาก server เท่านั้น API key ไม่ออกไปหน้าเว็บ
//
// ใช้ Interactions API (`client.interactions.create`) ของ @google/genai >= 2.3
// ซึ่งเป็นวิธีที่ Google แนะนำตอนนี้ แทน models.generateContent แบบเดิม
// structured output ส่งผ่าน `response_format` (แทน responseMimeType/responseSchema ที่ deprecated แล้ว)
import { GoogleGenAI } from '@google/genai';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const SYSTEM_INSTRUCTION = `คุณอ่านใบเสร็จ/บิลร้านอาหารและร้านเหล้าในประเทศไทย แล้วตอบเป็น JSON ตาม schema เท่านั้น
กติกา:
- items: หนึ่งบรรทัดในบิล = หนึ่ง item ตามลำดับในบิล
- total ของแต่ละบรรทัดคือ "ราคารวมของบรรทัด" ไม่ใช่ราคาต่อหน่วย (เช่น ไส้อ่อน 2 จาน 218 → qty 2, total 218)
- ถ้าบิลมีแต่ราคาต่อหน่วย ให้คูณจำนวนเอง
- ห้ามใส่บรรทัด Subtotal, Total, VAT, Service charge, ส่วนลด, เงินทอน, เงินสด เป็น item
- subtotal = ยอดก่อน VAT/service/ส่วนลด ตามที่พิมพ์ในบิล, total = ยอดสุทธิที่ต้องจ่าย ถ้าไม่มีให้เป็น null
- ห้ามเดาตัวเลขที่อ่านไม่ออก ถ้าบรรทัดไหนไม่ชัด (เช่น นิ้วบัง เบลอ) ให้ใส่ค่าที่เห็นได้ดีที่สุดและใส่ uncertain = true
- ชื่อเมนูคงภาษาตามบิล
- date รูปแบบ YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ.), time รูปแบบ HH:MM, ถ้าไม่มีให้เป็น null
- ถ้ารูปไม่ใช่บิล ให้ items เป็น [] และ notes อธิบาย
- notes: สั้นไม่เกิน 1–2 ประโยค เขียนให้คนจ่ายอ่าน บอกแค่ว่าต้องตรวจบรรทัดไหน/มี VAT หรือ service charge ไหม ห้ามแสดงวิธีคิดหรือการคำนวณ ถ้าไม่มีอะไรต้องบอกให้เป็น null
- ราคารวมของบรรทัดสำคัญที่สุด (ใช้คิดเงิน) ส่วนจำนวนใช้แสดงผลเท่านั้น`;

const nullable = (type) => ({ type: [type, 'null'] });

export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    store: { ...nullable('string'), description: 'ชื่อร้าน' },
    date: { ...nullable('string'), description: 'YYYY-MM-DD' },
    time: { ...nullable('string'), description: 'HH:MM' },
    table: { ...nullable('string'), description: 'เลขโต๊ะ' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          qty: { type: 'number', description: 'จำนวน' },
          name: { type: 'string', description: 'ชื่อเมนู' },
          total: { type: 'number', description: 'ราคารวมของบรรทัด (ไม่ใช่ต่อหน่วย)' },
          uncertain: { type: 'boolean', description: 'true ถ้าอ่านบรรทัดนี้ไม่ชัด' },
        },
        required: ['qty', 'name', 'total', 'uncertain'],
      },
    },
    subtotal: { ...nullable('number') },
    total: { ...nullable('number') },
    notes: { ...nullable('string'), description: 'ข้อสังเกต เช่น มี VAT/service charge/ส่วนลด หรืออ่านไม่ชัด' },
  },
  required: ['store', 'date', 'time', 'table', 'items', 'subtotal', 'total', 'notes'],
};

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('Gemini: ยังไม่ได้ตั้ง GEMINI_API_KEY (ดู .env.example)');
    const err = new Error(MSG.unavailable);
    err.status = 503;
    throw err;
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * @param {string} base64 รูปบิล (base64 ไม่มี data: prefix)
 * @param {string} mimeType
 */
export async function scanReceipt(base64, mimeType) {
  const ai = getClient();
  let interaction;
  try {
    interaction = await ai.interactions.create({
      model: GEMINI_MODEL,
      system_instruction: SYSTEM_INSTRUCTION,
      input: [
        { type: 'text', text: 'อ่านบิลนี้' },
        { type: 'image', data: base64, mime_type: mimeType, resolution: 'high' },
      ],
      response_format: { type: 'text', mime_type: 'application/json', schema: RECEIPT_SCHEMA },
      generation_config: { thinking_level: 'low' },
      store: false, // ไม่ต้องเก็บรูปบิลไว้ฝั่ง Google
    });
  } catch (e) {
    console.error('Gemini error', e.status, googleMessage(e) || e.message);
    const err = new Error(friendlyError(e));
    err.status = e.status === 429 ? 429 : 502;
    throw err;
  }

  if (interaction.status && interaction.status !== 'completed') {
    console.error('Gemini: interaction status', interaction.status);
    const err = new Error(MSG.unreadable);
    err.status = 502;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(interaction.output_text ?? '');
  } catch {
    console.error('Gemini: output ไม่ใช่ JSON', String(interaction.output_text).slice(0, 200));
    const err = new Error(MSG.unreadable);
    err.status = 502;
    throw err;
  }
  return normalizeReceipt(data);
}

/** ดึงข้อความจาก error ของ Google (body เป็น JSON string ที่อาจห่อด้วย array) */
function googleMessage(e) {
  try {
    const body = typeof e.body === 'string' ? JSON.parse(e.body) : e.body;
    const obj = Array.isArray(body) ? body[0] : body;
    return obj?.error?.message || null;
  } catch {
    return null;
  }
}

// ข้อความที่ผู้ใช้เห็น — รายละเอียดทางเทคนิคอยู่ใน log ของ server
const MSG = {
  unavailable: 'ตอนนี้ถ่ายบิลไม่ได้ พิมพ์รายการเองไปก่อนนะ',
  busy: 'ตอนนี้คนใช้เยอะ รอสักครู่แล้วลองใหม่ หรือพิมพ์เองก็ได้',
  unreadable: 'อ่านบิลไม่ออก ลองถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์เองก็ได้',
};

function friendlyError(e) {
  if (e.status === 429) return MSG.busy;
  // key ผิด / ไม่มีโมเดล / สิทธิ์ไม่พอ = ต้องให้คนดูแลแก้ ผู้ใช้ทำอะไรไม่ได้
  if ([400, 401, 403, 404].includes(e.status)) return MSG.unavailable;
  return MSG.unreadable;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function normalizeReceipt(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    store: str(data?.store),
    date: str(data?.date, 10),
    time: str(data?.time, 5),
    table: str(data?.table, 20),
    subtotal: num(data?.subtotal),
    total: num(data?.total),
    notes: str(data?.notes, 500),
    items: items.slice(0, 200).map((it) => ({
      qty: num(it?.qty) ?? 1,
      name: str(it?.name) ?? '(อ่านชื่อไม่ออก)',
      total: num(it?.total) ?? 0,
      uncertain: Boolean(it?.uncertain) || num(it?.total) === null,
    })),
  };
}
