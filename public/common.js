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
    const err = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
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
export function toast(msg, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/** ย่อรูปก่อนส่ง (ด้านยาวสุด 2000px) ให้อัปโหลดเร็ว แต่ยังอ่านตัวเลขได้ */
export async function prepareImage(file, maxSide = 2000, type = 'image/jpeg') {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL(type, 0.88);
    return { image: dataUrl.split(',')[1], mimeType: type };
  } catch {
    // เบราว์เซอร์ถอดรูปไม่ได้ (เช่น HEIC บางเครื่อง) → ส่งไฟล์เดิม
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { image: btoa(bin), mimeType: file.type || 'image/jpeg' };
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
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
};
