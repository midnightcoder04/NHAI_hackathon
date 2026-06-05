import * as Crypto from 'expo-crypto';

export async function computeIdempotencyKey(parts: string[]): Promise<string> {
  const input = parts.join(':');
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
}
