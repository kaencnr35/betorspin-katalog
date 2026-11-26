'use strict';
/**
 * Betorspin Katalog – Sunucu
 * - Rol & Yetki Sistemi: owner (Kurucu / En Üst Yetki), admin, editor, viewer (İzleyici)
 * - Profil & Avatar yükleme, şifreli (scrypt) hesaplar, HttpOnly oturum çerezleri
 * - IP tabanlı ve profil tabanlı yetkilendirme
 * - Canlı çevrimiçi kişiler (Anonim - X ve profiller)
 * - Admin Paneli: tüm işlem kayıtları (audit log), kullanıcı/IP yetkilendirme, engelleme (ban/kick)
 * - Görsel sıkıştırma, boyutlandırma (sharp) ve ZIP indirme
 */
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { ZipArchive } = require('archiver');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const passwords = require('./passwords');
const cloud = require('./cloud-sync');

const PORT = process.env.PORT || 3000;
const OWNER_INITIAL_PW = process.env.OWNER_PASSWORD || 'Betorspin2026!';
const OWNER_DEFAULT_IPS = (process.env.OWNER_IPS || '178.220.247.115,127.0.0.1,::1,10.192.8.201')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'db.json');
[UPLOAD_DIR, THUMB_DIR, AVATAR_DIR, TMP_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

sharp.cache(false);

/* ------------------------------------------------------------------ */
/* Veritabanı                                                          */
/* ------------------------------------------------------------------ */
let db = {
  rev: 1,
  categories: [],
  images: [],
  users: [],      // { id, username, name, pwHash, role: 'owner'|'admin'|'editor'|'viewer', avatar, lastIp, lastSeen, createdAt }
  sessions: {},   // sid -> { userId, ip, lastSeen, anonNum, createdAt, explicitLogout }
  ipRules: [],    // { id, ip, label, role: 'owner'|'admin'|'editor', createdBy, createdAt }
  bans: [],       // { id, type: 'user'|'ip', target, targetName, reason, createdBy, createdAt }
  logs: [],       // { id, ts, actorId, actorName, actorAvatar, actorRole, ip, action, detail }
};

function loadDbFromDisk() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...db, ...raw };
      db.users = db.users || [];
      db.sessions = db.sessions || {};
      db.ipRules = db.ipRules || [];
      db.bans = db.bans || [];
      db.logs = db.logs || [];
    } catch (e) {
      console.error('db.json okunamadı:', e);
    }
  }
}

function save(bumpRev = true) {
  if (bumpRev) db.rev++;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  cloud.syncDb(DB_FILE);
}

/* ------------------------------------------------------------------ */
/* Yardımcılar & Güvenlik                                              */
/* ------------------------------------------------------------------ */
const uid = () => crypto.randomBytes(6).toString('hex');
const genSid = () => crypto.randomBytes(32).toString('hex');
const sidKey = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16);
const sanitize = (s, max = 150) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, max);
const sanitizeUsername = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const ROLE_LABEL = { owner: 'Kurucu', admin: 'Admin', editor: 'Editör', viewer: 'İzleyici' };
const maxRole = (a, b) => ((ROLE_RANK[a] || 0) >= (ROLE_RANK[b] || 0) ? a : b);

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const ALLOWED = /\.(png|jpe?g|webp|gif)$/i;
const catById = (id) => db.categories.find((c) => c.id === id);
const normCat = (id) => (id && catById(id) ? id : null);
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const fixExt = (name, fmt) => {
  const ok = fmt === 'jpeg' ? /\.jpe?g$/i : new RegExp('\\.' + EXT[fmt] + '$', 'i');
  return ok.test(name) ? name : baseName(name) + '.' + EXT[fmt];
};
const filePath = (img) => path.join(UPLOAD_DIR, img.id + '.' + img.ext);
const thumbPath = (id) => path.join(THUMB_DIR, id + '.webp');
const avatarPath = (id) => path.join(AVATAR_DIR, id + '.webp');
const safeUnlink = (p) => fsp.unlink(p).catch(() => {});

function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  if (cf) return normalizeIp(String(cf).split(',')[0]);
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[0]);
  }
  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  });
  return out;
}

function setSessionCookie(req, res, sid) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `bk_sid=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${365 * 24 * 3600}`,
  ];
  if (isSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function ensureOwnerBootstrap() {
  let owner = db.users.find((u) => u.role === 'owner');
  let changed = false;
  if (!owner) {
    owner = {
      id: 'owner-kaan',
      username: 'kaan',
      name: 'Kaan',
      pwHash: await passwords.hash(OWNER_INITIAL_PW),
      role: 'owner',
      avatar: '',
      lastIp: '178.220.247.115',
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
    db.users.unshift(owner);
    changed = true;
  }
  for (const rawIp of OWNER_DEFAULT_IPS) {
    const ip = normalizeIp(rawIp);
    if (!ip) continue;
    if (!db.ipRules.some((r) => r.ip === ip)) {
      db.ipRules.push({
        id: uid(),
        ip,
        label: ip === '127.0.0.1' ? 'Yerel Bilgisayar (Kurucu)' : 'Kaan (Kurucu IP)',
        role: 'owner',
        createdBy: 'Sistem',
        createdAt: Date.now(),
      });
      changed = true;
    }
  }
  if (changed) save(false);
}

/* ------------------------------------------------------------------ */
/* Oturum, Yetki, Engelleme ve Çevrimiçi Takibi                        */
/* ------------------------------------------------------------------ */
const ONLINE_TTL_MS = 25 * 1000;

function addLog(req, action, detail) {
  const actor = req.auth || {};
  const entry = {
    id: uid(),
    ts: Date.now(),
    actorId: actor.user?.id || '',
    actorName: actor.name || 'Anonim',
    actorAvatar: actor.avatar || '',
    actorRole: actor.role || 'viewer',
    ip: actor.ip || getClientIp(req),
    action,
    detail: String(detail || '').slice(0, 500),
  };
  db.logs.unshift(entry);
  if (db.logs.length > 1000) db.logs.length = 1000;
}

function checkBan(userId, ip) {
  // Kurucu (owner) veya kurucu IP'si asla engellenemez
  if (userId) {
    const u = db.users.find((x) => x.id === userId);
    if (u && u.role === 'owner') return null;
  }
  const ipRule = db.ipRules.find((r) => r.ip === ip);
  if (ipRule && ipRule.role === 'owner') return null;

  if (userId) {
    const b = db.bans.find((x) => x.type === 'user' && x.target === userId);
    if (b) return b;
  }
  if (ip) {
    const b = db.bans.find((x) => x.type === 'ip' && x.target === ip);
    if (b) return b;
  }
  return null;
}

function resolveAuth(req, res) {
  const ip = getClientIp(req);
  const cookies = parseCookies(req);
  let sid = cookies.bk_sid;
  if (!sid || typeof sid !== 'string' || sid.length < 32 || sid.length > 128) {
    sid = genSid();
    setSessionCookie(req, res, sid);
  }
  let sess = db.sessions[sid];
  const now = Date.now();
  if (!sess) {
    sess = { userId: null, ip, lastSeen: now, createdAt: now, explicitLogout: false };
    db.sessions[sid] = sess;
  }
  sess.ip = ip;
  sess.lastSeen = now;

  const ipRule = db.ipRules.find((r) => r.ip === ip);
  const ownerUser = db.users.find((u) => u.role === 'owner');

  // Kurucu IP'sinden girildiğinde (ve özel olarak çıkış yapılmadıysa) otomatik Kurucu hesabına bağla
  if (!sess.userId && !sess.explicitLogout && ipRule && ipRule.role === 'owner' && ownerUser) {
    sess.userId = ownerUser.id;
  }

  let user = sess.userId ? db.users.find((u) => u.id === sess.userId) : null;
  if (sess.userId && !user) sess.userId = null;

  if (user) {
    user.lastIp = ip;
    user.lastSeen = now;
  }

  const ban = checkBan(user?.id, ip);
  const profileRole = user ? user.role : 'viewer';
  const ipRole = ipRule ? ipRule.role : 'viewer';
  const effectiveRole = maxRole(profileRole, ipRole);
  const rank = ROLE_RANK[effectiveRole] || 0;

  return {
    sid,
    sess,
    ip,
    user,
    ban,
    name: user ? user.name : '',
    username: user ? user.username : '',
    avatar: user ? user.avatar : '',
    profileRole,
    ipRole,
    role: effectiveRole,
    canEdit: !ban && rank >= ROLE_RANK.editor,
    canAdmin: !ban && rank >= ROLE_RANK.admin,
    isOwner: !ban && rank >= ROLE_RANK.owner,
    isAnon: !user,
  };
}

/** Çevrimiçi kişileri hesaplar (genel görünüm: IP sızdırmaz!) */
function getPublicPresence(mySid) {
  const now = Date.now();
  const activeSids = Object.entries(db.sessions)
    .filter(([, s]) => now - (s.lastSeen || 0) <= ONLINE_TTL_MS && !checkBan(s.userId, s.ip))
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

  const seenUsers = new Map(); // userId -> { id, name, avatar, role, isMe }
  const anonList = [];
  let myAnonLabel = '';

  for (const [sid, s] of activeSids) {
    const u = s.userId ? db.users.find((x) => x.id === s.userId) : null;
    const ipRule = db.ipRules.find((r) => r.ip === s.ip);
    const isMe = sid === mySid;
    if (u) {
      const role = maxRole(u.role, ipRule ? ipRule.role : 'viewer');
      const existing = seenUsers.get(u.id);
      if (!existing || isMe) {
        seenUsers.set(u.id, {
          id: u.id,
          name: u.name,
          avatar: u.avatar || '',
          role,
          roleLabel: ROLE_LABEL[role] || 'İzleyici',
          isMe: isMe || Boolean(existing?.isMe),
        });
      }
    } else {
      const idx = anonList.length + 1;
      const label = `Anonim - ${idx}`;
      anonList.push({ label, isMe });
      if (isMe) myAnonLabel = label;
    }
  }

  const users = [...seenUsers.values()].sort((a, b) => (ROLE_RANK[b.role] - ROLE_RANK[a.role]) || a.name.localeCompare(b.name, 'tr'));
  const anonCount = anonList.length;
  const totalOnline = users.length + anonCount;

  return {
    totalOnline,
    anonCount,
    anonSummary: anonCount > 0 ? `Anonim - ${anonCount}` : '',
    anonList,
    myAnonLabel,
    users,
  };
}

/* ------------------------------------------------------------------ */
/* Kategori & Görsel Yardımcıları                                      */
/* ------------------------------------------------------------------ */
function descendantIds(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of db.categories) {
      if (!out.has(c.id) && out.has(c.parentId)) { out.add(c.id); grew = true; }
    }
  }
  return out;
}

function uniqueImageName(categoryId, name, ignoreId) {
  const taken = new Set(db.images.filter((i) => i.categoryId === categoryId && i.id !== ignoreId).map((i) => i.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const m = name.match(/^(.*?)(\.[^.]+)?$/);
  for (let n = 2; ; n++) {
    const cand = `${m[1]} (${n})${m[2] || ''}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

function uniqueCategoryName(parentId, name, ignoreId) {
  const taken = new Set(db.categories.filter((c) => c.parentId === parentId && c.id !== ignoreId).map((c) => c.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  }
}

function ensureCategoryPath(parentId, segments) {
  let cur = parentId;
  for (const raw of segments) {
    const name = sanitize(raw);
    if (!name) continue;
    let found = db.categories.find((c) => c.parentId === cur && c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      found = { id: uid(), name, parentId: cur, createdAt: Date.now() };
      db.categories.push(found);
    }
    cur = found.id;
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* Görsel İşleme (sharp)                                               */
/* ------------------------------------------------------------------ */
const Q = {
  png: { high: 95, balanced: 85, small: 65 },
  jpeg: { none: 92, lossless: 95, high: 90, balanced: 82, small: 70 },
  webp: { none: 92, lossless: 95, high: 90, balanced: 80, small: 68 },
};

function encoder(img, fmt, level) {
  switch (fmt) {
    case 'png':
      if (level === 'none' || level === 'lossless') {
        return img.png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true });
      }
      return img.png({ palette: true, quality: Q.png[level], effort: 10, compressionLevel: 9, colours: 256, dither: 1 });
    case 'jpeg':
      return img.jpeg({
        quality: Q.jpeg[level], mozjpeg: true,
        chromaSubsampling: ['none', 'lossless', 'high'].includes(level) ? '4:4:4' : '4:2:0',
      });
    case 'webp':
      return img.webp({ quality: Q.webp[level], nearLossless: level === 'lossless', effort: 6, smartSubsample: true });
    case 'gif':
      return img.gif({ effort: 10 });
    default:
      throw new Error('Desteklenmeyen format');
  }
}

async function processImage(buf, opts = {}) {
  const meta = await sharp(buf, { limitInputPixels: false }).metadata();
  const srcFmt = meta.format;
  if (!EXT[srcFmt]) throw new Error('Desteklenmeyen format: ' + srcFmt);
  const swap = (meta.orientation || 1) >= 5;
  const ow = swap ? meta.height : meta.width;
  const oh = swap ? meta.width : meta.height;
  const pageH = meta.pageHeight || oh;

  const r = opts.resize || {};
  const wantResize = !!r.enabled;
  const fmtOpt = opts.format === 'jpg' ? 'jpeg' : opts.format;
  const target = fmtOpt && fmtOpt !== 'keep' && EXT[fmtOpt] ? fmtOpt : srcFmt;
  const level = opts.compress ? (['lossless', 'high', 'balanced', 'small'].includes(opts.level) ? opts.level : 'balanced') : 'none';
  const animated = (meta.pages || 1) > 1 && (target === 'webp' || target === 'gif');

  let img = sharp(buf, { animated, limitInputPixels: false }).rotate();
  const transparentBg = !r.background || r.background === 'transparent';

  let resized = false;
  if (wantResize) {
    let w = Math.round(+r.width) || 0;
    let h = Math.round(+r.height) || 0;
    if (+r.percent > 0) { w = Math.round((ow * r.percent) / 100); h = Math.round((pageH * r.percent) / 100); }
    if (w || h) {
      const fit = ['inside', 'cover', 'contain', 'fill'].includes(r.fit) ? r.fit : 'inside';
      img = img.resize({
        width: w || undefined,
        height: h || undefined,
        fit,
        position: fit === 'cover' && r.position === 'attention' ? sharp.strategy.attention : 'centre',
        background: transparentBg ? { r: 0, g: 0, b: 0, alpha: 0 } : r.background,
        withoutEnlargement: !!r.noUpscale,
        kernel: 'lanczos3',
      });
      resized = true;
    }
  }
  if (target === 'jpeg') img = img.flatten({ background: transparentBg ? '#ffffff' : r.background });

  const noChangeRequested = !resized && target === srcFmt && level === 'none';
  if (noChangeRequested) return { buffer: buf, fmt: srcFmt, width: ow, height: pageH, srcWidth: ow, srcHeight: pageH, unchanged: true };

  const { data, info } = await encoder(img, target, level).toBuffer({ resolveWithObject: true });
  if (!resized && target === srcFmt && data.length >= buf.length) {
    return { buffer: buf, fmt: srcFmt, width: ow, height: pageH, srcWidth: ow, srcHeight: pageH, unchanged: true };
  }
  return { buffer: data, fmt: target, width: info.width, height: info.pageHeight || info.height, srcWidth: ow, srcHeight: pageH, unchanged: false };
}

async function makeThumb(buf, id) {
  try {
    const p = thumbPath(id);
    await sharp(buf, { limitInputPixels: false })
      .rotate()
      .resize(520, 520, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(p);
    cloud.syncFileUp(p, `thumbs/${id}.webp`);
  } catch (e) {
    console.error('Önizleme üretilemedi:', e.message);
  }
}

async function storeImage({ buf, fmt, name, categoryId, user, width, height }) {
  if (!width || !height) {
    const m = await sharp(buf, { limitInputPixels: false }).metadata();
    width = (m.orientation || 1) >= 5 ? m.height : m.width;
    height = (m.orientation || 1) >= 5 ? m.width : m.pageHeight || m.height;
  }
  const id = uid();
  const rec = {
    id, categoryId,
    name: uniqueImageName(categoryId, fixExt(name, fmt)),
    ext: EXT[fmt], format: EXT[fmt], width, height, size: buf.length,
    addedBy: user || '', createdAt: Date.now(), updatedAt: Date.now(),
  };
  const fp = filePath(rec);
  await fsp.writeFile(fp, buf);
  cloud.syncFileUp(fp, `uploads/${rec.id}.${rec.ext}`);
  await makeThumb(buf, id);
  db.images.push(rec);
  return rec;
}

async function deleteImageFiles(img) {
  await safeUnlink(filePath(img));
  await safeUnlink(thumbPath(img.id));
  cloud.syncFileDel(`uploads/${img.id}.${img.ext}`);
  cloud.syncFileDel(`thumbs/${img.id}.webp`);
}

/* ------------------------------------------------------------------ */
/* Express & Güvenlik Katmanları                                       */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Güvenlik başlıkları
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '5mb' }));
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 300 * 1024 * 1024, files: 300 } });
const avatarUpload = multer({ dest: TMP_DIR, limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

// Oturum ve engelleme kontrolü
app.use((req, res, next) => {
  req.auth = resolveAuth(req, res);
  if (req.auth.ban && (req.path.startsWith('/api') || req.path.startsWith('/files') || req.path.startsWith('/thumbs'))) {
    return res.status(403).json({
      error: 'Siteden uzaklaştırıldınız (Erişiminiz engellendi).',
      banned: true,
      reason: req.auth.ban.reason || 'Yönetici tarafından engellendi.',
    });
  }
  next();
});

function requireEdit(req, res, next) {
  if (!req.auth.canEdit) {
    return res.status(403).json({ error: 'Bu işlem için düzenleme yetkiniz yok. Yöneticiden yetki isteyin.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth.canAdmin) {
    return res.status(403).json({ error: 'Bu alan yalnızca Admin ve Kurucu yetkisine açıktır.' });
  }
  next();
}

// Brute-force koruması (giriş denemeleri)
const loginAttempts = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) return true;
  return rec.count < 12;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
  else rec.count++;
}

app.use('/files', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true, dotfiles: 'allow' }));
app.use('/thumbs', express.static(THUMB_DIR, { maxAge: '365d', immutable: true, dotfiles: 'allow' }));
app.use('/avatars', express.static(AVATAR_DIR, { maxAge: '7d', dotfiles: 'allow' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- Genel Durum, Senkron & Profil ---- */
function publicMe(auth) {
  return {
    id: auth.user?.id || null,
    username: auth.username || '',
    name: auth.name || '',
    avatar: auth.avatar || '',
    role: auth.role,
    roleLabel: ROLE_LABEL[auth.role] || 'İzleyici',
    canEdit: auth.canEdit,
    canAdmin: auth.canAdmin,
    isOwner: auth.isOwner,
    isAnon: auth.isAnon,
  };
}

app.get('/api/rev', (req, res) => {
  res.json({
    rev: db.rev,
    me: publicMe(req.auth),
    presence: getPublicPresence(req.auth.sid),
  });
});

app.get('/api/state', (req, res) => {
  res.json({
    rev: db.rev,
    me: publicMe(req.auth),
    presence: getPublicPresence(req.auth.sid),
    categories: db.categories,
    images: db.images,
  });
});

/* ---- Kimlik Doğrulama & Profil ---- */
app.post('/api/auth/login', async (req, res) => {
  const ip = req.auth.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Çok fazla başarısız giriş denemesi. Lütfen 10 dakika sonra tekrar deneyin.' });
  }
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const user = db.users.find((u) => u.username === username || u.name.toLowerCase() === String(req.body.username || '').trim().toLowerCase());
  if (!user || !user.pwHash || !(await passwords.verify(password, user.pwHash))) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  const ban = checkBan(user.id, ip);
  if (ban) return res.status(403).json({ error: 'Bu hesap engellenmiş.', banned: true, reason: ban.reason });

  req.auth.sess.userId = user.id;
  req.auth.sess.explicitLogout = false;
  user.lastIp = ip;
  user.lastSeen = Date.now();

  // Kurucu yeni bir IP'den giriş yaptıysa o IP'yi otomatik olarak Kurucu IP'lerine ekle
  if (user.role === 'owner' && !db.ipRules.some((r) => r.ip === ip)) {
    db.ipRules.push({
      id: uid(),
      ip,
      label: 'Kaan (Otomatik Kurucu IP)',
      role: 'owner',
      createdBy: user.name,
      createdAt: Date.now(),
    });
  }

  req.auth = resolveAuth(req, res);
  addLog(req, 'Giriş', `“${user.name}” (${ROLE_LABEL[req.auth.role]}) hesabına giriş yaptı`);
  save(false);
  res.json({ me: publicMe(req.auth) });
});

app.post('/api/auth/register', async (req, res) => {
  const name = sanitize(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Görünen ad gerekli.' });
  let username = sanitizeUsername(req.body.username || name);
  if (username.length < 2) username = 'uye_' + uid().slice(0, 6);
  if (db.users.some((u) => u.username === username)) {
    return res.status(400).json({ error: 'Bu kullanıcı adı zaten kullanılıyor. Başka bir kullanıcı adı seçin.' });
  }
  const pw = String(req.body.password || '');
  if (pw && pw.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });

  const user = {
    id: uid(),
    username,
    name,
    pwHash: pw ? await passwords.hash(pw) : '',
    role: 'viewer',
    avatar: '',
    lastIp: req.auth.ip,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  db.users.push(user);
  req.auth.sess.userId = user.id;
  req.auth.sess.explicitLogout = false;
  req.auth = resolveAuth(req, res);
  addLog(req, 'Profil Oluşturma', `“${user.name}” (@${user.username}) profilini oluşturdu`);
  save(false);
  res.json({ me: publicMe(req.auth) });
});

app.post('/api/auth/logout', (req, res) => {
  req.auth.sess.userId = null;
  req.auth.sess.explicitLogout = true;
  req.auth = resolveAuth(req, res);
  save(false);
  res.json({ me: publicMe(req.auth) });
});

app.patch('/api/profile', async (req, res) => {
  const name = sanitize(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Görünen ad boş olamaz.' });
  let user = req.auth.user;

  if (!user) {
    // Anonim kullanıcı ilk kez profil adı kaydediyor
    let baseU = sanitizeUsername(req.body.username || name) || 'uye';
    let username = baseU;
    for (let n = 2; db.users.some((u) => u.username === username); n++) username = `${baseU}${n}`;
    user = {
      id: uid(),
      username,
      name,
      pwHash: req.body.password ? await passwords.hash(String(req.body.password)) : '',
      role: 'viewer',
      avatar: '',
      lastIp: req.auth.ip,
      lastSeen: Date.now(),
      createdAt: Date.now(),
    };
    db.users.push(user);
    req.auth.sess.userId = user.id;
    req.auth.sess.explicitLogout = false;
    req.auth = resolveAuth(req, res);
    addLog(req, 'Profil Oluşturma', `“${user.name}” profil oluşturdu`);
  } else {
    const oldName = user.name;
    user.name = name;
    if (req.body.username) {
      const uName = sanitizeUsername(req.body.username);
      if (uName.length >= 2 && !db.users.some((u) => u.id !== user.id && u.username === uName)) {
        user.username = uName;
      }
    }
    if (req.body.password) {
      if (String(req.body.password).length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });
      user.pwHash = await passwords.hash(String(req.body.password));
    }
    req.auth = resolveAuth(req, res);
    addLog(req, 'Profil Güncelleme', oldName !== name ? `Adını “${oldName}” → “${name}” olarak güncelledi` : 'Profil bilgilerini güncelledi');
  }
  save(false);
  res.json({ me: publicMe(req.auth) });
});

app.post('/api/profile/avatar', avatarUpload.single('avatar'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Görsel seçilmedi.' });
  try {
    let user = req.auth.user;
    if (!user) {
      const uname = 'uye_' + uid().slice(0, 6);
      user = {
        id: uid(), username: uname, name: 'Üye', pwHash: '', role: 'viewer',
        avatar: '', lastIp: req.auth.ip, lastSeen: Date.now(), createdAt: Date.now(),
      };
      db.users.push(user);
      req.auth.sess.userId = user.id;
      req.auth.sess.explicitLogout = false;
    }
    const buf = await fsp.readFile(f.path);
    const outPath = avatarPath(user.id);
    await sharp(buf, { limitInputPixels: false })
      .rotate()
      .resize(160, 160, { fit: 'cover', position: 'centre' })
      .webp({ quality: 84 })
      .toFile(outPath);
    cloud.syncFileUp(outPath, `avatars/${user.id}.webp`);
    user.avatar = `/avatars/${user.id}.webp?v=${Date.now()}`;
    req.auth = resolveAuth(req, res);
    addLog(req, 'Profil Fotoğrafı', 'Profil fotoğrafını güncelledi');
    save(false);
    res.json({ me: publicMe(req.auth) });
  } catch (e) {
    res.status(400).json({ error: 'Geçerli bir görsel yükleyin.' });
  } finally {
    await safeUnlink(f.path);
  }
});

app.delete('/api/profile/avatar', async (req, res) => {
  const user = req.auth.user;
  if (!user) return res.status(400).json({ error: 'Profil bulunamadı.' });
  await safeUnlink(avatarPath(user.id));
  cloud.syncFileDel(`avatars/${user.id}.webp`);
  user.avatar = '';
  req.auth = resolveAuth(req, res);
  addLog(req, 'Profil Fotoğrafı', 'Profil fotoğrafını kaldırdı');
  save(false);
  res.json({ me: publicMe(req.auth) });
});

/* ---- Admin Paneli API'leri ---- */
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const now = Date.now();
  const activeSids = Object.entries(db.sessions)
    .filter(([, s]) => now - (s.lastSeen || 0) <= ONLINE_TTL_MS);

  const onlineUserIds = new Set(activeSids.map(([, s]) => s.userId).filter(Boolean));

  const users = db.users.map((u) => {
    const ipRule = db.ipRules.find((r) => r.ip === u.lastIp);
    const eff = maxRole(u.role, ipRule ? ipRule.role : 'viewer');
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      avatar: u.avatar || '',
      role: u.role,
      effectiveRole: eff,
      roleLabel: ROLE_LABEL[eff] || 'İzleyici',
      hasPassword: Boolean(u.pwHash),
      lastIp: u.lastIp || '',
      lastSeen: u.lastSeen || u.createdAt,
      createdAt: u.createdAt,
      online: onlineUserIds.has(u.id),
      banned: db.bans.some((b) => (b.type === 'user' && b.target === u.id) || (b.type === 'ip' && b.target === u.lastIp)),
    };
  }).sort((a, b) => (ROLE_RANK[b.role] - ROLE_RANK[a.role]) || (b.online - a.online) || (b.lastSeen - a.lastSeen));

  let anonIdx = 0;
  const seenOnlineUsers = new Map();
  const onlineSessions = [];
  for (const [sid, s] of activeSids.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))) {
    const u = s.userId ? db.users.find((x) => x.id === s.userId) : null;
    const ipRule = db.ipRules.find((r) => r.ip === s.ip);
    const role = maxRole(u ? u.role : 'viewer', ipRule ? ipRule.role : 'viewer');
    const isAnon = !u;
    const isMe = sid === req.auth.sid;
    if (u) {
      if (seenOnlineUsers.has(u.id)) {
        if (isMe) seenOnlineUsers.get(u.id).isMe = true;
        continue;
      }
      const row = {
        sidHash: sidKey(sid),
        userId: u.id,
        name: u.name,
        username: u.username,
        avatar: u.avatar || '',
        role,
        roleLabel: ROLE_LABEL[role] || 'İzleyici',
        ip: s.ip || '',
        lastSeen: s.lastSeen,
        isAnon: false,
        isMe,
      };
      seenOnlineUsers.set(u.id, row);
      onlineSessions.push(row);
    } else {
      anonIdx++;
      onlineSessions.push({
        sidHash: sidKey(sid),
        userId: null,
        name: `Anonim - ${anonIdx}`,
        username: '',
        avatar: '',
        role,
        roleLabel: ROLE_LABEL[role] || 'İzleyici',
        ip: s.ip || '',
        lastSeen: s.lastSeen,
        isAnon: true,
        isMe,
      });
    }
  }

  res.json({
    me: publicMe(req.auth),
    myIp: req.auth.ip,
    users,
    onlineSessions,
    ipRules: db.ipRules,
    bans: db.bans,
    logs: db.logs.slice(0, 400),
  });
});

// Admin panelinden yeni yetkili kullanıcı oluşturma
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const name = sanitize(req.body.name, 40);
  const username = sanitizeUsername(req.body.username || name);
  const password = String(req.body.password || '').trim();
  const role = req.body.role || 'editor';
  if (!name || !username) return res.status(400).json({ error: 'Ad ve kullanıcı adı gerekli.' });
  if (db.users.some((u) => u.username === username)) return res.status(400).json({ error: 'Bu kullanıcı adı zaten mevcut.' });
  if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Geçersiz yetki.' });
  if (role === 'admin' && !req.auth.isOwner) {
    return res.status(403).json({ error: 'Yeni Admin atama yetkisi yalnızca Kurucu (En Üst Yetki) hesabına aittir.' });
  }
  const user = {
    id: uid(),
    username,
    name,
    pwHash: password ? await passwords.hash(password) : '',
    role,
    avatar: '',
    lastIp: '',
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  db.users.push(user);
  addLog(req, 'Yetkili Oluşturma', `“${user.name}” (@${user.username}) profilini ${ROLE_LABEL[role]} yetkisiyle oluşturdu`);
  save(false);
  res.json({ ok: true, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

// Kullanıcı yetkisini veya bilgilerini güncelleme
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.role === 'owner') {
    return res.status(403).json({ error: 'Kurucu (En Üst Yetki) hesabının yetkisi değiştirilemez.' });
  }
  if (target.role === 'admin' && !req.auth.isOwner) {
    return res.status(403).json({ error: 'Bir Admin hesabını yalnızca Kurucu düzenleyebilir.' });
  }
  const changes = [];
  if ('role' in req.body) {
    const newRole = req.body.role;
    if (!['viewer', 'editor', 'admin'].includes(newRole)) return res.status(400).json({ error: 'Geçersiz yetki.' });
    if (newRole === 'admin' && !req.auth.isOwner) {
      return res.status(403).json({ error: 'Admin yetkisini yalnızca Kurucu verebilir.' });
    }
    if (target.role !== newRole) {
      changes.push(`yetkisini ${ROLE_LABEL[target.role]} → ${ROLE_LABEL[newRole]} yaptı`);
      target.role = newRole;
    }
  }
  if ('name' in req.body) {
    const n = sanitize(req.body.name, 40);
    if (n && n !== target.name) { changes.push(`adını “${target.name}” → “${n}” yaptı`); target.name = n; }
  }
  if (req.body.password) {
    target.pwHash = await passwords.hash(String(req.body.password));
    changes.push('şifresini sıfırladı');
  }
  if (changes.length) {
    addLog(req, 'Yetki / Profil Değişikliği', `“${target.name}” kullanıcısının ${changes.join(', ')}`);
    save(false);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Kurucu hesabı silinemez.' });
  if (target.role === 'admin' && !req.auth.isOwner) return res.status(403).json({ error: 'Admin hesabını yalnızca Kurucu silebilir.' });

  await safeUnlink(avatarPath(target.id));
  cloud.syncFileDel(`avatars/${target.id}.webp`);
  for (const s of Object.values(db.sessions)) if (s.userId === target.id) s.userId = null;
  db.users = db.users.filter((u) => u.id !== target.id);
  addLog(req, 'Kullanıcı Silme', `“${target.name}” (@${target.username}) profilini sildi`);
  save(false);
  res.json({ ok: true });
});

// Çevrimiçi bir oturuma (anonim olsa bile) anında yetki verme
app.post('/api/admin/sessions/grant', requireAdmin, (req, res) => {
  const { sidHash, role, mode = 'ip' } = req.body;
  if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Geçersiz yetki.' });
  if (role === 'admin' && !req.auth.isOwner) return res.status(403).json({ error: 'Admin yetkisini yalnızca Kurucu verebilir.' });

  const entry = Object.entries(db.sessions).find(([sid]) => sidKey(sid) === sidHash);
  if (!entry) return res.status(404).json({ error: 'Oturum bulunamadı.' });
  const [, sess] = entry;

  if (mode === 'profile' || sess.userId) {
    let u = sess.userId ? db.users.find((x) => x.id === sess.userId) : null;
    if (!u) {
      const uname = 'ekip_' + uid().slice(0, 5);
      u = { id: uid(), username: uname, name: 'Ekip Üyesi', pwHash: '', role, avatar: '', lastIp: sess.ip, lastSeen: Date.now(), createdAt: Date.now() };
      db.users.push(u);
      sess.userId = u.id;
    } else {
      if (u.role === 'owner') return res.status(403).json({ error: 'Kurucu değiştirilemez.' });
      u.role = role;
    }
    addLog(req, 'Yetki Değişikliği', `Çevrimiçi “${u.name}” kullanıcısına ${ROLE_LABEL[role]} yetkisi verdi`);
  }
  if (mode === 'ip' && sess.ip) {
    let rule = db.ipRules.find((r) => r.ip === sess.ip);
    if (rule && rule.role === 'owner') return res.status(403).json({ error: 'Kurucu IP kuralı değiştirilemez.' });
    if (role === 'viewer') {
      db.ipRules = db.ipRules.filter((r) => r.ip !== sess.ip);
    } else if (rule) {
      rule.role = role;
    } else {
      db.ipRules.push({ id: uid(), ip: sess.ip, label: 'Çevrimiçi Yetkilendirme', role, createdBy: req.auth.name || 'Admin', createdAt: Date.now() });
    }
    addLog(req, 'IP Yetkilendirme', `${sess.ip} IP adresine ${ROLE_LABEL[role]} yetkisi verdi`);
  }
  save(false);
  res.json({ ok: true });
});

// IP Yetkilendirme Kuralları
app.post('/api/admin/ip-rules', requireAdmin, (req, res) => {
  const ip = normalizeIp(req.body.ip);
  const label = sanitize(req.body.label || 'Yetkili IP', 60);
  const role = req.body.role || 'editor';
  if (!ip) return res.status(400).json({ error: 'Geçerli bir IP adresi girin.' });
  if (!['editor', 'admin', 'owner'].includes(role)) return res.status(400).json({ error: 'Geçersiz yetki.' });
  if ((role === 'admin' || role === 'owner') && !req.auth.isOwner) {
    return res.status(403).json({ error: 'IP adresine Admin yetkisini yalnızca Kurucu verebilir.' });
  }
  let existing = db.ipRules.find((r) => r.ip === ip);
  if (existing) {
    if (existing.role === 'owner' && !req.auth.isOwner) return res.status(403).json({ error: 'Kurucu IP kuralı değiştirilemez.' });
    existing.role = role;
    existing.label = label;
  } else {
    db.ipRules.push({
      id: uid(),
      ip,
      label,
      role,
      createdBy: req.auth.name || 'Admin',
      createdAt: Date.now(),
    });
  }
  addLog(req, 'IP Yetkilendirme', `${ip} (${label}) IP adresine ${ROLE_LABEL[role]} yetkisi tanımladı`);
  save(false);
  res.json({ ok: true });
});

app.delete('/api/admin/ip-rules/:id', requireAdmin, (req, res) => {
  const rule = db.ipRules.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı.' });
  if ((rule.role === 'owner' || rule.role === 'admin') && !req.auth.isOwner) {
    return res.status(403).json({ error: 'Bu IP yetkisini yalnızca Kurucu kaldırabilir.' });
  }
  db.ipRules = db.ipRules.filter((r) => r.id !== rule.id);
  addLog(req, 'IP Yetki Kaldırma', `${rule.ip} (${rule.label}) IP yetkisini kaldırdı`);
  save(false);
  res.json({ ok: true });
});

// Engelleme (Ban / Uzaklaştırma)
app.post('/api/admin/bans', requireAdmin, (req, res) => {
  const userId = req.body.userId || null;
  const ip = req.body.ip ? normalizeIp(req.body.ip) : null;
  const reason = sanitize(req.body.reason || 'Yönetici tarafından siteden uzaklaştırıldı', 140);
  if (!userId && !ip) return res.status(400).json({ error: 'Engellenecek kullanıcı veya IP seçilmeli.' });

  if (userId) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    if (u.role === 'owner') return res.status(403).json({ error: 'Kurucu engellenemez.' });
    if (u.role === 'admin' && !req.auth.isOwner) return res.status(403).json({ error: 'Bir Admini yalnızca Kurucu engelleyebilir.' });
    if (u.id === req.auth.user?.id) return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz.' });
    if (!db.bans.some((b) => b.type === 'user' && b.target === u.id)) {
      db.bans.unshift({
        id: uid(), type: 'user', target: u.id, targetName: `${u.name} (@${u.username})`,
        reason, createdBy: req.auth.name || 'Admin', createdAt: Date.now(),
      });
    }
    addLog(req, 'Kullanıcı Engelleme', `“${u.name}” kullanıcısını siteden uzaklaştırdı (${reason})`);
  }

  if (ip) {
    if (ip === req.auth.ip) return res.status(400).json({ error: 'Kendi IP adresinizi engelleyemezsiniz.' });
    const rule = db.ipRules.find((r) => r.ip === ip);
    if (rule && rule.role === 'owner') return res.status(403).json({ error: 'Kurucu IP adresi engellenemez.' });
    if (rule && rule.role === 'admin' && !req.auth.isOwner) return res.status(403).json({ error: 'Admin IP adresini yalnızca Kurucu engelleyebilir.' });
    // Bu IP'deki admin yetkilerini de kontrol et
    if (!db.bans.some((b) => b.type === 'ip' && b.target === ip)) {
      db.bans.unshift({
        id: uid(), type: 'ip', target: ip, targetName: req.body.targetName ? `${ip} (${sanitize(req.body.targetName, 40)})` : ip,
        reason, createdBy: req.auth.name || 'Admin', createdAt: Date.now(),
      });
    }
    addLog(req, 'IP Engelleme', `${ip} IP adresini siteden uzaklaştırdı (${reason})`);
  }

  save(false);
  res.json({ ok: true });
});

app.delete('/api/admin/bans/:id', requireAdmin, (req, res) => {
  const ban = db.bans.find((b) => b.id === req.params.id);
  if (!ban) return res.status(404).json({ error: 'Engel kaydı bulunamadı.' });
  db.bans = db.bans.filter((b) => b.id !== ban.id);
  addLog(req, 'Engel Kaldırma', `${ban.targetName} üzerindeki engeli kaldırdı`);
  save(false);
  res.json({ ok: true });
});

/* ---- Kategoriler (Düzenleme Yetkisi Gerekir) ---- */
app.post('/api/categories', requireEdit, (req, res) => {
  const name = sanitize(req.body.name);
  if (!name) return res.status(400).json({ error: 'Kategori adı gerekli' });
  const parentId = normCat(req.body.parentId);
  const parent = parentId ? catById(parentId) : null;
  const cat = { id: uid(), name: uniqueCategoryName(parentId, name), parentId, createdAt: Date.now() };
  db.categories.push(cat);
  addLog(req, 'Kategori Oluşturma', `“${cat.name}” kategorisini ${parent ? `“${parent.name}” içine` : 'ana dizine'} oluşturdu`);
  save();
  res.json(cat);
});

app.patch('/api/categories/:id', requireEdit, (req, res) => {
  const cat = catById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Kategori bulunamadı' });
  const oldName = cat.name;
  const oldParent = cat.parentId;
  let parentId = cat.parentId;
  if ('parentId' in req.body) {
    parentId = normCat(req.body.parentId);
    if (parentId && descendantIds(cat.id).has(parentId)) return res.status(400).json({ error: 'Kategori kendi içine taşınamaz' });
  }
  const name = 'name' in req.body ? sanitize(req.body.name) : cat.name;
  if (!name) return res.status(400).json({ error: 'Kategori adı gerekli' });
  cat.parentId = parentId;
  cat.name = uniqueCategoryName(parentId, name, cat.id);
  if (oldName !== cat.name) addLog(req, 'Kategori Adlandırma', `“${oldName}” kategorisinin adını “${cat.name}” yaptı`);
  if (oldParent !== parentId) {
    const destName = parentId ? catById(parentId)?.name : 'Ana dizin';
    addLog(req, 'Kategori Taşıma', `“${cat.name}” kategorisini “${destName}” içine taşıdı`);
  }
  save();
  res.json(cat);
});

app.delete('/api/categories/:id', requireEdit, async (req, res) => {
  const cat = catById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Kategori bulunamadı' });
  if (req.query.mode === 'promote') {
    db.categories.forEach((c) => { if (c.parentId === cat.id) c.parentId = cat.parentId; });
    db.images.forEach((i) => { if (i.categoryId === cat.id) i.categoryId = cat.parentId; });
    db.categories = db.categories.filter((c) => c.id !== cat.id);
    addLog(req, 'Kategori Silme', `“${cat.name}” kategorisini sildi (içindekiler üst kategoriye aktarıldı)`);
  } else {
    const ids = descendantIds(cat.id);
    const doomed = db.images.filter((i) => ids.has(i.categoryId));
    await Promise.all(doomed.map(deleteImageFiles));
    db.images = db.images.filter((i) => !ids.has(i.categoryId));
    db.categories = db.categories.filter((c) => !ids.has(c.id));
    addLog(req, 'Kategori Silme', `“${cat.name}” kategorisini ve içindeki ${doomed.length} görseli sildi`);
  }
  save();
  res.json({ ok: true });
});

/* ---- Görseller ---- */
app.post('/api/images', requireEdit, upload.array('files'), async (req, res) => {
  const files = req.files || [];
  try {
    const meta = JSON.parse(req.body.meta || '[]');
    const baseCat = normCat(req.body.categoryId || null);
    const level = ['lossless', 'high', 'balanced', 'small'].includes(req.body.compress) ? req.body.compress : null;
    const user = req.auth.name || 'Yetkili';
    const added = [];
    const skipped = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const m = meta[i] || {};
      const rel = String(m.path || m.name || f.originalname).replace(/\\/g, '/');
      const segs = rel.split('/').filter(Boolean);
      const fileName = sanitize(segs.pop() || '');
      if (!ALLOWED.test(fileName)) { skipped.push(fileName || rel); continue; }
      try {
        let buf = await fsp.readFile(f.path);
        let fmt = (await sharp(buf, { limitInputPixels: false }).metadata()).format;
        if (!EXT[fmt]) throw new Error('format');
        let width, height;
        if (level) {
          const r = await processImage(buf, { compress: true, level });
          buf = r.buffer; fmt = r.fmt; width = r.width; height = r.height;
        }
        const categoryId = segs.length ? ensureCategoryPath(baseCat, segs) : baseCat;
        added.push(await storeImage({ buf, fmt, name: fileName, categoryId, user, width, height }));
      } catch (e) {
        skipped.push(fileName);
      }
    }
    if (added.length) {
      const catName = baseCat ? catById(baseCat)?.name : 'Ana dizin';
      const sampleNames = added.slice(0, 3).map((x) => x.name).join(', ') + (added.length > 3 ? '…' : '');
      addLog(req, 'Görsel Yükleme', `“${catName}” hedefinde ${added.length} görsel yükledi (${sampleNames})`);
    }
    save();
    res.json({ added: added.length, skipped });
  } finally {
    await Promise.all(files.map((f) => safeUnlink(f.path)));
  }
});

app.patch('/api/images/:id', requireEdit, (req, res) => {
  const img = db.images.find((i) => i.id === req.params.id);
  if (!img) return res.status(404).json({ error: 'Görsel bulunamadı' });
  const oldName = img.name;
  const oldCat = img.categoryId;
  if ('categoryId' in req.body) img.categoryId = normCat(req.body.categoryId);
  if ('name' in req.body) {
    let name = sanitize(req.body.name);
    if (!name) return res.status(400).json({ error: 'Ad gerekli' });
    if (!ALLOWED.test(name)) name += '.' + img.ext;
    img.name = name;
  }
  img.name = uniqueImageName(img.categoryId, img.name, img.id);
  if (oldName !== img.name) addLog(req, 'Görsel Adlandırma', `“${oldName}” görselinin adını “${img.name}” yaptı`);
  if (oldCat !== img.categoryId) {
    const dest = img.categoryId ? catById(img.categoryId)?.name : 'Ana dizin';
    addLog(req, 'Görsel Taşıma', `“${img.name}” görselini “${dest}” kategorisine taşıdı`);
  }
  save();
  res.json(img);
});

app.post('/api/images/move', requireEdit, (req, res) => {
  const ids = new Set(req.body.ids || []);
  const categoryId = normCat(req.body.categoryId);
  let moved = 0;
  for (const img of db.images) {
    if (ids.has(img.id)) {
      img.categoryId = categoryId;
      img.name = uniqueImageName(categoryId, img.name, img.id);
      moved++;
    }
  }
  if (moved) {
    const dest = categoryId ? catById(categoryId)?.name : 'Ana dizin';
    addLog(req, 'Görsel Taşıma', `${moved} görseli “${dest}” kategorisine taşıdı`);
  }
  save();
  res.json({ ok: true });
});

app.delete('/api/images', requireEdit, async (req, res) => {
  const ids = new Set(req.body.ids || []);
  const doomed = db.images.filter((i) => ids.has(i.id));
  await Promise.all(doomed.map(deleteImageFiles));
  db.images = db.images.filter((i) => !ids.has(i.id));
  if (doomed.length) {
    const sample = doomed.slice(0, 3).map((x) => x.name).join(', ') + (doomed.length > 3 ? '…' : '');
    addLog(req, 'Görsel Silme', `${doomed.length} görseli sildi (${sample})`);
  }
  save();
  res.json({ deleted: doomed.length });
});

app.post('/api/images/process', requireEdit, async (req, res) => {
  const { ids = [], opts = {}, mode = 'replace' } = req.body;
  const user = req.auth.name || 'Yetkili';
  const results = [];
  for (const id of ids) {
    const img = db.images.find((i) => i.id === id);
    if (!img) continue;
    const before = img.size;
    try {
      const buf = await fsp.readFile(filePath(img));
      const r = await processImage(buf, opts);
      if (r.unchanged) { results.push({ id, name: img.name, before, after: before, unchanged: true }); continue; }
      if (mode === 'copy') {
        const suffix = opts.resize && opts.resize.enabled ? `-${r.width}x${r.height}` : '-min';
        const rec = await storeImage({
          buf: r.buffer, fmt: r.fmt, name: baseName(img.name) + suffix + '.' + EXT[r.fmt],
          categoryId: img.categoryId, user, width: r.width, height: r.height,
        });
        results.push({ id, newId: rec.id, name: rec.name, before, after: rec.size, width: rec.width, height: rec.height });
      } else {
        const oldPath = filePath(img);
        const oldExt = img.ext;
        const newExt = EXT[r.fmt];
        if (newExt !== oldExt) {
          await safeUnlink(oldPath);
          cloud.syncFileDel(`uploads/${img.id}.${oldExt}`);
          img.name = fixExt(img.name, r.fmt);
        }
        img.ext = newExt; img.format = newExt;
        img.width = r.width; img.height = r.height; img.size = r.buffer.length; img.updatedAt = Date.now();
        img.name = uniqueImageName(img.categoryId, img.name, img.id);
        const newPath = filePath(img);
        await fsp.writeFile(newPath, r.buffer);
        cloud.syncFileUp(newPath, `uploads/${img.id}.${img.ext}`);
        await makeThumb(r.buffer, img.id);
        results.push({ id, name: img.name, before, after: img.size, width: img.width, height: img.height });
      }
    } catch (e) {
      results.push({ id, name: img.name, before, error: e.message });
    }
  }
  addLog(req, 'Görsel İşleme', `${results.length} görsel üzerinde sıkıştırma/boyutlandırma yaptı (${mode === 'copy' ? 'yeni kopya' : 'üzerine yazma'})`);
  save();
  res.json({ results });
});

app.get('/api/images/:id/download', (req, res) => {
  const img = db.images.find((i) => i.id === req.params.id);
  if (!img) return res.status(404).end();
  res.download(filePath(img), img.name, { dotfiles: 'allow' });
});

/* ---- ZIP ---- */
function startZip(res, zipName) {
  const archive = new ZipArchive({ store: true });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}.zip`);
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  return archive;
}

app.get('/api/zip', async (req, res) => {
  const ids = new Set(String(req.query.ids || '').split(',').filter(Boolean));
  const imgs = db.images.filter((i) => ids.has(i.id));
  if (!imgs.length) return res.status(404).json({ error: 'Görsel yok' });
  const archive = startZip(res, sanitize(req.query.name) || 'gorseller');
  for (const img of imgs) archive.file(filePath(img), { name: img.name });
  await archive.finalize();
});

app.get('/api/categories/:id/zip', async (req, res) => {
  const root = req.params.id === 'root' ? null : catById(req.params.id);
  if (req.params.id !== 'root' && !root) return res.status(404).end();
  const archive = startZip(res, root ? sanitize(root.name) : 'tum-gorseller');
  const walk = (catId, prefix) => {
    db.images.filter((i) => i.categoryId === catId).forEach((i) => archive.file(filePath(i), { name: prefix + i.name }));
    db.categories.filter((c) => c.parentId === catId).forEach((c) => walk(c.id, prefix + sanitize(c.name) + '/'));
  };
  walk(root ? root.id : null, '');
  await archive.finalize();
});

/* ---- Bağımsız Araçlar (Sıkıştır & Boyutlandır) ---- */
const toolFiles = new Map();

app.post('/api/tools/process', upload.array('files'), async (req, res) => {
  const files = req.files || [];
  try {
    const opts = JSON.parse(req.body.opts || '{}');
    const names = JSON.parse(req.body.names || '[]');
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = sanitize(names[i] || f.originalname) || 'gorsel';
      try {
        const buf = await fsp.readFile(f.path);
        const r = await processImage(buf, opts);
        const id = uid();
        const outName = fixExt(name, r.fmt);
        const p = path.join(TMP_DIR, `tool-${id}.${EXT[r.fmt]}`);
        await fsp.writeFile(p, r.buffer);
        toolFiles.set(id, { path: p, name: outName, fmt: r.fmt, created: Date.now() });
        results.push({
          id, name: outName, before: buf.length, after: r.buffer.length,
          width: r.width, height: r.height, srcWidth: r.srcWidth, srcHeight: r.srcHeight, unchanged: r.unchanged,
        });
      } catch (e) {
        results.push({ name, before: f.size, error: e.message });
      }
    }
    res.json({ results });
  } finally {
    await Promise.all(files.map((f) => safeUnlink(f.path)));
  }
});

app.get('/api/tools/file/:id', (req, res) => {
  const t = toolFiles.get(req.params.id);
  if (!t) return res.status(404).end();
  if (req.query.download) return res.download(t.path, t.name, { dotfiles: 'allow' });
  res.type(MIME[EXT[t.fmt]]);
  fs.createReadStream(t.path).pipe(res);
});

app.get('/api/tools/zip', async (req, res) => {
  const items = String(req.query.ids || '').split(',').map((id) => toolFiles.get(id)).filter(Boolean);
  if (!items.length) return res.status(404).json({ error: 'Dosya yok' });
  const archive = startZip(res, 'islenmis-gorseller');
  const used = new Set();
  for (const t of items) {
    let name = t.name;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${baseName(t.name)} (${n})${path.extname(t.name)}`;
    used.add(name.toLowerCase());
    archive.file(t.path, { name });
  }
  await archive.finalize();
});

app.post('/api/tools/save', requireEdit, async (req, res) => {
  const categoryId = normCat(req.body.categoryId);
  const user = req.auth.name || 'Yetkili';
  let added = 0;
  for (const id of req.body.ids || []) {
    const t = toolFiles.get(id);
    if (!t) continue;
    await storeImage({ buf: await fsp.readFile(t.path), fmt: t.fmt, name: t.name, categoryId, user });
    added++;
  }
  if (added) {
    const dest = categoryId ? catById(categoryId)?.name : 'Ana dizin';
    addLog(req, 'Araçlardan Kayıt', `Sıkıştır & Boyutlandır aracından ${added} görseli “${dest}” kategorisine kaydetti`);
  }
  save();
  res.json({ added });
});

setInterval(() => {
  const limit = Date.now() - 3 * 3600 * 1000;
  for (const [id, t] of toolFiles) {
    if (t.created < limit) { safeUnlink(t.path); toolFiles.delete(id); }
  }
  // 30 günden eski boş oturumları temizle
  const sessLimit = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [sid, s] of Object.entries(db.sessions)) {
    if ((s.lastSeen || 0) < sessLimit) delete db.sessions[sid];
  }
}, 15 * 60 * 1000).unref();

fsp.readdir(TMP_DIR).then((l) => l.forEach((f) => safeUnlink(path.join(TMP_DIR, f)))).catch(() => {});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Sunucu hatası' });
});

function applySeedIfNeeded() {
  const seedDir = path.join(__dirname, 'seed');
  const seedJson = path.join(seedDir, 'seed.json');
  if (!fs.existsSync(seedJson)) return;
  for (const [sub, targetDir] of [['uploads', UPLOAD_DIR], ['thumbs', THUMB_DIR]]) {
    const sdir = path.join(seedDir, sub);
    if (!fs.existsSync(sdir)) continue;
    for (const f of fs.readdirSync(sdir)) {
      const dst = path.join(targetDir, f);
      if (!fs.existsSync(dst)) {
        try { fs.linkSync(path.join(sdir, f), dst); } catch { fs.copyFileSync(path.join(sdir, f), dst); }
      }
    }
  }
  if (!db.categories.length && !db.images.length) {
    try {
      const s = JSON.parse(fs.readFileSync(seedJson, 'utf8'));
      db.categories = s.categories || [];
      db.images = s.images || [];
      save(false);
    } catch (e) { console.error('Seed okunamadı:', e.message); }
  }
}

(async () => {
  await cloud.restoreFromCloud(DATA_DIR);
  loadDbFromDisk();
  applySeedIfNeeded();
  await ensureOwnerBootstrap();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nBetorspin Katalog çalışıyor:\n  Bu bilgisayar : http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`  Ağdaki ekip   : http://${n.address}:${PORT}`);
    }
    console.log('  Kurucu (En Üst Yetki): Kaan (@kaan)\n');
  });
})();
