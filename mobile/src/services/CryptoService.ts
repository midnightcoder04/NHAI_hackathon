/**
 * T073: AES-256-GCM field-level encryption for PII at rest.
 *
 * Key lifecycle: a 256-bit AES key is generated once and stored in
 * expo-secure-store under a stable key name (device-bound, not exportable
 * beyond the secure enclave / keystore). All encrypt/decrypt calls use
 * AES-256-GCM with a random 96-bit IV prepended to the ciphertext.
 *
 * Future upgrade path: SQLCipher full-DB encryption (expo-sqlite doesn't
 * bundle it currently); field-level encryption is the interim safeguard.
 */
import * as SecureStore from 'expo-secure-store';

const SECURE_STORE_KEY = 'nhai_aes_key_v1';
const IV_BYTES = 12; // 96-bit IV for AES-GCM

/** Lazily cached raw AES key bytes (base64 → ArrayBuffer). */
let cachedKey: CryptoKey | null = null;

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  let keyB64 = await SecureStore.getItemAsync(SECURE_STORE_KEY);
  if (!keyB64) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    keyB64 = bufToBase64(raw);
    await SecureStore.setItemAsync(SECURE_STORE_KEY, keyB64, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  const rawBytes = base64ToBuf(keyB64);
  // Slice to produce a plain ArrayBuffer (BufferSource) — required by SubtleCrypto
  cachedKey = await crypto.subtle.importKey('raw', rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return cachedKey;
}

function bufToBase64(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt a UTF-8 string.
 * Returns a base64-encoded string: <12-byte IV> | <ciphertext>.
 */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return bufToBase64(combined);
}

/**
 * Decrypt a base64 blob produced by encryptString.
 */
export async function decryptString(ciphertextB64: string): Promise<string> {
  const key = await getOrCreateKey();
  const combined = base64ToBuf(ciphertextB64);
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt arbitrary binary (Uint8Array / ArrayBuffer).
 * Returns a Uint8Array: <12-byte IV> | <ciphertext>.
 */
export async function encryptBytes(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // slice() produces a plain ArrayBuffer — SubtleCrypto requires ArrayBuffer not Uint8Array<ArrayBufferLike>
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  return combined;
}

/**
 * Decrypt a Uint8Array produced by encryptBytes.
 */
export async function decryptBytes(data: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const key = await getOrCreateKey();
  const combined = data instanceof Uint8Array ? data : new Uint8Array(data);
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(plaintext);
}

export const CryptoService = {
  encryptString,
  decryptString,
  encryptBytes,
  decryptBytes,
};
