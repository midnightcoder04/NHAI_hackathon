/**
 * T073: AES-256-GCM field-level encryption (device key mocked via expo-secure-store in
 * jest.setup; real @noble/ciphers + Node random).
 */
import { CryptoService } from '../../../src/services/CryptoService';

describe('CryptoService (AES-256-GCM)', () => {
  it('round-trips a string and marks it encrypted', async () => {
    const ct = await CryptoService.encryptString('Asha Rao');
    expect(ct).not.toBe('Asha Rao');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(await CryptoService.decryptString(ct)).toBe('Asha Rao');
  });

  it('round-trips raw bytes (e.g. an embedding BLOB)', async () => {
    const data = new Uint8Array([1, 2, 3, 255, 0, 128, 64]);
    const enc = await CryptoService.encryptBytes(data);
    expect(Array.from(await CryptoService.decryptBytes(enc))).toEqual(Array.from(data));
  });

  it('uses a fresh nonce per call (ciphertext differs, still decrypts)', async () => {
    const a = await CryptoService.encryptString('same');
    const b = await CryptoService.encryptString('same');
    expect(a).not.toBe(b);
    expect(await CryptoService.decryptString(a)).toBe('same');
    expect(await CryptoService.decryptString(b)).toBe('same');
  });

  it('passes through legacy plaintext (no v1. prefix) unchanged', async () => {
    expect(await CryptoService.decryptString('legacy-plain')).toBe('legacy-plain');
  });

  it('rejects tampered ciphertext (GCM authentication)', async () => {
    const ct = await CryptoService.encryptString('secret');
    const tampered = ct.slice(0, -2) + (ct.endsWith('00') ? '11' : '00');
    await expect(CryptoService.decryptString(tampered)).rejects.toThrow();
  });
});
