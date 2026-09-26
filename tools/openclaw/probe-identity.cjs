// Persistent device identity and token store for the Node-side test tools, so
// repeated probe and e2e runs reuse one paired device instead of piling up new
// ones on the gateway. Keys are kept as JWK in .probe-state/ (gitignored, 0600).

const fs = require('node:fs');
const path = require('node:path');

const stateDir = path.join(__dirname, '.probe-state');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const keyFile = path.join(stateDir, 'device-key.json');
const keyStore = {
  async load() {
    const { subtle } = globalThis.crypto;
    if (!fs.existsSync(keyFile)) {
      const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const jwk = { publicKey: await subtle.exportKey('jwk', pair.publicKey), privateKey: await subtle.exportKey('jwk', pair.privateKey) };
      fs.writeFileSync(keyFile, JSON.stringify(jwk), { mode: 0o600 });
    }
    const jwk = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    return {
      publicKey: await subtle.importKey('jwk', jwk.publicKey, { name: 'Ed25519' }, true, ['verify']),
      privateKey: await subtle.importKey('jwk', jwk.privateKey, { name: 'Ed25519' }, false, ['sign']),
    };
  },
  async save() { /* load() always returns a pair */ },
};

const tokenFile = path.join(stateDir, 'device-tokens.json');
const readTokens = () => (fs.existsSync(tokenFile) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')) : {});
const writeTokens = all => fs.writeFileSync(tokenFile, JSON.stringify(all, null, 2), { mode: 0o600 });
const tokenKey = p => `${p.deviceId}:${p.clientId}:${p.role}`;
const tokenStore = {
  load: p => readTokens()[tokenKey(p)] || null,
  store: p => { const all = readTokens(); all[tokenKey(p)] = { token: p.token, scopes: p.scopes }; writeTokens(all); },
  clear: p => { const all = readTokens(); delete all[tokenKey(p)]; writeTokens(all); },
};

/** The client identity the probe paired as operator. */
const operatorClient = { id: 'webchat-ui', mode: 'webchat', version: '2.0.0', platform: 'chrome', displayName: 'ECHO' };

module.exports = { keyStore, tokenStore, operatorClient };
