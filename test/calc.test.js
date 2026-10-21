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

test('เพดานรายคน = จำนวนที่สั่ง ไม่ต้องรอคนอื่น', async () => {
  const { maxShareFor } = await import('../public/calc.js');
  assert.equal(maxShareFor({ qty: 8 }), 8);
  assert.equal(maxShareFor({ qty: 1 }), 1);
  assert.equal(maxShareFor({ qty: 0 }), 1);
});

test('ใส่รวมเกินจำนวนที่สั่ง: เตือนเฉพาะเมื่อมีคนใส่จำนวนชิ้น', async () => {
  const { overCount, computeBill } = await import('../public/calc.js');
  const ppl = people.slice(0, 4); // เอ บี ซี ปกติ, ดี เลือกเอง
  // ข้าวเหนียว 8: บี 5 + เอ 1 + ซี 1 (ยังไม่ได้เข้ามา) = 7 → ยังไม่เกิน
  assert.equal(overCount({ qty: 8, overrides: { b: 5 } }, ppl).over, false);
  // บี 8 + เอ 1 + ซี 1 = 10 > 8 → เกิน
  const o = overCount({ qty: 8, overrides: { b: 8 } }, ppl);
  assert.deepEqual([o.sum, o.qty, o.over], [10, 8, true]);
  // เบียร์ 3 ขวด เอ บี ซี คนละ 1 + ดี 1 = 4 > 3 แต่เป็นของแชร์ปกติ → ไม่เตือน
  assert.equal(overCount({ qty: 3, overrides: { d: 1 } }, ppl).over, false);
  const r = computeBill({ people: ppl, items: [{ id: 'x', qty: 8, total: 120, overrides: { b: 8 } }] });
  assert.equal(r.overItems.length, 1);
  assert.equal(r.balanced, true); // ยอดเงินยังครบ แค่สัดส่วนยังไม่ตรง
});
