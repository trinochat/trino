import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late FakeTrinoEngine engine;
  setUp(() => engine = FakeTrinoEngine(clock: () => now));
  tearDown(() => unawaited(engine.dispose()));

  FakeTrinoEngine firstRun() {
    final fresh = FakeTrinoEngine(clock: () => now, onboarded: false);
    addTearDown(() => unawaited(fresh.dispose()));
    return fresh;
  }

  group('devices', () {
    test('the demo phone is linked to the computer, which holds the account key', () async {
      final devices = await engine.devices.first;
      expect(
        [for (final d in devices) (d.name, d.platform, d.isThisDevice, d.isPrimary)],
        [
          ('Pixel 8', DevicePlatform.android, true, false),
          ('Computador de la casa', DevicePlatform.windows, false, true),
        ],
      );
      expect(devices.first.linkedAt.day, now.day, reason: 'linked today');
      expect(devices.first.lastSeen, isNull);
      expect(devices.last.lastSeen, now.subtract(const Duration(minutes: 5)));
    });

    test('this phone can unlink itself, and goes back to the first run', () async {
      await engine.unlinkThisDevice();
      expect(await engine.identityState.first, IdentityState.needsOnboarding);
      expect(await engine.devices.first, isEmpty);
      expect(await engine.chats.first, isEmpty);
    });

    test('a phone that holds the account key cannot unlink itself', () async {
      final fresh = firstRun();
      await fresh.createIdentity(name: 'Sofía', passphrase: 'una frase larga y mía', withTotp: false);
      final devices = await fresh.devices.first;
      expect([for (final d in devices) (d.isThisDevice, d.isPrimary)], [(true, true)]);
      expect(fresh.unlinkThisDevice, throwsStateError);
      expect(await fresh.identityState.first, IdentityState.unlocked);
    });
  });

  group('linking from the first run', () {
    test('a QR from the computer starts a session with the code to compare', () async {
      final fresh = firstRun();
      final sessions = record(fresh.linking);
      final session = await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      expect((session.code, session.computerName), ('418 207', 'Computador de la casa'));
      expect(
        (session.status, session.bringChats, session.chatsProgress),
        (LinkStatus.waitingForConfirmation, true, null),
      );
      await pumpEventQueue();
      expect(sessions.first, isNull);
      expect(sessions.last!.status, LinkStatus.waitingForConfirmation);
    });

    test('rejects a QR that is not a Trino linking code', () async {
      final fresh = firstRun();
      expect(() => fresh.beginLink('https://example.com/qr'), throwsA(isA<InvalidLinkCode>()));
      expect(() => fresh.beginLink('trino2:AQRBbmEgVG9ycmVzX2ZpZDQ2MWQ3YjBl'), throwsA(isA<InvalidLinkCode>()));
      expect(await fresh.linking.first, isNull);
    });

    test('is only for a phone without an identity', () async {
      expect(() => engine.beginLink(FakeTrinoEngine.demoLinkPayload), throwsStateError);
    });

    test('the computer confirms, the chats arrive, and the phone sets its own passphrase', () async {
      final fresh = firstRun();
      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      fresh.confirmLinkOnComputer();
      var session = (await fresh.linking.first)!;
      expect((session.status, session.chatsProgress), (LinkStatus.linked, 0));
      fresh.setLinkProgress(35);
      expect((await fresh.linking.first)!.chatsProgress, 35);
      // Still at the first run until this phone has its passphrase.
      expect(await fresh.identityState.first, IdentityState.needsOnboarding);

      await fresh.finishLink(passphrase: 'la frase de este celular', withTotp: false);
      expect(await fresh.identityState.first, IdentityState.unlocked);
      expect((await fresh.profile.first).name, FakeTrinoEngine.demoName);
      expect(await fresh.chats.first, isNotEmpty);
      final devices = await fresh.devices.first;
      expect([for (final d in devices) (d.isThisDevice, d.isPrimary)], [(true, false), (false, true)]);
      expect(devices.first.linkedAt, now);

      fresh.setLinkProgress(100);
      session = (await fresh.linking.first)!;
      expect(session.chatsProgress, 100);

      await fresh.lock();
      expect(await fresh.unlock('la frase de este celular'), UnlockResult.ok);
    });

    test('without the chats, the contacts come but no chat does', () async {
      final fresh = firstRun();
      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      await fresh.setBringChats(false);
      fresh.confirmLinkOnComputer();
      final session = (await fresh.linking.first)!;
      expect((session.bringChats, session.chatsProgress), (false, null));
      await fresh.finishLink(passphrase: 'la frase de este celular', withTotp: false);
      expect(await fresh.contacts.first, isNotEmpty);
      expect(await fresh.chats.first, isEmpty);
    });

    test('with 2FA, the code is verified before finishing', () async {
      final fresh = firstRun();
      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      fresh.confirmLinkOnComputer();
      expect(() => fresh.finishLink(passphrase: 'la frase de este celular', withTotp: true), throwsStateError);
      await fresh.beginTotp();
      await fresh.verifyTotp(FakeTrinoEngine.demoTotpCode);
      await fresh.finishLink(passphrase: 'la frase de este celular', withTotp: true);
      expect((await fresh.unlockInfo()).totpEnabled, isTrue);
    });

    test('cannot finish before the computer confirms', () async {
      final fresh = firstRun();
      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      expect(() => fresh.finishLink(passphrase: 'la frase de este celular', withTotp: false), throwsStateError);
    });

    test('can be cancelled, can expire, and the computer can reject it', () async {
      final fresh = firstRun();
      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      await fresh.cancelLink();
      var session = (await fresh.linking.first)!;
      expect((session.status, session.failure), (LinkStatus.failed, LinkFailure.cancelled));

      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      fresh.failLink(LinkFailure.expired);
      session = (await fresh.linking.first)!;
      expect((session.status, session.failure), (LinkStatus.failed, LinkFailure.expired));

      await fresh.beginLink(FakeTrinoEngine.demoLinkPayload);
      fresh.failLink(LinkFailure.rejected);
      expect((await fresh.linking.first)!.failure, LinkFailure.rejected);
      expect(await fresh.identityState.first, IdentityState.needsOnboarding);
    });

    testWidgets('in the demo, the computer confirms by itself and the chats arrive step by step', (tester) async {
      final demo = FakeTrinoEngine(clock: () => now, onboarded: false, linkConfirmAfter: const Duration(seconds: 2));
      addTearDown(() => unawaited(demo.dispose()));
      final sessions = <LinkSession?>[];
      final subscription = demo.linking.listen(sessions.add);
      unawaited(demo.beginLink(FakeTrinoEngine.demoLinkPayload));
      await tester.pump();
      expect(sessions.last!.status, LinkStatus.waitingForConfirmation);
      await tester.pump(const Duration(seconds: 2));
      expect((sessions.last!.status, sessions.last!.chatsProgress), (LinkStatus.linked, 0));
      for (final percent in [25, 50, 75, 100]) {
        await tester.pump(const Duration(seconds: 2));
        expect(sessions.last!.chatsProgress, percent);
      }
      unawaited(subscription.cancel());
      await tester.pump();
    });
  });
}
