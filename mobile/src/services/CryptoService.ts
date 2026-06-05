import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';

/**
 * T073: AES-256-GCM field-level encryption at rest for PII, keyed by a device-bound key
 * held in the OS keystore via `expo-secure-store` (hardware-backed where available). The
 * key never leaves the device and is generated once on first use.
 *
 * `expo-crypto` provides only digests + secure random — no symmetric cipher — so the AES
 * is the pure-JS, audited `@noble/ciphers` (works under Hermes). GCM gives authenticated
 * encryption (tampering is detected on decrypt). Each value uses a fresh 12-byte nonce,
 * stored as a prefix of the ciphertext.
 *
 * Scope (biometric-focused): the face embedding BLOB + `full_name`. `employee_id` stays
 * plaintext (it's the UNIQUE / RDS-upsert key); the transient sync_outbox payload stays
 * plaintext (sent over SigV4 TLS).
 */
const KEY_ALIAS = 'nhai_pii_key_v1';
const NONCE_BYTES = 12;
const STRING_PREFIX = 'v1.'; // marks encrypted strings; lets reads tolerate legacy plaintext

let keyPromise: Promise<Uint8Array> | null = null;

/** Get-or-create the 32-byte AES-256 key in the OS keystore (cached in-memory per session). */
async function getKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await SecureStore.getItemAsync(KEY_ALIAS);
      if (existing) return hexToBytes(existing);
      const fresh = Crypto.getRandomBytes(32);
      await SecureStore.setItemAsync(KEY_ALIAS, bytesToHex(fresh));
      return fresh;
    })();
  }
  return keyPromise;
}

/** Encrypt raw bytes → `[nonce(12) | GCM ciphertext+tag]`. */
export async function encryptBytes(plain: Uint8Array): Promise<Uint8Array> {
  const key = await getKey();
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  const ct = gcm(key, nonce).encrypt(plain);
  const out = new Uint8Array(NONCE_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

/** Decrypt bytes produced by {@link encryptBytes}. Throws if the data was tampered with. */
export async function decryptBytes(blob: Uint8Array): Promise<Uint8Array> {
  const key = await getKey();
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ct = blob.subarray(NONCE_BYTES);
  return gcm(key, nonce).decrypt(ct);
}

/** Encrypt a UTF-8 string → `"v1.<hex>"`. */
export async function encryptString(plain: string): Promise<string> {
  return STRING_PREFIX + bytesToHex(await encryptBytes(utf8ToBytes(plain)));
}

/**
 * Decrypt a string produced by {@link encryptString}. Values without the `v1.` prefix are
 * returned as-is — tolerating records written before encryption was enabled (migration).
 */
export async function decryptString(value: string): Promise<string> {
  if (!value.startsWith(STRING_PREFIX)) return value;
  return bytesToUtf8(await decryptBytes(hexToBytes(value.slice(STRING_PREFIX.length))));
}

export const CryptoService = { encryptBytes, decryptBytes, encryptString, decryptString };
