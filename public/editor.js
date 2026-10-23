// หน้าคนจ่าย: สแกน/พิมพ์รายการ → เทียบ Subtotal → บันทึก → แชร์ลิงก์ (req 5.2)
import { api, baht, esc, store, editKeyFor, saveEditKey, toast, prepareImage, copyText, icons } from './common.js';
import { checkSubtotal, cleanMenuName } from './calc.js';

const $ = (id) => document.getElementById(id);
const rid = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const editId = location.pathname.startsWith('/edit/') ? location.pathname.split('/')[2] : null;
const DRAFT_KEY = 'draft';

let state = {
  store: '', date: '', time: '', table: '', subtotal: '',
  people: [], payerId: null, items: [],
};
let editKey = null;
let knownPeople = [];
let hasPin = false; // บิลนี้ตั้งรหัสคนจ่ายไว้แล้วหรือยัง // รายชื่อที่หน้านี้รู้จัก — ชื่อที่เพื่อนเพิ่มทีหลังจะไม่ถูกลบตอนบันทึก
let savedId = null;
let dirty = false;

// ช่องทางรับเงิน — แยกจาก state บิลเพราะส่งคนละ endpoint และจำข้ามบิล
// qr: undefined = ไม่เปลี่ยน, null = เอาออก, {image, mimeType} = รูปใหม่
const MY_PAY = 'myPayment';
let payment = { promptpay: '', name: '', qr: undefined, previewUrl: null };
let payDirty = false;

// ---------- เริ่มต้น ----------
$('scanBtn').innerHTML = `${icons.camera}<span>ถ่ายรูป / เลือกรูปบิล</span>`;
$('addItemBtn').innerHTML = `${icons.plus}<span>เพิ่มรายการ</span>`;
$('nativeShareBtn').innerHTML = `${icons.share}<span>ส่งเข้า LINE</span>`;
$('backBtn').innerHTML = icons.back;
$('viewBtn').innerHTML = icons.grid;

async function init() {
  if (editId) {
    editKey = editKeyFor(editId);
    $('backBtn').href = `/b/${editId}`;
    $('backBtn').hidden = false;
    $('viewBtn').href = `/b/${editId}`;
    $('viewBtn').hidden = false;
    $('pageTitle').textContent = 'แก้บิล';
    if (!editKey) {
      showUnlock();
      return;
    }
    try {
      const { bill } = await api(`bills/${editId}`);
      state = {
        store: bill.store, date: bill.date, time: bill.time, table: bill.table,
        subtotal: bill.subtotal ?? '',
        people: bill.people, payerId: bill.payerId,
        items: bill.items.map(({ overrides, ...it }) => ({ ...it, name: cleanMenuName(it.name) })),
      };
      savedId = editId;
      knownPeople = bill.people.map((p) => p.id);
      payment.promptpay = bill.payment?.promptpay || '';
      payment.name = bill.payment?.name || '';
      payment.previewUrl = bill.payment?.qrType ? `/api/bills/${editId}/qr?v=${bill.payment.qrVersion}` : null;
      hasPin = Boolean(bill.hasPin);
      if (bill.closed) toast('บิลนี้ปิดไปแล้ว เปิดบิลก่อนถึงจะแก้ได้', true);
    } catch (e) {
      toast(e.message, true);
    }
  } else {
    const draft = store.get(DRAFT_KEY);
    if (draft?.items) state = draft;
    if (state.people.length === 0) {
      const me = store.get('myName');
      if (me) { const p = { id: rid(), name: me, mode: 'normal' }; state.people.push(p); state.payerId = p.id; }
    }
    if (state.items.length === 0) state.items.push(blankItem());
    // บิลใหม่: ใช้ช่องทางรับเงินที่เคยใส่ไว้ครั้งก่อน
    const saved = store.get(MY_PAY);
    if (saved) {
      payment.promptpay = saved.promptpay || '';
      payment.name = saved.name || '';
      if (saved.qr) { payment.qr = saved.qr; payment.previewUrl = `data:${saved.qr.mimeType};base64,${saved.qr.image}`; }
      payDirty = Boolean(saved.promptpay || saved.qr);
    }
  }

  try {
    const cfg = await api('config');
    if (!cfg.scanEnabled) {
      $('scanBtn').disabled = true;
      $('scanNote').textContent = 'ตอนนี้ถ่ายบิลไม่ได้ พิมพ์รายการเองด้านล่างไปก่อนนะ';
    }
  } catch { /* ใช้แบบพิมพ์เองต่อได้ */ }

  renderAll();
}

const blankItem = () => ({ id: rid(), qty: 1, name: '', total: '' });

function persistDraft() {
  dirty = true;
  if (!editId) store.set(DRAFT_KEY, state);
}

// ---------- คนในวง ----------
function renderPeople() {
  $('peopleChips').innerHTML = state.people.length
    ? state.people.map((p) => `
      <span class="chip" aria-pressed="${p.id === state.payerId}">
        <button type="button" data-payer="${p.id}" aria-label="ให้ ${esc(p.name)} เป็นคนจ่าย" title="ตั้งเป็นคนจ่าย">${p.id === state.payerId ? '★' : '☆'}</button>
        ${esc(p.name)}${p.id === state.payerId ? ' <span class="badge">คนจ่าย</span>' : ''}
        <button type="button" class="x" data-remove="${p.id}" aria-label="ลบ ${esc(p.name)}">×</button>
      </span>`).join('')
    : '<span class="muted small">ใส่ชื่อตัวเองก่อน เพื่อนเพิ่มชื่อเองได้ตอนเปิดลิงก์</span>';
}

$('peopleChips').addEventListener('click', (e) => {
  const payer = e.target.closest('[data-payer]');
  const rm = e.target.closest('[data-remove]');
  if (payer) state.payerId = payer.dataset.payer;
  if (rm) {
    state.people = state.people.filter((p) => p.id !== rm.dataset.remove);
    if (state.payerId === rm.dataset.remove) state.payerId = state.people[0]?.id ?? null;
  }
  persistDraft();
  renderPeople();
  renderCheck();
});

$('addPersonForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const names = $('personName').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (state.people.some((p) => p.name === name)) { toast(`มีชื่อ "${name}" แล้ว`, true); continue; }
    const p = { id: rid(), name: name.slice(0, 30), mode: 'normal' };
    state.people.push(p);
    if (!state.payerId) { state.payerId = p.id; store.set('myName', p.name); }
  }
  $('personName').value = '';
  persistDraft();
  renderPeople();
  renderCheck();
});

// ---------- รายการ ----------
function renderItems() {
  $('itemRows').innerHTML = state.items.map((it, i) => `
    <div class="item-row${it.uncertain ? ' uncertain' : ''}" data-i="${i}">
      <input class="input" data-f="name" value="${esc(it.name)}" placeholder="ชื่อเมนู" aria-label="ชื่อเมนู">
      <label class="mini qty"><span>จำนวน</span><input class="input num" data-f="qty" inputmode="numeric" value="${esc(it.qty)}"></label>
      <label class="mini total"><span>ราคา</span><input class="input num" data-f="total" inputmode="decimal" value="${esc(it.total)}" placeholder="0"></label>
      <button class="icon-btn" data-del="${i}" aria-label="ลบบรรทัด" style="width:36px;height:36px;color:var(--muted)">${icons.trash}</button>
      ${it.uncertain ? '<div class="hint">ตัวเลขบรรทัดนี้ไม่ชัด ดูบิลอีกทีนะ</div>' : ''}
    </div>`).join('');
  $('itemCount').textContent = `${state.items.length} รายการ`;
}

$('itemRows').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]');
  if (!row) return;
  const it = state.items[row.dataset.i];
  it[e.target.dataset.f] = e.target.value;
  if (it.uncertain && e.target.dataset.f !== 'name') {
    it.uncertain = false;
    row.classList.remove('uncertain');
    row.querySelector('.hint')?.remove();
  }
  persistDraft();
  renderCheck();
});

$('itemRows').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (!del) return;
  state.items.splice(Number(del.dataset.del), 1);
  persistDraft();
  renderItems();
  renderCheck();
});

$('addItemBtn').addEventListener('click', () => {
  state.items.push(blankItem());
  persistDraft();
  renderItems();
  renderCheck();
  $('itemRows').lastElementChild?.querySelector('[data-f="name"]')?.focus();
});

// ---------- เทียบ Subtotal (ห้ามปรับให้ตรงอัตโนมัติ) ----------
const parseNum = (v) => {
  const n = Number(String(v).replace(/[,\s฿]/g, ''));
  return String(v).trim() === '' || !Number.isFinite(n) ? NaN : n;
};

function validItems() {
  return state.items.filter((it) => String(it.name).trim() || String(it.total).trim());
}

function renderCheck() {
  const items = validItems().map((it) => ({ ...it, total: parseNum(it.total) }));
  const badRow = items.findIndex((it) => !Number.isFinite(it.total) || !Number.isFinite(parseNum(it.qty)));
  const sub = parseNum(state.subtotal);
  const r = checkSubtotal(items.map((it) => ({ total: Number.isFinite(it.total) ? it.total : 0 })), Number.isFinite(sub) ? sub : null);
  $('sumBox').textContent = baht(r.sum);

  let html = '';
  let canSave = false;
  let blocked = 'ยอดยังไม่ตรงบิล'; // ข้อความบนปุ่มตอนยังบันทึกไม่ได้
  if (state.people.length === 0) { html = alert('', 'ใส่ชื่อคนในวงก่อน'); blocked = 'ใส่ชื่อคนในวงก่อน'; }
  else if (items.length === 0) { html = alert('', 'ยังไม่มีรายการ'); blocked = 'ใส่รายการก่อน'; }
  else if (badRow >= 0) { html = alert('', `รายการที่ ${state.items.indexOf(validItems()[badRow]) + 1} ราคาหรือจำนวนยังไม่ถูก`); blocked = 'แก้ราคาหรือจำนวนก่อน'; }
  else if (r.subtotal === null) { html = alert('info', 'ใส่ยอดรวมจากบิล จะได้รู้ว่ารายการครบไหม'); blocked = 'ใส่ยอดรวมจากบิลก่อน'; }
  else if (r.matches) { html = alert('ok', `<strong>ตรงกับบิลแล้ว</strong> ${baht(r.sum)} บาท`); canSave = true; }
  else {
    const missing = r.diff > 0;
    html = alert('', `<strong>ยอดยังไม่ตรงบิล ${missing ? 'ขาด' : 'เกิน'} ${baht(Math.abs(r.diff))} บาท</strong><br>
      ${missing ? 'น่าจะมีรายการตกหล่น หรือราคาผิดสักบรรทัด' : 'น่าจะมีรายการซ้ำ หรือราคาผิดสักบรรทัด'}`);
  }
  if (canSave && !savedId && !PIN_OK.test($('pin').value)) {
    canSave = false;
    blocked = 'ตั้งรหัสคนจ่ายก่อน';
    html += `<div style="margin-top:10px">${alert('info', 'ตั้งรหัสคนจ่าย 4–6 ตัวเลขก่อน (อยู่ด้านล่าง)')}</div>`;
  }
  if (canSave && !ppValid(payment.promptpay)) {
    canSave = false;
    blocked = 'แก้เลขพร้อมเพย์ก่อน';
    html += `<div style="margin-top:10px">${alert('', 'เลขพร้อมเพย์ไม่ครบ แก้หรือลบออกก่อน')}</div>`;
  }
  $('checkResult').innerHTML = html;

  const save = $('saveBtn');
  save.disabled = !canSave || (editId && !editKey);
  save.innerHTML = canSave
    ? `${icons.share}<span>${savedId ? (dirty ? 'บันทึกการแก้ไข' : 'บันทึกแล้ว') : 'บันทึก แล้วส่งให้เพื่อน'}</span>`
    : `<span>${blocked}</span>`;
  if (savedId && !dirty) save.disabled = true;
  $('shareCard').hidden = !(savedId && canSave);
}

function alert(kind, html) {
  return `<div class="alert ${kind}" style="margin:0"><div>${html}</div></div>`;
}

$('subtotal').addEventListener('input', (e) => { state.subtotal = e.target.value; persistDraft(); renderCheck(); });
for (const f of ['store', 'date', 'time', 'table']) {
  $(f).addEventListener('input', (e) => { state[f] = e.target.value; persistDraft(); renderCheck(); });
}

function renderMeta() {
  for (const f of ['store', 'date', 'time', 'table']) $(f).value = state[f] || '';
  $('subtotal').value = state.subtotal ?? '';
  $('pageSub').textContent = state.store ? `${state.store}${state.table ? ` · โต๊ะ ${state.table}` : ''}` : 'ใครกินอะไร จ่ายเท่านั้น';
}

// ---------- ช่องทางรับเงิน ----------
$('qrPick').innerHTML = `${icons.camera}<span>เลือกรูป QR</span>`;
const ppDigits = (v) => String(v).replace(/\D/g, '');
const ppValid = (v) => !ppDigits(v) || /^0\d{9}$|^\d{13}$/.test(ppDigits(v));

function renderPayment() {
  $('promptpay').value = payment.promptpay;
  $('payName').value = payment.name;
  $('qrPreview').hidden = !payment.previewUrl;
  if (payment.previewUrl) $('qrPreview').src = payment.previewUrl;
  $('qrRemove').hidden = !payment.previewUrl;
  $('qrPick').querySelector('span').textContent = payment.previewUrl ? 'เปลี่ยนรูป QR' : 'เลือกรูป QR';
  renderPpHint();
}
function renderPpHint() {
  const ok = ppValid(payment.promptpay);
  $('ppHint').textContent = ok
    ? 'เพื่อนสแกนแล้วยอดขึ้นเลย ไม่ต้องพิมพ์เอง'
    : 'ใส่เบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก';
  $('ppHint').style.color = ok ? '' : 'var(--danger)';
}
function paymentChanged() {
  payDirty = true;
  dirty = true;
  renderCheck();
}
$('promptpay').addEventListener('input', (e) => { payment.promptpay = e.target.value; renderPpHint(); paymentChanged(); });
$('payName').addEventListener('input', (e) => { payment.name = e.target.value; paymentChanged(); });
$('qrPick').addEventListener('click', () => $('qrFile').click());
$('qrFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  payment.qr = await prepareImage(file, 1000, 'image/png'); // PNG ให้ QR คม
  if (payment.qr.image.length > 2_000_000) payment.qr = await prepareImage(file, 900, 'image/jpeg', 0.92);
  payment.previewUrl = `data:${payment.qr.mimeType};base64,${payment.qr.image}`;
  renderPayment();
  paymentChanged();
});
$('qrRemove').addEventListener('click', () => {
  payment.qr = null;
  payment.previewUrl = null;
  renderPayment();
  paymentChanged();
});

async function savePayment(id, key) {
  const body = { promptpay: ppDigits(payment.promptpay) || null, name: payment.name };
  if (payment.qr !== undefined) body.qr = payment.qr;
  await api(`bills/${id}/payment`, { method: 'PUT', body, key });
  // จำไว้ใช้บิลหน้า (รูปใหญ่เกิน localStorage ก็แค่ไม่จำรูป)
  const remember = { promptpay: body.promptpay, name: body.name };
  if (payment.qr) remember.qr = payment.qr;
  else if (payment.qr === undefined) remember.qr = store.get(MY_PAY)?.qr;
  store.set(MY_PAY, remember);
  if (payment.qr) payment.previewUrl = `/api/bills/${id}/qr?v=${Date.now()}`;
  payment.qr = undefined;
  payDirty = false;
  renderPayment();
}

const PIN_OK = /^\d{4,6}$/;

/** ช่องรหัส: บิลใหม่ต้องตั้ง, บิลเก่าที่ยังไม่มีรหัสตั้งได้, มีแล้วไม่ต้องโชว์ */
function renderPin() {
  const card = $('pinCard');
  card.hidden = Boolean(savedId && hasPin);
  $('pinSave').hidden = !savedId;
  if (savedId && !hasPin) $('pinHint').textContent = 'บิลนี้ยังไม่มีรหัส ตั้งไว้จะได้เปิดจากเครื่องอื่นได้';
}
$('pin').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  renderCheck();
});
$('pinSave').addEventListener('click', async () => {
  const pin = $('pin').value;
  if (!PIN_OK.test(pin)) return toast('รหัสต้องเป็นตัวเลข 4–6 หลัก', true);
  try {
    await api(`bills/${savedId}/pin`, { method: 'PUT', body: { pin }, key: editKey });
    hasPin = true;
    $('pin').value = '';
    toast('ตั้งรหัสคนจ่ายแล้ว');
    renderPin();
  } catch (e) { toast(e.message, true); }
});

/** เปิดหน้าแก้บิลจากเครื่องที่ไม่ได้สร้าง: ใส่รหัสคนจ่ายก่อน */
function showUnlock() {
  for (const el of document.querySelectorAll('main > :not(.topbar)')) el.hidden = true;
  document.querySelector('.bottom').hidden = true;
  document.querySelector('.topbar').insertAdjacentHTML('afterend', `
    <form class="card" id="unlockForm" style="margin-top:8px">
      <h2 style="margin:0 0 6px">ใส่รหัสคนจ่าย</h2>
      <p class="muted small" style="margin:0 0 14px">เครื่องนี้ยังไม่รู้ว่าคุณเป็นคนจ่าย ใส่รหัสที่ตั้งไว้ตอนสร้างบิล</p>
      <div style="display:flex;gap:8px">
        <input class="input pin-input" id="unlockPin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••">
        <button class="btn sm yellow" style="height:48px" type="submit">ปลดล็อก</button>
      </div>
    </form>`);
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`bills/${editId}/unlock`, { method: 'POST', body: { pin: $('unlockPin').value } });
      saveEditKey(editId, r.editKey);
      location.reload();
    } catch (err) { toast(err.message, true); }
  });
}

function renderAll() {
  renderPin();
  renderPayment();
  renderMeta();
  renderPeople();
  renderItems();
  renderCheck();
  renderShare();
}

// ---------- สแกน ----------
$('scanBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const hasItems = validItems().length > 0;
  if (hasItems && !confirm('ลบรายการเดิม แล้วใช้รายการจากรูปนี้แทน?')) return;

  const btn = $('scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>กำลังอ่านบิล…</span>';
  // บิลยาวอาจใช้เวลาเกินครึ่งนาที บอกคนรอให้รู้ว่ายังทำงานอยู่
  const slow = setTimeout(() => { btn.querySelector('span:last-child').textContent = 'บิลยาว รอแป๊บนะ…'; }, 15000);
  try {
    // ส่งได้ไม่เกิน ~4.5MB (ข้อจำกัดของ Vercel) — ถ้ารูปยังใหญ่ ย่อลงอีกขั้น
    let payload = await prepareImage(file);
    if (payload.image.length > 3_000_000) payload = await prepareImage(file, 1500, 'image/jpeg', 0.8);
    const r = await api('scan', { method: 'POST', body: payload });
    if (!r.items.length) throw new Error(r.notes || 'อ่านรายการไม่ออก ถ่ายใหม่ให้เห็นทั้งใบนะ');
    state.items = r.items.map((it) => ({ id: rid(), qty: it.qty, name: it.name, total: it.total, uncertain: it.uncertain }));
    state.subtotal = r.subtotal ?? r.total ?? '';
    for (const f of ['store', 'date', 'time', 'table']) if (r[f]) state[f] = r[f];
    $('notes').innerHTML = r.notes ? alert('info', `<strong>เช็กตรงนี้หน่อย:</strong> ${esc(r.notes)}`) : '';
    persistDraft();
    renderAll();
    toast(`ได้ ${r.items.length} รายการ ดูให้ตรงกับบิลด้วยนะ`);
    $('itemRows').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, true);
  } finally {
    clearTimeout(slow);
    btn.disabled = false;
    btn.innerHTML = `${icons.camera}<span>ถ่ายรูป / เลือกรูปบิล</span>`;
  }
});

// ---------- บันทึก & แชร์ ----------
$('saveBtn').addEventListener('click', async () => {
  const body = {
    store: state.store, date: state.date, time: state.time, table: state.table,
    subtotal: parseNum(state.subtotal),
    people: state.people, payerId: state.payerId, knownPeople,
    ...(savedId ? {} : { pin: $('pin').value }),
    items: validItems().map((it) => ({ id: it.id, qty: parseNum(it.qty), name: it.name, total: parseNum(it.total) })),
  };
  $('saveBtn').disabled = true;
  try {
    if (savedId) {
      const r = await api(`bills/${savedId}`, { method: 'PUT', body, key: editKey });
      // มีเพื่อนเพิ่มชื่อเข้ามาระหว่างแก้ → แสดงชื่อเขาด้วย
      state.people = r.bill.people;
      knownPeople = r.bill.people.map((p) => p.id);
      renderPeople();
    } else {
      const r = await api('bills', { method: 'POST', body });
      hasPin = true;
      $('pin').value = '';
      knownPeople = r.bill.people.map((p) => p.id);
      state.people = r.bill.people;
      savedId = r.bill.id;
      editKey = r.editKey;
      saveEditKey(savedId, editKey);
      const payer = state.people.find((p) => p.id === state.payerId);
      store.set(`me:${savedId}`, payer?.id);
      store.set(DRAFT_KEY, null);
      history.replaceState(null, '', `/edit/${savedId}`);
      $('viewBtn').href = `/b/${savedId}`;
      $('viewBtn').hidden = false;
    }
    if (payDirty) {
      try { await savePayment(savedId, editKey); }
      catch (e) { toast(`บันทึกบิลแล้ว แต่เลขบัญชี/QR ยังไม่ได้บันทึก: ${e.message}`, true); }
    }
    dirty = false;
    toast('บันทึกแล้ว');
    renderPin();
    renderCheck();
    renderShare();
    $('shareCard').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    toast(e.message, true);
    renderCheck();
  }
});

function renderShare() {
  if (!savedId) return;
  const url = `${location.origin}/b/${savedId}`;
  $('shareUrl').value = url;
  $('nativeShareBtn').hidden = !navigator.share;
}
$('copyBtn').addEventListener('click', async () => {
  toast((await copyText($('shareUrl').value)) ? 'คัดลอกลิงก์แล้ว' : 'คัดลอกไม่ได้ กดค้างที่ลิงก์แทน');
});
$('nativeShareBtn').addEventListener('click', () => {
  navigator.share({ title: 'หารค่าเหล้า', text: `เข้าไปกดของที่กินหน่อย${state.store ? ` (${state.store})` : ''}`, url: $('shareUrl').value }).catch(() => {});
});

init();
