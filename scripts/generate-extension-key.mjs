// Generate an RSA-2048 keypair for pinning the extension ID.
//
//   node scripts/generate-extension-key.mjs
//
// Writes the private key to keys/private.pem (gitignored), prints the
// public key (paste into manifest.json `key`) and the deterministic
// extension ID that Chrome will compute from it.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const keysDir = join(here, '..', 'keys');
if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });

const privKeyPath = join(keysDir, 'private.pem');
const pubKeyB64Path = join(keysDir, 'public.b64');

if (existsSync(privKeyPath)) {
  console.error(`Refusing to overwrite existing ${privKeyPath}`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048
});

const privKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
const pubKeyBase64 = pubKeyDer.toString('base64');

writeFileSync(privKeyPath, privKeyPem);
writeFileSync(pubKeyB64Path, pubKeyBase64 + '\n');

// Chrome's deterministic extension-ID derivation:
//   ID = first 32 hex chars of SHA-256(public_key_DER), each digit mapped a..p
const sha = createHash('sha256').update(pubKeyDer).digest('hex').slice(0, 32);
const extensionId = sha
  .split('')
  .map((c) => String.fromCharCode(parseInt(c, 16) + 'a'.charCodeAt(0)))
  .join('');

console.log('\nGenerated extension keypair.\n');
console.log('Private key (gitignored, keep safe):');
console.log('  ' + privKeyPath + '\n');
console.log('manifest.json `key` field value:');
console.log('  ' + pubKeyBase64 + '\n');
console.log('Pinned extension ID:');
console.log('  ' + extensionId + '\n');
console.log('Seznam OAuth redirect URI to register:');
console.log('  https://' + extensionId + '.chromiumapp.org/\n');
