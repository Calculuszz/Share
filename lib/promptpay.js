// สร้างข้อความ QR PromptPay (มาตรฐาน EMVCo / Thai QR Payment) พร้อมยอดเงิน
// รับเบอร์มือถือ 10 หลัก หรือเลขประจำตัว 13 หลัก (บัตร ปชช./นิติบุคคล)

const f = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

function crc16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** คืนเลขที่ทำความสะอาดแล้ว หรือ null ถ้าไม่ใช่รูปแบบ PromptPay */
export function normalizePromptPayId(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return d;
  if (/^\d{13}$/.test(d)) return d;
  return null;
}

export function promptPayPayload(id, amount) {
  const target = normalizePromptPayId(id);
  if (!target) throw new Error('เบอร์/เลข PromptPay ไม่ถูกต้อง');
  const account = target.length === 10
    ? f('01', `0066${target.slice(1)}`) // เบอร์มือถือ → 0066 + ตัด 0 หน้า
    : f('02', target);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const body = [
    f('00', '01'),
    f('01', hasAmount ? '12' : '11'),
    f('29', f('00', 'A000000677010111') + account),
    f('58', 'TH'),
    f('53', '764'),
    hasAmount ? f('54', amount.toFixed(2)) : '',
  ].join('') + '6304';
  return body + crc16(body);
}
