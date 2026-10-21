// หน้าเพื่อนติ๊กรายการ (req 4) + สรุปยอดการโอน (req 3.5) + QR โอนเงิน
// req 4.5: ไม่มี login — เลือกชื่อตัวเอง, แก้แทนคนอื่นได้ แต่ทุกการแก้ถูกบันทึกและแสดงให้ทุกคนเห็น
import { api, baht, baht0, fmtShare, fmtPromptPay, esc, store, editKeyFor, toast, copyText, icons } from './common.js';
import { computeBill, shareOf, checkSubtotal, maxShareFor, overCount, cleanMenuName } from './calc.js';

const $ = (id) => document.getElementById(id);
const billId = location.pathname.split('/')[2];
const editKey = editKeyFor(billId);

let bill = null;
let meId = store.get(`me:${billId}`);
let tab = 'items';
let pending = 0;
let picking = false; // กำลังเลือกชื่อใหม่
const expanded = new Set(); // รายการที่เปิด "แก้รายชื่อ" อยู่
let sheetFor = null; // personId ที่เปิดแผ่น QR อยู่
let wasClosed = null; // ไว้รู้ตอนคนจ่ายเพิ่งปิด/เปิดบิล

$('homeBtn').innerHTML = icons.back;
$('editBtn').innerHTML = icons.edit;
$('shareBtn').innerHTML = icons.share;
$('navMenuIco').innerHTML = icons.menu;
$('navSumIco').innerHTML = icons.basket;
$('navUserIco').innerHTML = icons.user;
if (editKey) { $('editBtn').href = `/edit/${billId}`; $('editBtn').hidden = false; }

const me = () => bill?.people.find((p) => p.id === meId) || null;
const nameOf = (id) => bill.people.find((p) => p.id === id)?.name ?? 'มีคน';
const hhmm = (iso) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

/** ชื่อเมนูไม่เอารหัสร้าน เช่น (C4) — บิลเก่าที่บันทึกไว้แล้วก็แสดงแบบสะอาด */
function tidy(b) {
  for (const it of b.items) it.name = cleanMenuName(it.name);
  for (const e of b.log || []) if (e.itemName) e.itemName = cleanMenuName(e.itemName);
  return b;
}

// ---------- โหลด & อัปเดตสด ----------
async function load() {
  try {
    const r = await api(`bills/${billId}`);
    if (!bill || r.bill.version !== bill.version) {
      bill = tidy(r.bill);
      if (wasClosed === false && bill.closed && meId && meId !== bill.payerId) toast('ปิดบิลแล้ว โอนได้เลย');
      if (wasClosed === true && !bill.closed) closeSheet();
      wasClosed = bill.closed;
      render();
    }
  } catch (e) {
    if (!bill) {
      $('storeName').textContent = 'เปิดบิลไม่ได้';
      $('whoSection').innerHTML = `<div class="alert"><div>${esc(e.message)}</div></div>`;
    }
  }
}
setInterval(() => { if (!document.hidden && pending === 0) load(); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && pending === 0) load(); });

async function mutate(path, body, optimistic) {
  if (bill.closed) { toast('บิลปิดแล้ว แก้ไม่ได้', true); return; }
  optimistic?.();
  render();
  pending++;
  try {
    const r = await api(`bills/${billId}/${path}`, { method: 'PATCH', body: { ...body, actorId: meId } });
    if (pending === 1) bill = tidy(r.bill); // ถ้ายังมีคำขออื่นค้างอยู่ รอผลสุดท้าย
  } catch (e) {
    toast(e.message, true);
    pending--;
    return load();
  }
  pending--;
  render();
}

function setShare(itemId, personId, value) {
  const p = bill.people.find((x) => x.id === personId);
  const item = bill.items.find((it) => it.id === itemId);
  // ถ้าค่าเท่ากับค่าเริ่มต้นของโหมด ไม่ต้องเก็บ override
  const def = p.mode === 'pick' ? 0 : 1;
  const v = value === def ? null : value;
  mutate('share', { personId, itemId, share: v }, () => {
    item.overrides = { ...item.overrides };
    if (v === null) delete item.overrides[personId]; else item.overrides[personId] = v;
  });
  if (personId !== meId) toast(`แก้ให้ ${p.name} แล้ว`);
}

function setMode(mode) {
  const p = me();
  if (p.mode === mode) return;
  mutate('mode', { personId: p.id, mode }, () => { p.mode = mode; });
  toast(mode === 'pick' ? 'กด "กินด้วย" เฉพาะของที่กิน' : 'กด "เอาชื่อออก" ของที่ไม่ได้กิน');
}

// ---------- ข้อความประวัติการแก้ ----------
function describe(e) {
  const by = esc(nameOf(e.by));
  const self = e.by === e.person;
  const who = esc(nameOf(e.person));
  const item = `<b>${esc(e.itemName ?? '')}</b>`;
  switch (e.kind) {
    case 'share':
      if (e.to === 0) return self ? `${by} เอาชื่อออกจาก ${item}` : `${by} เอาชื่อ <b>${who}</b> ออกจาก ${item}`;
      if (e.from === 0) return self ? `${by} กิน ${item}` : `${by} ใส่ชื่อ <b>${who}</b> ใน ${item}`;
      return self ? `${by} กิน ${item} ×${fmtShare(e.to)}` : `${by} ใส่ว่า <b>${who}</b> กิน ${item} ×${fmtShare(e.to)}`;
    case 'mode': return `${by} เลือก${self ? ' ' : ` ให้ <b>${who}</b> `}"${e.to === 'pick' ? 'กินบางอย่าง' : 'กินทุกอย่าง'}"`;
    case 'items': return `${by} (คนจ่าย) แก้รายการในบิล`;
    case 'payment': return `${by} (คนจ่าย) เปลี่ยนเลขบัญชี/QR รับเงิน`;
    case 'close': return `${by} ปิดบิล`;
    case 'reopen': return `${by} เปิดบิลให้แก้ต่อ`;
    default: return '';
  }
}
/** แก้แทนคนอื่น = สิ่งที่ต้องให้ทุกคนเห็นชัด */
const onBehalf = (e) => (e.kind === 'share' || e.kind === 'mode') && e.by !== e.person;

// ---------- วาดหน้า ----------
function render() {
  if (!bill) return;
  const r = computeBill(bill);
  const head = [bill.date, bill.time, bill.table && `โต๊ะ ${bill.table}`].filter(Boolean).join(' · ');
  $('storeName').textContent = bill.store || 'บิลวงเหล้า';
  $('billMeta').textContent = `${head ? head + ' · ' : ''}รวม ${baht(r.billTotal)} บาท`;
  document.title = `${bill.store || 'บิล'} · หารค่าเหล้า`;

  $('closedBanner').innerHTML = bill.closed
    ? `<div class="alert info"><div><strong>ปิดบิลแล้ว</strong> ยอดนี้คือยอดจริง</div></div>` : '';

  if (!me()) meId = null;
  const choosing = !meId || picking;
  $('whoSection').hidden = !choosing;
  $('tabs').hidden = choosing;
  $('itemsView').hidden = choosing || tab !== 'items';
  $('summaryView').hidden = choosing || tab !== 'summary';
  document.querySelector('.bottom').hidden = choosing;
  $('navWhoName').textContent = me()?.name ?? 'ฉัน';
  for (const el of document.querySelectorAll('[data-tab]')) {
    const on = el.dataset.tab === tab;
    if (el.classList.contains('tab')) el.setAttribute('aria-selected', on);
    else if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }

  renderWho();
  if (sheetFor) renderSheet(r);
  if (choosing) return;
  renderMe(r);
  renderWarnings(r);
  renderItems(r);
  renderSummary(r);
}

function renderWho() {
  $('whoChips').innerHTML = bill.people.map((p) => `
    <button class="chip" data-who="${p.id}" aria-pressed="${p.id === meId}">${esc(p.name)}${p.id === bill.payerId ? ' <span class="badge">คนจ่าย</span>' : ''}</button>`).join('');
}
$('whoChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-who]');
  if (!b) return;
  meId = b.dataset.who;
  store.set(`me:${billId}`, meId);
  picking = false;
  render();
});
$('navWho').addEventListener('click', () => { picking = true; render(); window.scrollTo({ top: 0 }); });

const hasPayment = () => Boolean(bill.payment?.promptpay || bill.payment?.qrType);

function renderMe(r) {
  const p = me();
  const mine = r.perPerson[p.id];
  const isPayer = p.id === bill.payerId;
  const eaten = bill.items.filter((it) => shareOf(it, p) > 0).length;
  const incoming = r.transfers.reduce((s, t) => s + t.amount, 0);

  // มีคนอื่นแก้ของเราตั้งแต่ครั้งล่าสุดที่กด "รับทราบ"
  const seen = store.get(`seen:${billId}:${p.id}`, '');
  const touched = (bill.log || []).filter((e) => e.person === p.id && e.by !== p.id && e.at > seen);

  $('meCard').innerHTML = `
    ${touched.length ? `
      <div class="alert info"><div>
        <strong>มีคนแก้ของคุณ ${touched.length} ครั้ง</strong>
        ${touched.slice(-3).reverse().map((e) => `<div class="small">${hhmm(e.at)} · ${describe(e)}</div>`).join('')}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm yellow" data-ack="${esc(touched.at(-1).at)}">โอเค ถูกแล้ว</button>
          <button class="btn sm ghost" data-goto="summary">ดูประวัติทั้งหมด</button>
        </div>
      </div></div>` : ''}
    <section class="card-yellow">
      <div class="row" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:26px;font-weight:800;line-height:1.1">${esc(p.name)}</div>
          <div class="stock" style="margin-top:6px">กิน ${eaten}/${bill.items.length} รายการ</div>
        </div>
        <div class="seg" role="group" aria-label="กินแบบไหน">
          <button data-mode="normal" aria-pressed="${p.mode !== 'pick'}">กินทุกอย่าง</button>
          <button data-mode="pick" aria-pressed="${p.mode === 'pick'}">กินบางอย่าง</button>
        </div>
      </div>
      <div class="muted small" style="margin-top:18px">${isPayer ? 'ส่วนของคุณ' : `โอนให้ ${esc(nameOf(bill.payerId))}`}</div>
      <div class="big-price">฿${baht0(mine.pay)}</div>
      ${isPayer ? `<div class="muted small">รอเพื่อนโอนคืน ฿${baht0(incoming)}</div>` : ''}
      ${!isPayer && mine.pay > 0 ? (!bill.closed
        ? `<div class="wait-note">รอ${esc(nameOf(bill.payerId))}ปิดบิลก่อน ถึงจะโอนได้ ยอดยังเปลี่ยนได้ถ้ามีคนแก้</div>`
        : hasPayment()
          ? `<button class="btn block" data-qr="${p.id}" style="margin-top:16px">${icons.qr}<span>QR โอนเงิน ฿${baht0(mine.pay)}</span></button>`
          : `<div class="muted small" style="margin-top:12px">${esc(nameOf(bill.payerId))} ยังไม่ได้ใส่เลขบัญชี ถามในกลุ่มก่อนนะ</div>`)
        : ''}
      ${isPayer && editKey && !bill.closed
        ? `<button class="btn block" data-close-bill style="margin-top:16px">${icons.lock}<span>ปิดบิล ให้เพื่อนโอน</span></button>
           <div class="muted small" style="margin-top:8px">ปิดแล้วจะแก้รายการไม่ได้ เปิดใหม่ได้ทีหลัง</div>` : ''}
      ${isPayer && !hasPayment() && editKey
        ? `<a class="btn block" href="/edit/${billId}" style="margin-top:16px">${icons.qr}<span>เพิ่ม QR รับเงิน</span></a>` : ''}
    </section>`;
}
$('meCard').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]');
  if (mode) setMode(mode.dataset.mode);
  if (e.target.closest('[data-close-bill]')) toggleClosed();
  const ack = e.target.closest('[data-ack]');
  if (ack) { store.set(`seen:${billId}:${meId}`, ack.dataset.ack); render(); }
});

function renderWarnings(r) {
  let html = '';
  if (r.unassigned.length) {
    html += `<div class="alert"><div>
      <strong>มี ${r.unassigned.length} รายการที่ไม่มีใครกิน รวม ${baht(r.unassignedTotal)} บาท</strong><br>
      ${r.unassigned.map((u) => esc(u.item.name)).join(', ')}<br>
      <span class="small">ใครกินกด "กินด้วย" นะ ไม่งั้น${esc(nameOf(bill.payerId))}ต้องจ่ายเอง</span></div></div>`;
  }
  if (r.overItems.length) {
    html += `<div class="alert"><div><strong>มี ${r.overItems.length} รายการที่ใส่จำนวนรวมเกินที่สั่ง</strong><br>
      ${r.overItems.map((it) => `${esc(it.name)} (ใส่ ${fmtShare(overCount(it, bill.people).sum)} จาก ${fmtShare(it.qty)})`).join(', ')}<br>
      <span class="small">ใครไม่ได้กินเอาชื่อออก หรือใครใส่เกินลดลงหน่อยนะ</span></div></div>`;
  }
  const sc = checkSubtotal(bill.items, bill.subtotal);
  if (sc.subtotal !== null && !sc.matches) {
    html += `<div class="alert"><div><strong>ยอดยังไม่ตรงบิล</strong> ต่างกัน ${baht(Math.abs(sc.diff))} บาท รอ${esc(nameOf(bill.payerId))}แก้ก่อนนะ</div></div>`;
  }
  $('warnings').innerHTML = html;
}

function renderItems(r) {
  const p = me();
  const locked = bill.closed;
  const log = bill.log || [];
  $('itemList').innerHTML = r.itemRows.map(({ item, shareSum, unassigned, over }) => {
    const mine = shareOf(item, p);
    const inIt = mine > 0;
    const myAmount = inIt ? item.total * (mine / shareSum) : 0;
    const eaters = bill.people.map((x) => [x, shareOf(item, x)]).filter(([, v]) => v > 0);
    const showStepper = inIt && (item.qty > 1 || mine !== 1);
    const max = maxShareFor(item);
    const counted = eaters.some(([, v]) => v > 1); // มีคนใส่จำนวนชิ้น → บอกว่ารวมแล้วเท่าไร
    const lastOther = log.findLast((e) => e.item === item.id && onBehalf(e));
    const open = expanded.has(item.id);
    return `
      <article class="item-card${inIt ? ' in' : ''}${unassigned || over ? ' orphan' : ''}" data-id="${item.id}">
        <div class="row">
          <div class="title">
            <span class="qty-tag" aria-label="จำนวน ${fmtShare(item.qty)}">×${fmtShare(item.qty)}</span>
            <div class="name">${esc(item.name)}</div>
          </div>
          <div class="total price">฿${baht(item.total)}</div>
        </div>
        <div class="meta">${unassigned
          ? '<b style="color:var(--danger)">ยังไม่มีใครกิน</b>'
          : inIt
            ? `หาร ${eaters.length} คน · คุณจ่าย <b>${baht(myAmount)}</b>`
            : `${eaters.length} คนกิน · คุณไม่ได้กิน`}${counted && item.qty > 1 && !over ? ` · ใส่แล้ว ${fmtShare(shareSum)}/${fmtShare(item.qty)}` : ''}</div>
        ${over ? `<div class="over-note">ใส่รวม ${fmtShare(shareSum)} แต่สั่งมา ${fmtShare(item.qty)} มีคนต้องลด</div>` : ''}
        ${showStepper ? '<div class="step-hint">กินกี่จาน กดเท่านั้น</div>' : ''}
        <div class="eaters">${eaters.map(([x, v]) => `<span class="eater">${esc(x.name)}${v !== 1 ? ` ×${fmtShare(v)}` : ''}</span>`).join('')}</div>
        ${lastOther ? `<div class="edited-by">✎ ${hhmm(lastOther.at)} ${describe(lastOther)}</div>` : ''}
        ${open ? `
          <div class="who-edit" role="group" aria-label="ใครกินรายการนี้">
            ${bill.people.map((x) => `<button class="chip" data-person="${x.id}" aria-pressed="${shareOf(item, x) > 0}" ${locked ? 'disabled' : ''}>${esc(x.name)}${shareOf(item, x) > 1 ? ` ×${fmtShare(shareOf(item, x))}` : ''}</button>`).join('')}
          </div>
          ` : ''}
        <div class="actions">
          ${showStepper ? `
            <div class="stepper sm" role="group" aria-label="คุณกินกี่ชิ้น">
              <button data-act="dec" aria-label="ลด" ${locked || mine <= 1 ? 'disabled' : ''}>–</button>
              <output>${fmtShare(mine)}</output>
              <button data-act="inc" aria-label="เพิ่ม" ${locked || mine >= max ? 'disabled' : ''} title="${mine >= max ? `ครบ ${fmtShare(item.qty)} แล้ว` : ''}">+</button>
            </div>` : ''}
          <button class="btn" data-act="${inIt ? 'out' : 'in'}" ${locked ? 'disabled' : ''}>
            ${inIt ? 'เอาชื่อออก' : `${icons.basket}<span>กินด้วย</span>`}
          </button>
          <button class="icon-btn round" data-act="who" aria-label="แก้รายชื่อคนกิน" aria-expanded="${open}" title="แก้รายชื่อคนกิน" style="${inIt ? 'background:rgba(0,0,0,.12);color:var(--ink)' : ''}">${icons.users}</button>
        </div>
      </article>`;
  }).join('') || '<div class="empty">ยังไม่มีรายการในบิล</div>';
}

$('itemList').addEventListener('click', (e) => {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  const item = bill.items.find((it) => it.id === id);

  const person = e.target.closest('[data-person]');
  if (person && !person.disabled) {
    const p = bill.people.find((x) => x.id === person.dataset.person);
    return setShare(id, p.id, shareOf(item, p) > 0 ? 0 : 1);
  }

  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.act === 'who') {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    return render();
  }
  const cur = shareOf(item, me());
  const next = { in: 1, out: 0, inc: Math.min(cur + 1, maxShareFor(item)), dec: Math.max(1, cur - 1) }[b.dataset.act];
  if (next === cur) return;
  setShare(id, meId, next);
});

function renderSummary(r) {
  const payer = bill.payerId;
  const incoming = r.transfers.reduce((s, t) => s + t.amount, 0);
  const rows = [...bill.people].sort((a, b) => (a.id === payer ? -1 : b.id === payer ? 1 : 0)).map((p) => {
    const pp = r.perPerson[p.id];
    const lines = pp.lines.map((l) => {
      const it = bill.items.find((x) => x.id === l.itemId);
      return `<div style="display:flex;justify-content:space-between;gap:8px" class="small"><span>${esc(it.name)}${l.share !== 1 ? ` ×${fmtShare(l.share)}` : ''}</span><span>${baht(l.amount)}</span></div>`;
    }).join('');
    const canQr = bill.closed && p.id !== payer && pp.pay > 0 && hasPayment();
    return `
      <details class="person-row${p.id === meId ? ' me' : ''}" style="display:block">
        <summary style="display:flex;align-items:center;gap:12px;cursor:pointer;list-style:none">
          <span class="avatar">${esc([...p.name.replace(/^[เแโใไ]/, '')][0] || '?')}</span>
          <span class="who"><b>${esc(p.name)}</b><span class="muted small">${p.id === payer ? 'คนจ่าย · ไม่ต้องโอน' : `โอนให้ ${esc(nameOf(payer))}`}</span></span>
          <span class="pay price">฿${baht0(pp.pay)}<small>${baht(pp.exact)}</small></span>
        </summary>
        <div style="margin-top:12px;display:grid;gap:4px;color:var(--muted)">${lines || '<span class="small">ไม่ได้กินอะไรเลย</span>'}</div>
        ${canQr ? `<button class="btn sm ghost block" data-qr="${p.id}" style="margin-top:12px">${icons.qr}<span>เปิด QR ของ ${esc(p.name)}</span></button>` : ''}
      </details>`;
  }).join('');

  const checkHtml = r.balanced
    ? `<div class="alert ok"><div>ทุกรายการมีคนกินครบแล้ว</div></div>`
    : `<div class="alert"><div><strong>ยังขาด ${baht(r.billTotal - r.assignedTotal)} บาท</strong><br>${r.unassigned.map((u) => esc(u.item.name)).join(', ')} ยังไม่มีใครกิน ตกลงกันในวงว่าใครรับ</div></div>`;

  const log = (bill.log || []).slice(-60).reverse();
  const logHtml = log.length
    ? `<div class="card log">${log.map((e) => `
        <div class="log-row${onBehalf(e) || e.kind === 'payment' ? ' other' : ''}">
          <time datetime="${esc(e.at)}">${hhmm(e.at)}</time><span>${describe(e)}</span>
        </div>`).join('')}</div>`
    : '<div class="empty small">ยังไม่มีใครแก้อะไร</div>';

  $('summaryView').innerHTML = `
    <section class="card-yellow">
      <div class="muted small">${esc(nameOf(payer))} ออกเงินไปก่อน</div>
      <div class="big-price">฿${baht0(r.billTotal)}</div>
      <div style="font-weight:600;margin-top:6px">รอรับคืนรวม ฿${baht0(incoming)} จาก ${r.transfers.length} คน</div>
      ${bill.payment?.promptpay ? `<div class="muted small" style="margin-top:4px">พร้อมเพย์ ${esc(fmtPromptPay(bill.payment.promptpay))}${bill.payment.name ? ` · ${esc(bill.payment.name)}` : ''}</div>` : ''}
      <button class="btn block" id="copySummary" style="margin-top:18px">${icons.share}<span>คัดลอกสรุปไปวางใน LINE</span></button>
    </section>
    ${checkHtml}
    <div class="section-title" style="margin-top:8px"><h2>ใครโอนเท่าไร</h2></div>
    ${rows}
    <div class="section-title"><h2>ประวัติการแก้</h2><span class="muted small">สีเหลือง คือแก้แทนเพื่อน</span></div>
    ${logHtml}
    ${editKey ? `
      <div class="section-title"><h2>เฉพาะคนจ่าย</h2></div>
      <div style="display:flex;gap:10px">
        <a class="btn ghost sm" href="/edit/${billId}" style="flex:1">${icons.edit}<span>แก้รายการ / QR</span></a>
        <button class="btn ${bill.closed ? 'yellow' : 'ghost'} sm" id="closeBtn" style="flex:1">${icons.lock}<span>${bill.closed ? 'เปิดบิลให้แก้ต่อ' : 'ปิดบิล'}</span></button>
      </div>` : ''}`;
}

$('summaryView').addEventListener('click', async (e) => {
  if (e.target.closest('#copySummary')) {
    const r = computeBill(bill);
    const pp = bill.payment?.promptpay;
    const lines = [
      `🍺 ${bill.store || 'หารค่าเหล้า'}${bill.date ? ` (${bill.date})` : ''} รวม ${baht(r.billTotal)} บาท`,
      `โอนให้ ${nameOf(bill.payerId)}${pp ? ` พร้อมเพย์ ${fmtPromptPay(pp)}` : ''}${bill.payment?.name ? ` (${bill.payment.name})` : ''}`,
      ...r.transfers.map((t) => `• ${nameOf(t.from)} ${baht0(t.amount)} บาท`),
      ...(r.unassigned.length ? [`⚠ ยังไม่มีคนกิน: ${r.unassigned.map((u) => u.item.name).join(', ')} (${baht(r.unassignedTotal)} บาท)`] : []),
      ...(bill.closed ? [] : ['(ยอดยังไม่สุดท้าย รอปิดบิลก่อนค่อยโอน)']),
      `ดูรายละเอียด/สแกน QR: ${location.href}`,
    ];
    toast((await copyText(lines.join('\n'))) ? 'คัดลอกสรุปแล้ว' : 'คัดลอกไม่ได้', false);
  }
  if (e.target.closest('#closeBtn')) toggleClosed();
});

async function toggleClosed() {
  const closing = !bill.closed;
  if (closing) {
    // ระบบไม่ตัดสินแทน (req 4.3) แต่เตือนให้ชัดก่อนปิด
    const r = computeBill(bill);
    const issues = [];
    if (r.unassigned.length) issues.push(`ยังมี ${r.unassigned.map((u) => u.item.name).join(', ')} ที่ไม่มีใครกิน (${baht(r.unassignedTotal)} บาท) ถ้าปิดตอนนี้ คุณต้องจ่ายส่วนนี้เอง`);
    if (r.overItems.length) issues.push(`${r.overItems.map((it) => it.name).join(', ')} ใส่จำนวนรวมเกินที่สั่ง ยอดแต่ละคนอาจยังไม่ตรงกับที่กินจริง`);
    if (issues.length && !confirm(`${issues.join('\n\n')}\n\nปิดบิลเลยไหม?`)) return;
  }
  try {
    const r = await api(`bills/${billId}/closed`, { method: 'PUT', body: { closed: closing }, key: editKey });
    bill = tidy(r.bill);
    wasClosed = bill.closed;
    toast(bill.closed ? 'ปิดบิลแล้ว เพื่อนโอนได้เลย' : 'เปิดบิลแล้ว แก้รายการต่อได้');
    render();
  } catch (err) { toast(err.message, true); }
}

// ---------- แผ่น QR โอนเงิน ----------
let sheetKind = null; // 'promptpay' | 'image'

function openSheet(personId) {
  if (!bill.closed) return toast(`รอ${nameOf(bill.payerId)}ปิดบิลก่อนนะ`);
  sheetFor = personId;
  sheetKind = bill.payment?.promptpay ? 'promptpay' : 'image';
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.id = 'sheet';
  el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="QR โอนเงิน"></div>';
  document.body.append(el);
  renderSheet(computeBill(bill));
}
function closeSheet() {
  sheetFor = null;
  $('sheet')?.remove();
}

function renderSheet(r) {
  const box = document.querySelector('#sheet .sheet');
  if (!box) return;
  const pay = bill.payment || {};
  const amount = r.perPerson[sheetFor]?.pay ?? 0;
  const both = pay.promptpay && pay.qrType;
  const src = sheetKind === 'promptpay'
    ? `/api/bills/${billId}/promptpay/${sheetFor}?v=${bill.version}`
    : `/api/bills/${billId}/qr?v=${pay.qrVersion}`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div>
        <div class="muted small">${esc(nameOf(sheetFor))} โอนให้ ${esc(nameOf(bill.payerId))}</div>
        <div class="big-price">฿${baht0(amount)}</div>
      </div>
      <button class="icon-btn round" data-close aria-label="ปิด" style="background:var(--ink);color:var(--yellow);font-size:22px">×</button>
    </div>
    ${both ? `
      <div class="seg" role="group" aria-label="ชนิด QR" style="margin-top:12px">
        <button data-kind="promptpay" aria-pressed="${sheetKind === 'promptpay'}">ยอดขึ้นเอง</button>
        <button data-kind="image" aria-pressed="${sheetKind === 'image'}">QR ของ${esc(nameOf(bill.payerId))}</button>
      </div>` : ''}
    <img class="qr-img" src="${src}" alt="QR โอนเงินให้ ${esc(nameOf(bill.payerId))}">
    <div style="text-align:center;font-weight:600">${sheetKind === 'promptpay'
      ? 'สแกนแล้วยอดขึ้นเอง ไม่ต้องพิมพ์'
      : `สแกนแล้ว<u>พิมพ์ยอด ${baht0(amount)} บาทเอง</u>`}</div>
    ${pay.name ? `<div class="muted small" style="text-align:center">ชื่อบัญชี: ${esc(pay.name)}</div>` : ''}
    ${pay.promptpay ? `
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn sm" data-copy="${esc(pay.promptpay)}" style="flex:1">คัดลอกเลข ${esc(fmtPromptPay(pay.promptpay))}</button>
        <button class="btn sm" data-copy="${amount}" style="flex:none">คัดลอกยอด</button>
      </div>` : ''}
    <p class="small muted" style="margin:14px 0 0;text-align:center">แคปหน้าจอไว้ แล้วสแกนจากรูปในแอปธนาคารก็ได้</p>`;
}

document.addEventListener('click', async (e) => {
  const qr = e.target.closest('[data-qr]');
  if (qr) return openSheet(qr.dataset.qr);
  const sheet = $('sheet');
  if (!sheet) return;
  if (e.target === sheet || e.target.closest('[data-close]')) return closeSheet();
  const kind = e.target.closest('[data-kind]');
  if (kind) { sheetKind = kind.dataset.kind; renderSheet(computeBill(bill)); }
  const cp = e.target.closest('[data-copy]');
  if (cp) toast((await copyText(cp.dataset.copy)) ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------- แท็บ & แชร์ ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab], [data-goto]');
  if (!t) return;
  tab = t.dataset.tab || t.dataset.goto;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('shareBtn').addEventListener('click', async () => {
  const url = location.href;
  if (navigator.share) return navigator.share({ title: 'หารค่าเหล้า', url }).catch(() => {});
  toast((await copyText(url)) ? 'คัดลอกลิงก์แล้ว' : url);
});

load();
