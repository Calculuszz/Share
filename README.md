# หารค่าเหล้า

เว็บหารค่าข้าววงเหล้า ตาม [req.md](req.md) — คนจ่ายถ่ายรูปบิล/พิมพ์รายการ → เทียบ Subtotal → แชร์ลิงก์ → เพื่อนเลือกชื่อแล้วติ๊กของที่กิน → ได้ยอดโอนของแต่ละคน

## เริ่มใช้

```bash
npm install
cp .env.example .env   # ใส่ GEMINI_API_KEY (ไม่ใส่ก็ใช้แบบพิมพ์เองได้)
npm start              # http://localhost:3000
npm test               # ทดสอบส่วนคำนวณ (มีตัวอย่าง req 3.3)
```

ต้องใช้ Node 22.9 ขึ้นไป

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `public/calc.js` | ส่วนคำนวณ (req ข้อ 3) ใช้ร่วมกันทั้งหน้าเว็บและเทสต์ |
| `public/index.html` + `editor.js` | หน้าคนจ่าย: สแกน/พิมพ์รายการ, เทียบ Subtotal, แชร์ (`/`, `/edit/:id`) |
| `public/bill.html` + `bill.js` | หน้าเพื่อนติ๊ก + สรุปยอด (`/b/:id`) อัปเดตสดทุก 4 วิ |
| `lib/promptpay.js` | สร้าง QR PromptPay ใส่ยอดของแต่ละคน (เทสต์เทียบกับไลบรารี promptpay-qr) |
| `lib/gemini.js` | อ่านบิลด้วย Gemini — เรียกจาก server เท่านั้น |
| `lib/app.js` | API ทั้งหมด (/api/*) ใช้ร่วมกันทั้ง Vercel และในเครื่อง |
| `lib/store.js` | ที่เก็บบิล: Upstash Redis ถ้าตั้งไว้ ไม่งั้นเป็นไฟล์ใน `data/bills/` |
| `api/index.js` | จุดเข้าของ Vercel Function |
| `server.js` | server สำหรับรันในเครื่อง (ไฟล์หน้าเว็บ + API) |

## Deploy บน Vercel

1. Vercel → Add New Project → เลือก repo นี้ (ไม่ต้องตั้ง build command, `vercel.json` ตั้งไว้ให้แล้ว)
2. โปรเจกต์ → แท็บ **Storage** → **Upstash (Redis)** → แผนฟรี, region **Singapore** → เชื่อมกับโปรเจกต์
   Vercel จะใส่ `KV_REST_API_URL` และ `KV_REST_API_TOKEN` ให้เอง
3. Settings → Environment Variables → ใส่ `GEMINI_API_KEY` (และ `GEMINI_MODEL` ถ้าอยากเปลี่ยน)
4. Deployments → Redeploy เพื่อให้ค่าใหม่มีผล

| ตัวแปร | ต้องมีไหม |
|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | ต้องมี — ไม่งั้นบันทึกบิลไม่ได้ (หน้าเว็บจะขึ้น "ตอนนี้เปิดบิลไม่ได้") |
| `GEMINI_API_KEY` | ต้องมีถ้าจะถ่ายบิล — ไม่มีก็ยังพิมพ์รายการเองได้ |
| `GEMINI_MODEL` | ไม่ต้อง (ค่าเริ่มต้น `gemini-3.8-flash`) |

ข้อจำกัดของ Vercel ที่เกี่ยว: request ละไม่เกิน 4.5MB (หน้าเว็บย่อรูปบิลให้แล้ว), function ตั้งเวลาไว้ 60 วินาที, region `sin1`

## Gemini

ใช้ **Interactions API** (`client.interactions.create`) ของ `@google/genai` 2.x ซึ่งเป็นวิธีที่ Google แนะนำตอนนี้
- structured output ผ่าน `response_format: { type: 'text', mime_type: 'application/json', schema }`
- `store: false` ไม่ให้ Google เก็บรูปบิล, `thinking_level: 'low'` ให้ตอบเร็ว
- โมเดลเปลี่ยนได้ที่ `GEMINI_MODEL` (ค่าเริ่มต้น `gemini-3.8-flash`, ประหยัดกว่า: `gemini-3.5-flash-lite`)

## ระบุตัวตน & ความโปร่งใส (req 4.5)

- ไม่มี login: เปิดลิงก์ → เลือกชื่อตัวเอง เครื่องจำไว้ (ปุ่มชื่อตัวเองที่แถบล่างใช้เปลี่ยนชื่อ)
- ทุกคนแก้รายชื่อคนกินของรายการไหนก็ได้ (ปุ่มรูปคนบนการ์ดรายการ) รวมถึงแก้แทนคนอื่น
- ทุกการแก้ถูกบันทึก: ใคร แก้อะไร ของใคร เมื่อไร — แสดงใต้การ์ดรายการ, ในแท็บสรุป และขึ้นเตือนเจ้าตัวว่า "มีคนแก้ของคุณ"
- ข้อยกเว้นที่ล็อก: **ช่องทางรับเงิน (QR/PromptPay) แก้ได้เฉพาะเครื่องที่สร้างบิล** เพราะถ้าแกล้งเปลี่ยน เงินจะไปผิดคน ซึ่งแก้คืนไม่ได้

## QR รับเงิน

คนจ่ายใส่ได้ 2 แบบในหน้าสร้างบิล (จำไว้ใช้บิลหน้า):
- **PromptPay** เบอร์มือถือ/เลข 13 หลัก → เพื่อนแต่ละคนได้ QR ที่มียอดของตัวเอง สแกนแล้วยอดขึ้นเลย (server คำนวณยอดเอง)
- **แปะรูป QR** จากแอปธนาคาร → เพื่อนสแกนแล้วพิมพ์ยอดเอง

## เรื่องอื่นที่ตัดสินใจไว้

- **แก้พร้อมกัน:** ส่งทีละ "ส่วนของคนหนึ่งในรายการหนึ่ง" server ต่อคิวการเขียนต่อบิล จึงไม่ทับกัน
- **ปิดบิล:** คนจ่ายกด "ปิดบิล" ในแท็บสรุป
- ยังไม่ทำ: VAT/service charge, คนจ่ายหลายคน, ลบบิลเก่า

## รูปและฟอนต์

- รูปขวดเบียร์ `public/img/beer.jpg` จาก [Pexels #5537952](https://www.pexels.com/photo/close-up-shot-of-bottles-of-beer-5537952/) (Pexels License ใช้ฟรี ไม่ต้องให้เครดิต)
- ฟอนต์ IBM Plex Sans Thai จาก Google Fonts
