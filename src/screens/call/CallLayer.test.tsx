// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { isValidElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CallLayer, callSlot } from './CallLayer';
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
      description: '¿Contestar directo? Ana Torres verá tu IP.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Contestar directo' }));
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

describe('callSlot', () => {
  it('hands the shell the layer, the way to call and who the call is with', () => {
    const controller = fakeController();
    const slot = callSlot(controller);
    expect(isValidElement(slot.layer) && slot.layer.type).toBe(CallLayer);
    expect(slot.start).toBe(controller.start);
    expect(slot.activePeer).toBe('ana');
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
