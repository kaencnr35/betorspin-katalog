'use strict';
const crypto = require('crypto');

const scrypt = (pw, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)));
});

/** Parola özeti üretir: scrypt$salt$hash (düz parola asla saklanmaz) */
async function hash(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(String(pw).normalize('NFKC'), salt);
  return `scrypt$${salt.toString('hex')}$${k.toString('hex')}`;
}

/** Sabit zamanlı karşılaştırma */
async function verify(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const k = await scrypt(String(pw).normalize('NFKC'), Buffer.from(s, 'hex'));
  const a = Buffer.from(h, 'hex');
  return a.length === k.length && crypto.timingSafeEqual(a, k);
}

module.exports = { hash, verify };
