import { File, Directory, Paths } from 'expo-file-system';
import { IMAGE_STORAGE_DIR } from '../constants';

export class StorageFullError extends Error {
  constructor(available: number, required: number) {
    super(`Insufficient storage: ${available} bytes available, ${required} bytes required`);
    this.name = 'StorageFullError';
  }
}

function storageDir(): Directory {
  return new Directory(Paths.document, IMAGE_STORAGE_DIR);
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

async function save(sourcePath: string, fileName: string): Promise<string> {
  const dir = storageDir();
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }

  const sourceFile = new File(toFileUri(sourcePath));
  const sourceSize = sourceFile.size;
  const available = Paths.availableDiskSpace;

  if (available < sourceSize * 2) {
    throw new StorageFullError(available, sourceSize * 2);
  }

  const destFile = new File(dir, fileName);
  await sourceFile.copy(destFile);
  // Return absolute filesystem path (strip file:// prefix)
  return destFile.uri.replace('file://', '');
}

function deleteByPath(imagePath: string): void {
  const file = new File(toFileUri(imagePath));
  if (file.exists) {
    file.delete();
  }
}

function deleteByPersonnelId(personnelId: string): void {
  const dir = storageDir();
  if (!dir.exists) return;

  const items = dir.list();
  for (const item of items) {
    if (item instanceof File && item.name.startsWith(`${personnelId}_`)) {
      item.delete();
    }
  }
}

export const ImageStorageService = { save, deleteByPath, deleteByPersonnelId };
