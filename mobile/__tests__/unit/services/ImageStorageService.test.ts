/**
 * Unit tests for ImageStorageService (T087). expo-file-system is mocked at the unit
 * boundary with an in-memory fake (Constitution III: unit tests isolate external deps).
 */
jest.mock('expo-file-system', () => {
  const files = new Map(); // uri -> size (bytes)
  const dirs = new Set(); // dir uri
  const state = { available: 1_000_000_000 };

  const join = (a, b) => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`.replace(/\/+$/, '');

  class Directory {
    constructor(...parts) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : p.uri))
        .reduce((acc, p) => (acc === undefined ? p.replace(/\/+$/, '') : join(acc, p)), undefined);
    }
    get exists() {
      return dirs.has(this.uri);
    }
    create() {
      dirs.add(this.uri);
    }
    list() {
      return [...files.keys()]
        .filter((u) => u.startsWith(`${this.uri}/`))
        .map((u) => new File(u));
    }
  }

  class File {
    constructor(a, b) {
      this.uri = a instanceof Directory ? join(a.uri, b) : a;
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return files.get(this.uri) ?? 0;
    }
    async copy(dest) {
      files.set(dest.uri, this.size);
    }
    delete() {
      files.delete(this.uri);
    }
  }

  const Paths = {
    document: 'file:///doc',
    get availableDiskSpace() {
      return state.available;
    },
  };

  return {
    File,
    Directory,
    Paths,
    __fs: {
      addFile: (uri, size) => files.set(uri, size),
      addDir: (uri) => dirs.add(uri),
      hasFile: (uri) => files.has(uri),
      hasDir: (uri) => dirs.has(uri),
      setAvailable: (n) => {
        state.available = n;
      },
      reset: () => {
        files.clear();
        dirs.clear();
        state.available = 1_000_000_000;
      },
    },
  };
});

import * as FileSystem from 'expo-file-system';
import { ImageStorageService, StorageFullError } from '../../../src/services/ImageStorageService';

const fs = (FileSystem as unknown as { __fs: any }).__fs;
const STORAGE_DIR = 'file:///doc/face_images';

beforeEach(() => fs.reset());

describe('ImageStorageService.save', () => {
  it('given_sufficient_space_when_save_then_returns_absolute_path_without_scheme', async () => {
    fs.addFile('file:///tmp/src.jpg', 1000);

    const path = await ImageStorageService.save('/tmp/src.jpg', 'p1_0.jpg');

    expect(path).not.toContain('file://');
    expect(path).toBe('/doc/face_images/p1_0.jpg');
    expect(fs.hasFile(`${STORAGE_DIR}/p1_0.jpg`)).toBe(true);
  });

  it('given_missing_storage_dir_when_save_then_creates_it', async () => {
    fs.addFile('file:///tmp/src.jpg', 1000);
    expect(fs.hasDir(STORAGE_DIR)).toBe(false);

    await ImageStorageService.save('/tmp/src.jpg', 'p1_0.jpg');
    expect(fs.hasDir(STORAGE_DIR)).toBe(true);
  });

  it('given_free_space_below_twice_image_size_when_save_then_throws_StorageFullError', async () => {
    fs.addFile('file:///tmp/big.jpg', 1000);
    fs.setAvailable(1500); // < 2 * 1000

    await expect(ImageStorageService.save('/tmp/big.jpg', 'p1_0.jpg')).rejects.toBeInstanceOf(
      StorageFullError,
    );
    expect(fs.hasFile(`${STORAGE_DIR}/p1_0.jpg`)).toBe(false);
  });
});

describe('ImageStorageService.deleteByPersonnelId', () => {
  it('given_images_for_two_people_when_delete_one_then_only_their_files_removed', () => {
    fs.addDir(STORAGE_DIR);
    fs.addFile(`${STORAGE_DIR}/p1_0.jpg`, 10);
    fs.addFile(`${STORAGE_DIR}/p1_1.jpg`, 10);
    fs.addFile(`${STORAGE_DIR}/p2_0.jpg`, 10);

    ImageStorageService.deleteByPersonnelId('p1');

    expect(fs.hasFile(`${STORAGE_DIR}/p1_0.jpg`)).toBe(false);
    expect(fs.hasFile(`${STORAGE_DIR}/p1_1.jpg`)).toBe(false);
    expect(fs.hasFile(`${STORAGE_DIR}/p2_0.jpg`)).toBe(true);
  });

  it('given_no_storage_dir_when_delete_then_noop', () => {
    expect(() => ImageStorageService.deleteByPersonnelId('p1')).not.toThrow();
  });
});

describe('ImageStorageService.deleteByPath', () => {
  it('given_existing_file_when_deleteByPath_then_removed', () => {
    fs.addFile('file:///doc/face_images/p1_0.jpg', 10);
    ImageStorageService.deleteByPath('/doc/face_images/p1_0.jpg');
    expect(fs.hasFile('file:///doc/face_images/p1_0.jpg')).toBe(false);
  });
});
