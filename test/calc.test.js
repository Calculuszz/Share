import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, checkSubtotal, roundUpBaht, shareOf } from '../public/calc.js';

const people = [
  { id: 'a', name: 'เอ', mode: 'normal' },
  { id: 'b', name: 'บี', mode: 'normal' },
  { id: 'c', name: 'ซี', mode: 'normal' },
  { id: 'd', name: 'ดี', mode: 'pick' }, // กินเหล้าอย่างเดียว → โหมดเลือกเอง
];

// ตัวอย่างใน req 3.3
const exampleBill = {
  payerId: 'a',
  people,
  items: [
    { id: 'i1', qty: 1, name: 'ข้าวผัดหมู', total: 99, overrides: { b: 0, c: 0 } },
    { id: 'i2', qty: 1, name: 'ลาบเป็ด', total: 139, overrides: {} },
    { id: 'i3', qty: 7, name: 'ข้าวเหนียว', total: 105, overrides: { a: 0, b: 3, c: 4 } },
    { id: 'i4', qty: 3, name: 'เบียร์โปร', total: 1076, overrides: { c: 0, d: 1 } },
  ],
};

test('ตัวอย่าง req 3.3 ได้ยอดตรงตาราง', () => {
  const r = computeBill(exampleBill);
  const close = (x, y) => assert.ok(Math.abs(x - y) < 0.01, `${x} ≈ ${y}`);
  close(r.perPerson.a.exact, 504.0);
  close(r.perPerson.b.exact, 450.0);
  close(r.perPerson.c.exact, 106.33);
  close(r.perPerson.d.exact, 358.67);
  assert.deepEqual(
    ['a', 'b', 'c', 'd'].map((id) => r.perPerson[id].pay),
    [504, 450, 107, 359],
  );
  assert.equal(r.balanced, true);
  assert.equal(r.unassigned.length, 0);
});

test('การโอน: ทุกคนยกเว้นคนจ่ายโอนให้คนจ่าย', () => {
  const r = computeBill(exampleBill);
  assert.deepEqual(r.transfers, [
    { from: 'b', to: 'a', amount: 450 },
    { from: 'c', to: 'a', amount: 107 },
    { from: 'd', to: 'a', amount: 359 },
  ]);
});

test('ปัดครั้งเดียวตอนท้าย ไม่ปัดเพราะเศษ float', () => {
  assert.equal(roundUpBaht(504.0000000001), 504);
  assert.equal(roundUpBaht(106.3333), 107);
  assert.equal(roundUpBaht(0), 0);
  // 3 คนหาร 100 สามรายการ: ปัดทีละรายการจะได้ 102 แต่ปัดตอนท้ายได้ 100
  const bill = {
    people: people.slice(0, 3),
    items: [1, 2, 3].map((n) => ({ id: 'x' + n, total: 100, overrides: {} })),
  };
  assert.equal(computeBill(bill).perPerson.a.pay, 100);
});

test('รายการไม่มีเจ้าของ: เตือน ไม่หารแทน', () => {
  const bill = {
    people: people.slice(0, 2),
    items: [
      { id: 'x', total: 200, overrides: { a: 0, b: 0 } },
      { id: 'y', total: 100, overrides: {} },
    ],
  };
  const r = computeBill(bill);
  assert.equal(r.unassigned.length, 1);
  assert.equal(r.unassignedTotal, 200);
  assert.equal(r.balanced, false);
  assert.equal(r.perPerson.a.exact, 50);
  assert.equal(r.perPerson.b.exact, 50);
});

test('โหมดเลือกเอง: เริ่มที่ 0, ติ๊กแล้วได้ 1', () => {
  const d = people[3];
  assert.equal(shareOf({ overrides: {} }, d), 0);
  assert.equal(shareOf({ overrides: { d: 1 } }, d), 1);
  assert.equal(shareOf({ overrides: {} }, people[0]), 1);
});

test('เทียบ Subtotal รายงานส่วนต่าง ไม่ปรับเอง', () => {
  const items = [{ total: 99 }, { total: 139 }];
  assert.deepEqual(checkSubtotal(items, 238), { sum: 238, subtotal: 238, diff: 0, matches: true });
  const r = checkSubtotal(items, 456);
  assert.equal(r.matches, false);
  assert.equal(r.diff, 218);
  assert.equal(checkSubtotal(items, '').matches, false);
});

test('ตัดรหัสเมนูหน้าชื่อ', async () => {
  const { cleanMenuName } = await import('../public/calc.js');
  const cases = {
    '(C4) ไส้อ่อนทอดกระเทียม': 'ไส้อ่อนทอดกระเทียม',
    '(R26) ข้าวผัดหมู (ล)': 'ข้าวผัดหมู (ล)',
    '(D40) ช้างคลาสิค 1 โปร (3 ขวด)': 'ช้างคลาสิค 1 โปร (3 ขวด)',
    'R03 ข้าวเหนียว': 'ข้าวเหนียว',
    'A12. ต้มยำ': 'ต้มยำ',
    'ลาบเป็ด': 'ลาบเป็ด',
    '(ล) น้ำเปล่า': '(ล) น้ำเปล่า',
    '(C4)': '(C4)',
  };
  for (const [a, b] of Object.entries(cases)) assert.equal(cleanMenuName(a), b, a);
});

test('เพดานส่วน: ทุกคนรวมกันไม่เกินจำนวนที่สั่ง แต่กินด้วย 1 ส่วนได้เสมอ', async () => {
  const { maxShareFor } = await import('../public/calc.js');
  const ppl = people.slice(0, 3); // เอ บี ซี โหมดปกติ
  const sticky = { qty: 7, overrides: { a: 0, b: 3 } }; // ซี default 1
  assert.equal(maxShareFor(sticky, ppl, 'c'), 4); // 7 - บี 3
  assert.equal(maxShareFor(sticky, ppl, 'b'), 6); // 7 - ซี 1
  const beer = { qty: 3, overrides: {} }; // 3 ขวด 3 คน คนละ 1 → เต็มแล้ว
  assert.equal(maxShareFor(beer, ppl, 'a'), 1);
  const full = { qty: 2, overrides: {} }; // 2 ชิ้น 3 คน → เกินอยู่แล้ว แต่ยังกินด้วยได้
  assert.equal(maxShareFor(full, ppl, 'a'), 1);
  assert.equal(maxShareFor({ qty: 8, overrides: { a: 0, b: 0, c: 0 } }, ppl, 'a'), 8);
});
