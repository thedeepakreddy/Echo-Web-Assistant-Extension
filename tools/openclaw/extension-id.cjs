// ECHO's Chrome extension id, as Chrome computes it: the first 128 bits of
// SHA-256 over the manifest's public key, written with the letters a–p.
// Without a "key", Chrome hashes the unpacked folder path instead.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const toId = bytes => [...crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

function extensionId(dist = path.join(root, 'dist')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  return manifest.key ? toId(Buffer.from(manifest.key, 'base64')) : toId(dist);
}

module.exports = { extensionId };
