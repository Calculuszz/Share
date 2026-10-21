// ส่วนคำนวณ (req ข้อ 3) — ใช้ร่วมกันทั้งหน้าเว็บและ server
//
// กฎข้อเดียว: ทุกรายการมีรายชื่อคนกิน แต่ละคนมี "ส่วน"
// ยอดของ X ในรายการ = ราคารวมของบรรทัด × (ส่วนของ X ÷ ผลรวมส่วนในรายการ)
//
// ส่วนของแต่ละคนในแต่ละรายการ = ค่าที่คนนั้นตั้งเองไว้ (overrides)
// ถ้าไม่เคยตั้ง → ใช้ค่าเริ่มต้นตามโหมด: "normal" = 1, "pick" = 0 (req 4.1, 4.2)

const EPS = 1e-6;

export function shareOf(item, person) {
  const o = item.overrides?.[person.id];
  if (typeof o === 'number' && Number.isFinite(o) && o >= 0) return o;
  return person.mode === 'pick' ? 0 : 1;
}

/** ยอดรวมของรายการทั้งหมด */
export function itemsTotal(items) {
  return items.reduce((s, it) => s + (Number(it.total) || 0), 0);
}

/** ปัดขึ้นเป็นบาทเต็ม ครั้งเดียวตอนท้าย (req 3.4) — กันเศษทศนิยมของ float เช่น 504.0000000001 */
export function roundUpBaht(x) {
  return Math.ceil(Math.round(x * 1e6) / 1e6);
}

/**
 * คำนวณบิล
 * @returns {{
 *   perPerson: Record<string, {exact:number, pay:number, lines:{itemId:string, amount:number, share:number}[]}>,
 *   itemRows: {item:object, shareSum:number, unassigned:boolean}[],
 *   unassigned: {item:object}[], unassignedTotal:number,
 *   billTotal:number, assignedTotal:number, balanced:boolean,
 *   transfers: {from:string, to:string, amount:number}[]
 * }}
 */
export function computeBill(bill) {
  const people = bill.people || [];
  const items = bill.items || [];
  const perPerson = {};
  for (const p of people) perPerson[p.id] = { exact: 0, pay: 0, lines: [] };

  const itemRows = [];
  const unassigned = [];
  for (const item of items) {
    const total = Number(item.total) || 0;
    const shares = people.map((p) => [p, shareOf(item, p)]);
    const shareSum = shares.reduce((s, [, v]) => s + v, 0);
    const isUnassigned = shareSum <= 0 && total !== 0;
    itemRows.push({ item, shareSum, unassigned: isUnassigned });
    if (isUnassigned) { unassigned.push({ item }); continue; }
    if (shareSum <= 0) continue;
    for (const [p, v] of shares) {
      if (v <= 0) continue;
      const amount = total * (v / shareSum); // ไม่ปัดระหว่างทาง
      perPerson[p.id].exact += amount;
      perPerson[p.id].lines.push({ itemId: item.id, amount, share: v });
    }
  }

  for (const id in perPerson) perPerson[id].pay = roundUpBaht(perPerson[id].exact);

  const billTotal = itemsTotal(items);
  const unassignedTotal = unassigned.reduce((s, u) => s + (Number(u.item.total) || 0), 0);
  const assignedTotal = Object.values(perPerson).reduce((s, p) => s + p.exact, 0);

  // การโอนคืน (req 3.5): ทุกคนยกเว้นคนจ่าย โอนยอดของตัวเองให้คนจ่าย
  const transfers = [];
  if (bill.payerId && perPerson[bill.payerId]) {
    for (const p of people) {
      if (p.id === bill.payerId) continue;
      if (perPerson[p.id].pay > 0) transfers.push({ from: p.id, to: bill.payerId, amount: perPerson[p.id].pay });
    }
  }

  return {
    perPerson, itemRows, unassigned, unassignedTotal,
    billTotal, assignedTotal,
    // ตัวเช็ค (req 3.6): ผลรวมยอดละเอียด ต้องเท่ายอดบิล
    balanced: Math.abs(assignedTotal - billTotal) < EPS,
    transfers,
  };
}

/** เทียบผลรวมรายการกับ Subtotal ในบิล (req 5.2) — ห้ามปรับให้ตรงเอง แค่รายงานส่วนต่าง */
export function checkSubtotal(items, subtotal) {
  const sum = itemsTotal(items);
  if (subtotal === null || subtotal === undefined || subtotal === '' || !Number.isFinite(Number(subtotal))) {
    return { sum, subtotal: null, diff: null, matches: false };
  }
  const diff = Number(subtotal) - sum; // บวก = รายการขาดไป, ลบ = รายการเกิน
  return { sum, subtotal: Number(subtotal), diff, matches: Math.abs(diff) < 0.005 };
}
