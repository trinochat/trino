// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { renderIn } from '../test-utils';
import { MediaViewer } from './MediaViewer';

afterEach(cleanup);

const PICTURE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAA==';

function Opener({ onDownload = () => {} }: { onDownload?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Ver foto
      </button>
      <MediaViewer open={open} name="foto.jpg" url={PICTURE} video={false} onClose={() => setOpen(false)} onDownload={onDownload} />
    </>
  );
}

describe('MediaViewer', () => {
  it('opens as a dialog named after the file, with the focus inside', () => {
    renderIn(<Opener />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto' }));
    const dialog = screen.getByRole('dialog', { name: 'foto.jpg' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('img', { name: 'foto.jpg' }).getAttribute('src')).toBe(PICTURE);
  });

  it('closes with Escape and gives the focus back to what opened it', () => {
    renderIn(<Opener />);
    const opener = screen.getByRole('button', { name: 'Ver foto' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes with its close button too, and saves the file with Descargar', () => {
    const onDownload = vi.fn();
    renderIn(<Opener onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('plays a video with its controls, never on its own', () => {
    renderIn(<MediaViewer open name="clip.mp4" url="data:video/mp4;base64,AAAA" video onClose={() => {}} onDownload={() => {}} />);
    const video = screen.getByRole('dialog', { name: 'clip.mp4' }).querySelector('video')!;
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.autoplay).toBe(false);
  });
});
