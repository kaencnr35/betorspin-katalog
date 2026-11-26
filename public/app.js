'use strict';
/* ====================================================================
   Betorspin Katalog – İstemci
   ==================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const col = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' KB';
  return (n / 1024 / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' MB';
};
const pct = (before, after) => (before ? Math.round((1 - after / before) * 100) : 0);
const fmtDate = (t) => new Date(t).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

const ROLE_ICON = { owner: '👑', admin: '🛡️', editor: '✏️', viewer: '👁️' };
const ROLE_NAME = { owner: 'Kurucu', admin: 'Admin', editor: 'Editör', viewer: 'İzleyici' };

const S = {
  cats: [], imgs: [], rev: 0,
  me: { id: null, username: '', name: '', avatar: '', role: 'viewer', roleLabel: 'İzleyici', canEdit: false, canAdmin: false, isOwner: false, isAnon: true },
  presence: { totalOnline: 1, anonCount: 0, anonSummary: '', anonList: [], users: [] },
  view: 'catalog', cur: null, query: '', sizeFilter: '', sortBy: 'name',
  sel: new Set(), lastSel: null, viewIds: [], busy: 0,
  adminTab: 'users', adminData: null, logFilter: '',
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
};

function renderAvatar(u, cls = '') {
  if (u && u.avatar) return `<span class="av ${cls}"><img src="${esc(u.avatar)}" alt=""></span>`;
  const letter = u && u.name ? [...u.name.trim()][0].toUpperCase() : '👤';
  return `<span class="av ${cls}">${esc(letter)}</span>`;
}

function renderRoleBadge(role) {
  const r = role || 'viewer';
  return `<span class="role-badge ${esc(r)}">${ROLE_ICON[r] || '👁️'} ${esc(ROLE_NAME[r] || 'İzleyici')}</span>`;
}

/* ---------- Toast ---------- */
function toast(msg, type = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/* ---------- Engellenme Ekranı ---------- */
function showBanScreen(reason) {
  if ($('#banScreen')) return;
  const div = document.createElement('div');
  div.id = 'banScreen';
  div.className = 'ban-screen';
  div.innerHTML = `<div>
    <div style="font-size:56px;margin-bottom:10px">🚫</div>
    <h2>Erişiminiz Engellendi</h2>
    <p class="muted" style="max-width:440px;margin:8px auto 0">${esc(reason || 'Yönetici tarafından bu siteye erişiminiz kısıtlandı.')}</p>
  </div>`;
  document.body.append(div);
}

/* ---------- API ---------- */
async function api(url, o = {}) {
  const headers = {};
  let body;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  const res = await fetch(url, { method: o.method || 'GET', headers, body, credentials: 'same-origin' });
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch { /* yok */ }
    if (res.status === 403 && data.banned) showBanScreen(data.reason);
    throw new Error(data.error || res.statusText);
  }
  return res.json();
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; }
  catch (e) { toast('⚠ ' + esc(e.message), 'err', 6000); return undefined; }
}

/* ---------- Modal ---------- */
const modals = [];
function openModal(html, { cls = '', static: isStatic = false, onClose } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${cls}">${html}</div>`;
  const m = {
    el: ov.firstElementChild,
    set(h) { m.el.innerHTML = h; },
    close() {
      const i = modals.indexOf(m);
      if (i >= 0) modals.splice(i, 1);
      ov.remove();
      if (onClose) onClose();
    },
    static: isStatic,
  };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov && !isStatic) m.close(); });
  $('#modalRoot').append(ov);
  modals.push(m);
  return m;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modals.length) {
    const top = modals[modals.length - 1];
    if (!top.static) top.close();
  }
});

function dialog({ title, body = '', ok = 'Tamam', cancel = 'Vazgeç', danger = false, cls = '', extra = [] }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    const m = openModal(
      `<h3>${title}</h3><div class="body">${body}</div>
       <div class="foot">${cancel ? `<button data-v="__cancel">${cancel}</button>` : ''}
       ${extra.map((x) => `<button class="${x.cls || ''}" data-v="${x.value}">${x.label}</button>`).join('')}
       <button class="${danger ? 'danger' : 'primary'}" data-v="__ok">${ok}</button></div>`,
      { cls, onClose: () => finish({ value: '__cancel' }) },
    );
    const done = (value) => { finish({ value, el: m.el }); m.close(); };
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) done(b.dataset.v);
    });
    m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') done('__ok'); });
    const first = $('input,select', m.el);
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

async function askText({ title, label, value = '', ok = 'Kaydet', placeholder = '' }) {
  const r = await dialog({
    title, ok,
    body: `<div class="field"><label>${esc(label)}</label><input type="text" id="dlgText" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
  });
  if (r.value !== '__ok') return null;
  const v = r.el.querySelector('#dlgText').value.trim();
  return v || null;
}
async function confirmBox({ title, message, ok = 'Evet', danger = false }) {
  const r = await dialog({ title, body: `<p>${message}</p>`, ok, danger });
  return r.value === '__ok';
}

/* ---------- Veri yardımcıları ---------- */
const catById = (id) => S.cats.find((c) => c.id === id);
const kids = (pid) => S.cats.filter((c) => c.parentId === pid).sort((a, b) => col.compare(a.name, b.name));
function catPath(id) {
  const out = [];
  let c = catById(id);
  while (c) { out.unshift(c); c = catById(c.parentId); }
  return out;
}
const catLabel = (id) => (id ? catPath(id).map((c) => c.name).join(' › ') : 'Ana dizin');
function descendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of S.cats) if (!out.has(c.id) && out.has(c.parentId)) { out.add(c.id); grew = true; }
  }
  return out;
}
function catOptions(selected, exclude = new Set(), rootLabel = '🏠 Ana dizin (kategorisiz)') {
  const list = S.cats.filter((c) => !exclude.has(c.id)).map((c) => ({ id: c.id, label: catLabel(c.id) }))
    .sort((a, b) => col.compare(a.label, b.label));
  return `<option value="">${rootLabel}</option>` + list.map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
}
async function pickCategory({ title, selected = null, exclude = new Set(), ok = 'Seç', note = '' }) {
  const r = await dialog({
    title, ok,
    body: `${note ? `<p class="muted">${note}</p>` : ''}<div class="field"><select id="dlgCat">${catOptions(selected, exclude)}</select></div>`,
  });
  if (r.value !== '__ok') return null;
  return { id: r.el.querySelector('#dlgCat').value || null };
}
const imgUrl = (i) => `/files/${i.id}.${i.ext}?v=${i.updatedAt}`;
const thumbUrl = (i) => `/thumbs/${i.id}.webp?v=${i.updatedAt}`;

/* ---------- Durum yükleme / yoklama ---------- */
async function loadState() {
  try {
    const st = await api('/api/state');
    S.cats = st.categories; S.imgs = st.images; S.rev = st.rev;
    if (st.me) S.me = st.me;
    if (st.presence) S.presence = st.presence;
    const ids = new Set(S.imgs.map((i) => i.id));
    for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);
    if (!S.me.canEdit) S.sel.clear();
    if (S.cur && !catById(S.cur)) { S.cur = null; if (S.view === 'catalog') location.hash = '#/'; }
    if (S.view === 'admin' && !S.me.canAdmin) location.hash = '#/';
    render();
  } catch (e) { /* ban veya bağlantı hatası */ }
}

setInterval(async () => {
  try {
    const r = await api('/api/rev');
    $('#syncDot').classList.remove('off');
    const prevRole = S.me.role;
    if (r.me) S.me = r.me;
    if (r.presence) { S.presence = r.presence; renderTopbar(); }
    if (r.rev !== S.rev && !S.busy) await loadState();
    else if (prevRole !== S.me.role) render();
  } catch { $('#syncDot').classList.add('off'); }
}, 4000);

/* ---------- Yönlendirme ---------- */
function route() {
  const h = location.hash || '#/';
  if (S.keepQuery) S.keepQuery = false; else { S.query = ''; $('#search').value = ''; }
  if (h.startsWith('#/tools')) S.view = 'tools';
  else if (h.startsWith('#/admin')) {
    if (!S.me.canAdmin) { location.hash = '#/'; return; }
    S.view = 'admin';
    loadAdminOverview();
  } else {
    S.view = 'catalog';
    const m = h.match(/^#\/c\/(.+)$/);
    S.cur = m && catById(m[1]) ? m[1] : null;
    if (S.cur) { catPath(S.cur).forEach((c) => S.expanded.add(c.id)); saveExpanded(); }
  }
  $('#sidebar').classList.remove('open');
  render();
}
window.addEventListener('hashchange', route);
const go = (id) => { location.hash = id ? '#/c/' + id : '#/'; };
const saveExpanded = () => localStorage.setItem('expanded', JSON.stringify([...S.expanded]));

/* ---------- Üst Çubuk & Çevrimiçi Kişiler ---------- */
function renderTopbar() {
  const me = S.me;
  const p = S.presence || { totalOnline: 1, anonCount: 0, users: [], anonList: [] };

  // Kullanıcı butonu
  $('#userAvatar').outerHTML = renderAvatar(me.isAnon ? null : me).replace('class="av', 'id="userAvatar" class="av');
  $('#userName').textContent = me.name || p.myAnonLabel || 'Anonim';
  const rb = $('#userRoleBadge');
  rb.className = `role-badge ${me.role || 'viewer'}`;
  rb.textContent = `${ROLE_ICON[me.role] || '👁️'} ${ROLE_NAME[me.role] || 'İzleyici'}`;

  // Çevrimiçi sayacı ve hover menüsü
  $('#onlineCount').textContent = p.totalOnline || 1;
  const rows = [];
  for (const u of (p.users || [])) {
    rows.push(`<div class="op-row">
      ${renderAvatar(u)}
      <div class="nm" title="${esc(u.name)}">${esc(u.name)}${u.isMe ? '<span class="me-tag">(Sen)</span>' : ''}</div>
      ${renderRoleBadge(u.role)}
    </div>`);
  }
  if (p.anonCount > 0) {
    rows.push(`<div class="op-row anon">
      <span class="av">🕶️</span>
      <div class="nm">Anonim - ${p.anonCount}${me.isAnon ? '<span class="me-tag">(Sen dahil)</span>' : ''}</div>
      <span class="role-badge viewer">${p.anonCount} kişi</span>
    </div>`);
  }
  $('#onlinePopover').innerHTML = `
    <div class="op-head"><span>🟢 Çevrimiçi Kişiler</span><span>${p.totalOnline || 1} aktif</span></div>
    <div class="op-list">${rows.join('') || '<div class="muted small">Kimse yok</div>'}</div>`;
}

/* ---------- Render ---------- */
function render() {
  const canEdit = S.me.canEdit;
  const canAdmin = S.me.canAdmin;

  $('#viewCatalog').hidden = S.view !== 'catalog';
  $('#viewTools').hidden = S.view !== 'tools';
  $('#viewAdmin').hidden = S.view !== 'admin';
  $('#tabCatalog').classList.toggle('active', S.view === 'catalog');
  $('#tabTools').classList.toggle('active', S.view === 'tools');
  $('#tabAdmin').classList.toggle('active', S.view === 'admin');
  $('#tabAdmin').hidden = !canAdmin;

  $$('.edit-only').forEach((el) => { el.hidden = !canEdit; });
  $('#readonlyNotice').hidden = canEdit;

  renderTopbar();
  renderTree();
  if (S.view === 'catalog') renderCatalog();
  if (S.view === 'admin') renderAdmin();
  renderBulk();
}

function renderTree() {
  const canEdit = S.me.canEdit;
  const direct = new Map();
  S.imgs.forEach((i) => direct.set(i.categoryId, (direct.get(i.categoryId) || 0) + 1));
  const total = new Map();
  const calc = (id) => { let t = direct.get(id) || 0; kids(id).forEach((c) => { t += calc(c.id); }); total.set(id, t); return t; };
  kids(null).forEach((c) => calc(c.id));
  S.totals = total;
  const node = (c) => {
    const ks = kids(c.id);
    const open = S.expanded.has(c.id);
    return `<div class="node"><div class="node-row ${S.view === 'catalog' && S.cur === c.id ? 'active' : ''}" data-id="${c.id}" ${canEdit ? `data-drop="${c.id}" draggable="true"` : ''}>
      <span class="caret">${ks.length ? (open ? '▼' : '▶') : ''}</span><span class="nm" title="${esc(c.name)}">📁 ${esc(c.name)}</span>
      <span class="ct">${total.get(c.id)}</span>${canEdit ? '<button class="mini add" data-act="add" title="Alt kategori ekle">＋</button>' : ''}</div>
      ${ks.length && open ? `<div class="children">${ks.map(node).join('')}</div>` : ''}</div>`;
  };
  $('#tree').innerHTML =
    `<div class="node-row ${S.view === 'catalog' && S.cur === null ? 'active' : ''}" data-id="" ${canEdit ? 'data-drop=""' : ''}>
      <span class="caret"></span><span class="nm">🏠 Ana dizin</span><span class="ct">${S.imgs.length}</span></div>` +
    kids(null).map(node).join('');
}

function renderCatalog() {
  const q = S.query.trim().toLowerCase();
  const canEdit = S.me.canEdit;

  if (q) {
    $('#crumbs').innerHTML = `<span>🔎 Arama: “${esc(S.query.trim())}”</span>`;
  } else {
    const path = catPath(S.cur);
    $('#crumbs').innerHTML = `<a data-go="" ${canEdit ? 'data-drop=""' : ''}>🏠 Ana dizin</a>` + path.map((c, i) =>
      `<span class="sep">›</span>` + (i === path.length - 1 ? `<span>${esc(c.name)}</span>` : `<a data-go="${c.id}" ${canEdit ? `data-drop="${c.id}"` : ''}>${esc(c.name)}</a>`)).join('');
  }

  const cur = catById(S.cur);
  if (q) {
    $('#catActions').innerHTML = '';
  } else if (cur) {
    $('#catActions').innerHTML = (canEdit
      ? `<button data-a="rename">✎ Adını değiştir</button><button data-a="movecat">↪ Taşı</button>` : '') +
      `<button data-a="zip">⬇ ZIP indir</button>` +
      (canEdit ? `<button data-a="delcat" class="danger">🗑 Sil</button>` : '');
  } else {
    $('#catActions').innerHTML = `<button data-a="zip">⬇ Tümünü ZIP indir</button>`;
  }
  $('#btnNewCat').textContent = cur ? '＋ Alt kategori' : '＋ Yeni kategori';

  let tileCats;
  if (q) tileCats = S.cats.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => col.compare(a.name, b.name));
  else tileCats = kids(S.cur);
  $('#tiles').innerHTML = tileCats.map((c) => {
    const ds = descendants(c.id);
    const cover = S.imgs.find((i) => ds.has(i.categoryId));
    const sub = kids(c.id).length;
    return `<div class="tile" data-go="${c.id}" ${canEdit ? `data-drop="${c.id}" data-catid="${c.id}" draggable="true"` : ''}>
      <div class="cover" ${cover ? `style="background-image:url('${thumbUrl(cover)}')"` : ''}>${cover ? '' : '📁'}</div>
      <div class="info"><div class="tn" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="ts">${S.totals.get(c.id) || 0} görsel${sub ? ` · ${sub} alt kategori` : ''}</div></div></div>`;
  }).join('');

  let list = q
    ? S.imgs.filter((i) => i.name.toLowerCase().includes(q) || catLabel(i.categoryId).toLowerCase().includes(q))
    : S.imgs.filter((i) => i.categoryId === S.cur);

  const sizes = new Map();
  list.forEach((i) => { const k = `${i.width}×${i.height}`; sizes.set(k, (sizes.get(k) || 0) + 1); });
  if (S.sizeFilter && !sizes.has(S.sizeFilter)) S.sizeFilter = '';
  $('#sizeFilter').innerHTML = `<option value="">Tüm ölçüler</option>` +
    [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${k}" ${k === S.sizeFilter ? 'selected' : ''}>${k} (${n})</option>`).join('');
  if (S.sizeFilter) list = list.filter((i) => `${i.width}×${i.height}` === S.sizeFilter);

  const sorters = {
    name: (a, b) => col.compare(a.name, b.name),
    new: (a, b) => b.createdAt - a.createdAt,
    size: (a, b) => b.size - a.size,
  };
  list.sort(sorters[S.sortBy]);
  $('#sortBy').value = S.sortBy;
  S.viewIds = list.map((i) => i.id);

  const sum = list.reduce((t, i) => t + i.size, 0);
  $('#gridInfo').innerHTML = list.length
    ? `<span>${list.length} görsel · ${fmtBytes(sum)}</span><button class="mini" data-a="selall" style="font-size:12px;padding:2px 8px">Tümünü seç</button>` : '';
  $('#grid').innerHTML = list.map((i) => `
    <div class="card ${S.sel.has(i.id) ? 'sel' : ''}" data-id="${i.id}" ${canEdit ? 'draggable="true"' : ''}>
      <div class="chk" data-chk="1">✓</div>
      <div class="img"><img loading="lazy" draggable="false" src="${thumbUrl(i)}" alt=""></div>
      <div class="meta"><div class="nm" title="${esc(i.name)}">${esc(i.name)}</div>
        <div class="sub"><span>${i.width}×${i.height}</span><span>${fmtBytes(i.size)}</span></div>
        ${q ? `<div class="cat" title="${esc(catLabel(i.categoryId))}">📁 ${esc(catLabel(i.categoryId))}</div>` : ''}</div></div>`).join('');

  const empty = !list.length && !tileCats.length;
  $('#empty').hidden = !empty;
  if (empty) {
    $('#empty').innerHTML = q ? 'Sonuç bulunamadı.' :
      `<div style="font-size:40px">📂</div><p><b>${cur ? 'Bu kategori boş' : 'Katalog henüz boş'}</b></p>
       <p>${canEdit ? 'Görselleri veya klasörleri buraya sürükleyip bırak, ya da yukarıdaki butonları kullan.' : 'Henüz bu kategoriye görsel eklenmemiş.'}</p>`;
  }
}

/* ---------- Seçim ---------- */
function toggleSel(id, shift) {
  if (shift && S.lastSel && S.viewIds.includes(S.lastSel)) {
    const a = S.viewIds.indexOf(S.lastSel); const b = S.viewIds.indexOf(id);
    S.viewIds.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => S.sel.add(x));
  } else if (S.sel.has(id)) S.sel.delete(id);
  else S.sel.add(id);
  S.lastSel = id;
  $$('#grid .card').forEach((c) => c.classList.toggle('sel', S.sel.has(c.dataset.id)));
  renderBulk();
}
function renderBulk() {
  const n = S.sel.size;
  const canEdit = S.me.canEdit;
  document.body.classList.toggle('selecting', n > 0);
  const bar = $('#bulkBar');
  bar.hidden = !n || S.view !== 'catalog';
  bar.innerHTML = `<span class="cnt">${n} seçili</span>` +
    (canEdit ? `<button data-b="move">↪ Taşı</button><button data-b="compress">🗜 Sıkıştır</button><button data-b="resize">📐 Boyutlandır</button>` : '') +
    `<button data-b="zip">⬇ ZIP</button>` +
    (canEdit ? `<button data-b="del" class="danger">🗑 Sil</button>` : '') +
    `<button data-b="all">Hepsini seç</button><button data-b="clear" title="Seçimi temizle">✕</button>`;
}
$('#bulkBar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-b]');
  if (!b) return;
  const ids = [...S.sel];
  switch (b.dataset.b) {
    case 'clear': S.sel.clear(); render(); break;
    case 'all': S.viewIds.forEach((id) => S.sel.add(id)); render(); break;
    case 'move': await moveImages(ids); break;
    case 'compress': processDialog(ids, 'compress'); break;
    case 'resize': processDialog(ids, 'resize'); break;
    case 'zip': location.href = '/api/zip?ids=' + ids.join(',') + '&name=' + encodeURIComponent('secili-gorseller'); break;
    case 'del': await deleteImages(ids); break;
    default:
  }
});

async function moveImages(ids, dest) {
  if (!S.me.canEdit) return;
  if (dest === undefined) {
    const p = await pickCategory({ title: `${ids.length} görseli taşı`, selected: S.cur, ok: 'Taşı' });
    if (!p) return;
    dest = p.id;
  }
  const r = await act(() => api('/api/images/move', { method: 'POST', body: { ids, categoryId: dest } }), `${ids.length} görsel “${esc(catLabel(dest))}” içine taşındı`);
  if (r) { S.sel.clear(); await loadState(); }
}
async function deleteImages(ids) {
  if (!S.me.canEdit) return;
  const ok = await confirmBox({ title: 'Görselleri sil', message: `<b>${ids.length}</b> görsel kalıcı olarak silinecek. Emin misin?`, ok: 'Sil', danger: true });
  if (!ok) return;
  const r = await act(() => api('/api/images', { method: 'DELETE', body: { ids } }), `${ids.length} görsel silindi`);
  if (r) { ids.forEach((id) => S.sel.delete(id)); await loadState(); }
}

/* ---------- Kategori işlemleri ---------- */
async function newCategory(parentId) {
  if (!S.me.canEdit) return;
  const name = await askText({ title: parentId ? `“${catLabel(parentId)}” içine yeni kategori` : 'Yeni kategori', label: 'Kategori adı', ok: 'Oluştur', placeholder: 'ör. Story' });
  if (!name) return;
  const r = await act(() => api('/api/categories', { method: 'POST', body: { name, parentId } }));
  if (r) { if (parentId) { S.expanded.add(parentId); saveExpanded(); } await loadState(); go(r.id); }
}
async function renameCategory(id) {
  if (!S.me.canEdit) return;
  const name = await askText({ title: 'Kategori adını değiştir', label: 'Yeni ad', value: catById(id).name });
  if (!name) return;
  if (await act(() => api('/api/categories/' + id, { method: 'PATCH', body: { name } }))) await loadState();
}
async function moveCategory(id, dest) {
  if (!S.me.canEdit) return;
  if (dest === undefined) {
    const p = await pickCategory({ title: 'Kategoriyi taşı', selected: catById(id).parentId, exclude: descendants(id), ok: 'Taşı' });
    if (!p) return;
    dest = p.id;
  }
  if (await act(() => api('/api/categories/' + id, { method: 'PATCH', body: { parentId: dest } }), 'Kategori taşındı')) await loadState();
}
async function deleteCategory(id) {
  if (!S.me.canEdit) return;
  const ds = descendants(id);
  const n = S.imgs.filter((i) => ds.has(i.categoryId)).length;
  const parent = catById(id).parentId;
  let mode = 'cascade';
  if (n || ds.size > 1) {
    const r = await dialog({
      title: 'Kategoriyi sil',
      body: `<p><b>${esc(catById(id).name)}</b> içinde ${n} görsel${ds.size > 1 ? ` ve ${ds.size - 1} alt kategori` : ''} var.</p>`,
      ok: 'İçindekilerle birlikte sil', danger: true,
      extra: [{ label: `İçindekileri “${esc(catLabel(parent))}” içine taşı, sadece kategoriyi sil`, value: 'promote' }],
    });
    if (r.value === '__cancel') return;
    mode = r.value === 'promote' ? 'promote' : 'cascade';
  } else if (!(await confirmBox({ title: 'Kategoriyi sil', message: 'Boş kategori silinecek.', ok: 'Sil', danger: true }))) return;
  if (await act(() => api(`/api/categories/${id}?mode=${mode}`, { method: 'DELETE' }), 'Kategori silindi')) {
    if (S.cur === id) go(parent); await loadState();
  }
}

/* ---------- Profil & Hesap Modalı ---------- */
function openProfileModal() {
  const me = S.me;
  const m = openModal('', { cls: 'wide' });
  let mode = 'profile'; // 'profile' | 'login'

  const draw = () => {
    if (mode === 'login') {
      m.set(`<h3>🔑 Hesaba Giriş Yap</h3>
        <div class="body">
          <p class="muted small">Yetkili bir profiliniz varsa kullanıcı adı ve şifrenizle giriş yapın.</p>
          <div class="field"><label>Kullanıcı adı veya görünen ad</label><input type="text" id="lgUser" placeholder="ör. kaan"></div>
          <div class="field"><label>Şifre</label><input type="password" id="lgPass" placeholder="••••••••"></div>
        </div>
        <div class="foot">
          <button data-p="back">← Geri</button>
          <button class="primary" data-p="dologin">Giriş Yap</button>
        </div>`);
      $('#lgUser', m.el)?.focus();
      return;
    }

    m.set(`<h3>👤 Profil &amp; Hesap Ayarları</h3>
      <div class="body">
        <div class="profile-box">
          ${renderAvatar(me.isAnon ? null : me, 'lg')}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <b style="font-size:16px">${esc(me.name || 'Anonim Ziyaretçi')}</b>
              ${renderRoleBadge(me.role)}
            </div>
            <div class="muted small" style="margin-top:2px">
              ${me.username ? `@${esc(me.username)} · ` : ''}${me.canEdit ? 'Katalogda düzenleme ve yükleme yetkiniz aktif.' : 'Şu an izleyici modundasınız. Düzenleme için yöneticiden yetki isteyin.'}
            </div>
            <div class="row-btns" style="margin-top:8px">
              <button data-p="pickav" class="mini" style="font-size:12px;padding:3px 10px">📷 Fotoğraf Yükle</button>
              ${me.avatar ? `<button data-p="delav" class="mini danger" style="font-size:12px;padding:3px 10px">Kaldır</button>` : ''}
            </div>
          </div>
        </div>
        <div class="field"><label>Görünen Adın (ekip listesinde ve yüklemelerde görünür)</label>
          <input type="text" id="prName" value="${esc(me.name || '')}" placeholder="Adını yaz…"></div>
        <div class="field"><label>Kullanıcı Adı (giriş yaparken kullanılır)</label>
          <input type="text" id="prUser" value="${esc(me.username || '')}" placeholder="ör. kaan"></div>
        <div class="field"><label>Şifre Belirle / Değiştir <span class="muted">(değiştirmek istemiyorsan boş bırak)</span></label>
          <input type="password" id="prPass" placeholder="Yeni şifre (en az 4 karakter)"></div>
      </div>
      <div class="foot">
        <button data-p="loginmode">🔑 Başka Hesaba Giriş</button>
        ${!me.isAnon ? '<button data-p="logout" class="danger">Çıkış Yap</button>' : ''}
        <div class="spacer"></div>
        <button data-p="close">Kapat</button>
        <button class="primary" data-p="save">Kaydet</button>
      </div>`);
  };

  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const actName = b.dataset.p;
    if (actName === 'close') m.close();
    if (actName === 'loginmode') { mode = 'login'; draw(); }
    if (actName === 'back') { mode = 'profile'; draw(); }
    if (actName === 'pickav') $('#avatarInput').click();
    if (actName === 'delav') {
      const r = await act(() => api('/api/profile/avatar', { method: 'DELETE' }), 'Profil fotoğrafı kaldırıldı');
      if (r) { S.me = r.me; Object.assign(me, r.me); draw(); renderTopbar(); }
    }
    if (actName === 'save') {
      const name = $('#prName', m.el).value.trim();
      const username = $('#prUser', m.el).value.trim();
      const password = $('#prPass', m.el).value;
      const r = await act(() => api('/api/profile', { method: 'PATCH', body: { name, username, password } }), 'Profil kaydedildi');
      if (r) { S.me = r.me; m.close(); await loadState(); }
    }
    if (actName === 'dologin') {
      const username = $('#lgUser', m.el).value.trim();
      const password = $('#lgPass', m.el).value;
      const r = await act(() => api('/api/auth/login', { method: 'POST', body: { username, password } }), 'Hoş geldin!');
      if (r) { S.me = r.me; m.close(); await loadState(); }
    }
    if (actName === 'logout') {
      const r = await act(() => api('/api/auth/logout', { method: 'POST' }), 'Çıkış yapıldı');
      if (r) { S.me = r.me; m.close(); await loadState(); }
    }
  });

  $('#avatarInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const form = new FormData();
    form.append('avatar', f);
    const r = await act(() => api('/api/profile/avatar', { method: 'POST', form }), 'Profil fotoğrafı güncellendi');
    if (r) { S.me = r.me; Object.assign(me, r.me); draw(); renderTopbar(); }
  };

  draw();
}

/* ---------- Katalog olayları ---------- */
$('#crumbs').addEventListener('click', (e) => { const a = e.target.closest('[data-go]'); if (a) go(a.dataset.go || null); });
$('#tiles').addEventListener('click', (e) => { const t = e.target.closest('[data-go]'); if (t) go(t.dataset.go); });
$('#catActions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const id = S.cur;
  if (b.dataset.a === 'rename') renameCategory(id);
  if (b.dataset.a === 'movecat') moveCategory(id);
  if (b.dataset.a === 'delcat') deleteCategory(id);
  if (b.dataset.a === 'zip') location.href = `/api/categories/${id || 'root'}/zip`;
});
$('#gridInfo').addEventListener('click', (e) => { if (e.target.dataset.a === 'selall') { S.viewIds.forEach((id) => S.sel.add(id)); render(); } });
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('[data-chk]') || S.sel.size > 0 || e.ctrlKey || e.metaKey) toggleSel(id, e.shiftKey);
  else openLightbox(id);
});
$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.node-row');
  if (!row) return;
  const id = row.dataset.id || null;
  if (e.target.closest('[data-act=add]')) { newCategory(id); return; }
  if (e.target.closest('.caret') && id) {
    if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
    saveExpanded(); renderTree(); return;
  }
  if (S.view !== 'catalog') { location.hash = id ? '#/c/' + id : '#/'; return; }
  go(id);
});
$('#btnNewRootCat').onclick = () => newCategory(null);
$('#btnNewCat').onclick = () => newCategory(S.cur);
$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('open');
$('#sizeFilter').onchange = (e) => { S.sizeFilter = e.target.value; renderCatalog(); };
$('#sortBy').onchange = (e) => { S.sortBy = e.target.value; renderCatalog(); };
$('#thumbSize').oninput = (e) => { document.documentElement.style.setProperty('--thumb', e.target.value + 'px'); localStorage.setItem('thumb', e.target.value); };
(() => { const t = localStorage.getItem('thumb'); if (t) { $('#thumbSize').value = t; document.documentElement.style.setProperty('--thumb', t + 'px'); } })();
let searchT;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  searchT = setTimeout(() => {
    S.query = e.target.value;
    if (S.view !== 'catalog') { S.keepQuery = true; location.hash = '#/'; S.query = e.target.value; }
    renderCatalog();
  }, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !modals.length) { e.preventDefault(); $('#search').focus(); }
});
$('#btnUser').onclick = openProfileModal;

/* ---------- Sürükle-bırak (yalnızca düzenleme yetkisi olanlar) ---------- */
document.addEventListener('dragstart', (e) => {
  if (!S.me.canEdit) return;
  const card = e.target.closest && e.target.closest('.card');
  const row = e.target.closest && e.target.closest('.node-row[data-id], .tile[data-catid]');
  if (card) {
    const id = card.dataset.id;
    const ids = S.sel.has(id) ? [...S.sel] : [id];
    e.dataTransfer.setData('application/x-imgs', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  } else if (row) {
    const id = row.dataset.catid || row.dataset.id;
    if (!id) return;
    e.dataTransfer.setData('application/x-cat', id);
    e.dataTransfer.effectAllowed = 'move';
  }
});
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (S.me.canEdit && hasFiles(e) && S.view === 'catalog') { dragDepth++; $('#dropHint').hidden = false; }
});
document.addEventListener('dragleave', (e) => {
  if (S.me.canEdit && hasFiles(e) && S.view === 'catalog') { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; }
});
document.addEventListener('dragover', (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  const files = types.includes('Files');
  const internal = types.includes('application/x-imgs') || types.includes('application/x-cat');
  $$('.dragover').forEach((x) => x.classList.remove('dragover'));
  if (files && !e.target.closest('#toolDrop')) {
    if (S.me.canEdit) e.preventDefault();
  }
  if (!S.me.canEdit) return;
  const t = e.target.closest('[data-drop]');
  if (t && (internal || (files && S.view === 'catalog'))) { e.preventDefault(); t.classList.add('dragover'); }
});
document.addEventListener('drop', async (e) => {
  dragDepth = 0; $('#dropHint').hidden = true;
  $$('.dragover').forEach((x) => x.classList.remove('dragover'));
  if (!S.me.canEdit) return;
  const types = [...(e.dataTransfer?.types || [])];
  if (types.includes('Files')) {
    e.preventDefault();
    if (S.view !== 'catalog') return;
    const t = e.target.closest('[data-drop]');
    const dest = t ? (t.dataset.drop || null) : S.cur;
    const entries = await filesFromDrop(e.dataTransfer);
    startUpload(entries, dest);
    return;
  }
  const t = e.target.closest('[data-drop]');
  if (!t) return;
  const dest = t.dataset.drop || null;
  if (types.includes('application/x-imgs')) {
    e.preventDefault();
    moveImages(JSON.parse(e.dataTransfer.getData('application/x-imgs')), dest);
  } else if (types.includes('application/x-cat')) {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/x-cat');
    if (id !== dest) moveCategory(id, dest);
  }
});

async function filesFromDrop(dt) {
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const en of batch) await walk(en, prefix + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}

/* ---------- Yükleme ---------- */
const LEVELS = [
  ['', 'Sıkıştırma yok (orijinal)'],
  ['lossless', 'Kayıpsız'], ['high', 'Yüksek kalite'], ['balanced', 'Dengeli (önerilen)'], ['small', 'Küçük boyut'],
];
async function startUpload(entries, defaultCat) {
  if (!S.me.canEdit) { toast('⚠ Görsel yüklemek için düzenleme yetkisi gerekir.', 'err'); return; }
  const ok = entries.filter((x) => IMG_RE.test(x.file.name));
  const skipped = entries.length - ok.length;
  if (!ok.length) { toast('Yüklenecek görsel bulunamadı (PNG, JPG, WebP, GIF)', 'err'); return; }

  const hasFolders = ok.some((x) => x.path.includes('/'));
  const firstSegs = new Set(ok.map((x) => x.path.split('/')[0]));
  const commonRoot = ok.every((x) => x.path.split('/').length >= 2) && firstSegs.size === 1 ? [...firstSegs][0] : null;
  const deep = commonRoot && ok.some((x) => x.path.split('/').length >= 3);
  const totalSize = ok.reduce((t, x) => t + x.file.size, 0);

  const r = await dialog({
    title: `⬆ ${ok.length} görsel yüklenecek`, ok: 'Yüklemeyi başlat', cls: 'wide',
    body: `<p class="muted">Toplam ${fmtBytes(totalSize)}${skipped ? ` · ${skipped} desteklenmeyen dosya atlanacak` : ''}</p>
      <div class="field"><label>Hedef kategori</label><select id="upCat">${catOptions(defaultCat)}</select></div>
      ${hasFolders ? `<div class="field"><label class="inline" style="color:var(--text);font-size:14px"><input type="checkbox" id="upStrip" ${deep ? 'checked' : ''} ${commonRoot ? '' : 'disabled'}>
        Ana klasörü atla${commonRoot ? ` (“${esc(commonRoot)}” kategorisi oluşturma, içindekileri doğrudan hedefe aç)` : ''}</label>
        <div class="muted small" style="margin-top:4px">Klasör yapısı alt kategori olarak oluşturulur.</div></div>` : ''}
      <div class="field"><label>Yüklerken sıkıştır</label><select id="upLevel">${LEVELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>`,
  });
  if (r.value !== '__ok') return;
  const cat = r.el.querySelector('#upCat').value || null;
  const level = r.el.querySelector('#upLevel').value;
  const strip = r.el.querySelector('#upStrip')?.checked;
  const items = strip ? ok.map((x) => ({ file: x.file, path: x.path.split('/').slice(1).join('/') })) : ok;

  const batches = [];
  let curB = []; let sz = 0;
  for (const it of items) {
    if (curB.length && (sz + it.file.size > 30e6 || curB.length >= 15)) { batches.push(curB); curB = []; sz = 0; }
    curB.push(it); sz += it.file.size;
  }
  if (curB.length) batches.push(curB);

  const m = openModal(`<h3>Yükleniyor…</h3><div class="body"><div id="upText">0 / ${items.length}</div><div class="progress"><div id="upBar"></div></div>
    <p class="muted small">Bu pencereyi kapatma. ${level ? 'Sıkıştırma nedeniyle biraz sürebilir.' : ''}</p></div>`, { static: true });
  S.busy++;
  let done = 0; let added = 0; const failed = [];
  try {
    for (const b of batches) {
      const form = new FormData();
      form.append('categoryId', cat || '');
      form.append('compress', level);
      form.append('meta', JSON.stringify(b.map((x) => ({ name: x.file.name, path: x.path }))));
      b.forEach((x) => form.append('files', x.file, x.file.name));
      try {
        const res = await api('/api/images', { method: 'POST', form });
        added += res.added; failed.push(...res.skipped);
      } catch (e) { failed.push(...b.map((x) => x.file.name)); toast('⚠ ' + esc(e.message), 'err'); }
      done += b.length;
      $('#upText', m.el).textContent = `${done} / ${items.length}`;
      $('#upBar', m.el).style.width = (done / items.length) * 100 + '%';
    }
  } finally { S.busy--; m.close(); }
  toast(`✅ ${added} görsel yüklendi${failed.length ? ` · ⚠ ${failed.length} dosya yüklenemedi` : ''}`, failed.length ? 'err' : 'ok', 6000);
  if (cat) { catPath(cat).forEach((c) => S.expanded.add(c.id)); saveExpanded(); }
  await loadState();
}
$('#btnUpload').onclick = () => $('#fileInput').click();
$('#btnUploadFolder').onclick = () => $('#folderInput').click();
$('#fileInput').onchange = (e) => {
  const entries = [...e.target.files].map((f) => ({ file: f, path: f.name }));
  e.target.value = ''; startUpload(entries, S.cur);
};
$('#folderInput').onchange = (e) => {
  const entries = [...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  e.target.value = ''; startUpload(entries, S.cur);
};

/* ---------- Önizleme (lightbox) ---------- */
function openLightbox(startId) {
  let idx = Math.max(0, S.viewIds.indexOf(startId));
  let currentId = startId;
  const canEdit = S.me.canEdit;
  const onKey = (e) => {
    if (modals[modals.length - 1] !== m || /INPUT|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  const m = openModal('', { cls: 'xl', onClose: () => document.removeEventListener('keydown', onKey) });
  document.addEventListener('keydown', onKey);

  const step = (d) => { idx = (idx + d + S.viewIds.length) % S.viewIds.length; draw(); };
  const sync = () => {
    if (S.viewIds.includes(currentId)) idx = S.viewIds.indexOf(currentId);
    else idx = Math.min(idx, S.viewIds.length - 1);
  };
  const draw = () => {
    const img = S.imgs.find((i) => i.id === S.viewIds[idx]);
    if (!img) { m.close(); return; }
    currentId = img.id;
    m.set(`<div class="lb"><div class="stage"><img src="${imgUrl(img)}" alt="">
        ${S.viewIds.length > 1 ? '<button class="nav l" data-n="-1">‹</button><button class="nav r" data-n="1">›</button>' : ''}</div>
      <div class="side">
        ${canEdit
          ? `<div class="field"><label>Dosya adı</label><input type="text" id="lbName" value="${esc(img.name)}"></div>
             <div class="field"><label>Kategori</label><select id="lbCat">${catOptions(img.categoryId)}</select></div>`
          : `<div><b>${esc(img.name)}</b><div class="muted small">📁 ${esc(catLabel(img.categoryId))}</div></div>`}
        <div class="kv"><span>Ölçü</span><span>${img.width} × ${img.height} px</span>
          <span>Boyut</span><span>${fmtBytes(img.size)}</span><span>Biçim</span><span>${img.format.toUpperCase()}</span>
          <span>Ekleyen</span><span>${esc(img.addedBy || '—')}</span><span>Tarih</span><span>${fmtDate(img.createdAt)}</span></div>
        <div class="row-btns">
          <a href="/api/images/${img.id}/download"><button class="primary">⬇ İndir</button></a>
          <button data-x="copy">📋 Panoya kopyala</button></div>
        ${canEdit ? `<div class="row-btns"><button data-x="compress">🗜 Sıkıştır</button><button data-x="resize">📐 Boyutlandır</button></div>` : ''}
        <div class="row-btns" style="margin-top:auto">
          ${canEdit ? '<button data-x="del" class="danger">🗑 Sil</button>' : ''}
          <button data-x="close">Kapat</button></div>
      </div></div>`);
    const el = m.el;
    $$('[data-n]', el).forEach((b) => { b.onclick = () => step(+b.dataset.n); });
    if (canEdit) {
      const rename = async () => {
        const v = $('#lbName', el).value.trim();
        if (!v || v === img.name) return;
        if (await act(() => api('/api/images/' + img.id, { method: 'PATCH', body: { name: v } }), 'Ad güncellendi')) { await loadState(); sync(); draw(); }
      };
      $('#lbName', el).onchange = rename;
      $('#lbName', el).onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
      $('#lbCat', el).onchange = async (e) => {
        if (await act(() => api('/api/images/' + img.id, { method: 'PATCH', body: { categoryId: e.target.value || null } }), 'Taşındı')) {
          await loadState(); sync(); if (S.viewIds.length) draw(); else m.close();
        }
      };
    }
    el.onclick = async (e) => {
      const x = e.target.closest('[data-x]');
      if (!x) return;
      switch (x.dataset.x) {
        case 'close': m.close(); break;
        case 'copy': copyImage(img); break;
        case 'compress': m.close(); processDialog([img.id], 'compress'); break;
        case 'resize': m.close(); processDialog([img.id], 'resize'); break;
        case 'del':
          if (await confirmBox({ title: 'Görseli sil', message: `<b>${esc(img.name)}</b> silinecek.`, ok: 'Sil', danger: true })) {
            if (await act(() => api('/api/images', { method: 'DELETE', body: { ids: [img.id] } }), 'Silindi')) {
              await loadState(); sync(); if (S.viewIds.length) draw(); else m.close();
            }
          }
          break;
        default:
      }
    };
  };
  draw();
}
async function copyImage(img) {
  try {
    let blob = await (await fetch(imgUrl(img))).blob();
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('📋 Görsel panoya kopyalandı', 'ok');
  } catch (e) { toast('⚠ Kopyalanamadı (tarayıcı izni / HTTPS gerekli olabilir)', 'err'); }
}

/* ---------- Sıkıştırma / boyutlandırma seçenekleri ---------- */
let optUid = 0;
const PRESETS = [[1280, 640], [500, 800], [1080, 1920], [1080, 1080], [1920, 1080]];
function buildOptions(host, { preset = 'compress', sample = null } = {}) {
  const n = ++optUid;
  host.innerHTML = `
  <div class="opt-block"><label class="hd"><input type="checkbox" class="o-compress" ${preset !== 'resize' ? 'checked' : ''}> 🗜 Sıkıştır <span class="muted small">(TinyPNG tarzı)</span></label>
    <div class="bd"><div class="radios">
      <label><input type="radio" name="lv${n}" value="lossless"><div><b>Kayıpsız</b><div class="d">Görüntü birebir aynı kalır, daha az tasarruf</div></div></label>
      <label><input type="radio" name="lv${n}" value="high"><div><b>Yüksek kalite</b><div class="d">Gözle fark edilmez, güvenli</div></div></label>
      <label><input type="radio" name="lv${n}" value="balanced" checked><div><b>Dengeli (önerilen)</b><div class="d">Kalite ve boyut arasında en iyi denge</div></div></label>
      <label><input type="radio" name="lv${n}" value="small"><div><b>Küçük boyut</b><div class="d">Maksimum küçültme, hafif kalite kaybı olabilir</div></div></label>
    </div></div></div>
  <div class="opt-block"><label class="hd"><input type="checkbox" class="o-resize" ${preset === 'resize' ? 'checked' : ''}> 📐 Boyutlandır <span class="muted small">(oranı bozmadan)</span></label>
    <div class="bd">
      <div class="presets">${PRESETS.map(([w, h]) => `<button type="button" data-w="${w}" data-h="${h}">${w}×${h}</button>`).join('')}</div>
      <div class="dims"><div class="field" style="margin:0"><label>Genişlik (px)</label><input type="number" class="o-w" min="1" placeholder="otomatik"></div>
        <span class="x">×</span><div class="field" style="margin:0"><label>Yükseklik (px)</label><input type="number" class="o-h" min="1" placeholder="otomatik"></div>
        <span class="x">veya</span><div class="field" style="margin:0"><label>Ölçek (%)</label><input type="number" class="o-p" min="1" max="500" placeholder="—"></div></div>
      <div class="field"><label>Yerleşim</label><select class="o-fit">
        <option value="inside">Oranı koru, ölçüye sığdır (tasarım bozulmaz)</option>
        <option value="contain">Oranı koru, boşluk ekleyerek tam ölçüye getir</option>
        <option value="cover">Kırparak tam ölçüyü doldur</option>
        <option value="fill">Esnet (oran bozulur)</option></select></div>
      <div class="field o-bgwrap" hidden><label>Boşluk rengi</label><div class="inline"><select class="o-bg">
        <option value="transparent">Şeffaf</option><option value="#ffffff">Beyaz</option><option value="#000000">Siyah</option><option value="custom">Özel…</option></select>
        <input type="color" class="o-color" value="#1a1a2e" hidden></div></div>
      <div class="field o-poswrap" hidden><label class="inline" style="color:var(--text);font-size:14px"><input type="checkbox" class="o-pos"> Akıllı kırpma (önemli bölgeyi odakla)</label></div>
      <label class="inline" style="margin-top:6px"><input type="checkbox" class="o-noup"> Küçük görselleri büyütme</label>
      <div class="dim-hint" hidden></div>
    </div></div>
  <div class="opt-block"><div class="hd">🔄 Çıktı biçimi</div><div class="bd"><select class="o-format" style="width:100%">
    <option value="keep">Aynı biçimde bırak</option><option value="webp">WebP'ye çevir (çok daha küçük)</option>
    <option value="png">PNG'ye çevir</option><option value="jpg">JPG'ye çevir (şeffaflık kaybolur)</option></select></div></div>`;

  const q = (s) => $(s, host);
  const syncUI = () => {
    $$('.opt-block', host).forEach((b) => {
      const cb = $('input[type=checkbox].o-compress, input[type=checkbox].o-resize', b);
      const bd = $('.bd', b);
      if (cb) {
        bd.hidden = cb.classList.contains('o-compress') && !cb.checked;
        b.classList.toggle('on', cb.checked);
      }
    });
    q('.o-bgwrap').hidden = q('.o-fit').value !== 'contain';
    q('.o-poswrap').hidden = q('.o-fit').value !== 'cover';
    q('.o-color').hidden = q('.o-bg').value !== 'custom';
    updateHint();
  };
  const updateHint = () => {
    const hint = q('.dim-hint');
    const s = sample && sample();
    const w = +q('.o-w').value || 0; const h = +q('.o-h').value || 0; const p = +q('.o-p').value || 0;
    if (!q('.o-resize').checked || (!w && !h && !p)) { hint.hidden = true; return; }
    if (!s) { hint.hidden = false; hint.innerHTML = 'Çıktı ölçüsü görsele göre hesaplanır. Oran korunur, tasarım bozulmaz.'; return; }
    const fit = q('.o-fit').value;
    let ow; let oh;
    if (p) { ow = Math.round((s.w * p) / 100); oh = Math.round((s.h * p) / 100); }
    else if (w && h) {
      if (fit === 'inside') {
        let k = Math.min(w / s.w, h / s.h);
        if (q('.o-noup').checked) k = Math.min(k, 1);
        ow = Math.round(s.w * k); oh = Math.round(s.h * k);
      } else { ow = w; oh = h; }
    } else if (w) { ow = w; oh = Math.round((s.h * w) / s.w); } else { oh = h; ow = Math.round((s.w * h) / s.h); }
    hint.hidden = false;
    hint.innerHTML = `Örnek: <b>${s.w}×${s.h}</b> → <b>${ow}×${oh}</b> px`;
  };
  host.addEventListener('input', (e) => {
    if (e.target.matches('.o-w, .o-h, .o-p') && e.target.value && !q('.o-resize').checked) { q('.o-resize').checked = true; syncUI(); }
    updateHint();
  });
  host.addEventListener('change', (e) => {
    if (e.target.matches('.o-fit, .o-bg, .o-color, .o-pos, .o-noup') && !q('.o-resize').checked && (+q('.o-w').value || +q('.o-h').value || +q('.o-p').value)) q('.o-resize').checked = true;
    syncUI();
  });
  host.addEventListener('click', (e) => {
    const b = e.target.closest('.presets button');
    if (!b) return;
    q('.o-w').value = b.dataset.w; q('.o-h').value = b.dataset.h; q('.o-p').value = '';
    q('.o-resize').checked = true; syncUI();
  });
  q('.o-p').addEventListener('input', () => { if (q('.o-p').value) { q('.o-w').value = ''; q('.o-h').value = ''; } });
  syncUI();

  return {
    refresh: syncUI,
    get() {
      const bgSel = q('.o-bg').value;
      return {
        compress: q('.o-compress').checked,
        level: ($(`input[name=lv${n}]:checked`, host) || {}).value || 'balanced',
        format: q('.o-format').value,
        resize: {
          enabled: q('.o-resize').checked,
          width: +q('.o-w').value || 0, height: +q('.o-h').value || 0, percent: +q('.o-p').value || 0,
          fit: q('.o-fit').value,
          background: bgSel === 'custom' ? q('.o-color').value : bgSel,
          position: q('.o-pos').checked ? 'attention' : 'centre',
          noUpscale: q('.o-noup').checked,
        },
      };
    },
    valid() {
      const o = this.get();
      if (o.resize.enabled && !o.resize.width && !o.resize.height && !o.resize.percent) return 'Boyutlandırma için genişlik, yükseklik veya yüzde gir';
      if (!o.compress && !o.resize.enabled && o.format === 'keep') return 'En az bir işlem seç (sıkıştır / boyutlandır / biçim)';
      return '';
    },
  };
}

async function processDialog(ids, preset) {
  if (!S.me.canEdit) return;
  const isResize = preset === 'resize';
  const m = openModal(`<h3>${isResize ? '📐 Boyutlandır' : '🗜 Sıkıştır'} <span class="muted small">· ${ids.length} görsel</span></h3>
    <div class="body"><div id="optHost"></div>
      <div class="field"><label>Kayıt şekli</label><div class="radios">
        <label><input type="radio" name="pmode" value="replace" ${isResize ? '' : 'checked'}><div><b>Orijinalin üzerine yaz</b><div class="d">Geri alınamaz</div></div></label>
        <label><input type="radio" name="pmode" value="copy" ${isResize ? 'checked' : ''}><div><b>Yeni kopya olarak ekle</b><div class="d">Orijinal korunur, aynı kategoriye eklenir</div></div></label>
      </div></div></div>
    <div class="foot"><button data-x="cancel">Vazgeç</button><button class="primary" data-x="run">Başlat</button></div>`, { cls: 'wide' });
  const form = buildOptions($('#optHost', m.el), {
    preset,
    sample: () => { const i = S.imgs.find((x) => x.id === ids[0]); return i ? { w: i.width, h: i.height } : null; },
  });
  m.el.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'cancel') { m.close(); return; }
    const err = form.valid();
    if (err) { toast('⚠ ' + err, 'err'); return; }
    x.disabled = true; x.textContent = 'İşleniyor…';
    m.static = true; S.busy++;
    try {
      const mode = $('input[name=pmode]:checked', m.el).value;
      const { results } = await api('/api/images/process', { method: 'POST', body: { ids, opts: form.get(), mode } });
      const ok = results.filter((r) => !r.error);
      const before = ok.reduce((t, r) => t + r.before, 0);
      const after = ok.reduce((t, r) => t + r.after, 0);
      const errs = results.filter((r) => r.error);
      const same = ok.filter((r) => r.unchanged).length;
      toast(`✅ ${ok.length - same} görsel işlendi · ${fmtBytes(before)} → ${fmtBytes(after)} (${pct(before, after) >= 0 ? '−' : '+'}%${Math.abs(pct(before, after))})` +
        (same ? `<br>${same} görsel zaten optimize` : '') + (errs.length ? `<br>⚠ ${errs.length} hata: ${esc(errs[0].error)}` : ''), errs.length ? 'err' : 'ok', 8000);
      S.sel.clear();
    } catch (er) { toast('⚠ ' + esc(er.message), 'err', 7000); } finally { S.busy--; m.static = false; m.close(); await loadState(); }
  });
}

/* ---------- Araçlar sayfası ---------- */
const T = { files: [], results: [] };
const toolForm = buildOptions($('#toolOptions'), {
  preset: 'compress',
  sample: () => { const x = T.files.find((f) => f.w); return x ? { w: x.w, h: x.h } : null; },
});
function toolAdd(files) {
  const ok = files.filter((f) => IMG_RE.test(f.name));
  if (files.length > ok.length) toast(`${files.length - ok.length} desteklenmeyen dosya atlandı`, 'err');
  ok.forEach((f) => {
    const item = { file: f, url: URL.createObjectURL(f) };
    const probe = new Image();
    probe.onload = () => { item.w = probe.naturalWidth; item.h = probe.naturalHeight; toolForm.refresh(); };
    probe.src = item.url;
    T.files.push(item);
  });
  toolRenderQueue();
}
function toolRenderQueue() {
  $('#toolQueue').innerHTML = T.files.map((x, i) => `<div class="qitem"><img src="${x.url}" alt=""><div class="nm" title="${esc(x.file.name)}">${esc(x.file.name)}</div>
    <span class="muted small">${fmtBytes(x.file.size)}</span><button class="mini" data-rm="${i}" title="Kaldır">✕</button></div>`).join('') +
    (T.files.length ? `<div><button data-rm="all" class="mini" style="padding:4px 10px;font-size:12px">Listeyi temizle</button></div>` : '');
  toolForm.refresh();
  $('#btnToolRun').disabled = !T.files.length;
  $('#btnToolRun').textContent = T.files.length ? `${T.files.length} görseli işle` : 'İşlemi başlat';
}
$('#toolQueue').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  if (b.dataset.rm === 'all') T.files = []; else T.files.splice(+b.dataset.rm, 1);
  toolRenderQueue();
});
const dz = $('#toolDrop');
dz.onclick = () => $('#toolFile').click();
$('#toolFile').onchange = (e) => { toolAdd([...e.target.files]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('dragover')));
dz.addEventListener('drop', async (e) => {
  e.preventDefault(); e.stopPropagation();
  const entries = await filesFromDrop(e.dataTransfer);
  toolAdd(entries.map((x) => x.file));
});
$('#btnToolRun').onclick = async () => {
  const err = toolForm.valid();
  if (err) { toast('⚠ ' + err, 'err'); return; }
  const opts = toolForm.get();
  const files = T.files.slice();
  const btn = $('#btnToolRun'); btn.disabled = true;
  const bar = $('#toolProgress'); bar.hidden = false; $('div', bar).style.width = '0';
  S.busy++;
  T.results = [];
  try {
    for (let i = 0; i < files.length; i += 3) {
      const chunk = files.slice(i, i + 3);
      const form = new FormData();
      form.append('opts', JSON.stringify(opts));
      form.append('names', JSON.stringify(chunk.map((x) => x.file.name)));
      chunk.forEach((x) => form.append('files', x.file, x.file.name));
      const { results } = await api('/api/tools/process', { method: 'POST', form });
      results.forEach((r, k) => { r.srcUrl = chunk[k].url; });
      T.results.push(...results);
      $('div', bar).style.width = Math.min(100, ((i + chunk.length) / files.length) * 100) + '%';
      toolRenderResults();
    }
    T.files = []; toolRenderQueue();
  } catch (e) { toast('⚠ ' + esc(e.message), 'err', 7000); } finally {
    S.busy--; btn.disabled = !T.files.length; setTimeout(() => { bar.hidden = true; }, 600);
  }
};
function toolRenderResults() {
  const ok = T.results.filter((r) => !r.error);
  const before = ok.reduce((t, r) => t + r.before, 0);
  const after = ok.reduce((t, r) => t + r.after, 0);
  $('#toolResults').innerHTML = !T.results.length ? '' : `
    <div class="summary"><div><div class="muted small">Toplam</div><b>${fmtBytes(before)} → ${fmtBytes(after)}</b></div>
      <span class="badge ${after < before ? 'good' : 'neutral'}">${after <= before ? '−' : '+'}%${Math.abs(pct(before, after))}</span>
      <div class="spacer"></div>
      <button data-t="zip" class="primary">⬇ Tümünü ZIP indir</button>
      ${S.me.canEdit ? '<button data-t="save">📥 Kataloğa kaydet</button>' : ''}
      <button data-t="clear">Temizle</button></div>
    <table class="res-table"><thead><tr><th></th><th>Dosya</th><th>Önce</th><th>Sonra</th><th>Kazanç</th><th>Ölçü</th><th></th></tr></thead><tbody>
    ${T.results.map((r) => r.error
      ? `<tr><td></td><td>${esc(r.name)}</td><td colspan="4"><span class="badge bad">Hata: ${esc(r.error)}</span></td><td></td></tr>`
      : `<tr><td><img src="/api/tools/file/${r.id}" alt=""></td><td>${esc(r.name)}</td><td>${fmtBytes(r.before)}</td><td><b>${fmtBytes(r.after)}</b></td>
         <td>${r.unchanged ? '<span class="badge neutral">Zaten optimize</span>' : `<span class="badge ${r.after < r.before ? 'good' : 'bad'}">${r.after <= r.before ? '−' : '+'}%${Math.abs(pct(r.before, r.after))}</span>`}</td>
         <td>${r.srcWidth && (r.srcWidth !== r.width || r.srcHeight !== r.height) ? `<span class="muted">${r.srcWidth}×${r.srcHeight}</span> → <b>${r.width}×${r.height}</b>` : `${r.width}×${r.height}`}</td>
         <td><a class="dl-link" href="/api/tools/file/${r.id}?download=1" download="${esc(r.name)}"><button class="mini" style="font-size:13px;padding:3px 10px" title="İndir">⬇</button></a></td></tr>`).join('')}
    </tbody></table>`;
}
$('#toolResults').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  const ids = T.results.filter((r) => !r.error).map((r) => r.id);
  if (b.dataset.t === 'zip') location.href = '/api/tools/zip?ids=' + ids.join(',');
  if (b.dataset.t === 'clear') { T.results = []; toolRenderResults(); }
  if (b.dataset.t === 'save' && S.me.canEdit) {
    const p = await pickCategory({ title: `${ids.length} görseli kataloğa kaydet`, selected: S.cur, ok: 'Kaydet' });
    if (!p) return;
    const r = await act(() => api('/api/tools/save', { method: 'POST', body: { ids, categoryId: p.id } }));
    if (r) { toast(`✅ ${r.added} görsel “${esc(catLabel(p.id))}” içine kaydedildi`, 'ok'); await loadState(); }
  }
});

/* ====================================================================
   Admin Paneli
   ==================================================================== */
async function loadAdminOverview() {
  if (!S.me.canAdmin) return;
  const d = await act(() => api('/api/admin/overview'));
  if (d) { S.adminData = d; renderAdmin(); }
}

$('#btnAdminRefresh').onclick = loadAdminOverview;
$('#adminSubtabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-atab]');
  if (!b) return;
  S.adminTab = b.dataset.atab;
  $$('#adminSubtabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderAdmin();
});

function renderAdmin() {
  if (S.view !== 'admin' || !S.me.canAdmin) return;
  const d = S.adminData;
  if (!d) { $('#adminBody').innerHTML = '<div class="muted">Yükleniyor…</div>'; return; }

  const isOwner = S.me.isOwner;
  $('#adminStats').innerHTML = `
    <div class="stat-card"><div class="lbl">Senin Yetkin</div><div class="val">${renderRoleBadge(S.me.role)}</div><div class="sub">IP: <span class="code-ip">${esc(d.myIp)}</span></div></div>
    <div class="stat-card"><div class="lbl">Çevrimiçi Kişiler</div><div class="val">${d.onlineSessions.length} aktif</div><div class="sub">${d.onlineSessions.filter((s) => s.isAnon).length} anonim · ${d.onlineSessions.filter((s) => !s.isAnon).length} profil</div></div>
    <div class="stat-card"><div class="lbl">Profiller &amp; IP İzinleri</div><div class="val">${d.users.length} profil</div><div class="sub">${d.ipRules.length} yetkili IP kuralı</div></div>
    <div class="stat-card"><div class="lbl">Güvenlik &amp; Kayıtlar</div><div class="val">${d.logs.length} işlem</div><div class="sub">${d.bans.length} aktif engel</div></div>
  `;

  if (S.adminTab === 'users') {
    const roleSelect = (curRole, targetIsOwner, targetIsAdmin) => {
      if (targetIsOwner) return renderRoleBadge('owner');
      if (targetIsAdmin && !isOwner) return renderRoleBadge('admin');
      return `<select class="adm-role-sel" style="padding:4px 8px;font-size:12px">
        <option value="viewer" ${curRole === 'viewer' ? 'selected' : ''}>👁️ İzleyici (Sadece Görür)</option>
        <option value="editor" ${curRole === 'editor' ? 'selected' : ''}>✏️ Editör (Düzenleme Yetkisi)</option>
        ${isOwner ? `<option value="admin" ${curRole === 'admin' ? 'selected' : ''}>🛡️ Admin (Admin Paneli)</option>` : ''}
      </select>`;
    };

    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3><span>🟢 Şu An Sitede Olan Kişiler (${d.onlineSessions.length})</span><span class="muted small">Buradan anlık olarak kişilere/IP'lere yetki verebilir veya siteden uzaklaştırabilirsiniz</span></h3>
        <table class="res-table">
          <thead><tr><th>Kişi</th><th>IP Adresi</th><th>Mevcut Yetki</th><th>Hızlı İşlem</th></tr></thead>
          <tbody>
            ${d.onlineSessions.map((s) => `
              <tr>
                <td><div class="inline">${renderAvatar(s.isAnon ? null : s)}<div><b>${esc(s.name)}</b>${s.isMe ? ' <span class="badge good">Sen</span>' : ''}${s.username ? `<div class="muted small">@${esc(s.username)}</div>` : ''}</div></div></td>
                <td><span class="code-ip">${esc(s.ip)}</span></td>
                <td>${renderRoleBadge(s.role)}</td>
                <td>
                  ${s.role === 'owner' ? '<span class="muted small">En Üst Yetki</span>' : `
                    <div class="row-btns">
                      <button class="mini" style="font-size:12px;padding:3px 9px" data-act="grant-sess" data-sid="${s.sidHash}" data-role="editor">✏️ Editör Yap</button>
                      ${isOwner ? `<button class="mini" style="font-size:12px;padding:3px 9px" data-act="grant-sess" data-sid="${s.sidHash}" data-role="admin">🛡️ Admin Yap</button>` : ''}
                      ${s.role !== 'viewer' ? `<button class="mini" style="font-size:12px;padding:3px 9px" data-act="grant-sess" data-sid="${s.sidHash}" data-role="viewer">Yetkiyi Al</button>` : ''}
                      ${!s.isMe ? `<button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="ban-ip" data-ip="${esc(s.ip)}" data-name="${esc(s.name)}">🚫 Uzaklaştır</button>` : ''}
                    </div>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="admin-card">
        <h3><span>👥 Tüm Profiller &amp; Yetkililer (${d.users.length})</span></h3>
        <div class="admin-form">
          <div class="f"><label>Görünen Ad</label><input type="text" id="nuName" placeholder="ör. Ahmet"></div>
          <div class="f"><label>Kullanıcı Adı</label><input type="text" id="nuUser" placeholder="ör. ahmet"></div>
          <div class="f"><label>Şifre</label><input type="password" id="nuPass" placeholder="Giriş şifresi"></div>
          <div class="f"><label>Yetki Seviyesi</label><select id="nuRole">
            <option value="editor">✏️ Editör (Düzenleme Yetkisi)</option>
            ${isOwner ? '<option value="admin">🛡️ Admin (Admin Paneli)</option>' : ''}
            <option value="viewer">👁️ İzleyici</option>
          </select></div>
          <button class="primary" data-act="create-user">＋ Yeni Yetkili Profil Ekle</button>
        </div>
        <table class="res-table">
          <thead><tr><th>Profil</th><th>Kullanıcı Adı</th><th>Son IP</th><th>Son Görülme</th><th>Profil Yetkisi</th><th>İşlem</th></tr></thead>
          <tbody>
            ${d.users.map((u) => `
              <tr data-uid="${u.id}">
                <td><div class="inline">${renderAvatar(u)}<div><b>${esc(u.name)}</b> ${u.online ? '<span class="badge good">Çevrimiçi</span>' : ''} ${u.banned ? '<span class="badge bad">Engelli</span>' : ''}</div></div></td>
                <td>@${esc(u.username)}</td>
                <td>${u.lastIp ? `<span class="code-ip">${esc(u.lastIp)}</span>` : '—'}</td>
                <td class="muted small">${fmtDate(u.lastSeen)}</td>
                <td>${roleSelect(u.role, u.role === 'owner', u.role === 'admin')}</td>
                <td>
                  ${u.role === 'owner' ? '<span class="muted small">Kurucu Hesap</span>' : (u.role === 'admin' && !isOwner ? '<span class="muted small">Admin</span>' : `
                    <div class="row-btns">
                      <button class="mini" style="font-size:12px;padding:3px 9px" data-act="pw-user" data-uid="${u.id}" data-name="${esc(u.name)}">🔑 Şifre</button>
                      <button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="ban-user" data-uid="${u.id}" data-ip="${esc(u.lastIp)}" data-name="${esc(u.name)}">🚫 Engelle</button>
                      <button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="del-user" data-uid="${u.id}" data-name="${esc(u.name)}">🗑</button>
                    </div>`)}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } else if (S.adminTab === 'ips') {
    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3><span>🌐 IP Adresine Göre Yetkilendirme</span><span class="muted small">Buraya eklenen IP adreslerinden siteye giren kişiler şifre girmese bile seçilen yetkiye sahip olur</span></h3>
        <div class="admin-form">
          <div class="f"><label>IP Adresi</label><input type="text" id="nipAddr" placeholder="ör. 178.220.247.115"></div>
          <div class="f"><label>Açıklama / Kişi Adı</label><input type="text" id="nipLabel" placeholder="ör. Ofis / Mehmet Ev"></div>
          <div class="f"><label>Verilecek Yetki</label><select id="nipRole">
            <option value="editor">✏️ Editör (Düzenleme Yetkisi)</option>
            ${isOwner ? '<option value="admin">🛡️ Admin (Admin Paneli)</option>' : ''}
          </select></div>
          <button class="primary" data-act="add-ip">＋ IP Yetkisi Ekle</button>
        </div>
        <table class="res-table">
          <thead><tr><th>IP Adresi</th><th>Açıklama</th><th>Yetki</th><th>Ekleyen</th><th>Tarih</th><th></th></tr></thead>
          <tbody>
            ${d.ipRules.map((r) => `
              <tr>
                <td><span class="code-ip">${esc(r.ip)}</span></td>
                <td><b>${esc(r.label)}</b></td>
                <td>${renderRoleBadge(r.role)}</td>
                <td class="muted small">${esc(r.createdBy || '—')}</td>
                <td class="muted small">${fmtDate(r.createdAt)}</td>
                <td>${(r.role === 'owner' || r.role === 'admin') && !isOwner ? '' : `<button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="del-ip" data-id="${r.id}">Kaldır</button>`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } else if (S.adminTab === 'logs') {
    const q = S.logFilter.trim().toLowerCase();
    const list = q
      ? d.logs.filter((l) => (l.actorName || '').toLowerCase().includes(q) || (l.action || '').toLowerCase().includes(q) || (l.detail || '').toLowerCase().includes(q) || (l.ip || '').includes(q))
      : d.logs;

    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3>
          <span>📜 Tüm İşlem Geçmişi (${list.length})</span>
          <input type="search" id="logSearch" value="${esc(S.logFilter)}" placeholder="Kişi, işlem, dosya adı veya IP ara…" style="width:280px">
        </h3>
        <table class="res-table">
          <thead><tr><th>Tarih / Saat</th><th>Kişi</th><th>IP Adresi</th><th>İşlem</th><th>Detay</th></tr></thead>
          <tbody>
            ${list.map((l) => `
              <tr>
                <td class="muted small" style="white-space:nowrap">${fmtDate(l.ts)}</td>
                <td><div class="inline"><b>${esc(l.actorName)}</b> ${renderRoleBadge(l.actorRole)}</div></td>
                <td><span class="code-ip">${esc(l.ip || '—')}</span></td>
                <td><span class="badge neutral">${esc(l.action)}</span></td>
                <td>${esc(l.detail)}</td>
              </tr>`).join('') || '<tr><td colspan="5" class="muted">Henüz işlem kaydı yok.</td></tr>'}
          </tbody>
        </table>
      </div>`;
    const ls = $('#logSearch');
    if (ls) {
      ls.oninput = (e) => {
        S.logFilter = e.target.value;
        renderAdmin();
        const input = $('#logSearch');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      };
    }
  } else if (S.adminTab === 'bans') {
    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3><span>🚫 Siteden Uzaklaştırılan Kişiler &amp; IP'ler (${d.bans.length})</span><span class="muted small">Engellenen kişi veya IP siteyi görüntüleyemez ve hiçbir işlem yapamaz</span></h3>
        <div class="admin-form">
          <div class="f"><label>Engellenecek IP Adresi</label><input type="text" id="banIpInput" placeholder="ör. 185.x.x.x"></div>
          <div class="f"><label>Sebep / Not</label><input type="text" id="banReasonInput" placeholder="ör. İzinsiz giriş denemesi"></div>
          <button class="danger" data-act="manual-ban">🚫 IP'yi Engelle</button>
        </div>
        <table class="res-table">
          <thead><tr><th>Tür</th><th>Hedef</th><th>Sebep</th><th>Engelleyen</th><th>Tarih</th><th></th></tr></thead>
          <tbody>
            ${d.bans.map((b) => `
              <tr>
                <td><span class="badge bad">${b.type === 'ip' ? 'IP Engeli' : 'Kullanıcı Engeli'}</span></td>
                <td><b>${esc(b.targetName || b.target)}</b></td>
                <td>${esc(b.reason)}</td>
                <td class="muted small">${esc(b.createdBy)}</td>
                <td class="muted small">${fmtDate(b.createdAt)}</td>
                <td><button class="mini" style="font-size:12px;padding:3px 10px" data-act="unban" data-id="${b.id}">Engeli Kaldır</button></td>
              </tr>`).join('') || '<tr><td colspan="6" class="muted">Engellenmiş kişi veya IP bulunmuyor.</td></tr>'}
          </tbody>
        </table>
      </div>`;
  }
}

$('#adminBody').addEventListener('change', async (e) => {
  if (e.target.classList.contains('adm-role-sel')) {
    const tr = e.target.closest('tr[data-uid]');
    if (!tr) return;
    const role = e.target.value;
    if (await act(() => api('/api/admin/users/' + tr.dataset.uid, { method: 'PATCH', body: { role } }), 'Yetki güncellendi')) {
      await loadAdminOverview();
    }
  }
});

$('#adminBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;

  if (a === 'create-user') {
    const name = $('#nuName').value.trim();
    const username = $('#nuUser').value.trim();
    const password = $('#nuPass').value;
    const role = $('#nuRole').value;
    if (await act(() => api('/api/admin/users', { method: 'POST', body: { name, username, password, role } }), 'Yeni yetkili profil oluşturuldu')) {
      await loadAdminOverview();
    }
  }
  if (a === 'pw-user') {
    const pw = await askText({ title: `“${b.dataset.name}” için yeni şifre`, label: 'Yeni şifre', ok: 'Güncelle' });
    if (!pw) return;
    if (await act(() => api('/api/admin/users/' + b.dataset.uid, { method: 'PATCH', body: { password: pw } }), 'Şifre güncellendi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'del-user') {
    if (!(await confirmBox({ title: 'Profili sil', message: `<b>${esc(b.dataset.name)}</b> profili silinecek.`, ok: 'Sil', danger: true }))) return;
    if (await act(() => api('/api/admin/users/' + b.dataset.uid, { method: 'DELETE' }), 'Profil silindi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'ban-user') {
    const reason = await askText({ title: `🚫 “${b.dataset.name}” kullanıcısını uzaklaştır`, label: 'Engelleme sebebi', value: 'Yönetici tarafından uzaklaştırıldı', ok: 'Uzaklaştır' });
    if (!reason) return;
    if (await act(() => api('/api/admin/bans', { method: 'POST', body: { userId: b.dataset.uid, ip: b.dataset.ip || null, reason } }), 'Kullanıcı siteden uzaklaştırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'ban-ip') {
    const reason = await askText({ title: `🚫 ${b.dataset.name} (${b.dataset.ip}) uzaklaştır`, label: 'Engelleme sebebi', value: 'Yönetici tarafından uzaklaştırıldı', ok: 'Uzaklaştır' });
    if (!reason) return;
    if (await act(() => api('/api/admin/bans', { method: 'POST', body: { ip: b.dataset.ip, targetName: b.dataset.name, reason } }), 'IP adresi siteden uzaklaştırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'grant-sess') {
    if (await act(() => api('/api/admin/sessions/grant', { method: 'POST', body: { sidHash: b.dataset.sid, role: b.dataset.role, mode: 'ip' } }), 'Yetki güncellendi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'add-ip') {
    const ip = $('#nipAddr').value.trim();
    const label = $('#nipLabel').value.trim();
    const role = $('#nipRole').value;
    if (await act(() => api('/api/admin/ip-rules', { method: 'POST', body: { ip, label, role } }), 'IP yetkisi eklendi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'del-ip') {
    if (await act(() => api('/api/admin/ip-rules/' + b.dataset.id, { method: 'DELETE' }), 'IP yetkisi kaldırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'manual-ban') {
    const ip = $('#banIpInput').value.trim();
    const reason = $('#banReasonInput').value.trim() || 'Yönetici tarafından engellendi';
    if (await act(() => api('/api/admin/bans', { method: 'POST', body: { ip, reason } }), 'IP engellendi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'unban') {
    if (await act(() => api('/api/admin/bans/' + b.dataset.id, { method: 'DELETE' }), 'Engel kaldırıldı')) {
      await loadAdminOverview();
    }
  }
});

/* ---------- Başlat ---------- */
(async function init() {
  await loadState();
  route();
})();
