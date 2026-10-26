import { describe, expect, it } from 'vitest';
import { makeT } from '../../lib/i18n';
import { fileKindOf, previewOf, shortFingerprint, shownName, sizeText, viaOf } from './requests-model';
import { request, T0 } from './test-support';

const t = makeT('es');

describe('how a request names itself', () => {
  it('says the name the admin wrote with "~" (R-10)', () => {
    expect(shownName(request())).toBe('ana');
    expect(shownName(request({ name: 'mara', by_admin: true }))).toBe('~mara');
    expect(shownName(request({ name: '' }))).toBe('?');
  });

  it('says where it came from, as §12.2 words it', () => {
    expect(viaOf(request(), t)).toBe('por tu @nombre');
    expect(viaOf(request({ via: { kind: 'link', label: 'Para Mara' } }), t)).toBe('usó tu enlace «Para Mara»');
    expect(viaOf(request({ via: { kind: 'code', label: 'Trabajo' } }), t)).toBe('usó tu código «Trabajo»');
    expect(viaOf(request({ via: { kind: 'group', gid: 'g1', group: 'Familia' } }), t)).toBe('está en «Familia» contigo');
  });

  it('shows the first two groups of the fingerprint', () => {
    expect(shortFingerprint(request().fingerprint)).toBe('70A5 83C6');
  });
});

describe('what a request says of what came', () => {
  it('previews its latest text, else a file or a call, never their content', () => {
    expect(previewOf(request(), t)).toBe('Hola, soy Ana, la del taller de cerámica');
    const file = request({ items: [{ kind: 'file', mime: 'image/jpeg', size: 1_200_000, at: T0 }] });
    expect(previewOf(file, t)).toBe('Mandó un archivo');
    const call = request({ items: [{ kind: 'call', video: false, at: T0 }] });
    expect(previewOf(call, t)).toBe('Intentó llamarte');
    const both = request({
      items: [
        { kind: 'text', text: 'primero', at: T0 },
        { kind: 'text', text: 'después', at: T0 + 1 },
        { kind: 'call', video: true, at: T0 + 2 },
      ],
    });
    expect(previewOf(both, t)).toBe('después');
  });

  it('names a file by its kind and its size', () => {
    expect(fileKindOf('image/jpeg')).toBe('photo');
    expect(fileKindOf('image/png')).toBe('photo');
    expect(fileKindOf('video/mp4')).toBe('video');
    expect(fileKindOf('audio/ogg')).toBe('audio');
    expect(fileKindOf('application/pdf')).toBe('file');
    expect(sizeText(1_258_291, 'es')).toBe('1,2 MB');
    expect(sizeText(2_048, 'es')).toBe('2 kB');
  });
});
