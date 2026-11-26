'use strict';
/* ====================================================================
   Betorspin Katalog – İstemci (Profil & Hesap Tabanlı Güvenlik Sistemi)
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
  cats: [], imgs: [], templates: [], rev: 0,
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

function genPassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map((x) => chars[x % chars.length]).join('');
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

/* ---------- API (CSRF Korumalı) ---------- */
async function api(url, o = {}) {
  const headers = { 'X-Requested-With': 'BetorspinKatalog' };
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
    if (st.templates) S.templates = st.templates;
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
    const prevAnon = S.me.isAnon;
    if (r.me) S.me = r.me;
    if (r.presence) { S.presence = r.presence; renderTopbar(); }
    if (r.rev !== S.rev && !S.busy) await loadState();
    else if (prevRole !== S.me.role || prevAnon !== S.me.isAnon) render();
  } catch { $('#syncDot').classList.add('off'); }
}, 4000);

/* ---------- Yönlendirme ---------- */
function route() {
  const h = location.hash || '#/';
  if (S.keepQuery) S.keepQuery = false; else { S.query = ''; $('#search').value = ''; }
  if (h.startsWith('#/tools')) S.view = 'tools';
  else if (h.startsWith('#/domain')) { S.view = 'domain'; initDomainTool(); }
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

  if (me.isAnon) {
    $('#userAvatar').outerHTML = '<span id="userAvatar" class="av">🔑</span>';
    $('#userName').textContent = 'Giriş Yap';
    const rb = $('#userRoleBadge');
    rb.className = 'role-badge viewer';
    rb.textContent = p.myAnonLabel || 'İzleyici';
  } else {
    $('#userAvatar').outerHTML = renderAvatar(me).replace('class="av', 'id="userAvatar" class="av');
    $('#userName').textContent = me.name;
    const rb = $('#userRoleBadge');
    rb.className = `role-badge ${me.role || 'viewer'}`;
    rb.textContent = `${ROLE_ICON[me.role] || '👁️'} ${ROLE_NAME[me.role] || 'İzleyici'}`;
  }

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
  $('#viewDomain').hidden = S.view !== 'domain';
  $('#viewTools').hidden = S.view !== 'tools';
  $('#viewAdmin').hidden = S.view !== 'admin';
  $('#tabCatalog').classList.toggle('active', S.view === 'catalog');
  $('#tabDomain').classList.toggle('active', S.view === 'domain');
  $('#tabTools').classList.toggle('active', S.view === 'tools');
  $('#tabAdmin').classList.toggle('active', S.view === 'admin');
  $('#tabAdmin').hidden = !canAdmin;

  $$('.edit-only').forEach((el) => { el.hidden = !canEdit; });
  $('#readonlyNotice').hidden = canEdit;

  renderTopbar();
  renderTree();
  if (S.view === 'catalog') renderCatalog();
  if (S.view === 'domain') renderDomainTplBar();
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
      <div class="card-actions">
        <button class="ca-btn" type="button" data-qact="copy" title="Panoya kopyala">📋</button>
        <a class="dl-link" href="/api/images/${i.id}/download" download="${esc(i.name)}" data-qact="dl" title="İndir"><button class="ca-btn" type="button">⬇</button></a>
      </div>
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

/* ---------- Giriş & Profil Modalı ---------- */
function openProfileModal() {
  const me = S.me;
  const m = openModal('', { cls: 'wide' });
  let mode = me.isAnon ? 'login' : 'profile';

  const draw = () => {
    if (mode === 'login') {
      m.set(`<h3>🔑 Hesaba Giriş Yap</h3>
        <div class="body">
          <p class="muted small">Yöneticinizden aldığınız kullanıcı adı ve şifre ile giriş yapın. Girişiniz bu tarayıcıda kalıcı olarak hatırlanır.</p>
          <div class="field"><label>Kullanıcı adı</label><input type="text" id="lgUser" autocomplete="username"></div>
          <div class="field"><label>Şifre</label><input type="password" id="lgPass" placeholder="••••••••" autocomplete="current-password"></div>
        </div>
        <div class="foot">
          ${!me.isAnon ? '<button data-p="back">← Profilime Dön</button>' : ''}
          <button data-p="close">Vazgeç</button>
          <button class="primary" data-p="dologin">Giriş Yap</button>
        </div>`);
      const uIn = $('#lgUser', m.el);
      if (uIn) uIn.focus();
      m.el.onkeydown = (e) => { if (e.key === 'Enter') $('[data-p="dologin"]', m.el)?.click(); };
      return;
    }

    m.el.onkeydown = null;
    m.set(`<h3>👤 Profilim &amp; Hesap Bilgilerim</h3>
      <div class="body">
        <div class="profile-box">
          ${renderAvatar(me, 'lg')}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <b style="font-size:16px">${esc(me.name)}</b>
              ${renderRoleBadge(me.role)}
            </div>
            <div class="muted small" style="margin-top:2px">
              @${esc(me.username)} · Kalıcı oturum aktif
            </div>
            <div class="row-btns" style="margin-top:8px">
              <button data-p="pickav" class="mini" style="font-size:12px;padding:3px 10px">📷 Fotoğraf Yükle / Değiştir</button>
              ${me.avatar ? `<button data-p="delav" class="mini danger" style="font-size:12px;padding:3px 10px">Fotoğrafı Kaldır</button>` : ''}
            </div>
          </div>
        </div>
        <div class="field"><label>Görünen Adın (ekip listesinde ve yüklemelerde görünür)</label>
          <input type="text" id="prName" value="${esc(me.name || '')}"></div>
        <div class="field"><label>Kullanıcı Adın (giriş yaparken kullandığın k.adı)</label>
          <input type="text" id="prUser" value="${esc(me.username || '')}"></div>
        <div style="border-top:1px solid var(--line);margin:14px 0 10px;padding-top:10px">
          <div class="muted small" style="margin-bottom:6px">🔒 Şifreni değiştirmek istiyorsan aşağıyı doldur (istemiyorsan boş bırak):</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field" style="margin:0"><label>Mevcut Şifren</label><input type="password" id="prCurPass" placeholder="Mevcut şifren"></div>
            <div class="field" style="margin:0"><label>Yeni Şifren</label><input type="password" id="prNewPass" placeholder="Yeni şifre (en az 4 karakter)"></div>
          </div>
        </div>
      </div>
      <div class="foot">
        <button data-p="loginmode">🔑 Farklı Hesaba Geç</button>
        <button data-p="logout" class="danger">Çıkış Yap</button>
        <div class="spacer"></div>
        <button data-p="close">Kapat</button>
        <button class="primary" data-p="save">Bilgilerimi Güncelle</button>
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
      const currentPassword = $('#prCurPass', m.el).value;
      const newPassword = $('#prNewPass', m.el).value;
      const r = await act(() => api('/api/profile', { method: 'PATCH', body: { name, username, currentPassword, newPassword } }), 'Profil bilgilerin güncellendi');
      if (r) { S.me = r.me; m.close(); await loadState(); }
    }
    if (actName === 'dologin') {
      const username = $('#lgUser', m.el).value.trim();
      const password = $('#lgPass', m.el).value;
      const r = await act(() => api('/api/auth/login', { method: 'POST', body: { username, password } }), 'Giriş başarılı, hoş geldin!');
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
  if (e.target.closest('[data-qact="copy"]')) {
    const img = S.imgs.find((x) => x.id === id);
    if (img) copyImage(img);
    return;
  }
  if (e.target.closest('[data-qact="dl"]')) return;
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
$('#readonlyNotice').onclick = openProfileModal;
$('#readonlyNotice').style.cursor = 'pointer';

/* ---------- Sürükle-bırak ---------- */
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
  <div class="opt-block"><label class="hd"><input type="checkbox" class="o-compress" ${preset !== 'resize' ? 'checked' : ''}> 🗜 Sıkıştır</label>
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
   Admin & Güvenlik Paneli
   ==================================================================== */
function showCredentialsCard({ name, username, password, roleLabel, title = '✅ Profil Oluşturuldu' }) {
  const text = `Betorspin Katalog Giriş Bilgileri\nSite: ${location.origin}\nGörünen Ad: ${name}\nKullanıcı Adı: ${username}\nŞifre: ${password}\nYetki: ${roleLabel}\n(Giriş yaptıktan sonra sağ üstteki profilinden adını, şifreni ve profil fotoğrafını değiştirebilirsin.)`;
  const m = openModal(`<h3>${esc(title)}</h3>
    <div class="body">
      <p class="muted small">Bu bilgileri kopyalayıp ekip arkadaşına iletebilirsin. Bu bilgilerle kalıcı giriş yapabilir ve isterse kendi profilinden değiştirebilir.</p>
      <pre style="background:#08080a;border:1px solid var(--accent-line);padding:12px 14px;border-radius:12px;white-space:pre-wrap;font-size:13px;line-height:1.6">${esc(text)}</pre>
    </div>
    <div class="foot">
      <button data-c="close">Kapat</button>
      <button class="primary" data-c="copy">📋 Bilgileri Kopyala</button>
    </div>`);
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'close') m.close();
    if (b.dataset.c === 'copy') {
      await navigator.clipboard.writeText(text);
      toast('📋 Giriş bilgileri panoya kopyalandı', 'ok');
    }
  });
}

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
  const secLogs = d.logs.filter((l) => l.severity === 'security');
  const trashList = d.trash || [];
  const trashTabBtn = $('#adminSubtabs button[data-atab="trash"]');
  if (trashTabBtn) trashTabBtn.textContent = `🗑️ Çöp Kutusu (${trashList.length})`;
  $('#adminStats').innerHTML = `
    <div class="stat-card"><div class="lbl">Senin Hesabın</div><div class="val">${renderRoleBadge(S.me.role)}</div><div class="sub">@${esc(S.me.username)} · Kalıcı Oturum</div></div>
    <div class="stat-card"><div class="lbl">Çevrimiçi Kişiler</div><div class="val">${d.onlineSessions.length} aktif</div><div class="sub">${d.onlineSessions.filter((s) => s.isAnon).length} anonim · ${d.onlineSessions.filter((s) => !s.isAnon).length} giriş yapmış</div></div>
    <div class="stat-card"><div class="lbl">Profiller &amp; Çöp Kutusu</div><div class="val">${d.users.length} profil</div><div class="sub">${trashList.length} silinen görsel çöp kutusunda</div></div>
    <div class="stat-card"><div class="lbl">Güvenlik Duvarı</div><div class="val">${secLogs.length} uyarı</div><div class="sub">${d.bans.length} aktif engel · ${d.logs.length} toplam kayıt</div></div>
  `;

  if (S.adminTab === 'trash') {
    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3>
          <span>🗑️ Çöp Kutusu – Son Silinen Görseller (${trashList.length})</span>
          <div class="row-btns">
            ${trashList.length ? `<button class="primary mini" style="font-size:12px;padding:5px 12px" data-act="restore-all-trash">↩️ Tümünü Geri Yükle</button>
            <button class="danger mini" style="font-size:12px;padding:5px 12px" data-act="empty-trash">🧹 Çöp Kutusunu Boşalt</button>` : ''}
          </div>
        </h3>
        <p class="muted small" style="margin-top:0">Silinen görseller 30 gün boyunca burada saklanır. İstediğiniz zaman eski kategorisine geri yükleyebilir veya kalıcı olarak silebilirsiniz.</p>
        <table class="res-table">
          <thead><tr><th>Önizleme</th><th>Dosya Adı</th><th>Önceki Kategori</th><th>Ölçü / Boyut</th><th>Silen Kişi</th><th>Silinme Tarihi</th><th>İşlem</th></tr></thead>
          <tbody>
            ${trashList.map((t) => `
              <tr>
                <td><img src="/thumbs/${esc(t.id)}.webp" alt=""></td>
                <td><b>${esc(t.name)}</b></td>
                <td><span class="badge neutral">📁 ${esc(t.origCategoryName || 'Ana dizin')}</span></td>
                <td class="muted small">${t.width}×${t.height} · ${fmtBytes(t.size)}</td>
                <td><b>${esc(t.deletedBy || '—')}</b></td>
                <td class="muted small">${fmtDate(t.deletedAt)}</td>
                <td>
                  <div class="row-btns">
                    <button class="mini primary" style="font-size:12px;padding:3px 10px" data-act="restore-trash" data-id="${t.id}">↩️ Geri Yükle</button>
                    <button class="mini danger" style="font-size:12px;padding:3px 10px" data-act="del-trash" data-id="${t.id}" data-name="${esc(t.name)}">🔥 Kalıcı Sil</button>
                  </div>
                </td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted">Çöp kutusu boş.</td></tr>'}
          </tbody>
        </table>
      </div>`;
    return;
  }

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
        <h3><span>➕ Yeni Ekip Profili Oluştur (Kullanıcı Adı &amp; Şifre Dağıtımı)</span><span class="muted small">Oluşturduğunuz k.adı ve şifre ile ekip arkadaşınız kalıcı giriş yapabilir</span></h3>
        <div class="admin-form">
          <div class="f"><label>Görünen Ad</label><input type="text" id="nuName" placeholder="ör. Ahmet"></div>
          <div class="f"><label>Kullanıcı Adı (Giriş için)</label><input type="text" id="nuUser" placeholder="ör. ahmet"></div>
          <div class="f"><label>Başlangıç Şifresi</label>
            <div class="inline"><input type="text" id="nuPass" value="${esc(genPassword(8))}" style="flex:1"><button type="button" class="mini" data-act="gen-pw" title="Rastgele şifre üret">🎲</button></div>
          </div>
          <div class="f"><label>Yetki Seviyesi</label><select id="nuRole">
            <option value="editor">✏️ Editör (Düzenleme Yetkisi)</option>
            ${isOwner ? '<option value="admin">🛡️ Admin (Admin Paneli &amp; Profil Açma)</option>' : ''}
            <option value="viewer">👁️ İzleyici (Sadece Görüntüleme)</option>
          </select></div>
          <button class="primary" data-act="create-user">＋ Profili Oluştur &amp; Bilgileri Al</button>
        </div>

        <h3 style="margin-top:18px"><span>👥 Kayıtlı Tüm Profiller (${d.users.length})</span></h3>
        <table class="res-table">
          <thead><tr><th>Profil</th><th>Kullanıcı Adı</th><th>Oluşturan</th><th>Son Görülme</th><th>Yetki Seviyesi</th><th>İşlemler</th></tr></thead>
          <tbody>
            ${d.users.map((u) => `
              <tr data-uid="${u.id}">
                <td><div class="inline">${renderAvatar(u)}<div><b>${esc(u.name)}</b> ${u.online ? '<span class="badge good">Çevrimiçi</span>' : ''} ${u.banned ? '<span class="badge bad">Engelli</span>' : ''}</div></div></td>
                <td><span class="code-ip">@${esc(u.username)}</span></td>
                <td class="muted small">${esc(u.createdBy || 'Sistem')}</td>
                <td class="muted small">${fmtDate(u.lastSeen)}</td>
                <td>${roleSelect(u.role, u.role === 'owner', u.role === 'admin')}</td>
                <td>
                  ${u.role === 'owner' ? '<span class="muted small">Kurucu Hesap</span>' : (u.role === 'admin' && !isOwner ? '<span class="muted small">Admin</span>' : `
                    <div class="row-btns">
                      <button class="mini" style="font-size:12px;padding:3px 9px" data-act="pw-user" data-uid="${u.id}" data-uname="${esc(u.username)}" data-name="${esc(u.name)}" data-role="${esc(u.roleLabel)}">🔑 Şifre Sıfırla</button>
                      <button class="mini" style="font-size:12px;padding:3px 9px" data-act="revoke-user" data-uid="${u.id}" data-name="${esc(u.name)}" title="Açık tüm cihazlarından çıkış yaptır">🔒 Oturumu Kapat</button>
                      <button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="ban-user" data-uid="${u.id}" data-name="${esc(u.name)}">🚫 Engelle</button>
                      <button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="del-user" data-uid="${u.id}" data-name="${esc(u.name)}">🗑</button>
                    </div>`)}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="admin-card">
        <h3><span>🟢 Şu An Sitede Olan Kişiler (${d.onlineSessions.length})</span><span class="muted small">Ortak IP kullanılsa bile her tarayıcı/cihaz ayrı oturum olarak izole edilir</span></h3>
        <table class="res-table">
          <thead><tr><th>Kişi / Oturum</th><th>Durum</th><th>Yetki</th><th>İşlem</th></tr></thead>
          <tbody>
            ${d.onlineSessions.map((s) => `
              <tr>
                <td><div class="inline">${renderAvatar(s.isAnon ? null : s)}<div><b>${esc(s.name)}</b>${s.isMe ? ' <span class="badge good">Sen</span>' : ''}${s.username ? `<div class="muted small">@${esc(s.username)}</div>` : ''}</div></div></td>
                <td class="muted small">${s.isAnon ? 'Giriş yapmamış ziyaretçi' : 'Giriş yapmış profil'}</td>
                <td>${renderRoleBadge(s.role)}</td>
                <td>
                  ${s.isMe || s.role === 'owner' ? '<span class="muted small">—</span>' : `
                    <button class="mini danger" style="font-size:12px;padding:3px 9px" data-act="ban-dev" data-dev="${esc(s.devId)}" data-uid="${esc(s.userId || '')}" data-name="${esc(s.name)}">🚫 Bu Kişiyi / Cihazı Uzaklaştır</button>
                  `}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } else if (S.adminTab === 'logs') {
    const q = S.logFilter.trim().toLowerCase();
    const list = q
      ? d.logs.filter((l) => (l.actorName || '').toLowerCase().includes(q) || (l.action || '').toLowerCase().includes(q) || (l.detail || '').toLowerCase().includes(q))
      : d.logs;

    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3>
          <span>📜 Tüm İşlem Geçmişi (${list.length})</span>
          <input type="search" id="logSearch" value="${esc(S.logFilter)}" placeholder="Kişi, işlem veya dosya adı ara…" style="width:280px">
        </h3>
        <table class="res-table">
          <thead><tr><th>Tarih / Saat</th><th>Kişi</th><th>İşlem</th><th>Detay</th></tr></thead>
          <tbody>
            ${list.map((l) => `
              <tr>
                <td class="muted small" style="white-space:nowrap">${fmtDate(l.ts)}</td>
                <td><div class="inline"><b>${esc(l.actorName)}</b> ${renderRoleBadge(l.actorRole)}</div></td>
                <td><span class="badge ${l.severity === 'security' ? 'bad' : 'neutral'}">${esc(l.action)}</span></td>
                <td>${esc(l.detail)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="muted">Henüz işlem kaydı yok.</td></tr>'}
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
  } else if (S.adminTab === 'security') {
    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3><span>🛡️ Aktif Güvenlik Katmanları</span></h3>
        <div class="admin-stats" style="margin-bottom:0">
          <div class="stat-card"><div class="lbl">Veri &amp; Yetki İzolasyonu</div><div class="val" style="font-size:15px;color:var(--ok)">✓ Aktif</div><div class="sub">Kullanıcı listesi, şifre özetleri ve işlem geçmişi yalnızca Admin/Kurucu oturumlarına açıktır.</div></div>
          <div class="stat-card"><div class="lbl">Kalıcı Kriptografik Oturum</div><div class="val" style="font-size:15px;color:var(--ok)">✓ HMAC-SHA256 + scrypt</div><div class="sub">HttpOnly çerezler JS/XSS ile okunamaz; şifre değiştiğinde eski jetonlar anında iptal olur.</div></div>
          <div class="stat-card"><div class="lbl">WAF &amp; CSRF Koruması</div><div class="val" style="font-size:15px;color:var(--ok)">✓ Aktif</div><div class="sub">Dış sitelerden sahte istekler (CSRF), XSS, Path Traversal ve tarayıcı bot saldırıları otomatik engellenir.</div></div>
          <div class="stat-card"><div class="lbl">Brute-Force Koruması</div><div class="val" style="font-size:15px;color:var(--ok)">✓ Hesap Bazlı</div><div class="sub">Aynı ofis IP'sini etkilemeden yalnızca hedef hesaba yönelik şifre denemelerini kilitler.</div></div>
        </div>
      </div>
      <div class="admin-card">
        <h3><span>🚨 Güvenlik &amp; Saldırı Kayıtları (${secLogs.length})</span></h3>
        <table class="res-table">
          <thead><tr><th>Tarih / Saat</th><th>Kişi / Oturum</th><th>Olay</th><th>Detay</th></tr></thead>
          <tbody>
            ${secLogs.map((l) => `
              <tr>
                <td class="muted small" style="white-space:nowrap">${fmtDate(l.ts)}</td>
                <td><b>${esc(l.actorName)}</b></td>
                <td><span class="badge bad">${esc(l.action)}</span></td>
                <td>${esc(l.detail)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="muted">Şu ana kadar engellenen bir saldırı veya güvenlik ihlali kaydı yok.</td></tr>'}
          </tbody>
        </table>
      </div>`;
  } else if (S.adminTab === 'bans') {
    $('#adminBody').innerHTML = `
      <div class="admin-card">
        <h3><span>🚫 Siteden Uzaklaştırılan Profiller &amp; Cihazlar (${d.bans.length})</span><span class="muted small">Ortak IP'deki diğer ekip arkadaşlarını etkilemeden yalnızca ilgili profili veya tarayıcı cihazını engeller</span></h3>
        <table class="res-table">
          <thead><tr><th>Tür</th><th>Hedef</th><th>Sebep</th><th>Engelleyen</th><th>Tarih</th><th></th></tr></thead>
          <tbody>
            ${d.bans.map((b) => `
              <tr>
                <td><span class="badge bad">${b.type === 'user' ? 'Profil Engeli' : 'Cihaz Oturum Engeli'}</span></td>
                <td><b>${esc(b.targetName || b.target)}</b></td>
                <td>${esc(b.reason)}</td>
                <td class="muted small">${esc(b.createdBy)}</td>
                <td class="muted small">${fmtDate(b.createdAt)}</td>
                <td><button class="mini" style="font-size:12px;padding:3px 10px" data-act="unban" data-id="${b.id}">Engeli Kaldır</button></td>
              </tr>`).join('') || '<tr><td colspan="6" class="muted">Engellenmiş profil veya cihaz bulunmuyor.</td></tr>'}
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

  if (a === 'gen-pw') {
    const inp = $('#nuPass');
    if (inp) inp.value = genPassword(8);
  }
  if (a === 'create-user') {
    const name = $('#nuName').value.trim();
    const username = $('#nuUser').value.trim();
    const password = $('#nuPass').value.trim();
    const role = $('#nuRole').value;
    const res = await act(() => api('/api/admin/users', { method: 'POST', body: { name, username, password, role } }), 'Yeni profil oluşturuldu');
    if (res && res.user) {
      await loadAdminOverview();
      showCredentialsCard({ name: res.user.name, username: res.user.username, password, roleLabel: res.user.roleLabel });
    }
  }
  if (a === 'pw-user') {
    const pw = await askText({ title: `🔑 “${b.dataset.name}” için yeni şifre belirle`, label: 'Yeni şifre', value: genPassword(8), ok: 'Şifreyi Güncelle' });
    if (!pw) return;
    if (await act(() => api('/api/admin/users/' + b.dataset.uid, { method: 'PATCH', body: { password: pw } }), 'Şifre sıfırlandı')) {
      await loadAdminOverview();
      showCredentialsCard({
        title: '🔑 Şifre Sıfırlandı',
        name: b.dataset.name,
        username: b.dataset.uname,
        password: pw,
        roleLabel: b.dataset.role,
      });
    }
  }
  if (a === 'revoke-user') {
    if (!(await confirmBox({ title: 'Oturumları kapat', message: `<b>${esc(b.dataset.name)}</b> kullanıcısının açık tüm cihazlarındaki oturumu kapatılacak.`, ok: 'Oturumları Kapat' }))) return;
    if (await act(() => api('/api/admin/users/' + b.dataset.uid, { method: 'PATCH', body: { revokeSessions: true } }), 'Kullanıcının tüm oturumları kapatıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'del-user') {
    if (!(await confirmBox({ title: 'Profili sil', message: `<b>${esc(b.dataset.name)}</b> profili kalıcı olarak silinecek.`, ok: 'Sil', danger: true }))) return;
    if (await act(() => api('/api/admin/users/' + b.dataset.uid, { method: 'DELETE' }), 'Profil silindi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'ban-user') {
    const reason = await askText({ title: `🚫 “${b.dataset.name}” profilini uzaklaştır`, label: 'Engelleme sebebi', value: 'Yönetici tarafından uzaklaştırıldı', ok: 'Uzaklaştır' });
    if (!reason) return;
    if (await act(() => api('/api/admin/bans', { method: 'POST', body: { userId: b.dataset.uid, reason } }), 'Profil siteden uzaklaştırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'ban-dev') {
    const reason = await askText({ title: `🚫 “${b.dataset.name}” oturumunu uzaklaştır`, label: 'Engelleme sebebi', value: 'Yönetici tarafından uzaklaştırıldı', ok: 'Uzaklaştır' });
    if (!reason) return;
    if (await act(() => api('/api/admin/bans', { method: 'POST', body: { userId: b.dataset.uid || null, devId: b.dataset.dev || null, targetName: b.dataset.name, reason } }), 'Kişi siteden uzaklaştırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'unban') {
    if (await act(() => api('/api/admin/bans/' + b.dataset.id, { method: 'DELETE' }), 'Engel kaldırıldı')) {
      await loadAdminOverview();
    }
  }
  if (a === 'restore-trash') {
    const r = await act(() => api('/api/admin/trash/restore', { method: 'POST', body: { ids: [b.dataset.id] } }), 'Görsel kataloğa geri yüklendi');
    if (r) { await loadState(); await loadAdminOverview(); }
  }
  if (a === 'restore-all-trash') {
    const allIds = (S.adminData?.trash || []).map((t) => t.id);
    if (!allIds.length) return;
    const r = await act(() => api('/api/admin/trash/restore', { method: 'POST', body: { ids: allIds } }), `${allIds.length} görsel geri yüklendi`);
    if (r) { await loadState(); await loadAdminOverview(); }
  }
  if (a === 'del-trash') {
    if (!(await confirmBox({ title: 'Kalıcı olarak sil', message: `<b>${esc(b.dataset.name)}</b> kalıcı olarak silinecek ve bir daha geri alınamayacak.`, ok: 'Kalıcı Sil', danger: true }))) return;
    if (await act(() => api('/api/admin/trash', { method: 'DELETE', body: { ids: [b.dataset.id] } }), 'Görsel kalıcı olarak silindi')) {
      await loadAdminOverview();
    }
  }
  if (a === 'empty-trash') {
    if (!(await confirmBox({ title: 'Çöp kutusunu boşalt', message: 'Çöp kutusundaki tüm görseller kalıcı olarak silinecek. Emin misin?', ok: 'Tümünü Kalıcı Sil', danger: true }))) return;
    if (await act(() => api('/api/admin/trash', { method: 'DELETE', body: {} }), 'Çöp kutusu boşaltıldı')) {
      await loadAdminOverview();
    }
  }
});

/* ====================================================================
   Genel Tasarım & Otomatik Domain Üretici (AI Olmadan Akıllı Tuval)
   ==================================================================== */
const FONTS = ['Poppins', 'Montserrat', 'Oswald', 'Bebas Neue', 'Anton', 'Arial'];
const SWATCHES = ['#ffffff', '#050807', '#ff6a00', '#ff2a12', '#12e268', '#ffd600', '#00d2ff'];

const DOM = {
  ready: false,
  activeTplId: 'default-betorspin-domain',
  tplName: 'Betorspin Kare Domain',
  bgUrl: '/domain-template.png',
  uploadedFile: null,
  isFreshUpload: false,
  img: null,
  cleanCanvas: document.createElement('canvas'),
  mode: 'move', // 'move' | 'erase' | 'pick'
  eraseMode: 'vertical', // 'vertical' | 'laplace' | 'horizontal' | 'solid'
  eraseColor: '#111111',
  patches: [],
  layers: [],
  selLayerId: null,
  drag: null, // { type:'layer'|'erase', ... }
  hoverBox: null,
};

function defaultBetorspinLayers() {
  return [
    {
      id: 'l1', enabled: true, tpl: '{no}', x: 50, y: 245,
      font: 'Poppins', weight: '700', size: 202, color: '#ffffff', align: 'left', angle: 0,
      shadow: true, shadowColor: '#000000', shadowBlur: 14,
      stroke: false, strokeColor: '#000000', strokeWidth: 4,
      pill: false, pillColor1: '#ff7a1a', pillColor2: '#ff2a12', pillPadX: 24, pillPadY: 12, pillRadius: 14,
    },
    {
      id: 'l2', enabled: true, tpl: 'www.{no}betorspin.com', x: 227, y: 681,
      font: 'Poppins', weight: '500', size: 29, color: '#ffffff', align: 'center', angle: 0,
      shadow: false, shadowColor: '#000000', shadowBlur: 8,
      stroke: false, strokeColor: '#000000', strokeWidth: 2,
      pill: false, pillColor1: '#ff7a1a', pillColor2: '#ff2a12', pillPadX: 24, pillPadY: 12, pillRadius: 14,
    },
  ];
}

function parseDomainNumbers(raw) {
  const s = String(raw || '').trim();
  if (!s) return ['801'];
  const out = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      const step = a <= b ? 1 : -1;
      for (let k = a; step > 0 ? k <= b : k >= b; k += step) {
        out.push(String(k));
        if (out.length >= 150) break;
      }
    } else {
      out.push(part.slice(0, 24));
    }
    if (out.length >= 150) break;
  }
  return out.length ? [...new Set(out)] : ['801'];
}

function getSelectedLayer() {
  return DOM.layers.find((l) => l.id === DOM.selLayerId) || DOM.layers[0] || null;
}

function selectTemplate(tpl) {
  DOM.activeTplId = tpl.id;
  DOM.tplName = tpl.name;
  DOM.bgUrl = tpl.bgUrl;
  DOM.uploadedFile = null;
  DOM.isFreshUpload = false;
  DOM.patches = JSON.parse(JSON.stringify(tpl.patches || []));
  DOM.layers = JSON.parse(JSON.stringify(tpl.layers?.length ? tpl.layers : defaultBetorspinLayers()));
  DOM.selLayerId = DOM.layers[0]?.id || null;
  setDomMode('move');
  renderDomainTplBar();
  renderLayerList();
  renderLayerEditor();
  renderEraseBar();
  loadDomainTemplate(tpl.bgUrl);
}

function renderDomainTplBar() {
  const bar = $('#domTplBar');
  if (!bar) return;
  const list = S.templates?.length ? S.templates : [{
    id: 'default-betorspin-domain', name: 'Betorspin Kare Domain', bgUrl: '/domain-template.png',
    builtin: true, patches: [], layers: defaultBetorspinLayers(),
  }];
  bar.innerHTML = `<span class="muted small" style="margin-right:4px">Kayıtlı Şablonlar:</span>` +
    list.map((t) => `<div class="tpl-chip ${DOM.activeTplId === t.id ? 'active' : ''}" data-tplid="${esc(t.id)}">
      <span>🎨 ${esc(t.name)}</span>
      ${!t.builtin && S.me.canEdit ? `<span class="del" data-deltpl="${esc(t.id)}" title="Şablonu sil">✕</span>` : ''}
    </div>`).join('');
}

function setDomMode(m) {
  DOM.mode = m;
  $$('#domToolModes button').forEach((b) => b.classList.toggle('active', b.dataset.dmode === m));
  const cv = $('#domainCanvas');
  if (cv) cv.style.cursor = m === 'erase' ? 'crosshair' : m === 'pick' ? 'copy' : 'grab';
  renderEraseBar();
}

function renderEraseBar() {
  const bar = $('#domEraseBar');
  if (!bar) return;
  if (DOM.mode !== 'erase' && !DOM.patches.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <span>🧽 <b>Silgi Modu:</b></span>
    <select id="selEraseMode" style="padding:3px 8px;font-size:12px">
      <option value="vertical" ${DOM.eraseMode === 'vertical' ? 'selected' : ''}>Dikey Geçiş (Buton / Şerit İçi Yazılar İçin En İyi)</option>
      <option value="laplace" ${DOM.eraseMode === 'laplace' ? 'selected' : ''}>4 Yönlü Akıllı Arka Plan Doldurma</option>
      <option value="horizontal" ${DOM.eraseMode === 'horizontal' ? 'selected' : ''}>Yatay Geçiş</option>
      <option value="solid" ${DOM.eraseMode === 'solid' ? 'selected' : ''}>Tek Renk ile Kapat</option>
    </select>
    ${DOM.eraseMode === 'solid' ? `<input type="color" id="inpEraseColor" value="${esc(DOM.eraseColor)}">` : ''}
    <div class="spacer"></div>
    ${DOM.patches.length ? `<span class="muted">${DOM.patches.length} alan temizlendi</span>
      <button type="button" class="mini" data-eract="undo" style="font-size:12px;padding:2px 8px">↩️ Geri Al</button>
      <button type="button" class="mini danger" data-eract="clear" style="font-size:12px;padding:2px 8px">🧹 Silgileri Sıfırla</button>` : '<span class="muted">Görseldeki eski yazının üzerine fareyle dikdörtgen çizin</span>'}
  `;
}

/** AI olmadan piksel interpolasyonu ile seçili dikdörtgen alandaki eski yazıyı temizler */
function rebuildCleanCanvas() {
  const cc = DOM.cleanCanvas;
  if (!DOM.img) return;
  const w = DOM.img.naturalWidth || 1080;
  const h = DOM.img.naturalHeight || 1080;
  cc.width = w;
  cc.height = h;
  const ctx = cc.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(DOM.img, 0, 0);
  if (!DOM.patches.length) return;

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  for (const p of DOM.patches) {
    const x0 = Math.max(1, Math.min(w - 2, Math.round(p.x)));
    const y0 = Math.max(1, Math.min(h - 2, Math.round(p.y)));
    const x1 = Math.max(x0 + 1, Math.min(w - 2, Math.round(p.x + p.w)));
    const y1 = Math.max(y0 + 1, Math.min(h - 2, Math.round(p.y + p.h)));
    const mode = p.mode || 'vertical';

    if (mode === 'solid') {
      const hex = (p.color || '#000000').replace('#', '');
      const sr = parseInt(hex.slice(0, 2), 16) || 0;
      const sg = parseInt(hex.slice(2, 4), 16) || 0;
      const sb = parseInt(hex.slice(4, 6), 16) || 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * w + x) * 4;
          d[i] = sr; d[i + 1] = sg; d[i + 2] = sb; d[i + 3] = 255;
        }
      }
    } else if (mode === 'vertical') {
      for (let x = x0; x <= x1; x++) {
        const T = (y0 * w + x) * 4;
        const B = (y1 * w + x) * 4;
        for (let y = y0 + 1; y < y1; y++) {
          const t = (y - y0) / (y1 - y0);
          const i = (y * w + x) * 4;
          d[i] = Math.round(d[T] * (1 - t) + d[B] * t);
          d[i + 1] = Math.round(d[T + 1] * (1 - t) + d[B + 1] * t);
          d[i + 2] = Math.round(d[T + 2] * (1 - t) + d[B + 2] * t);
        }
      }
    } else if (mode === 'horizontal') {
      for (let y = y0; y <= y1; y++) {
        const L = (y * w + x0) * 4;
        const R = (y * w + x1) * 4;
        for (let x = x0 + 1; x < x1; x++) {
          const t = (x - x0) / (x1 - x0);
          const i = (y * w + x) * 4;
          d[i] = Math.round(d[L] * (1 - t) + d[R] * t);
          d[i + 1] = Math.round(d[L + 1] * (1 - t) + d[R + 1] * t);
          d[i + 2] = Math.round(d[L + 2] * (1 - t) + d[R + 2] * t);
        }
      }
    } else {
      // 4-yönlü Laplace yumuşatma
      for (let y = y0 + 1; y < y1; y++) {
        const ty = (y - y0) / (y1 - y0);
        const L = (y * w + x0) * 4;
        const R = (y * w + x1) * 4;
        for (let x = x0 + 1; x < x1; x++) {
          const tx = (x - x0) / (x1 - x0);
          const T = (y0 * w + x) * 4;
          const B = (y1 * w + x) * 4;
          const i = (y * w + x) * 4;
          for (let k = 0; k < 3; k++) {
            const hBlend = d[L + k] * (1 - tx) + d[R + k] * tx;
            const vBlend = d[T + k] * (1 - ty) + d[B + k] * ty;
            d[i + k] = Math.round((hBlend + vBlend) * 0.5);
          }
        }
      }
      for (let it = 0; it < 45; it++) {
        for (let y = y0 + 1; y < y1; y++) {
          for (let x = x0 + 1; x < x1; x++) {
            const i = (y * w + x) * 4;
            const L = i - 4, R = i + 4, T = i - w * 4, B = i + w * 4;
            d[i] = (d[L] + d[R] + d[T] + d[B] + 2) >> 2;
            d[i + 1] = (d[L + 1] + d[R + 1] + d[T + 1] + d[B + 1] + 2) >> 2;
            d[i + 2] = (d[L + 2] + d[R + 2] + d[T + 2] + d[B + 2] + 2) >> 2;
          }
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function renderLayerList() {
  const host = $('#domLayerList');
  if (!host) return;
  host.innerHTML = DOM.layers.map((l, idx) => `
    <div class="layer-item ${l.id === DOM.selLayerId ? 'active' : ''}" data-lid="${esc(l.id)}">
      <input type="checkbox" class="l-toggle" ${l.enabled !== false ? 'checked' : ''} title="Göster / Gizle">
      <span class="l-sw" style="background:${esc(l.color || '#ffffff')}"></span>
      <span class="l-txt">${esc(l.tpl || `Katman ${idx + 1}`)}</span>
      <span class="muted small">${l.size}px</span>
      ${DOM.layers.length > 1 ? `<button type="button" class="mini danger l-del" title="Katmanı sil" style="padding:0 6px;font-size:13px">✕</button>` : ''}
    </div>
  `).join('');
}

function renderLayerEditor() {
  const host = $('#domLayerEditor');
  if (!host) return;
  const l = getSelectedLayer();
  if (!l) { host.innerHTML = '<div class="muted small">Düzenlemek için bir yazı katmanı ekleyin.</div>'; return; }

  host.innerHTML = `
    <div class="field" style="margin-top:4px">
      <label style="display:flex;justify-content:space-between">
        <span>Yazı Kalıbı (<code>{no}</code> otomatik değişir)</span>
        <a href="javascript:void(0)" id="lnkInsertNo" style="color:var(--o1);text-decoration:none;font-weight:600">＋ {no} Ekle</a>
      </label>
      <input type="text" id="leTpl" value="${esc(l.tpl)}" placeholder="ör. {no}Baywin.com veya {no}" style="width:100%;font-weight:600">
    </div>
    <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px">
      <div class="field" style="margin:0"><label>Yazı Tipi</label>
        <select id="leFont" style="width:100%">${FONTS.map((f) => `<option value="${f}" ${l.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
      </div>
      <div class="field" style="margin:0"><label>Kalınlık</label>
        <select id="leWeight" style="width:100%">
          <option value="500" ${l.weight === '500' ? 'selected' : ''}>Medium</option>
          <option value="600" ${l.weight === '600' ? 'selected' : ''}>SemiBold</option>
          <option value="700" ${l.weight === '700' ? 'selected' : ''}>Bold</option>
          <option value="800" ${l.weight === '800' ? 'selected' : ''}>ExtraBold</option>
          <option value="900" ${l.weight === '900' ? 'selected' : ''}>Black</option>
        </select>
      </div>
      <div class="field" style="margin:0"><label>Boyut (px)</label>
        <input type="number" id="leSize" value="${l.size}" min="10" max="500" style="width:100%">
      </div>
    </div>

    <div class="field">
      <label>Yazı Rengi &amp; Hızlı Renkler</label>
      <div class="swatches">
        <input type="color" id="leColor" value="${esc(l.color || '#ffffff')}" style="width:34px;height:28px;padding:0;border:none;background:none;cursor:pointer">
        ${SWATCHES.map((c) => `<button type="button" class="swatch" data-sw="${c}" style="background:${c}"></button>`).join('')}
        <button type="button" class="mini" id="btnLePickColor" style="font-size:11px;padding:2px 8px">🎯 Görselden Seç</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
      <div class="field" style="margin:0"><label>Hizalama</label>
        <select id="leAlign" style="width:100%">
          <option value="left" ${l.align === 'left' ? 'selected' : ''}>Sola</option>
          <option value="center" ${l.align === 'center' ? 'selected' : ''}>Ortala</option>
          <option value="right" ${l.align === 'right' ? 'selected' : ''}>Sağa</option>
        </select>
      </div>
      <div class="field" style="margin:0"><label>Eğim Açısı (°)</label>
        <input type="number" id="leAngle" value="${l.angle || 0}" min="-90" max="90" style="width:100%">
      </div>
      <div class="field" style="margin:0"><label>Konum (X / Y)</label>
        <div class="inline"><input type="number" id="leX" value="${Math.round(l.x)}" style="width:50%"><input type="number" id="leY" value="${Math.round(l.y)}" style="width:50%"></div>
      </div>
    </div>

    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid var(--line)">
      <label class="inline small"><input type="checkbox" id="leShadow" ${l.shadow ? 'checked' : ''}> Gölge</label>
      <label class="inline small"><input type="checkbox" id="leStroke" ${l.stroke ? 'checked' : ''}> Dış Çizgi (Kontur)</label>
      <label class="inline small"><input type="checkbox" id="lePill" ${l.pill ? 'checked' : ''}> Arka Plan Kutusu Çiz</label>
    </div>

    ${l.stroke ? `<div class="inline" style="margin-top:6px"><span class="muted small">Çizgi Rengi/Kalınlık:</span>
      <input type="color" id="leStrokeColor" value="${esc(l.strokeColor || '#000000')}">
      <input type="number" id="leStrokeWidth" value="${l.strokeWidth || 4}" min="1" max="30" style="width:70px"></div>` : ''}

    ${l.pill ? `<div class="inline" style="margin-top:6px;flex-wrap:wrap"><span class="muted small">Kutu Renkleri:</span>
      <input type="color" id="lePillC1" value="${esc(l.pillColor1 || '#ff7a1a')}">
      <input type="color" id="lePillC2" value="${esc(l.pillColor2 || '#ff2a12')}">
      <span class="muted small">Köşe:</span><input type="number" id="lePillRad" value="${l.pillRadius ?? 16}" min="0" max="80" style="width:60px">
      <span class="muted small">İç Boşluk:</span><input type="number" id="lePillPad" value="${l.pillPadX ?? 26}" min="4" max="120" style="width:60px"></div>` : ''}
  `;
}

function renderDomainToCanvas(numStr, showGuides = false) {
  const cv = $('#domainCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (DOM.img) {
    const w = DOM.img.naturalWidth || 1080;
    const h = DOM.img.naturalHeight || 1080;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.drawImage(DOM.cleanCanvas, 0, 0);
  } else {
    ctx.fillStyle = '#140c08';
    ctx.fillRect(0, 0, cv.width, cv.height);
  }

  for (const l of DOM.layers) {
    if (l.enabled === false) continue;
    const text = String(l.tpl || '').replace(/\{no\}/gi, numStr);
    if (!text) continue;

    ctx.save();
    ctx.translate(l.x, l.y);
    if (l.angle) ctx.rotate((l.angle * Math.PI) / 180);
    ctx.font = `${l.weight || '700'} ${l.size || 48}px "${l.font || 'Poppins'}", sans-serif`;
    ctx.textAlign = l.align || 'center';
    ctx.textBaseline = 'middle';

    const m = ctx.measureText(text);
    const tw = m.width;
    const th = l.size || 48;
    const bx = l.align === 'left' ? 0 : l.align === 'right' ? -tw : -tw / 2;
    const by = -th / 2;

    if (l.pill) {
      const px = l.pillPadX ?? 26;
      const py = l.pillPadY ?? Math.round((l.pillPadX ?? 26) * 0.48);
      const rx = bx - px;
      const ry = by - py;
      const rw = tw + px * 2;
      const rh = th + py * 2;
      const rad = Math.min(l.pillRadius ?? 16, rh / 2);
      const grad = ctx.createLinearGradient(rx, ry, rx + rw, ry);
      grad.addColorStop(0, l.pillColor1 || '#ff7a1a');
      grad.addColorStop(1, l.pillColor2 || '#ff2a12');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(rx, ry, rw, rh, rad);
      ctx.fill();
    }

    if (l.shadow) {
      ctx.shadowColor = l.shadowColor || 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = l.shadowBlur ?? 14;
      ctx.shadowOffsetY = 4;
    }

    if (l.stroke) {
      ctx.lineWidth = l.strokeWidth || 4;
      ctx.strokeStyle = l.strokeColor || '#000000';
      ctx.lineJoin = 'round';
      ctx.strokeText(text, 0, 0);
    }

    ctx.fillStyle = l.color || '#ffffff';
    ctx.fillText(text, 0, 0);

    // Tuval üzerinde tıklama algılama için son ölçüleri sakla
    l._bbox = { x: l.x + bx - 10, y: l.y + by - 10, w: tw + 20, h: th + 20 };

    if (showGuides && l.id === DOM.selLayerId && DOM.mode === 'move') {
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(255, 122, 26, 0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(bx - 10, by - 8, tw + 20, th + 16);
    }
    ctx.restore();
  }

  // Silgi kutusu çizilirken canlı seçim dikdörtgeni göster
  if (showGuides && DOM.drag && DOM.drag.type === 'erase') {
    const r = normRect(DOM.drag.sx, DOM.drag.sy, DOM.drag.cx, DOM.drag.cy);
    ctx.save();
    ctx.fillStyle = 'rgba(255, 90, 26, 0.22)';
    ctx.strokeStyle = '#ff7a1a';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

function normRect(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function canvasCoords(e) {
  const cv = $('#domainCanvas');
  const rect = cv.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * cv.width,
    y: ((e.clientY - rect.top) / rect.height) * cv.height,
  };
}

function initDomainTool() {
  if (!DOM.layers.length) {
    const first = S.templates?.[0] || {
      id: 'default-betorspin-domain', name: 'Betorspin Kare Domain', bgUrl: '/domain-template.png',
      patches: [], layers: defaultBetorspinLayers(),
    };
    selectTemplate(first);
  } else {
    renderDomainTplBar();
    drawDomainPreview(true);
  }
  if (DOM.ready) return;
  DOM.ready = true;

  $('#domTplBar').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-deltpl]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.deltpl;
      const t = S.templates.find((x) => x.id === id);
      if (!(await confirmBox({ title: 'Şablonu sil', message: `<b>${esc(t?.name)}</b> şablonu silinecek.`, ok: 'Sil', danger: true }))) return;
      if (await act(() => api('/api/templates/' + id, { method: 'DELETE' }), 'Şablon silindi')) {
        await loadState();
        if (DOM.activeTplId === id && S.templates.length) selectTemplate(S.templates[0]);
      }
      return;
    }
    const chip = e.target.closest('[data-tplid]');
    if (chip) {
      const t = S.templates.find((x) => x.id === chip.dataset.tplid);
      if (t) selectTemplate(t);
    }
  });

  $('#domToolModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dmode]');
    if (b) { setDomMode(b.dataset.dmode); drawDomainPreview(true); }
  });

  $('#domEraseBar').addEventListener('change', (e) => {
    if (e.target.id === 'selEraseMode') {
      DOM.eraseMode = e.target.value;
      if (DOM.patches.length) {
        DOM.patches[DOM.patches.length - 1].mode = DOM.eraseMode;
        rebuildCleanCanvas();
        drawDomainPreview(true);
      }
      renderEraseBar();
    }
    if (e.target.id === 'inpEraseColor') {
      DOM.eraseColor = e.target.value;
      if (DOM.patches.length && DOM.eraseMode === 'solid') {
        DOM.patches[DOM.patches.length - 1].color = DOM.eraseColor;
        rebuildCleanCanvas();
        drawDomainPreview(true);
      }
    }
  });

  $('#domEraseBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-eract]');
    if (!b) return;
    if (b.dataset.eract === 'undo') DOM.patches.pop();
    if (b.dataset.eract === 'clear') DOM.patches = [];
    rebuildCleanCanvas();
    renderEraseBar();
    drawDomainPreview(true);
  });

  $('#domInput').addEventListener('input', () => drawDomainPreview(true));

  $('#btnDomAddLayer').onclick = () => {
    const cv = $('#domainCanvas');
    const nl = {
      id: 'l_' + Date.now().toString(36),
      enabled: true,
      tpl: '{no}',
      x: Math.round((cv.width || 1080) / 2),
      y: Math.round((cv.height || 1080) / 2),
      font: 'Poppins', weight: '700', size: 64, color: '#ffffff', align: 'center', angle: 0,
      shadow: true, shadowColor: '#000000', shadowBlur: 12,
      stroke: false, strokeColor: '#000000', strokeWidth: 4,
      pill: false, pillColor1: '#ff7a1a', pillColor2: '#ff2a12', pillPadX: 26, pillPadY: 12, pillRadius: 16,
    };
    DOM.layers.push(nl);
    DOM.selLayerId = nl.id;
    setDomMode('move');
    renderLayerList();
    renderLayerEditor();
    drawDomainPreview(true);
  };

  $('#domLayerList').addEventListener('click', (e) => {
    const row = e.target.closest('.layer-item');
    if (!row) return;
    const id = row.dataset.lid;
    const layer = DOM.layers.find((l) => l.id === id);
    if (!layer) return;
    if (e.target.classList.contains('l-toggle')) {
      layer.enabled = e.target.checked;
      drawDomainPreview(true);
      return;
    }
    if (e.target.classList.contains('l-del')) {
      DOM.layers = DOM.layers.filter((l) => l.id !== id);
      if (DOM.selLayerId === id) DOM.selLayerId = DOM.layers[0]?.id || null;
      renderLayerList();
      renderLayerEditor();
      drawDomainPreview(true);
      return;
    }
    DOM.selLayerId = id;
    renderLayerList();
    renderLayerEditor();
    drawDomainPreview(true);
  });

  const syncLayerFromForm = (rerenderEditor = false) => {
    const l = getSelectedLayer();
    if (!l) return;
    const host = $('#domLayerEditor');
    l.tpl = $('#leTpl', host)?.value ?? l.tpl;
    l.font = $('#leFont', host)?.value || l.font;
    l.weight = $('#leWeight', host)?.value || l.weight;
    l.size = +$('#leSize', host)?.value || l.size;
    l.color = $('#leColor', host)?.value || l.color;
    l.align = $('#leAlign', host)?.value || l.align;
    l.angle = +$('#leAngle', host)?.value || 0;
    l.x = +$('#leX', host)?.value || 0;
    l.y = +$('#leY', host)?.value || 0;
    l.shadow = $('#leShadow', host)?.checked ?? l.shadow;
    l.stroke = $('#leStroke', host)?.checked ?? l.stroke;
    l.pill = $('#lePill', host)?.checked ?? l.pill;
    if ($('#leStrokeColor', host)) l.strokeColor = $('#leStrokeColor', host).value;
    if ($('#leStrokeWidth', host)) l.strokeWidth = +$('#leStrokeWidth', host).value || 4;
    if ($('#lePillC1', host)) l.pillColor1 = $('#lePillC1', host).value;
    if ($('#lePillC2', host)) l.pillColor2 = $('#lePillC2', host).value;
    if ($('#lePillRad', host)) l.pillRadius = +$('#lePillRad', host).value || 0;
    if ($('#lePillPad', host)) { l.pillPadX = +$('#lePillPad', host).value || 10; l.pillPadY = Math.round(l.pillPadX * 0.48); }
    renderLayerList();
    if (rerenderEditor) renderLayerEditor();
    drawDomainPreview(true);
  };

  $('#domLayerEditor').addEventListener('input', (e) => {
    if (['leShadow', 'leStroke', 'lePill'].includes(e.target.id)) return;
    syncLayerFromForm(false);
  });
  $('#domLayerEditor').addEventListener('change', (e) => {
    syncLayerFromForm(['leShadow', 'leStroke', 'lePill'].includes(e.target.id));
  });
  $('#domLayerEditor').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-sw]');
    if (sw) {
      const l = getSelectedLayer();
      if (l) { l.color = sw.dataset.sw; renderLayerEditor(); renderLayerList(); drawDomainPreview(true); }
    }
    if (e.target.id === 'btnLePickColor') setDomMode('pick');
    if (e.target.id === 'lnkInsertNo') {
      const inp = $('#leTpl');
      if (inp) { inp.value += '{no}'; syncLayerFromForm(false); inp.focus(); }
    }
  });

  // Tuval üzerinde fare etkileşimleri (Sürükle-Taşı, Kutu Çizerek Eski Yazıyı Sil, Renk Seç)
  const cv = $('#domainCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const pt = canvasCoords(e);
    if (DOM.mode === 'pick') {
      const ctx = DOM.cleanCanvas.getContext('2d');
      const px = ctx.getImageData(Math.round(pt.x), Math.round(pt.y), 1, 1).data;
      const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const l = getSelectedLayer();
      if (l) { l.color = hex; renderLayerEditor(); renderLayerList(); }
      setDomMode('move');
      drawDomainPreview(true);
      toast(`🎯 Renk seçildi: ${hex}`, 'ok');
      return;
    }
    if (DOM.mode === 'erase') {
      cv.setPointerCapture(e.pointerId);
      DOM.drag = { type: 'erase', sx: pt.x, sy: pt.y, cx: pt.x, cy: pt.y };
      return;
    }
    // 'move' modu: tıklanan yazı katmanını bul veya seçili katmanı sürükle
    let hit = null;
    for (let i = DOM.layers.length - 1; i >= 0; i--) {
      const l = DOM.layers[i];
      if (l.enabled === false || !l._bbox) continue;
      const b = l._bbox;
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) { hit = l; break; }
    }
    if (hit && hit.id !== DOM.selLayerId) {
      DOM.selLayerId = hit.id;
      renderLayerList();
      renderLayerEditor();
    }
    const active = hit || getSelectedLayer();
    if (active) {
      cv.setPointerCapture(e.pointerId);
      DOM.drag = { type: 'layer', layer: active, ox: pt.x - active.x, oy: pt.y - active.y };
      cv.style.cursor = 'grabbing';
      drawDomainPreview(true);
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!DOM.drag) return;
    const pt = canvasCoords(e);
    if (DOM.drag.type === 'layer') {
      DOM.drag.layer.x = Math.round(pt.x - DOM.drag.ox);
      DOM.drag.layer.y = Math.round(pt.y - DOM.drag.oy);
      const xIn = $('#leX'); const yIn = $('#leY');
      if (xIn) xIn.value = DOM.drag.layer.x;
      if (yIn) yIn.value = DOM.drag.layer.y;
      drawDomainPreview(true);
    } else if (DOM.drag.type === 'erase') {
      DOM.drag.cx = pt.x;
      DOM.drag.cy = pt.y;
      drawDomainPreview(true);
    }
  });

  cv.addEventListener('pointerup', () => {
    if (!DOM.drag) return;
    if (DOM.drag.type === 'erase') {
      const r = normRect(DOM.drag.sx, DOM.drag.sy, DOM.drag.cx, DOM.drag.cy);
      DOM.drag = null;
      if (r.w > 6 && r.h > 6) {
        // Kutunun en-boy oranına göre en uygun silgi modunu otomatik seç (yatay buton içi ise vertical, geniş açık alan ise laplace)
        const autoMode = r.w > r.h * 2.1 ? 'vertical' : DOM.eraseMode;
        DOM.eraseMode = autoMode;
        DOM.patches.push({ ...r, mode: autoMode, color: DOM.eraseColor });
        rebuildCleanCanvas();

        // Yeni yüklenen bir görselde ilk silgi kutusu çizildiyse, aktif yazıyı otomatik olarak silinen kutunun tam ortasına yerleştir ve kontrast rengini ayarla!
        const l = getSelectedLayer();
        if (l && DOM.isFreshUpload && DOM.patches.length === 1) {
          const cx = Math.round(r.x + r.w / 2);
          const cy = Math.round(r.y + r.h / 2);
          l.x = cx;
          l.y = cy;
          l.align = 'center';
          l.size = Math.max(18, Math.min(200, Math.round(r.h * 0.68)));
          const px = DOM.cleanCanvas.getContext('2d').getImageData(cx, cy, 1, 1).data;
          const lum = px[0] * 0.299 + px[1] * 0.587 + px[2] * 0.114;
          l.color = lum > 135 ? '#060a08' : '#ffffff';
          l.shadow = lum <= 135;
          DOM.isFreshUpload = false;
          setDomMode('move');
          renderLayerList();
          renderLayerEditor();
          toast('✨ Eski yazı temizlendi ve yeni yazı otomatik olarak yerine yerleştirildi!', 'ok');
        }
        renderEraseBar();
        drawDomainPreview(true);
      }
      return;
    }
    DOM.drag = null;
    cv.style.cursor = DOM.mode === 'move' ? 'grab' : 'crosshair';
    drawDomainPreview(true);
  });

  // Yeni özel görsel yükleme
  $('#btnDomCustomTpl').onclick = () => $('#domTplFile').click();
  $('#domTplFile').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    DOM.uploadedFile = f;
    DOM.activeTplId = 'custom_' + Date.now();
    DOM.tplName = f.name.replace(/\.[^.]+$/, '');
    DOM.patches = [];
    DOM.isFreshUpload = true;
    renderDomainTplBar();
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => {
      DOM.img = im;
      const w = im.naturalWidth || 1080;
      const h = im.naturalHeight || 1080;
      DOM.layers = [{
        id: 'l1', enabled: true, tpl: '{no}',
        x: Math.round(w / 2), y: Math.round(h / 2),
        font: 'Poppins', weight: '800', size: Math.round(Math.min(w, h) * 0.065),
        color: '#ffffff', align: 'center', angle: 0,
        shadow: false, shadowColor: '#000000', shadowBlur: 12,
        stroke: false, strokeColor: '#000000', strokeWidth: 4,
        pill: false, pillColor1: '#ff7a1a', pillColor2: '#ff2a12', pillPadX: 26, pillPadY: 12, pillRadius: 16,
      }];
      DOM.selLayerId = 'l1';
      rebuildCleanCanvas();
      setDomMode('erase');
      renderLayerList();
      renderLayerEditor();
      drawDomainPreview(true);
      toast('🧽 Görsel yüklendi! Görseldeki eski yazının/adresin üzerine fareyle kutu çizerek temizleyin.', 'ok', 6500);
    };
    im.src = url;
  };

  // Şablon olarak kaydetme
  $('#btnDomSaveTpl').onclick = async () => {
    if (!S.me.canEdit) { toast('⚠ Şablon kaydetmek için düzenleme yetkisi gerekir.', 'err'); return; }
    const name = await askText({
      title: '💾 Tasarımı Şablon Olarak Kaydet',
      label: 'Şablon Adı (tüm ekip bu şablonu tek tıkla kullanabilir)',
      value: DOM.tplName === 'Betorspin Kare Domain' ? '' : DOM.tplName,
      placeholder: 'ör. Baywin Domain veya Story Domain',
      ok: 'Şablonu Kaydet',
    });
    if (!name) return;
    const form = new FormData();
    if (DOM.uploadedFile) form.append('bg', DOM.uploadedFile, DOM.uploadedFile.name);
    form.append('template', JSON.stringify({
      id: DOM.activeTplId,
      name,
      bgUrl: DOM.bgUrl,
      width: DOM.img?.naturalWidth || 1080,
      height: DOM.img?.naturalHeight || 1080,
      patches: DOM.patches,
      layers: DOM.layers,
    }));
    const res = await act(() => api('/api/templates', { method: 'POST', form }), `✅ “${esc(name)}” şablonu kaydedildi`);
    if (res && res.template) {
      await loadState();
      selectTemplate(res.template);
    }
  };

  $('#btnDomSingleDl').onclick = async () => {
    const list = parseDomainNumbers($('#domInput').value);
    renderDomainToCanvas(list[0], false);
    const blob = await new Promise((r) => $('#domainCanvas').toBlob(r, 'image/png'));
    drawDomainPreview(true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${list[0]}.png`;
    a.click();
  };
  $('#btnDomCopy').onclick = async () => {
    try {
      const list = parseDomainNumbers($('#domInput').value);
      renderDomainToCanvas(list[0], false);
      const blob = await new Promise((r) => $('#domainCanvas').toBlob(r, 'image/png'));
      drawDomainPreview(true);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`📋 ${list[0]}.png panoya kopyalandı`, 'ok');
    } catch { toast('⚠ Panoya kopyalanamadı', 'err'); }
  };
  $('#btnDomBatchZip').onclick = () => runDomainBatch('download');
  $('#btnDomSaveCat').onclick = () => runDomainBatch('catalog');
}

function loadDomainTemplate(src) {
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    DOM.img = im;
    rebuildCleanCanvas();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawDomainPreview(true));
    else drawDomainPreview(true);
  };
  im.src = src;
}

function drawDomainPreview(showGuides = true) {
  const list = parseDomainNumbers($('#domInput')?.value);
  const first = list[0];
  if ($('#domPreviewLabel')) $('#domPreviewLabel').textContent = `${first}.png`;
  if ($('#domCountInfo')) {
    $('#domCountInfo').innerHTML = list.length === 1
      ? `<b>1</b> adet görsel üretilecek (<b>${esc(first)}.png</b>)`
      : `Toplam <b>${list.length}</b> adet görsel üretilecek (<b>${esc(first)}.png</b> … <b>${esc(list[list.length - 1])}.png</b>)`;
  }
  if ($('#btnDomBatchZip')) $('#btnDomBatchZip').textContent = list.length === 1 ? `⬇ ${first}.png İndir` : `📦 ${list.length} Görseli Üret & ZIP İndir`;
  if ($('#btnDomSaveCat')) $('#btnDomSaveCat').textContent = list.length === 1 ? `📥 ${first}.png Kataloğa Kaydet` : `📥 ${list.length} Görseli Kataloğa Kaydet`;
  renderDomainToCanvas(first, showGuides);
}

async function runDomainBatch(mode) {
  const list = parseDomainNumbers($('#domInput').value);
  if (mode === 'download' && list.length === 1) {
    $('#btnDomSingleDl').click();
    return;
  }
  let targetCatId = null;
  if (mode === 'catalog') {
    if (!S.me.canEdit) { toast('⚠ Kataloğa kaydetmek için düzenleme yetkisi gerekir.', 'err'); return; }
    const domCat = S.cats.find((c) => c.name.toLowerCase().includes('domain'));
    const pick = await pickCategory({
      title: `${list.length} Görseli Kataloğa Kaydet`,
      selected: domCat ? domCat.id : S.cur,
      ok: 'Üret & Kaydet',
    });
    if (!pick) return;
    targetCatId = pick.id;
  }

  const bar = $('#domProgress');
  bar.hidden = false;
  $('div', bar).style.width = '0%';
  $('#btnDomBatchZip').disabled = true;
  $('#btnDomSaveCat').disabled = true;
  S.busy++;

  try {
    const blobs = [];
    for (let i = 0; i < list.length; i++) {
      const no = list[i];
      renderDomainToCanvas(no, false);
      const blob = await new Promise((r) => $('#domainCanvas').toBlob(r, 'image/png'));
      blobs.push({ name: `${no}.png`, blob });
      $('div', bar).style.width = Math.round(((i + 1) / list.length) * 50) + '%';
    }

    if (mode === 'catalog') {
      const batchSize = 10;
      let added = 0;
      for (let i = 0; i < blobs.length; i += batchSize) {
        const chunk = blobs.slice(i, i + batchSize);
        const form = new FormData();
        form.append('categoryId', targetCatId || '');
        form.append('compress', 'balanced');
        form.append('meta', JSON.stringify(chunk.map((x) => ({ name: x.name, path: x.name }))));
        chunk.forEach((x) => form.append('files', x.blob, x.name));
        const res = await api('/api/images', { method: 'POST', form });
        added += res.added;
        $('div', bar).style.width = (50 + Math.round(((i + chunk.length) / blobs.length) * 50)) + '%';
      }
      toast(`✅ ${added} görsel kataloğa kaydedildi`, 'ok');
      await loadState();
    } else {
      const toolIds = [];
      const batchSize = 8;
      for (let i = 0; i < blobs.length; i += batchSize) {
        const chunk = blobs.slice(i, i + batchSize);
        const form = new FormData();
        form.append('opts', JSON.stringify({ compress: true, level: 'balanced', format: 'keep', resize: { enabled: false } }));
        form.append('names', JSON.stringify(chunk.map((x) => x.name)));
        chunk.forEach((x) => form.append('files', x.blob, x.name));
        const res = await api('/api/tools/process', { method: 'POST', form });
        res.results.forEach((r) => { if (r.id) toolIds.push(r.id); });
        $('div', bar).style.width = (50 + Math.round(((i + chunk.length) / blobs.length) * 50)) + '%';
      }
      if (toolIds.length) {
        location.href = '/api/tools/zip?ids=' + toolIds.join(',');
        toast(`📦 ${toolIds.length} görsel ZIP olarak indiriliyor`, 'ok');
      }
    }
  } catch (e) {
    toast('⚠ ' + esc(e.message), 'err');
  } finally {
    S.busy--;
    drawDomainPreview(true);
    $('#btnDomBatchZip').disabled = false;
    $('#btnDomSaveCat').disabled = false;
    setTimeout(() => { bar.hidden = true; }, 600);
  }
}

/* ---------- Başlat ---------- */
(async function init() {
  await loadState();
  route();
})();
