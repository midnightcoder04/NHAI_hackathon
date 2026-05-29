/**
 * Global test setup. Replaces native Expo modules with Node-backed equivalents so
 * unit/integration tests run under the jest-expo (React Native) environment.
 *
 * - expo-crypto  → real Node `crypto` (deterministic SHA-256, RFC-4122 v4 UUIDs).
 * - expo-sqlite  → `useSQLiteContext` is a jest.fn(); integration tests point it at a
 *   real `node:sqlite` database via __tests__/helpers/testDb (NOT a mock DB — see
 *   Constitution III: integration tests run against real implementations).
 */

jest.mock('expo-crypto', () => {
  const nodeCrypto = require('crypto');
  return {
    randomUUID: () => nodeCrypto.randomUUID(),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: async (_algorithm, data) =>
      nodeCrypto.createHash('sha256').update(String(data)).digest('hex'),
  };
});

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: jest.fn(),
  SQLiteProvider: ({ children }) => children,
  openDatabaseAsync: jest.fn(),
}));
