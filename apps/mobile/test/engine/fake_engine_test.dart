import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late FakeTrinoEngine engine;
  setUp(() => engine = FakeTrinoEngine(clock: () => now));
  // Not awaited: inside testWidgets nothing would run the future's completion.
  tearDown(() => unawaited(engine.dispose()));

  group('demo data', () {
    test('starts unlocked and connected, with a profile', () async {
      expect(await engine.identityState.first, IdentityState.unlocked);
      expect(await engine.network.first, const NetworkState.connected());
      final profile = await engine.profile.first;
      expect(profile.name, isNotEmpty);
      expect(profile.contactCode, startsWith('trino2:'));
      expect(profile.fingerprint, matches(RegExp(r'^([0-9A-F]{4} ){3}[0-9A-F]{4}$')));
    });

    test('has the demo chats, the latest first', () async {
      final chats = await engine.chats.first;
      expect(chats.map((c) => c.title), ['Ana Torres', 'Familia', 'Carlos Méndez', 'Lucía']);

      final ana = chats[0];
      expect((ana.kind, ana.trust, ana.unread), (ChatKind.direct, Trust.verified, 1));
      expect(ana.lastMessage, 'Perfecto, nos vemos el jueves');
      expect(ana.lastActivity, DateTime(2026, 10, 9, 10, 42));

      final familia = chats[1];
      expect(familia.kind, ChatKind.group);
      expect(familia.memberNames, ['Mamá', 'Papá']);
      expect((familia.lastSender, familia.lastMessage), ('Papá', 'Llego a las 7'));

      final carlos = chats[2];
      expect(carlos.draft, 'Mañana te confirmo la hora');
      expect(carlos.lastActivity!.day, 8, reason: 'yesterday');

      expect(chats[3].trust, Trust.unverified);
    });

    test('has the contacts, Mamá and Papá included', () async {
      final contacts = await engine.contacts.first;
      expect(contacts.map((c) => c.name), containsAll(['Ana Torres', 'Carlos Méndez', 'Lucía', 'Mamá', 'Papá']));
      expect(contacts.firstWhere((c) => c.name == 'Ana Torres').trust, Trust.verified);
    });

    test('gives the messages of a chat oldest first, with their states', () async {
      final ana = (await engine.chats.first).first;
      final messages = [...(await engine.messages(ana.id).first).where((m) => !m.isCall)];
      expect(messages.map((m) => m.text), [
        '¿Te llegó el documento que te mandé?',
        'Sí, ya lo revisé. Está todo bien.',
        '¿El jueves a las 6, entonces?',
        'Perfecto, nos vemos el jueves',
      ]);
      expect(messages.map((m) => m.outgoing), [true, false, true, false]);
      expect(messages.first.sentAt, DateTime(2026, 10, 9, 10, 31));

      final carlos = (await engine.chats.first).firstWhere((c) => c.title == 'Carlos Méndez');
      expect((await engine.messages(carlos.id).first).last.status, MessageStatus.failed);

      final familia = (await engine.chats.first).firstWhere((c) => c.isGroup);
      expect((await engine.messages(familia.id).first).first.sender, 'Mamá');
    });
  });

  group('chats', () {
    test('send shows the message as sending, then sent, and moves the chat up', () async {
      final lucia = (await engine.chats.first).last;
      final updates = record(engine.messages(lucia.id));
      await engine.send(lucia.id, 'Te la mando ya');
      await pumpEventQueue();
      final states = [for (final list in updates.skip(1)) list.last.status];
      expect(states.first, MessageStatus.sending);
      expect(states.last, MessageStatus.sent);
      expect(updates.last.last.text, 'Te la mando ya');

      final chats = await engine.chats.first;
      expect(chats.first.title, 'Lucía');
      expect((chats.first.lastMessage, chats.first.lastIsMine), ('Te la mando ya', true));
    });

    test('sending clears the draft', () async {
      final carlos = (await engine.chats.first).firstWhere((c) => c.title == 'Carlos Méndez');
      await engine.send(carlos.id, 'Mañana te confirmo la hora');
      await pumpEventQueue();
      expect((await engine.chats.first).firstWhere((c) => c.id == carlos.id).draft, isNull);
    });

    test('retry sends a failed message again', () async {
      final carlos = (await engine.chats.first).firstWhere((c) => c.title == 'Carlos Méndez');
      final failed = (await engine.messages(carlos.id).first).last;
      await engine.retry(carlos.id, failed.id);
      await pumpEventQueue();
      expect((await engine.messages(carlos.id).first).last.status, MessageStatus.sent);
    });

    test('leaving a draft moves the chat to the top; clearing it puts it back', () async {
      final before = await engine.chats.first;
      final lucia = before.last;
      expect(before.first.id, isNot(lucia.id));
      await engine.saveDraft(lucia.id, 'Te llamo al rato');
      final drafted = await engine.chats.first;
      expect(drafted.first.id, lucia.id, reason: 'a draft counts as activity, as in WhatsApp');
      expect(drafted.first.draft, 'Te llamo al rato');
      expect(drafted.first.lastActivity!.isAfter(before.first.lastActivity!), isTrue);

      // Opening the chat again saves the same words: that is not new activity.
      final at = drafted.first.lastActivity;
      await engine.saveDraft(lucia.id, 'Te llamo al rato');
      expect((await engine.chats.first).first.lastActivity, at);

      await engine.saveDraft(lucia.id, '');
      expect((await engine.chats.first).map((c) => c.id), before.map((c) => c.id));
    });

    test('keeps a draft per chat, and markRead clears the unread count', () async {
      final ana = (await engine.chats.first).first;
      await engine.saveDraft(ana.id, 'Llevo el');
      await engine.markRead(ana.id);
      final updated = (await engine.chats.first).firstWhere((c) => c.id == ana.id);
      expect((updated.draft, updated.unread), ('Llevo el', 0));
      await engine.saveDraft(ana.id, '   ');
      expect((await engine.chats.first).firstWhere((c) => c.id == ana.id).draft, isNull);
    });

    test('an incoming message adds to the unread count', () async {
      final ana = (await engine.chats.first).first;
      engine.receive(ana.id, '¿Llevo algo?');
      final updated = (await engine.chats.first).first;
      expect((updated.unread, updated.lastMessage), (2, '¿Llevo algo?'));
    });
  });

  group('contacts', () {
    test('adds a contact from a trino2 code and rejects anything else', () async {
      final contact = await engine.addContact('trino2:AQRBbmEgVG9ycmVzX2ZpZDQ2MWQ3YjBl');
      expect(contact.trust, Trust.unverified);
      expect((await engine.contacts.first).map((c) => c.id), contains(contact.id));
      expect(() => engine.addContact('hola'), throwsA(isA<InvalidContactCode>()));
      expect(() => engine.addContact('trino2:'), throwsA(isA<InvalidContactCode>()));
    });

    test('opens the chat of a contact, creating it the first time', () async {
      final contacts = await engine.contacts.first;
      final ana = contacts.firstWhere((c) => c.name == 'Ana Torres');
      final anaChat = (await engine.chats.first).first;
      expect(await engine.openChat(ana.id), anaChat.id);

      final papa = contacts.firstWhere((c) => c.name == 'Papá');
      final papaChat = await engine.openChat(papa.id);
      expect((await engine.chats.first).map((c) => c.id), contains(papaChat));
      expect(await engine.openChat(papa.id), papaChat);
    });
  });

  group('calls', () {
    test('a call has seven symbols, and the users can say they match', () async {
      final ana = (await engine.contacts.first).firstWhere((c) => c.name == 'Ana Torres');
      final sessions = record(engine.call);
      await engine.startCall(ana.id);
      await pumpEventQueue();
      final call = sessions.last!;
      expect((call.peerName, call.sas.length, call.verified), ('Ana Torres', 7, false));
      // Indices into the SAS v2 table, as the mock shows them.
      expect(call.sas, [0, 9, 17, 23, 31, 40, 52]);
      expect(call.path, CallPath.relay, reason: 'Trino calls through the server');

      await engine.confirmSas(matches: false);
      await pumpEventQueue();
      expect((sessions.last!.mismatch, sessions.last!.verified), (true, false));
      await engine.confirmSas(matches: true);
      await pumpEventQueue();
      expect((sessions.last!.mismatch, sessions.last!.verified), (false, true));
    });

    test('mute, speaker and camera switch, and hanging up ends the call', () async {
      final ana = (await engine.contacts.first).firstWhere((c) => c.name == 'Ana Torres');
      final sessions = record(engine.call);
      await engine.startCall(ana.id);
      await engine.setMuted(true);
      await engine.setSpeaker(true);
      await engine.setCamera(true);
      await pumpEventQueue();
      expect((sessions.last!.muted, sessions.last!.speaker, sessions.last!.camera), (true, true, true));
      await engine.hangUp();
      await pumpEventQueue();
      expect(sessions.last, isNull);
    });

    testWidgets('the call time runs while the call is watched', (tester) async {
      final engine = FakeTrinoEngine(clock: () => now, callStartsAt: const Duration(minutes: 3, seconds: 21));
      addTearDown(() => unawaited(engine.dispose()));
      await engine.startCall('ana');
      final sessions = <CallSession?>[];
      final subscription = engine.call.listen(sessions.add);
      await tester.pump();
      expect(sessions.last!.elapsed, const Duration(minutes: 3, seconds: 21));
      await tester.pump(const Duration(seconds: 2));
      expect(sessions.last!.elapsed, const Duration(minutes: 3, seconds: 23));
      // Nobody watches any more: the clock stops, and no timer outlives the test.
      unawaited(subscription.cancel());
      await tester.pump();
    });
  });

  group('identity and lock', () {
    test('a fresh install needs onboarding, and creating the identity opens the session', () async {
      final fresh = FakeTrinoEngine(clock: () => now, onboarded: false);
      addTearDown(() => unawaited(fresh.dispose()));
      expect(await fresh.identityState.first, IdentityState.needsOnboarding);
      await fresh.createIdentity(name: 'Sofía', passphrase: 'una frase larga y mía', withTotp: false);
      expect(await fresh.identityState.first, IdentityState.unlocked);
      expect((await fresh.profile.first).name, 'Sofía');
    });

    test('2FA needs a verified code before the identity is created with it', () async {
      final fresh = FakeTrinoEngine(clock: () => now, onboarded: false);
      addTearDown(() => unawaited(fresh.dispose()));
      final setup = await fresh.beginTotp();
      expect(setup.secret, matches(RegExp(r'^[A-Z2-7 ]+$')));
      expect(setup.uri, startsWith('otpauth://totp/'));
      expect(await fresh.verifyTotp('000000'), isFalse);
      expect(await fresh.verifyTotp(FakeTrinoEngine.demoTotpCode), isTrue);
      await fresh.createIdentity(name: 'Sofía', passphrase: 'una frase larga y mía', withTotp: true);
      await fresh.lock();
      expect((await fresh.unlockInfo()).totpEnabled, isTrue);
      expect(await fresh.unlock('una frase larga y mía'), UnlockResult.codeRequired);
      expect(await fresh.unlock('una frase larga y mía', code: '000000'), UnlockResult.wrongPassphraseOrCode);
      expect(await fresh.unlock('una frase larga y mía', code: FakeTrinoEngine.demoTotpCode), UnlockResult.ok);
    });

    test('locks, says why, and unlocks with the passphrase', () async {
      await engine.lock();
      expect(await engine.identityState.first, IdentityState.locked);
      final info = await engine.unlockInfo();
      expect((info.reason, info.totpEnabled), (LockReason.manual, false));
      expect(await engine.unlock('otra cosa'), UnlockResult.wrongPassphrase);
      expect(await engine.identityState.first, IdentityState.locked);
      expect(await engine.unlock(FakeTrinoEngine.demoPassphrase), UnlockResult.ok);
      expect(await engine.identityState.first, IdentityState.unlocked);
    });

    test('checks passphrases: at least 10 characters, not a common one, stronger when longer', () async {
      final short = await engine.checkPassphrase('corta');
      expect((short.problem, short.minLength), (PassphraseProblem.tooShort, 10));
      // Counted in characters, not in UTF-16 units: nine emoji are nine.
      expect((await engine.checkPassphrase('🦊🎸🌵⚓🍄🚲🔔🦊🎸')).problem, PassphraseProblem.tooShort);
      expect((await engine.checkPassphrase('🦊🎸🌵⚓🍄🚲🔔🦊🎸🌵')).problem, isNull);
      // A single repeated character is as weak as a common one.
      expect((await engine.checkPassphrase('aaaaaaaaaaaa')).problem, PassphraseProblem.tooCommon);
      expect((await engine.checkPassphrase('contraseña123')).problem, PassphraseProblem.tooCommon);
      final fair = await engine.checkPassphrase('montaña verde');
      final strong = await engine.checkPassphrase('caballo correcto batería grapa');
      expect(fair.problem, isNull);
      expect(strong.strength.index, greaterThan(fair.strength.index));
    });

    test('wipe forgets everything and goes back to the first run', () async {
      await engine.wipe();
      expect(await engine.identityState.first, IdentityState.needsOnboarding);
      expect(await engine.chats.first, isEmpty);
      expect(await engine.contacts.first, isEmpty);
    });
  });

  group('settings and relays', () {
    test('keeps the settings, with private defaults', () async {
      final settings = await engine.settings.first;
      expect(settings.notificationPreview, NotificationPreview.nameOnly);
      expect(settings.diagnosticLog, isFalse);
      await engine.updateSettings(settings.copyWith(messageSound: false, autoLockMinutes: () => null));
      final updated = await engine.settings.first;
      expect((updated.messageSound, updated.autoLockMinutes), (false, null));
    });

    test('lists its relays with their state', () async {
      final relays = await engine.relays.first;
      expect(relays, isNotEmpty);
      expect(relays.every((r) => r.url.startsWith('wss://')), isTrue);
    });
  });
}
