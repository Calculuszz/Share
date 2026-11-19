// หน้าคนจ่าย ทีละขั้น: รายการ (สแกน/พิมพ์) → Recheck ยอดรวม → คนในวง → รับเงิน → บันทึกแล้วแชร์ลิงก์ (req 5.2)
import { api, baht, esc, store, editKeyFor, saveEditKey, toast, ask, prepareImage, IMAGE_ACCEPT, setupThemeButton, copyText, icons } from './common.js';
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
let knownPeople = []; // รายชื่อที่หน้านี้รู้จัก — ชื่อที่เพื่อนเพิ่มทีหลังจะไม่ถูกลบตอนบันทึก
let hasPin = false; // บิลนี้ตั้งรหัสคนจ่ายไว้แล้วหรือยัง
let step = 1; // 1 รายการ, 2 Recheck, 3 คนในวง, 4 รับเงิน, 'done' ส่งลิงก์
let savedId = null;
let dirty = false;

// ช่องทางรับเงิน — แยกจาก state บิลเพราะส่งคนละ endpoint และจำข้ามบิล
// qr: undefined = ไม่เปลี่ยน, null = เอาออก, {image, mimeType} = รูปใหม่
const MY_PAY = 'myPayment';
let payment = { promptpay: '', name: '', qr: undefined, previewUrl: null };
let payDirty = false;

// ---------- เริ่มต้น ----------
const CAMERA_LABEL = `${icons.camera}<span>ถ่ายรูปบิล</span>`;
const UPLOAD_LABEL = `${icons.upload}<span>เลือกรูปจากเครื่อง</span>`;
$('cameraBtn').innerHTML = CAMERA_LABEL;
$('scanBtn').innerHTML = UPLOAD_LABEL;
$('fileInput').accept = IMAGE_ACCEPT;
$('qrFile').accept = IMAGE_ACCEPT;
setupThemeButton($('themeBtn'));
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
      $('cameraBtn').disabled = true;
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

// ---------- คนในวง: คนจ่าย กับ เพื่อนที่ต้องโอนคืน แยกกัน ----------
const payer = () => state.people.find((p) => p.id === state.payerId) || null;

function renderPeople() {
  const p = payer();
  if (document.activeElement !== $('payerName')) $('payerName').value = p?.name ?? '';
  const friends = state.people.filter((x) => x.id !== state.payerId);
  $('peopleChips').innerHTML = friends.length
    ? friends.map((x) => `
      <span class="chip">${esc(x.name)}
        <button type="button" class="x" data-remove="${x.id}" aria-label="ลบ ${esc(x.name)}">×</button>
      </span>`).join('')
    : '<span class="muted small">ยังไม่มี</span>';
}

$('payerName').addEventListener('input', (e) => {
  const name = e.target.value.trim().slice(0, 30);
  let p = payer();
  if (!p && name) {
    p = { id: rid(), name, mode: 'normal' };
    state.people.unshift(p);
    state.payerId = p.id;
  } else if (p) {
    p.name = name;
  }
  if (name) store.set('myName', name);
  persistDraft();
  renderCheck();
});
$('payerName').addEventListener('blur', renderPeople);

$('peopleChips').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (!rm) return;
  state.people = state.people.filter((p) => p.id !== rm.dataset.remove);
  persistDraft();
  renderPeople();
  renderCheck();
});

$('addPersonForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const names = $('personName').value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  for (const name of names) {
    if (state.people.some((p) => p.name === name)) { toast(`มีชื่อ "${name}" แล้ว`, true); continue; }
    state.people.push({ id: rid(), name: name.slice(0, 30), mode: 'normal' });
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

/** แต่ละขั้นพร้อมไปต่อหรือยัง และถ้ายัง เพราะอะไร (ข้อความบนปุ่ม) */
function status() {
  const items = validItems().map((it) => ({ ...it, total: parseNum(it.total) }));
  const badRow = items.findIndex((it) => !Number.isFinite(it.total) || !Number.isFinite(parseNum(it.qty)));
  const sub = parseNum(state.subtotal);
  const r = checkSubtotal(items.map((it) => ({ total: Number.isFinite(it.total) ? it.total : 0 })), Number.isFinite(sub) ? sub : null);
  const p = payer();
  const why = {
    1: items.length === 0 ? 'ใส่รายการก่อน'
      : badRow >= 0 ? `รายการที่ ${state.items.indexOf(validItems()[badRow]) + 1} ราคาหรือจำนวนยังไม่ถูก` : null,
    2: r.subtotal === null ? 'ใส่ยอดรวมท้ายบิลก่อน' : !r.matches ? 'ยอดยังไม่ตรงบิล' : null,
    3: !p?.name ? 'ใส่ชื่อคนจ่ายก่อน'
      : new Set(state.people.map((x) => x.name)).size !== state.people.length ? 'มีชื่อซ้ำกัน' : null,
    4: !ppValid(payment.promptpay) ? 'เลขพร้อมเพย์ไม่ครบ'
      : !savedId && !PIN_OK.test($('pin').value) ? 'ตั้งรหัสคนจ่ายก่อน' : null,
  };
  return { r, why, firstBad: [1, 2, 3, 4].find((n) => why[n]) ?? null };
}

function renderCheck() {
  const st = status();
  const { r } = st;
  $('sumBox').textContent = `฿${baht(r.sum)}`;
  // Recheck: ห้ามปรับให้ตรงเอง แค่บอกส่วนต่าง (req 5.2)
  let html;
  if (r.subtotal === null) {
    html = '<div class="recheck-result wait">ใส่ยอดรวมท้ายบิลด้านบน แล้วจะบอกว่าตรงกันไหม</div>';
  } else if (r.matches) {
    html = `<div class="recheck-result ok"><b>✓ ตรงกับบิล</b><span>รายการครบ ไปต่อได้เลย</span></div>`;
  } else {
    const missing = r.diff > 0;
    html = `<div class="recheck-result bad">
      <b>ยังไม่ตรง ${missing ? 'ขาด' : 'เกิน'} ฿${baht(Math.abs(r.diff))}</b>
      <span>${missing ? 'น่าจะมีรายการตกหล่น หรือราคาผิดสักบรรทัด' : 'น่าจะมีรายการซ้ำ หรือราคาผิดสักบรรทัด'}</span>
      <button class="btn sm ghost" type="button" data-go="1">กลับไปแก้รายการ</button>
    </div>`;
  }
  $('checkResult').innerHTML = html;
  renderNav(st);
}

// ---------- ทีละขั้น ----------
function goTo(next) {
  step = next;
  for (const el of document.querySelectorAll('.step')) el.hidden = el.dataset.step !== String(step);
  window.scrollTo({ top: 0 });
  renderNav();
}

function renderNav(st = status()) {
  for (const b of document.querySelectorAll('#steps [data-go]')) {
    const n = Number(b.dataset.go);
    b.classList.toggle('current', n === step);
    b.classList.toggle('ok', !st.why[n] && n !== step);
  }
  const prev = $('prevBtn');
  const next = $('nextBtn');
  prev.hidden = step === 1 || step === 'done';
  if (step === 'done') {
    next.innerHTML = '<span>ดูหน้าบิล</span>';
    next.classList.remove('not-ready');
    return;
  }
  const last = step === 4;
  const blocked = last ? st.why[st.firstBad] : st.why[step];
  next.classList.toggle('not-ready', Boolean(blocked));
  next.innerHTML = blocked ? `<span>${blocked}</span>`
    : last ? `${icons.share}<span>${savedId ? 'บันทึกการแก้ไข' : 'บันทึก แล้วส่งให้เพื่อน'}</span>`
      : '<span>ถัดไป</span>';
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) goTo(Number(go.dataset.go));
});
$('prevBtn').addEventListener('click', () => goTo(step - 1));
$('nextBtn').addEventListener('click', () => {
  if (step === 'done') { location.href = `/b/${savedId}`; return; }
  const st = status();
  if (step < 4) {
    if (st.why[step]) return toast(st.why[step], true);
    return goTo(step + 1);
  }
  // ขั้นสุดท้าย: ถ้าขั้นก่อนหน้ายังไม่พร้อม พาไปขั้นนั้น
  if (st.firstBad) {
    toast(st.why[st.firstBad], true);
    if (st.firstBad !== 4) goTo(st.firstBad);
    return;
  }
  save();
});

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
  $('ppHint').textContent = ppValid(payment.promptpay) ? '' : 'ใส่เบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก';
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
  try {
    payment.qr = await prepareImage(file, 1000, 'image/png'); // PNG ให้ QR คม
    if (payment.qr.image.length > 2_000_000) payment.qr = await prepareImage(file, 900, 'image/jpeg', 0.92);
  } catch (err) {
    return toast(err.message, true);
  }
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
  $('steps').hidden = true;
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
$('cameraBtn').addEventListener('click', () => $('cameraInput').click());
$('scanBtn').addEventListener('click', () => $('fileInput').click());
for (const [inputId, btnId] of [['cameraInput', 'cameraBtn'], ['fileInput', 'scanBtn']]) {
  $(inputId).addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) scanFile(file, $(btnId));
  });
}

async function scanFile(file, btn) {
  if (validItems().length > 0 && !(await ask('ลบรายการเดิม แล้วใช้รายการจากรูปนี้แทน?', { ok: 'ใช้รูปนี้' }))) return;

  const original = btn.innerHTML;
  const setLabel = (text) => { btn.innerHTML = `<span class="spinner"></span><span>${text}</span>`; };
  $('cameraBtn').disabled = true;
  $('scanBtn').disabled = true;
  setLabel('กำลังเตรียมรูป…');
  // บิลยาวอาจใช้เวลาเกินครึ่งนาที บอกคนรอให้รู้ว่ายังทำงานอยู่
  let slow;
  try {
    // ส่งได้ไม่เกิน ~4.5MB (ข้อจำกัดของ Vercel) — ถ้ารูปยังใหญ่ ย่อลงอีกขั้น
    let payload = await prepareImage(file, 2000, 'image/jpeg', 0.88, setLabel);
    if (payload.image.length > 3_000_000) payload = await prepareImage(file, 1500, 'image/jpeg', 0.8);
    setLabel('กำลังอ่านบิล…');
    slow = setTimeout(() => setLabel('บิลยาว รอแป๊บนะ…'), 15000);
    const r = await api('scan', { method: 'POST', body: payload });
    if (!r.items.length) throw new Error(r.notes || 'อ่านรายการไม่ออก ถ่ายใหม่ให้เห็นทั้งใบนะ');
    state.items = r.items.map((it) => ({ id: rid(), qty: it.qty, name: it.name, total: it.total, uncertain: it.uncertain }));
    state.subtotal = r.subtotal ?? r.total ?? '';
    for (const f of ['store', 'date', 'time', 'table']) if (r[f]) state[f] = r[f];
    $('notes').innerHTML = r.notes ? alert('info', `<strong>เช็กตรงนี้หน่อย:</strong> ${esc(r.notes)}`) : '';
    persistDraft();
    renderAll();
    toast(`ได้ ${r.items.length} รายการ ดูให้ตรงกับบิล แล้วกดถัดไป`);
    $('itemRows').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message, true);
  } finally {
    clearTimeout(slow);
    $('cameraBtn').disabled = false;
    $('scanBtn').disabled = false;
    btn.innerHTML = original;
  }
}

// ---------- บันทึก & แชร์ ----------
async function save() {
  const body = {
    store: state.store, date: state.date, time: state.time, table: state.table,
    subtotal: parseNum(state.subtotal),
    people: state.people, payerId: state.payerId, knownPeople,
    ...(savedId ? {} : { pin: $('pin').value }),
    items: validItems().map((it) => ({ id: it.id, qty: parseNum(it.qty), name: it.name, total: parseNum(it.total) })),
  };
  const next = $('nextBtn');
  next.disabled = true;
  next.innerHTML = '<span class="spinner"></span><span>กำลังบันทึก…</span>';
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
    renderPin();
    renderShare();
    goTo('done');
  } catch (e) {
    toast(e.message, true);
  } finally {
    next.disabled = false;
    renderCheck();
  }
}

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
