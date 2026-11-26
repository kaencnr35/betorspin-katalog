'use strict';
/**
 * Betorspin Katalog – Sunucu (Profil & Hesap Tabanlı Güvenlik Mimarisi)
 * - IP tabanlı yetkilendirme kaldırıldı (aynı ağ/IP'den çalışan ekipler için tam izolasyon)
 * - Dışarıdan kayıt kapalıdır; yalnızca Admin ve Kurucu yeni profil (kullanıcı adı + şifre) oluşturabilir
 * - Kalıcı, HMAC-SHA256 imzalı + tokenVersion korumalı HttpOnly oturumlar (sunucu yeniden başlasa bile oturum düşmez)
 * - Giriş yapan kullanıcı kendi adını, kullanıcı adını, şifresini (mevcut şifre doğrulamasıyla) ve profil fotoğrafını değiştirebilir
 * - Saldırı & Güvenlik Sistemi (WAF, CSRF/Origin kontrolü, CSP, hesap bazlı brute-force koruması, cihaz bazlı engelleme, güvenlik günlükleri)
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
const AUTH_SECRET = crypto.createHash('sha256')
  .update(process.env.STORAGE_SECRET || process.env.GITHUB_SYNC_TOKEN || 'betorspin-auth-secret-2026')
  .digest();

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
  // users: { id, username, name, pwHash, role:'owner'|'admin'|'editor'|'viewer', avatar, tokenVersion, banned, banReason, lastSeen, createdAt, createdBy }
  users: [],
  // sessions: sid -> { userId, devId, lastSeen, createdAt }
  sessions: {},
  // bans: { id, type:'user'|'device', target, targetName, reason, createdBy, createdAt }
  bans: [],
  // trash: { ...imageRecord, origCategoryName, deletedBy, deletedAt }
  trash: [],
  // logs: { id, ts, actorId, actorName, actorAvatar, actorRole, action, detail, severity:'info'|'warn'|'security' }
  logs: [],
};

function loadDbFromDisk() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...db, ...raw };
      db.users = (db.users || []).map((u) => ({ tokenVersion: 1, banned: false, banReason: '', ...u }));
      db.sessions = db.sessions || {};
      // Eski IP banlarını temizle (aynı IP'den çalışıldığı için IP engeli kullanılmaz)
      db.bans = (db.bans || []).filter((b) => b.type !== 'ip');
      db.trash = db.trash || [];
      db.logs = db.logs || [];
      delete db.ipRules;
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
/* Yardımcılar & Kriptografik Oturum                                   */
/* ------------------------------------------------------------------ */
const uid = () => crypto.randomBytes(6).toString('hex');
const genSid = () => crypto.randomBytes(32).toString('hex');
const sidKey = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16);
const sanitize = (s, max = 150) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, max);
const sanitizeUsername = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const ROLE_LABEL = { owner: 'Kurucu', admin: 'Admin', editor: 'Editör', viewer: 'İzleyici' };

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

/** Kalıcı giriş için HMAC-SHA256 imzalı çerez jetonu */
function signAuthToken(user) {
  const payload = `${user.id}.${user.tokenVersion || 1}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, verStr, sig] = parts;
  const payload = `${userId}.${verStr}`;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const user = db.users.find((u) => u.id === userId);
  if (!user || (user.tokenVersion || 1) !== Number(verStr)) return null;
  return user;
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

function setCookies(req, res, cookieMap) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  for (const [name, val] of Object.entries(cookieMap)) {
    const maxAge = val === '' ? 0 : 365 * 24 * 3600;
    const parts = [`${name}=${encodeURIComponent(val)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (isSecure) parts.push('Secure');
    list.push(parts.join('; '));
  }
  res.setHeader('Set-Cookie', list);
}

async function ensureOwnerBootstrap() {
  let owner = db.users.find((u) => u.role === 'owner');
  if (!owner) {
    owner = {
      id: 'owner-kaan',
      username: 'kaan',
      name: 'Kaan',
      pwHash: await passwords.hash(OWNER_INITIAL_PW),
      role: 'owner',
      avatar: '',
      tokenVersion: 1,
      banned: false,
      banReason: '',
      lastSeen: Date.now(),
      createdAt: Date.now(),
      createdBy: 'Sistem',
    };
    db.users.unshift(owner);
    save(false);
  }
}

/* ------------------------------------------------------------------ */
/* Oturum, Yetki, Engelleme ve Çevrimiçi Takibi                        */
/* ------------------------------------------------------------------ */
const ONLINE_TTL_MS = 25 * 1000;

function addLog(req, action, detail, severity = 'info') {
  const actor = req?.auth || {};
  const entry = {
    id: uid(),
    ts: Date.now(),
    actorId: actor.user?.id || '',
    actorName: actor.name || 'Anonim',
    actorAvatar: actor.avatar || '',
    actorRole: actor.role || 'viewer',
    action,
    detail: String(detail || '').slice(0, 500),
    severity,
  };
  db.logs.unshift(entry);
  if (db.logs.length > 1200) db.logs.length = 1200;
}

function checkBan(user, devId) {
  if (user && user.role === 'owner') return null;
  if (user) {
    if (user.banned) return { reason: user.banReason || 'Hesabınız yönetici tarafından askıya alındı.' };
    const b = db.bans.find((x) => x.type === 'user' && x.target === user.id);
    if (b) return b;
  }
  if (devId) {
    const b = db.bans.find((x) => x.type === 'device' && x.target === devId);
    if (b) return b;
  }
  return null;
}

function buildAuthObject(sid, devId, sess) {
  let user = sess.userId ? db.users.find((u) => u.id === sess.userId) : null;
  if (sess.userId && !user) sess.userId = null;
  if (user) user.lastSeen = Date.now();
  const ban = checkBan(user, devId);
  const role = user && !ban ? user.role : 'viewer';
  const rank = ROLE_RANK[role] || 0;
  return {
    sid,
    devId,
    sess,
    user,
    ban,
    name: user ? user.name : '',
    username: user ? user.username : '',
    avatar: user ? user.avatar : '',
    role,
    canEdit: !ban && rank >= ROLE_RANK.editor,
    canAdmin: !ban && rank >= ROLE_RANK.admin,
    isOwner: !ban && rank >= ROLE_RANK.owner,
    isAnon: !user,
  };
}

function refreshAuth(req) {
  req.auth = buildAuthObject(req.auth.sid, req.auth.devId, req.auth.sess);
  return req.auth;
}

function resolveAuth(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies.bk_sid;
  let devId = cookies.bk_dev;
  const toSet = {};
  if (!sid || typeof sid !== 'string' || sid.length < 32 || sid.length > 128) {
    sid = genSid();
    toSet.bk_sid = sid;
  }
  if (!devId || typeof devId !== 'string' || devId.length < 16 || devId.length > 64) {
    devId = crypto.randomBytes(16).toString('hex');
    toSet.bk_dev = devId;
  }
  if (Object.keys(toSet).length) setCookies(req, res, toSet);

  let sess = db.sessions[sid];
  const now = Date.now();
  if (!sess) {
    sess = { userId: null, devId, lastSeen: now, createdAt: now };
    db.sessions[sid] = sess;
  }
  sess.devId = devId;
  sess.lastSeen = now;

  let user = sess.userId ? db.users.find((u) => u.id === sess.userId) : null;
  if (!user && cookies.bk_auth) {
    const verified = verifyAuthToken(cookies.bk_auth);
    if (verified) {
      user = verified;
      sess.userId = user.id;
    }
  }
  if (user && cookies.bk_auth) {
    const verified = verifyAuthToken(cookies.bk_auth);
    if (!verified) {
      user = null;
      sess.userId = null;
      setCookies(req, res, { bk_auth: '' });
    }
  }
  return buildAuthObject(sid, devId, sess);
}

/** Çevrimiçi kişileri hesaplar (hassas veri içermez) */
function getPublicPresence(mySid) {
  const now = Date.now();
  const activeSids = Object.entries(db.sessions)
    .filter(([, s]) => {
      if (now - (s.lastSeen || 0) > ONLINE_TTL_MS) return false;
      const u = s.userId ? db.users.find((x) => x.id === s.userId) : null;
      return !checkBan(u, s.devId);
    })
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));

  const seenUsers = new Map();
  const anonList = [];
  let myAnonLabel = '';

  for (const [sid, s] of activeSids) {
    const u = s.userId ? db.users.find((x) => x.id === s.userId) : null;
    const isMe = sid === mySid;
    if (u) {
      const existing = seenUsers.get(u.id);
      if (!existing || isMe) {
        seenUsers.set(u.id, {
          id: u.id,
          name: u.name,
          avatar: u.avatar || '',
          role: u.role,
          roleLabel: ROLE_LABEL[u.role] || 'İzleyici',
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
/* Express & Çok Katmanlı Güvenlik Sistemi (WAF + CSRF + CSP)          */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 1. Sıkı Güvenlik Başlıkları (CSP, Clickjacking, MIME Sniffing, İzolasyon)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 300 * 1024 * 1024, files: 300 } });
const avatarUpload = multer({ dest: TMP_DIR, limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

// 2. Oturum ve Engelleme Kontrolü
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

// 3. WAF (Saldırı Tarayıcıları, Path Traversal, XSS/Injection Tespiti) & CSRF Koruması
const SCANNER_UA = /(sqlmap|nikto|nuclei|dirbuster|gobuster|wpscan|acunetix|nessus|masscan|zgrab)/i;
const ATTACK_PATH = /(\.\.[/\\]|%2e%2e|<script|javascript:|onerror\s*=|onload\s*=|union\s+select|\/etc\/passwd|\.env\b|\.git\b|__proto__|constructor\.prototype)/i;

app.use((req, res, next) => {
  const ua = String(req.headers['user-agent'] || '');
  const rawUrl = req.originalUrl || req.url || '';
  let decodedUrl = rawUrl;
  try { decodedUrl = decodeURIComponent(rawUrl); } catch { /* bozuk url */ }
  const bodyStr = req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '';
  if (SCANNER_UA.test(ua) || ATTACK_PATH.test(rawUrl) || ATTACK_PATH.test(decodedUrl) || ATTACK_PATH.test(bodyStr)) {
    addLog(req, 'Saldırı Engellendi (WAF)', `Şüpheli istek engellendi: ${req.method} ${decodedUrl.slice(0, 120)}`, 'security');
    save(false);
    return res.status(403).json({ error: 'Güvenlik duvarı tarafından engellendi.' });
  }
  // Durum değiştiren API isteklerinde CSRF & Origin doğrulaması
  if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const xrw = req.headers['x-requested-with'];
    if (xrw !== 'BetorspinKatalog') {
      addLog(req, 'CSRF Engellendi', `Geçersiz başlık ile dış istek reddedildi: ${req.method} ${req.path}`, 'security');
      save(false);
      return res.status(403).json({ error: 'Güvenlik doğrulaması başarısız (CSRF).' });
    }
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) {
          addLog(req, 'Origin Engellendi', `Farklı kaynaktan (${origin}) gelen istek reddedildi`, 'security');
          save(false);
          return res.status(403).json({ error: 'Farklı kaynaktan istek gönderilemez.' });
        }
      } catch {
        return res.status(403).json({ error: 'Geçersiz Origin.' });
      }
    }
  }
  next();
});

function requireEdit(req, res, next) {
  if (!req.auth.canEdit) {
    return res.status(403).json({ error: 'Bu işlem için düzenleme yetkiniz yok. Yetkili hesabınızla giriş yapın.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth.canAdmin) {
    addLog(req, 'Yetkisiz Admin Erişimi', `Yetkisiz kullanıcı (${req.auth.name || 'Anonim'}) admin API'sine erişmeye çalıştı: ${req.path}`, 'security');
    save(false);
    return res.status(403).json({ error: 'Bu alan yalnızca Admin ve Kurucu yetkisine açıktır.' });
  }
  next();
}

// 4. Hesap & Oturum Bazlı Brute-Force Koruması (Aynı IP'deki diğer ekip üyelerini etkilemez!)
const loginAttempts = new Map(); // key (username veya sid) -> { count, lockUntil }
function checkLoginLock(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockUntil && now < rec.lockUntil) return Math.ceil((rec.lockUntil - now) / 1000);
  return 0;
}
function recordFailedAttempt(key) {
  const rec = loginAttempts.get(key) || { count: 0, lockUntil: 0 };
  rec.count++;
  if (rec.count >= 5) {
    const lockSec = rec.count >= 10 ? 300 : 45;
    rec.lockUntil = Date.now() + lockSec * 1000;
  }
  loginAttempts.set(key, rec);
  return rec.count;
}
function clearFailedAttempts(key) {
  loginAttempts.delete(key);
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

/* ---- Kimlik Doğrulama & Kendi Profilini Düzenleme ---- */
app.post('/api/auth/login', async (req, res) => {
  const rawInput = String(req.body.username || '').trim();
  const username = sanitizeUsername(rawInput);
  const password = String(req.body.password || '');
  if (!rawInput || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre girin.' });

  const lockUser = checkLoginLock('u:' + username);
  const lockSess = checkLoginLock('s:' + req.auth.sid);
  const waitSec = Math.max(lockUser, lockSess);
  if (waitSec > 0) {
    return res.status(429).json({ error: `Çok fazla hatalı deneme. Lütfen ${waitSec} saniye bekleyin.` });
  }

  const user = db.users.find((u) => u.username === username || u.name.toLowerCase() === rawInput.toLowerCase());
  if (!user || !user.pwHash || !(await passwords.verify(password, user.pwHash))) {
    const c1 = recordFailedAttempt('u:' + username);
    recordFailedAttempt('s:' + req.auth.sid);
    if (c1 >= 5) {
      addLog(req, 'Brute-Force Uyarısı', `“${rawInput}” hesabına üst üste ${c1} hatalı şifre denemesi yapıldı (geçici kilit uygulandı)`, 'security');
      save(false);
    }
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }

  const ban = checkBan(user, req.auth.devId);
  if (ban) return res.status(403).json({ error: 'Bu hesap yönetici tarafından engellenmiş.', banned: true, reason: ban.reason });

  clearFailedAttempts('u:' + username);
  clearFailedAttempts('s:' + req.auth.sid);

  req.auth.sess.userId = user.id;
  user.lastSeen = Date.now();
  setCookies(req, res, { bk_auth: signAuthToken(user) });

  refreshAuth(req);
  addLog(req, 'Giriş', `“${user.name}” (@${user.username}) hesabına giriş yaptı`);
  save(false);
  res.json({ me: publicMe(req.auth) });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.auth.user) {
    addLog(req, 'Çıkış', `“${req.auth.user.name}” (@${req.auth.user.username}) çıkış yaptı`);
  }
  req.auth.sess.userId = null;
  setCookies(req, res, { bk_auth: '' });
  refreshAuth(req);
  save(false);
  res.json({ me: publicMe(req.auth) });
});

// Giriş yapmış kullanıcı kendi adını, kullanıcı adını ve şifresini değiştirebilir
app.patch('/api/profile', async (req, res) => {
  const user = req.auth.user;
  if (!user) return res.status(401).json({ error: 'Bilgilerinizi düzenlemek için önce hesabınıza giriş yapın.' });

  const changes = [];
  if ('name' in req.body) {
    const name = sanitize(req.body.name, 40);
    if (!name) return res.status(400).json({ error: 'Görünen ad boş olamaz.' });
    if (name !== user.name) {
      changes.push(`görünen adını “${user.name}” → “${name}” yaptı`);
      user.name = name;
    }
  }
  if ('username' in req.body) {
    const uName = sanitizeUsername(req.body.username);
    if (uName.length < 2) return res.status(400).json({ error: 'Kullanıcı adı en az 2 karakter olmalı.' });
    if (db.users.some((u) => u.id !== user.id && u.username === uName)) {
      return res.status(400).json({ error: 'Bu kullanıcı adı başka bir profilde kullanılıyor.' });
    }
    if (uName !== user.username) {
      changes.push(`kullanıcı adını @${user.username} → @${uName} yaptı`);
      user.username = uName;
    }
  }
  if (req.body.newPassword) {
    const curPw = String(req.body.currentPassword || '');
    const newPw = String(req.body.newPassword || '');
    if (newPw.length < 4) return res.status(400).json({ error: 'Yeni şifre en az 4 karakter olmalı.' });
    if (user.pwHash && !(await passwords.verify(curPw, user.pwHash))) {
      return res.status(401).json({ error: 'Mevcut şifrenizi yanlış girdiniz.' });
    }
    user.pwHash = await passwords.hash(newPw);
    user.tokenVersion = (user.tokenVersion || 1) + 1;
    setCookies(req, res, { bk_auth: signAuthToken(user) });
    changes.push('şifresini değiştirdi');
  }

  refreshAuth(req);
  if (changes.length) {
    addLog(req, 'Profil Güncelleme', `Kendi profilinde ${changes.join(', ')}`);
    save(false);
  }
  res.json({ me: publicMe(req.auth) });
});

app.post('/api/profile/avatar', avatarUpload.single('avatar'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Görsel seçilmedi.' });
  try {
    const user = req.auth.user;
    if (!user) return res.status(401).json({ error: 'Profil fotoğrafı eklemek için önce giriş yapın.' });
    const buf = await fsp.readFile(f.path);
    const outPath = avatarPath(user.id);
    await sharp(buf, { limitInputPixels: false })
      .rotate()
      .resize(160, 160, { fit: 'cover', position: 'centre' })
      .webp({ quality: 84 })
      .toFile(outPath);
    cloud.syncFileUp(outPath, `avatars/${user.id}.webp`);
    user.avatar = `/avatars/${user.id}.webp?v=${Date.now()}`;
    refreshAuth(req);
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
  if (!user) return res.status(401).json({ error: 'Profil bulunamadı.' });
  await safeUnlink(avatarPath(user.id));
  cloud.syncFileDel(`avatars/${user.id}.webp`);
  user.avatar = '';
  refreshAuth(req);
  addLog(req, 'Profil Fotoğrafı', 'Profil fotoğrafını kaldırdı');
  save(false);
  res.json({ me: publicMe(req.auth) });
});

/* ---- Admin Paneli API'leri (Yalnızca Admin ve Kurucu) ---- */
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const now = Date.now();
  const activeSids = Object.entries(db.sessions)
    .filter(([, s]) => now - (s.lastSeen || 0) <= ONLINE_TTL_MS);

  const onlineUserIds = new Set(activeSids.map(([, s]) => s.userId).filter(Boolean));

  const users = db.users.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    avatar: u.avatar || '',
    role: u.role,
    roleLabel: ROLE_LABEL[u.role] || 'İzleyici',
    lastSeen: u.lastSeen || u.createdAt,
    createdAt: u.createdAt,
    createdBy: u.createdBy || 'Sistem',
    online: onlineUserIds.has(u.id),
    banned: Boolean(u.banned) || db.bans.some((b) => b.type === 'user' && b.target === u.id),
    banReason: u.banReason || '',
  })).sort((a, b) => (ROLE_RANK[b.role] - ROLE_RANK[a.role]) || (b.online - a.online) || (b.lastSeen - a.lastSeen));

  let anonIdx = 0;
  const seenOnlineUsers = new Map();
  const onlineSessions = [];
  for (const [sid, s] of activeSids.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))) {
    const u = s.userId ? db.users.find((x) => x.id === s.userId) : null;
    const isMe = sid === req.auth.sid;
    if (u) {
      if (seenOnlineUsers.has(u.id)) {
        if (isMe) seenOnlineUsers.get(u.id).isMe = true;
        continue;
      }
      const row = {
        sidHash: sidKey(sid),
        devId: s.devId || '',
        userId: u.id,
        name: u.name,
        username: u.username,
        avatar: u.avatar || '',
        role: u.role,
        roleLabel: ROLE_LABEL[u.role] || 'İzleyici',
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
        devId: s.devId || '',
        userId: null,
        name: `Anonim - ${anonIdx}`,
        username: '',
        avatar: '',
        role: 'viewer',
        roleLabel: 'İzleyici',
        lastSeen: s.lastSeen,
        isAnon: true,
        isMe,
      });
    }
  }

  res.json({
    me: publicMe(req.auth),
    users,
    onlineSessions,
    bans: db.bans,
    trash: db.trash,
    logs: db.logs.slice(0, 500),
  });
});

// Çöp Kutusu: Görselleri geri yükleme veya kalıcı silme
app.post('/api/admin/trash/restore', requireAdmin, (req, res) => {
  const ids = new Set(req.body.ids || []);
  let restored = 0;
  const remaining = [];
  for (const item of db.trash) {
    if (!ids.has(item.id)) { remaining.push(item); continue; }
    let catId = item.categoryId && catById(item.categoryId) ? item.categoryId : null;
    if (!catId && item.origCategoryName) {
      let found = db.categories.find((c) => c.parentId === null && c.name.toLowerCase() === item.origCategoryName.toLowerCase());
      if (!found) {
        found = { id: uid(), name: item.origCategoryName, parentId: null, createdAt: Date.now() };
        db.categories.push(found);
      }
      catId = found.id;
    }
    const rec = {
      id: item.id,
      categoryId: catId,
      name: uniqueImageName(catId, item.name, item.id),
      ext: item.ext,
      format: item.format,
      width: item.width,
      height: item.height,
      size: item.size,
      addedBy: item.addedBy || '',
      createdAt: item.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    db.images.push(rec);
    restored++;
  }
  db.trash = remaining;
  if (restored) {
    addLog(req, 'Çöp Kutusundan Geri Yükleme', `${restored} görseli çöp kutusundan kataloğa geri yükledi`);
    save();
  }
  res.json({ restored });
});

app.delete('/api/admin/trash', requireAdmin, async (req, res) => {
  const ids = req.body?.ids ? new Set(req.body.ids) : null;
  const doomed = ids ? db.trash.filter((i) => ids.has(i.id)) : [...db.trash];
  await Promise.all(doomed.map(deleteImageFiles));
  db.trash = ids ? db.trash.filter((i) => !ids.has(i.id)) : [];
  if (doomed.length) {
    addLog(req, 'Çöp Kutusu Temizleme', `Çöp kutusundaki ${doomed.length} görseli kalıcı olarak sildi`);
    save(false);
  }
  res.json({ deleted: doomed.length });
});

// Admin veya Kurucu tarafından yeni profil oluşturma (kullanıcı adı + şifre ile)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const name = sanitize(req.body.name, 40);
  const username = sanitizeUsername(req.body.username || name);
  const password = String(req.body.password || '').trim();
  const role = req.body.role || 'editor';
  if (!name || !username) return res.status(400).json({ error: 'Görünen ad ve kullanıcı adı gerekli.' });
  if (username.length < 2) return res.status(400).json({ error: 'Kullanıcı adı en az 2 karakter olmalı.' });
  if (password.length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });
  if (db.users.some((u) => u.username === username)) return res.status(400).json({ error: 'Bu kullanıcı adı zaten mevcut.' });
  if (!['viewer', 'editor', 'admin'].includes(role)) return res.status(400).json({ error: 'Geçersiz yetki.' });
  if (role === 'admin' && !req.auth.isOwner) {
    return res.status(403).json({ error: 'Yeni Admin atama yetkisi yalnızca Kurucu (En Üst Yetki) hesabına aittir.' });
  }
  const user = {
    id: uid(),
    username,
    name,
    pwHash: await passwords.hash(password),
    role,
    avatar: '',
    tokenVersion: 1,
    banned: false,
    banReason: '',
    lastSeen: Date.now(),
    createdAt: Date.now(),
    createdBy: req.auth.name || 'Admin',
  };
  db.users.push(user);
  addLog(req, 'Profil Oluşturma', `“${user.name}” (@${user.username}) profilini ${ROLE_LABEL[role]} yetkisiyle oluşturdu`);
  save(false);
  res.json({
    ok: true,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, roleLabel: ROLE_LABEL[user.role] },
  });
});

// Kullanıcı yetkisini, şifresini veya oturumlarını güncelleme
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.role === 'owner' && !req.auth.isOwner) {
    return res.status(403).json({ error: 'Kurucu (En Üst Yetki) hesabı düzenlenemez.' });
  }
  if (target.role === 'admin' && !req.auth.isOwner && target.id !== req.auth.user?.id) {
    return res.status(403).json({ error: 'Bir Admin hesabını yalnızca Kurucu düzenleyebilir.' });
  }
  const changes = [];
  if ('role' in req.body) {
    if (target.role === 'owner') return res.status(403).json({ error: 'Kurucu hesabının yetkisi değiştirilemez.' });
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
    if (String(req.body.password).length < 4) return res.status(400).json({ error: 'Şifre en az 4 karakter olmalı.' });
    target.pwHash = await passwords.hash(String(req.body.password));
    target.tokenVersion = (target.tokenVersion || 1) + 1;
    changes.push('şifresini sıfırladı');
  }
  if (req.body.revokeSessions) {
    target.tokenVersion = (target.tokenVersion || 1) + 1;
    for (const s of Object.values(db.sessions)) if (s.userId === target.id) s.userId = null;
    changes.push('tüm açık oturumlarını kapattı');
  }
  if (changes.length) {
    addLog(req, 'Yetki / Profil Yönetimi', `“${target.name}” (@${target.username}) kullanıcısının ${changes.join(', ')}`);
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
  db.bans = db.bans.filter((b) => !(b.type === 'user' && b.target === target.id));
  db.users = db.users.filter((u) => u.id !== target.id);
  addLog(req, 'Profil Silme', `“${target.name}” (@${target.username}) profilini sildi`);
  save(false);
  res.json({ ok: true });
});

// Engelleme (Profil veya Cihaz Oturumu Bazlı – Ortak Ofis IP'sini Etkilemez!)
app.post('/api/admin/bans', requireAdmin, (req, res) => {
  const userId = req.body.userId || null;
  const devId = req.body.devId || null;
  const reason = sanitize(req.body.reason || 'Yönetici tarafından siteden uzaklaştırıldı', 140);
  if (!userId && !devId) return res.status(400).json({ error: 'Engellenecek profil veya oturum seçilmeli.' });

  if (userId) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
    if (u.role === 'owner') return res.status(403).json({ error: 'Kurucu engellenemez.' });
    if (u.role === 'admin' && !req.auth.isOwner) return res.status(403).json({ error: 'Bir Admini yalnızca Kurucu engelleyebilir.' });
    if (u.id === req.auth.user?.id) return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz.' });

    u.banned = true;
    u.banReason = reason;
    u.tokenVersion = (u.tokenVersion || 1) + 1;
    if (!db.bans.some((b) => b.type === 'user' && b.target === u.id)) {
      db.bans.unshift({
        id: uid(), type: 'user', target: u.id, targetName: `${u.name} (@${u.username})`,
        reason, createdBy: req.auth.name || 'Admin', createdAt: Date.now(),
      });
    }
    addLog(req, 'Profil Engelleme', `“${u.name}” (@${u.username}) profilini siteden uzaklaştırdı (${reason})`, 'security');
  }

  if (devId) {
    if (devId === req.auth.devId) return res.status(400).json({ error: 'Kendi tarayıcı oturumunuzu engelleyemezsiniz.' });
    const targetName = sanitize(req.body.targetName || 'Anonim Cihaz', 50);
    if (!db.bans.some((b) => b.type === 'device' && b.target === devId)) {
      db.bans.unshift({
        id: uid(), type: 'device', target: devId, targetName: `${targetName} (Cihaz #${devId.slice(0, 6)})`,
        reason, createdBy: req.auth.name || 'Admin', createdAt: Date.now(),
      });
    }
    addLog(req, 'Cihaz Uzaklaştırma', `${targetName} (Cihaz #${devId.slice(0, 6)}) oturumunu siteden uzaklaştırdı (${reason})`, 'security');
  }

  save(false);
  res.json({ ok: true });
});

app.delete('/api/admin/bans/:id', requireAdmin, (req, res) => {
  const ban = db.bans.find((b) => b.id === req.params.id);
  if (!ban) return res.status(404).json({ error: 'Engel kaydı bulunamadı.' });
  if (ban.type === 'user') {
    const u = db.users.find((x) => x.id === ban.target);
    if (u) { u.banned = false; u.banReason = ''; }
  }
  db.bans = db.bans.filter((b) => b.id !== ban.id);
  addLog(req, 'Engel Kaldırma', `${ban.targetName} üzerindeki erişim engelini kaldırdı`);
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

function moveToTrash(imgs, actorName) {
  const now = Date.now();
  for (const img of imgs) {
    const cat = img.categoryId ? catById(img.categoryId) : null;
    db.trash.unshift({
      ...img,
      origCategoryName: cat ? cat.name : '',
      deletedBy: actorName || 'Yetkili',
      deletedAt: now,
    });
  }
}

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
    moveToTrash(doomed, req.auth.name);
    db.images = db.images.filter((i) => !ids.has(i.categoryId));
    db.categories = db.categories.filter((c) => !ids.has(c.id));
    addLog(req, 'Kategori Silme', `“${cat.name}” kategorisini sildi (${doomed.length} görsel çöp kutusuna taşındı)`);
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
  moveToTrash(doomed, req.auth.name);
  db.images = db.images.filter((i) => !ids.has(i.id));
  if (doomed.length) {
    const sample = doomed.slice(0, 3).map((x) => x.name).join(', ') + (doomed.length > 3 ? '…' : '');
    addLog(req, 'Görsel Silme (Çöp Kutusu)', `${doomed.length} görseli çöp kutusuna taşıdı (${sample})`);
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
  const sessLimit = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [sid, s] of Object.entries(db.sessions)) {
    if ((s.lastSeen || 0) < sessLimit) delete db.sessions[sid];
  }
  // 30 günden eski çöp kutusu öğelerini otomatik temizle
  const oldTrash = (db.trash || []).filter((t) => (t.deletedAt || 0) < sessLimit);
  if (oldTrash.length) {
    oldTrash.forEach((t) => deleteImageFiles(t));
    db.trash = db.trash.filter((t) => (t.deletedAt || 0) >= sessLimit);
    save(false);
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
