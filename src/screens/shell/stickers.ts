/** The stickers the chat's picker shows, imports and removes, over the backend's commands. */
import type { StickerApi } from '../types';
import type { ShellApi } from './shell-api';

/** A file's contents in base64, without the `data:` prefix. */
function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

export function stickerApi(api: Pick<ShellApi, 'listStickers' | 'importSticker' | 'deleteSticker'>): StickerApi {
  return {
    list: () => api.listStickers(),
    importFile: async file => api.importSticker(await readBase64(file), file.type || 'image/png'),
    remove: id => api.deleteSticker(id),
  };
}
