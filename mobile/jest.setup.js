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

// Native ML runtime (Nitro): VisionCamera v5 + fast-tflite v3 are Nitro HybridObjects
// with no JS implementation under jest. Stub the model loader + NitroModules.box so the
// tfliteRuntime loader logic is unit-testable without a device build.
jest.mock('react-native-fast-tflite', () => ({
  loadTensorflowModel: jest.fn(async () => ({
    inputs: [{ name: 'input', dataType: 'float32', shape: [1, 128, 128, 3] }],
    outputs: [{ name: 'output', dataType: 'float32', shape: [1, 128] }],
    delegates: [],
    runSync: jest.fn(() => [new ArrayBuffer(8)]),
    run: jest.fn(async () => [new ArrayBuffer(8)]),
  })),
}));

jest.mock('react-native-nitro-modules', () => ({
  NitroModules: { box: jest.fn((obj) => ({ unbox: () => obj })) },
}));
