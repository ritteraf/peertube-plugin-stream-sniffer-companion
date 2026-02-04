module.exports = {
  encrypt,
  decrypt
};
// lib/secure-store.js
// Secure JSON storage with AES-256-GCM encryption
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended

// Key management: use PeerTube's persistent data directory (survives plugin updates)
// Path: /data/plugins/data/peertube-plugin-stream-sniffer-companion/encryption.key
const KEY_FILE = path.join(__dirname, '../../../../../data/peertube-plugin-stream-sniffer-companion/encryption.key');
let KEY;

// Ensure the data directory exists
const dataDir = path.dirname(KEY_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

if (fs.existsSync(KEY_FILE)) {
  KEY = fs.readFileSync(KEY_FILE);
  if (KEY.length !== 32) throw new Error('encryption.key file must be 32 bytes');
} else {
  KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, KEY, { mode: 0o600 });
  console.log('[PLUGIN] Generated new encryption key at:', KEY_FILE);
}

function getStorageFile(name) {
  return path.join(__dirname, '../storage', name + '.json.enc');
}

function encrypt(data) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, Buffer.from(KEY), iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(enc) {
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.slice(0, IV_LENGTH);
  const tag = buf.slice(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buf.slice(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGO, Buffer.from(KEY), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function readJson(name) {
  const file = getStorageFile(name);
  if (!fs.existsSync(file)) return {};
  const enc = fs.readFileSync(file, 'utf8');
  return decrypt(enc);
}

function writeJson(name, data) {
  const file = getStorageFile(name);
  const enc = encrypt(data);
  fs.writeFileSync(file, enc, 'utf8');
}

