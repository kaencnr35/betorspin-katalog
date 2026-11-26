'use strict';
/**
 * Render (ephemeral disk) için otomatik GitHub 'storage-data' dalı senkronizasyonu.
 * - GITHUB_SYNC_TOKEN ve GITHUB_SYNC_REPO tanımlıysa çalışır, değilse (yerelde) sessizce devre dışıdır.
 * - db.json dosyası STORAGE_SECRET anahtarıyla AES-256-GCM ile şifrelenerek (db.enc) saklanır;
 *   böylece parola özetleri, IP kuralları ve kayıtlar GitHub üzerinde asla düz metin olarak yer almaz.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const TOKEN = (process.env.GITHUB_SYNC_TOKEN || '').trim();
const REPO = (process.env.GITHUB_SYNC_REPO || '').trim(); // ör. kaencnr35/betorspin-katalog
const BRANCH = process.env.GITHUB_SYNC_BRANCH || 'storage-data';
const SECRET = crypto.createHash('sha256').update(process.env.STORAGE_SECRET || TOKEN || 'betorspin-local-key').digest();
const ENABLED = Boolean(TOKEN && REPO);

function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptBuffer(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

async function gh(endpoint, opts = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/repos/${REPO}${endpoint}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'betorspin-katalog-sync',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 404 && opts.allow404) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${t.slice(0, 160)}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

const shaCache = new Map(); // remotePath -> sha
let branchReady = false;

async function ensureBranch() {
  if (!ENABLED || branchReady) return;
  const ref = await gh(`/git/ref/heads/${BRANCH}`, { allow404: true });
  if (ref) { branchReady = true; return; }
  const mainRef = await gh('/git/ref/heads/main', { allow404: true }) || await gh('/git/ref/heads/master', { allow404: true });
  if (!mainRef) return;
  await gh('/git/refs', {
    method: 'POST',
    body: { ref: `refs/heads/${BRANCH}`, sha: mainRef.object.sha },
  });
  branchReady = true;
}

/** Sunucu açılışında buluttaki verileri yerel DATA_DIR içine geri yükler */
async function restoreFromCloud(dataDir) {
  if (!ENABLED) return false;
  try {
    await ensureBranch();
    const ref = await gh(`/git/ref/heads/${BRANCH}`, { allow404: true });
    if (!ref) return false;
    const tree = await gh(`/git/trees/${ref.object.sha}?recursive=1`, { allow404: true });
    if (!tree || !Array.isArray(tree.tree)) return false;

    const items = tree.tree.filter((t) => t.type === 'blob' && (t.path === 'db.enc' || t.path.startsWith('uploads/') || t.path.startsWith('thumbs/') || t.path.startsWith('avatars/')));
    if (!items.length) return false;

    console.log(`[CloudSync] ${items.length} dosya buluttan geri yükleniyor...`);
    for (const item of items) {
      shaCache.set(item.path, item.sha);
      const localRel = item.path === 'db.enc' ? 'db.json' : item.path;
      const dest = path.join(dataDir, localRel);
      if (item.path !== 'db.enc' && fs.existsSync(dest)) continue;
      const blob = await gh(`/git/blobs/${item.sha}`);
      let buf = Buffer.from(blob.content, 'base64');
      if (item.path === 'db.enc') {
        try { buf = decryptBuffer(buf); } catch (e) { console.error('[CloudSync] db.enc şifresi çözülemedi:', e.message); continue; }
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    }
    console.log('[CloudSync] Geri yükleme tamamlandı.');
    return true;
  } catch (e) {
    console.error('[CloudSync] Geri yükleme hatası:', e.message);
    return false;
  }
}

// Sıralı arka plan kuyruğu (yarış durumlarını önler)
const queue = [];
let running = false;
function enqueue(fn) {
  if (!ENABLED) return;
  queue.push(fn);
  if (!running) drain();
}
async function drain() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); } catch (e) { console.error('[CloudSync] İşlem hatası:', e.message); }
  }
  running = false;
}

async function putRemoteFile(remotePath, buf) {
  await ensureBranch();
  let sha = shaCache.get(remotePath);
  if (!sha) {
    const cur = await gh(`/contents/${remotePath}?ref=${BRANCH}`, { allow404: true });
    if (cur && cur.sha) sha = cur.sha;
  }
  const res = await gh(`/contents/${remotePath}`, {
    method: 'PUT',
    body: {
      message: `sync ${remotePath}`,
      content: buf.toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    },
  });
  if (res && res.content && res.content.sha) shaCache.set(remotePath, res.content.sha);
}

async function deleteRemoteFile(remotePath) {
  await ensureBranch();
  let sha = shaCache.get(remotePath);
  if (!sha) {
    const cur = await gh(`/contents/${remotePath}?ref=${BRANCH}`, { allow404: true });
    if (cur && cur.sha) sha = cur.sha;
  }
  if (!sha) return;
  await gh(`/contents/${remotePath}`, {
    method: 'DELETE',
    body: { message: `del ${remotePath}`, sha, branch: BRANCH },
  });
  shaCache.delete(remotePath);
}

let dbTimer = null;
function syncDb(dbFile) {
  if (!ENABLED) return;
  clearTimeout(dbTimer);
  dbTimer = setTimeout(() => {
    enqueue(async () => {
      const raw = await fsp.readFile(dbFile);
      await putRemoteFile('db.enc', encryptBuffer(raw));
    });
  }, 800);
}

function syncFileUp(localPath, remotePath) {
  if (!ENABLED) return;
  enqueue(async () => {
    if (!fs.existsSync(localPath)) return;
    const buf = await fsp.readFile(localPath);
    await putRemoteFile(remotePath, buf);
  });
}

function syncFileDel(remotePath) {
  if (!ENABLED) return;
  enqueue(() => deleteRemoteFile(remotePath));
}

module.exports = { ENABLED, restoreFromCloud, syncDb, syncFileUp, syncFileDel };
