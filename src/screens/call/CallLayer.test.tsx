// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { isValidElement, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from '../../ui';
import { CallLayer, callCoversShell, callSlot } from './CallLayer';
import { fakeController, renderIn } from './test-support';
import type { CallController } from './useCallController';

afterEach(cleanup);

const STREAM = { id: 'remote' } as unknown as MediaStream;

function layer(over: Partial<CallController> = {}) {
  const controller = fakeController(over);
  const view = renderIn(<CallLayer controller={controller} />);
  return { ...view, controller };
}

const callScreen = () => screen.queryByRole('region', { name: 'Llamada en curso con Ana Torres' });
const callName = () => within(callScreen()!).getByRole('heading', { name: 'Ana Torres' });

/** The shell as W2 mounts the call slot: the bar above the chat, and the layer over it all. */
function Shell({ over = {} }: { over?: Partial<CallController> }) {
  const [minimized, setMinimized] = useState(false);
  const slot = callSlot(fakeController({ minimized, setMinimized, ...over }));
  return (
    <>
      {slot.bar}
      <textarea aria-label="Mensaje" />
      {slot.layer}
    </>
  );
}

describe('CallLayer', () => {
  it('keeps playing the other side while the call is minimized to its bar', () => {
    layer({ minimized: true, remoteStream: STREAM });
    expect(callScreen()).toBeNull();
    expect(document.querySelector('audio')!.srcObject).toBe(STREAM);
  });

  it('shows the call screen while a call rings out, connects or is on', () => {
    for (const view of ['ringing-out', 'connecting', 'connected'] as const) {
      const { unmount } = layer({ view });
      expect(callScreen()).not.toBeNull();
      unmount();
    }
    layer({ view: 'idle', activePeer: null });
    expect(callScreen()).toBeNull();
  });

  it('rings an incoming call, and answers or declines it through the controller', () => {
    const { controller } = layer({ view: 'incoming', video: true });
    screen.getByRole('alertdialog', { name: 'Ana Torres', description: 'Videollamada entrante' });
    expect(callScreen()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Contestar solo con audio' }));
    expect(controller.accept).toHaveBeenCalledWith({ video: false });
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(controller.reject).toHaveBeenCalledTimes(1);
  });

  it('asks before answering directly, naming the contact, and answers through the controller', () => {
    const { controller } = layer({ view: 'connecting', consent: { peer: 'ana', outgoing: false } });
    screen.getByRole('alertdialog', {
      name: 'No se pudo proteger la llamada.',
      description: '¿Contestar sin protección? Ana Torres verá desde dónde te conectas.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Contestar' }));
    expect(controller.answerConsent).toHaveBeenCalledWith(true);
  });

  it('shows the end card of a call that ended', () => {
    const { controller } = layer({
      view: 'ended',
      activePeer: null,
      ended: {
        callId: 'c'.repeat(32),
        peer: 'ana',
        name: 'Ana Torres',
        avatar: null,
        reason: 'ended',
        durationSec: 61,
        video: false,
        logged: true,
      },
    });
    screen.getByRole('dialog', { name: 'Llamada finalizada' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a llamar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(controller.callAgain).toHaveBeenCalledTimes(1);
    expect(controller.dismissEnded).toHaveBeenCalledTimes(1);
  });

  it('asks before hanging up to lock', () => {
    const { controller } = layer({ endConfirm: 'lock' });
    screen.getByRole('alertdialog', { name: 'Hay una llamada en curso' });
    fireEvent.click(screen.getByRole('button', { name: 'Colgar y bloquear' }));
    expect(controller.answerEndConfirm).toHaveBeenCalledWith(true);
  });
});

// The call screen covers the shell: the focus may not stay behind it (WCAG 2.4.11), and its Escape only
// hears a focus inside it (review of W6).
describe('the focus', () => {
  it('goes into the call screen when it shows, so Escape works from the start', () => {
    renderIn(<Shell />);
    expect(document.activeElement).toBe(callName());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(callScreen()).toBeNull();
    expect(screen.getByRole('region', { name: 'Llamada en curso' })).toBeTruthy();
  });

  it('goes to "Volver a la llamada" on minimizing, and back into the call screen on returning', () => {
    renderIn(<Shell />);
    fireEvent.keyDown(callName(), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Volver a la llamada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a la llamada' }));
    expect(document.activeElement).toBe(callName());
    fireEvent.click(screen.getByRole('button', { name: 'Volver al chat' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Volver a la llamada' }));
  });

  // The incoming call gives the focus back to what had it, here the chat, as it closes: the call
  // screen takes it after that, or the typing would go on in the hidden draft.
  it('takes the focus from the chat when a call answered from the keyboard covers it', () => {
    const view = renderIn(<Shell over={{ view: 'idle', activePeer: null }} />);
    const composer = screen.getByRole('textbox', { name: 'Mensaje' });
    composer.focus();
    view.rerender(<Shell over={{ view: 'incoming' }} />);
    expect(document.activeElement).not.toBe(composer);
    view.rerender(<Shell over={{ view: 'connecting' }} />);
    expect(document.activeElement).toBe(callName());
  });

  // A dialog of the shell stays above the call screen (both are portals at z-40 over its z-30): it keeps
  // the focus it holds, as aria-modal promises.
  it('leaves the focus in a dialog that is open over the shell', () => {
    const withDialog = (over: Partial<CallController>) => (
      <>
        <Dialog open onClose={() => {}} title="Contactos">
          <button type="button">Agregar</button>
        </Dialog>
        <Shell over={over} />
      </>
    );
    const view = renderIn(withDialog({ view: 'idle', activePeer: null }));
    const inDialog = screen.getByRole('button', { name: 'Agregar' });
    expect(document.activeElement).toBe(inDialog);
    view.rerender(withDialog({ view: 'connecting' }));
    expect(callScreen()).not.toBeNull();
    expect(document.activeElement).toBe(inDialog);
  });

  // The bar takes the focus that the call screen gives up as it minimizes, and only that one.
  it('leaves the focus where it is when the bar shows without the call screen giving it up', () => {
    const chat = (bar: ReactNode) => (
      <>
        {bar}
        <textarea aria-label="Mensaje" />
      </>
    );
    const view = renderIn(chat(null));
    const composer = screen.getByRole('textbox', { name: 'Mensaje' });
    composer.focus();
    view.rerender(chat(callSlot(fakeController({ minimized: true })).bar));
    expect(screen.getByRole('button', { name: 'Volver a la llamada' })).toBeTruthy();
    expect(document.activeElement).toBe(composer);
  });
});

describe('callSlot', () => {
  it('hands the shell the layer, the way to call and who the call is with', () => {
    const controller = fakeController();
    const slot = callSlot(controller);
    expect(isValidElement(slot.layer) && slot.layer.type).toBe(CallLayer);
    expect(slot.start).toBe(controller.start);
    expect(slot.activePeer).toBe('ana');
  });

  // For the shell to make its panes inert meanwhile: CallSlot.covering (I5).
  it('says when the call screen covers the shell', () => {
    for (const view of ['ringing-out', 'connecting', 'connected'] as const) {
      expect(callCoversShell(fakeController({ view }))).toBe(true);
      expect(callCoversShell(fakeController({ view, minimized: true }))).toBe(false);
    }
    for (const view of ['idle', 'incoming', 'ended'] as const) {
      expect(callCoversShell(fakeController({ view, activePeer: view === 'incoming' ? 'ana' : null }))).toBe(false);
    }
  });

  it('tells the shell when the call screen covers it, as the screen shows', () => {
    for (const view of ['ringing-out', 'connecting', 'connected'] as const) {
      expect(callSlot(fakeController({ view })).covering).toBe(true);
      expect(callSlot(fakeController({ view, minimized: true })).covering).toBe(false);
    }
    for (const view of ['idle', 'incoming', 'ended'] as const) {
      expect(callSlot(fakeController({ view, activePeer: view === 'incoming' ? 'ana' : null })).covering).toBe(false);
    }
  });

  it('shows the bar only while a call is minimized', () => {
    expect(callSlot(fakeController()).bar).toBeNull();
    expect(callSlot(fakeController({ minimized: true, view: 'incoming' })).bar).toBeNull();
    expect(callSlot(fakeController({ minimized: true, activePeer: null, view: 'ended' })).bar).toBeNull();
    const controller = fakeController({ minimized: true, media: { muted: true, cameraOn: false, hasVideo: false } });
    renderIn(<>{callSlot(controller).bar}</>);
    const region = screen.getByRole('region', { name: 'Llamada en curso' });
    expect(region.textContent).toContain('En llamada con Ana Torres');
    expect(screen.getByRole('button', { name: 'Silenciar micrófono' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a la llamada' }));
    expect(controller.setMinimized).toHaveBeenCalledWith(false);
  });
});
