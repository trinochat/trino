import type { ReactNode } from 'react';
import { describe, expectTypeOf, it } from 'vitest';
import type { ForgeResponse, GroupInfo, NodeInfo, UnsealResponse } from '../lib/api';
import type { ConvoRef as LibConvoRef } from '../lib/convo';
import type {
  CallSlot,
  ChannelViewProps,
  ChatPaneProps,
  ConvoRef,
  InboxFilter,
  Msg,
  OnboardingApi,
  SendFailure,
  SettingsSectionId,
  ShellSlots,
  Trust,
  UnlockApi,
} from './types';

// The props contracts between the units of the redesign. Checked by tsc: a
// change here breaks the build of every unit that relies on it, which is the
// point. Only the parent changes types.ts (plan §2, E0.3).
describe('the screen contracts', () => {
  it('share the conversation reference of lib/convo', () => {
    expectTypeOf<ConvoRef>().toEqualTypeOf<LibConvoRef>();
  });

  it('describe a message with a stable key, a side and an optional send state', () => {
    expectTypeOf<Msg['key']>().toEqualTypeOf<string>();
    expectTypeOf<Msg['side']>().toEqualTypeOf<'me' | 'them'>();
    expectTypeOf<Msg['state']>().toEqualTypeOf<'sending' | 'sent' | 'failed' | undefined>();
    expectTypeOf<SendFailure>().toEqualTypeOf<'offline' | 'not_accepted' | 'too_long' | 'no_session' | 'partial' | 'other'>();
  });

  it('leave message requests out of this batch', () => {
    expectTypeOf<InboxFilter>().toEqualTypeOf<'all' | 'unread' | 'groups'>();
    expectTypeOf<Trust>().toEqualTypeOf<'verified' | 'unverified' | 'keyChanged'>();
  });

  it('inject the backend into the first run and unlock screens', () => {
    expectTypeOf<OnboardingApi['createIdentity']>().returns.toEqualTypeOf<Promise<ForgeResponse>>();
    expectTypeOf<UnlockApi['unseal']>().returns.toEqualTypeOf<Promise<UnsealResponse>>();
  });

  it('let the shell mount every other unit through its slots', () => {
    expectTypeOf<keyof ShellSlots>().toEqualTypeOf<
      'chat' | 'channel' | 'contacts' | 'newGroup' | 'groupPanel' | 'settings' | 'contactDetails' | 'verifyContact'
    >();
    expectTypeOf<ShellSlots['groupPanel']>().parameter(0).toHaveProperty('group').toEqualTypeOf<GroupInfo>();
    expectTypeOf<ShellSlots['contactDetails']>().parameter(0).toHaveProperty('node').toEqualTypeOf<NodeInfo>();
    expectTypeOf<ReturnType<ShellSlots['chat']>>().toEqualTypeOf<ReactNode>();
    expectTypeOf<CallSlot['bar']>().toEqualTypeOf<ReactNode | null>();
  });

  it('keep the chat on contacts and groups, never the channel', () => {
    expectTypeOf<ChatPaneProps['convo']>().toEqualTypeOf<Exclude<ConvoRef, { kind: 'channel' }>>();
  });

  // The links in a message open through the shell, as the channel's do, so
  // the chat never imports the opener plugin and its tests need no mock.
  it('hand the links of a message to the shell', () => {
    expectTypeOf<ChatPaneProps['onOpenLink']>().toEqualTypeOf<(url: string) => void>();
    expectTypeOf<ChatPaneProps['onOpenLink']>().toEqualTypeOf<ChannelViewProps['onOpenLink']>();
  });

  // Delete for me needs the backend (K11). Until it lands the shell leaves
  // the handler out and the chat hides the menu item: nothing is faked.
  it('make delete for me optional, so the chat can hide it', () => {
    expectTypeOf<ChatPaneProps['onDeleteForMe']>().toEqualTypeOf<((msgKey: string) => Promise<void>) | undefined>();
  });

  // Accessibility sits between Appearance and Language (accesibilidad.md §2.1).
  it('name the eight sections of Settings', () => {
    expectTypeOf<SettingsSectionId>().toEqualTypeOf<
      'profile' | 'privacy' | 'notifications' | 'security' | 'appearance' | 'accessibility' | 'language' | 'advanced'
    >();
  });
});
