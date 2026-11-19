// ของใช้ร่วมกันของทุกหน้า

export async function api(path, { method = 'GET', body, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Edit-Key'] = key;
  const res = await fetch(`/api/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* ว่าง */ }
  if (!res.ok) {
    const fallback = res.status === 413 ? 'รูปใหญ่เกินไป ลองรูปที่เล็กลง' : 'มีอะไรผิดพลาด ลองใหม่อีกครั้ง';
    const err = new Error(data.error || fallback);
    err.status = res.status;
    throw err;
  }
  return data;
}

const nf = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
export const baht = (n) => nf.format(n);
export const baht0 = (n) => nf0.format(n);
/** ส่วน เช่น 1, 1.5 */
export const fmtShare = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// localStorage ใช้แค่จำของสะดวกบนเครื่องนี้ (ชื่อตัวเอง, กุญแจแก้บิลของคนจ่าย)
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* โหมดส่วนตัว */ } },
};
/** เลข PromptPay แบบอ่านง่าย 081-234-5678 */
export function fmtPromptPay(id) {
  const d = String(id || '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 13) return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
  return d;
}

export const editKeyFor =(id) => store.get('editKeys', {})[id] || null;
export function saveEditKey(id, key) {
  const all = store.get('editKeys', {});
  all[id] = key;
  store.set('editKeys', all);
}

let toastTimer;
/** แถบแจ้งเตือนที่เลื่อนลงมาจากด้านบน แล้วหายเอง */
export function toast(msg, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<span class="toast-ico" aria-hidden="true"></span><span class="toast-text"></span>';
    document.body.append(el);
  }
  el.querySelector('.toast-text').textContent = msg;
  el.querySelector('.toast-ico').innerHTML = isError ? '!' : CHECK_SVG;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4000 : 2600);
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7.5"/></svg>';

/**
 * ถามยืนยันด้วยแผ่นที่เลื่อนขึ้นจากด้านล่าง (แทน confirm() ของเบราว์เซอร์
 * ซึ่งเบราว์เซอร์ในแอปบางตัว เช่น LINE บล็อกแล้วตอบ "ยกเลิก" เองทันที)
 */
export function ask(message, { ok = 'ตกลง', cancel = 'ยกเลิก', danger = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'sheet-backdrop';
    back.innerHTML = `
      <div class="sheet ask" role="alertdialog" aria-modal="true" aria-labelledby="askText">
        <p id="askText" class="ask-text"></p>
        <div class="ask-actions">
          <button type="button" class="btn block ${danger ? 'danger' : ''}" data-ok></button>
          <button type="button" class="btn ghost block" data-cancel></button>
        </div>
      </div>`;
    back.querySelector('#askText').textContent = message;
    back.querySelector('[data-ok]').textContent = ok;
    back.querySelector('[data-cancel]').textContent = cancel;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-cancel]')) done(false);
      else if (e.target.closest('[data-ok]')) done(true);
    });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    back.querySelector('[data-ok]').focus();
  });
}

// ---------- ธีมสว่าง/มืด ----------
// สคริปต์ใน <head> ตั้งธีมก่อนหน้าโหลด (จำต่อเครื่อง, ครั้งแรกตามโทรศัพท์) — ปุ่มนี้แค่สลับ
export function setupThemeButton(btn) {
  const paint = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.innerHTML = dark ? icons.sun : icons.moon;
    btn.setAttribute('aria-label', dark ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด');
  };
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    // ปิด transition ชั่วครู่ ไม่งั้นพื้นค่อย ๆ เปลี่ยนแต่ตัวหนังสือเปลี่ยนทันที (แวบเห็นตัวขาวบนพื้นขาว)
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.dataset.theme = next;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    try { localStorage.setItem('hkl-theme', next); } catch { /* ไม่จำ แต่ยังสลับได้ */ }
    paint();
  });
  paint();
}

/** สำหรับ <input accept>: Windows/Android บางเครื่องไม่บอกชนิดไฟล์ HEIC จึงใส่นามสกุลด้วย */
export const IMAGE_ACCEPT = 'image/*,.heic,.heif';

/** รูปจาก iPhone (HEIC/HEIF): ไบต์ 4–8 เป็น "ftyp" ตามด้วยแบรนด์ */
async function looksLikeHeic(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head.length < 12) return false;
  const text = new TextDecoder('latin1').decode(head);
  return text.slice(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(text.slice(8, 12));
}

/**
 * เปิดรูปเป็น bitmap: ลองตัวถอดรูปของเบราว์เซอร์ก่อน (Safari เปิด HEIC ได้)
 * Chrome/LINE บน Android เปิด HEIC ไม่ได้ → โหลดตัวแปลง heic-to (~3MB) เฉพาะตอนนั้น
 */
async function decodeImage(file, onStatus) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (nativeError) {
    if (!(await looksLikeHeic(file))) throw nativeError;
    onStatus?.('กำลังแปลงรูปจาก iPhone…');
    const { heicTo } = await import('https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js');
    return await heicTo({ blob: file, type: 'bitmap' });
  }
}

/** ย่อรูปก่อนส่ง (ด้านยาวสุด 2000px) ให้อัปโหลดเร็ว แต่ยังอ่านตัวเลขได้ */
export async function prepareImage(file, maxSide = 2000, type = 'image/jpeg', quality = 0.88, onStatus) {
  let bmp;
  try {
    bmp = await decodeImage(file, onStatus);
  } catch {
    const heic = await looksLikeHeic(file).catch(() => false);
    throw new Error(heic
      ? 'แปลงรูปจาก iPhone ไม่ได้ ลองกด "ถ่ายรูปบิล" แทน'
      : 'เปิดรูปนี้ไม่ได้ ลองรูป JPG หรือ PNG');
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // รูปโปร่งใสจะได้ไม่กลายเป็นพื้นดำตอนเป็น JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(type, quality);
    return { image: dataUrl.split(',')[1], mimeType: type };
  } finally {
    bmp.close?.();
  }
}

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
}

export const icons = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="2.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="2.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="2.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="2.5"/></svg>',
  basket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18l-1.6 9.2a2 2 0 0 1-2 1.8H6.6a2 2 0 0 1-2-1.8z"/><path d="M8 10l3-6M16 10l-3-6M9 14v3M12 14v3M15 14v3"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><path d="M14 14h3v3h-3zM17 17h3.5v3.5M20.5 14v.01M14 20.5h.01" stroke-linecap="round"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.9-3.3 3.4-5 6.5-5s5.6 1.7 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M17 14.5c2.3 0 4 1.3 4.6 3.8"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5V2 M12 22v-1.5 M3.5 12H2 M22 12h-1.5 M6 6 4.9 4.9 M19.1 19.1 18 18 M6 18l-1.1 1.1 M19.1 4.9 18 6 M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16 M12 15V4 M7.5 8.5 12 4l4.5 4.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
};
