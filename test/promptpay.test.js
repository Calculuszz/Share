import test from 'node:test';
import assert from 'node:assert/strict';
import { promptPayPayload, normalizePromptPayId } from '../lib/promptpay.js';

test('รูปแบบเลข PromptPay', () => {
  assert.equal(normalizePromptPayId('081-234-5678'), '0812345678');
  assert.equal(normalizePromptPayId('1 2345 67890 12 3'), '1234567890123');
  assert.equal(normalizePromptPayId('12345'), null);
});

// ค่าอ้างอิงสร้างจากไลบรารี promptpay-qr (npm) ที่ใช้กันแพร่หลาย
test('ตรงกับค่าอ้างอิง', () => {
  assert.equal(promptPayPayload('0812345678', 450),
    '00020101021229370016A000000677010111011300668123456785802TH53037645406450.0063040E36');
  assert.equal(promptPayPayload('0812345678'),
    '00020101021129370016A000000677010111011300668123456785802TH530376463045D82');
  assert.equal(promptPayPayload('1234567890123', 106.5),
    '00020101021229370016A000000677010111021312345678901235802TH53037645406106.50630478A6');
});

test('เลขผิดรูปแบบ → error', () => {
  assert.throws(() => promptPayPayload('123'));
});
