import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late DateTime time;
  late FakeTrinoEngine engine;
  setUp(() {
    time = now;
    engine = FakeTrinoEngine(clock: () => time);
  });
  tearDown(() => unawaited(engine.dispose()));

  Future<void> turnOnBiometrics(FakeTrinoEngine engine, {ReaskInterval interval = ReaskInterval.threeDays}) async =>
      engine.updateSettings((await engine.settings.first).copyWith(biometricUnlock: true, reaskInterval: interval));

  test('an idle lock says after how long, and is not a restart', () async {
    engine.lockForIdle(5);
    final info = await engine.unlockInfo();
    expect((info.reason, info.idleMinutes), (LockReason.idle, 5));
    expect(await engine.identityState.first, IdentityState.locked);
  });

  group('biometric unlock', () {
    test('is not offered while the setting is off, and does not open', () async {
      await engine.lock();
      final info = await engine.unlockInfo();
      expect((info.biometricAllowed, info.reason), (false, LockReason.manual));
      expect(await engine.unlockWithBiometrics(), isFalse);
      expect(await engine.identityState.first, IdentityState.locked);
    });

    test('opens Trino after a lock, within the interval', () async {
      await turnOnBiometrics(engine);
      await engine.lock();
      time = now.add(const Duration(days: 2, hours: 23));
      expect((await engine.unlockInfo()).biometricAllowed, isTrue);
      expect(await engine.unlockWithBiometrics(), isTrue);
      expect(await engine.identityState.first, IdentityState.unlocked);
    });

    test('after a restart the passphrase is always asked', () async {
      final restarted = FakeTrinoEngine(clock: () => time, locked: true);
      addTearDown(() => unawaited(restarted.dispose()));
      await turnOnBiometrics(restarted);
      final info = await restarted.unlockInfo();
      expect((info.biometricAllowed, info.reason), (false, LockReason.coldStart));
      expect(await restarted.unlockWithBiometrics(), isFalse);
      expect(await restarted.identityState.first, IdentityState.locked);

      expect(await restarted.unlock(FakeTrinoEngine.demoPassphrase), UnlockResult.ok);
      await restarted.lock();
      expect((await restarted.unlockInfo()).biometricAllowed, isTrue);
    });

    test('is never offered with reinforced protection', () async {
      await turnOnBiometrics(engine);
      await engine.updateSettings((await engine.settings.first).copyWith(reinforcedProtection: true));
      await engine.lock();
      expect((await engine.unlockInfo()).biometricAllowed, isFalse);
      expect(await engine.unlockWithBiometrics(), isFalse);
    });

    test('asks for the passphrase again once the interval passes, and typing it starts the interval over', () async {
      await turnOnBiometrics(engine);
      await engine.lock();
      time = now.add(const Duration(days: 3));
      final info = await engine.unlockInfo();
      expect((info.biometricAllowed, info.reason), (false, LockReason.reask));
      expect(await engine.unlockWithBiometrics(), isFalse);

      expect(await engine.unlock(FakeTrinoEngine.demoPassphrase), UnlockResult.ok);
      await engine.lock();
      time = time.add(const Duration(days: 2));
      final again = await engine.unlockInfo();
      expect((again.biometricAllowed, again.reason), (true, LockReason.manual));
    });

    test('the interval can be a day or a week', () async {
      await turnOnBiometrics(engine, interval: ReaskInterval.day);
      await engine.lock();
      time = now.add(const Duration(hours: 23));
      expect((await engine.unlockInfo()).biometricAllowed, isTrue);
      time = now.add(const Duration(days: 1));
      expect((await engine.unlockInfo()).biometricAllowed, isFalse);

      await engine.updateSettings((await engine.settings.first).copyWith(reaskInterval: ReaskInterval.week));
      time = now.add(const Duration(days: 6, hours: 23));
      expect((await engine.unlockInfo()).biometricAllowed, isTrue);
      time = now.add(const Duration(days: 7));
      expect((await engine.unlockInfo()).biometricAllowed, isFalse);
    });

    test('the interval also covers the 2FA code: biometric unlock skips both until it passes', () async {
      final fresh = FakeTrinoEngine(clock: () => time, onboarded: false);
      addTearDown(() => unawaited(fresh.dispose()));
      await fresh.beginTotp();
      await fresh.verifyTotp(FakeTrinoEngine.demoTotpCode);
      await fresh.createIdentity(name: 'Sofía', passphrase: 'una frase larga y mía', withTotp: true);
      await turnOnBiometrics(fresh);
      await fresh.lock();
      expect(await fresh.unlockWithBiometrics(), isTrue);
      await fresh.lock();
      time = now.add(const Duration(days: 4));
      expect(await fresh.unlockWithBiometrics(), isFalse);
      expect(await fresh.unlock('una frase larga y mía'), UnlockResult.codeRequired);
    });
  });
}
