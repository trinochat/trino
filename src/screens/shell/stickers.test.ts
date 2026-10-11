// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { stickerApi } from './stickers';
import { fakeApi } from './test-fakes';

describe('stickerApi', () => {
  it('lists and removes through the backend', async () => {
    const api = fakeApi();
    api.listStickers.mockResolvedValueOnce([{ id: 's1', mime: 'image/png', data_url: 'data:image/png;base64,QQ==' }]);
    const stickers = stickerApi(api);
    expect((await stickers.list()).map(s => s.id)).toEqual(['s1']);
    await stickers.remove('s1');
    expect(api.deleteSticker).toHaveBeenCalledWith('s1');
  });

  it('imports a picked file as base64 with its type', async () => {
    const api = fakeApi();
    api.importSticker.mockResolvedValueOnce({ id: 's2', mime: 'image/webp', data_url: 'data:image/webp;base64,QUJD' });
    const sticker = await stickerApi(api).importFile(new File(['ABC'], 'gato.webp', { type: 'image/webp' }));
    expect(api.importSticker).toHaveBeenCalledWith('QUJD', 'image/webp');
    expect(sticker.id).toBe('s2');
  });
});
