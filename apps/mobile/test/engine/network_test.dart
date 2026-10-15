import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late FakeTrinoEngine engine;
  setUp(() => engine = FakeTrinoEngine(clock: () => now));
  tearDown(() => unawaited(engine.dispose()));

  group('network state', () {
    test('starts connected privately, and reports each change', () async {
      final states = record(engine.network);
      engine.setNetwork(const NetworkState.connecting(40));
      engine.setNetwork(const NetworkState.failed(NetworkProblem.clock));
      await pumpEventQueue();
      expect(states, [
        const NetworkState.connected(),
        const NetworkState.connecting(40),
        const NetworkState.failed(NetworkProblem.clock),
      ]);
    });

    testWidgets('can start connecting, show progress and connect after a while', (tester) async {
      final slow = FakeTrinoEngine(clock: () => now, connectAfter: const Duration(seconds: 2));
      addTearDown(() => unawaited(slow.dispose()));
      final states = <NetworkState>[];
      final subscription = slow.network.listen(states.add);
      await tester.pump();
      expect(states, [const NetworkState.connecting()]);
      await tester.pump(const Duration(seconds: 1));
      expect(states.last, const NetworkState.connecting(50));
      await tester.pump(const Duration(seconds: 1));
      expect(states.last, const NetworkState.connected());
      unawaited(subscription.cancel());
      await tester.pump();
    });

    test('retry connects again from a failure', () async {
      engine.setNetwork(const NetworkState.failed(NetworkProblem.blocked));
      final states = record(engine.network);
      await engine.retryConnection();
      await pumpEventQueue();
      expect(states, [
        const NetworkState.failed(NetworkProblem.blocked),
        const NetworkState.connecting(),
        const NetworkState.connected(),
      ]);
    });

    test('trying another way searches for a bridge while still saying why it failed, then connects', () async {
      await engine.setBridgeMode(BridgeMode.snowflake);
      engine.setNetwork(const NetworkState.failed(NetworkProblem.blocked));
      final states = record(engine.network);
      await engine.tryAnotherWay();
      await pumpEventQueue();
      expect(states, [
        const NetworkState.failed(NetworkProblem.blocked),
        const NetworkState(status: NetworkStatus.failed, problem: NetworkProblem.blocked, tryingAnotherWay: true),
        const NetworkState.connected(),
      ]);
      expect((await engine.bridges.first).mode, BridgeMode.automatic);
    });

    test('connecting without protection lasts until the app closes, and is never remembered', () async {
      await engine.connectUnprotected();
      expect(await engine.network.first, const NetworkState.unprotected());
      // Nothing in the settings carries it over to the next start.
      final next = FakeTrinoEngine(clock: () => now);
      addTearDown(() => unawaited(next.dispose()));
      expect(await next.network.first, const NetworkState.connected());
      expect(await next.settings.first, isA<EngineSettings>());

      final states = record(engine.network);
      await engine.reconnectPrivately();
      await pumpEventQueue();
      expect(states.skip(1), [const NetworkState.connecting(), const NetworkState.connected()]);
    });
  });

  group('bridges', () {
    test('are automatic by default, and the built-in ones can be chosen', () async {
      expect((await engine.bridges.first).mode, BridgeMode.automatic);
      expect((await engine.bridges.first).hasCustomBridge, isFalse);
      await engine.setBridgeMode(BridgeMode.obfs4);
      expect((await engine.bridges.first).mode, BridgeMode.obfs4);
    });

    test('custom mode needs a code first', () async {
      expect(() => engine.setBridgeMode(BridgeMode.custom), throwsStateError);
    });

    test('a custom bridge code is kept, and forces connecting only after unlocking', () async {
      await engine.setCustomBridge('obfs4 192.0.2.7:443 4A1B2C3D4E5F60718293A4B5C6D7E8F901234567 cert=abc iat-mode=0');
      final bridges = await engine.bridges.first;
      expect((bridges.mode, bridges.hasCustomBridge), (BridgeMode.custom, true));
      final settings = await engine.settings.first;
      expect(settings.connectAfterUnlockOnly, isTrue);

      // The rule holds even if the screen tries to turn it off.
      await engine.updateSettings(settings.copyWith(connectAfterUnlockOnly: false));
      expect((await engine.settings.first).connectAfterUnlockOnly, isTrue);

      // Without the code, the setting can be turned off again.
      await engine.removeCustomBridge();
      expect((await engine.bridges.first).mode, BridgeMode.automatic);
      await engine.updateSettings((await engine.settings.first).copyWith(connectAfterUnlockOnly: false));
      expect((await engine.settings.first).connectAfterUnlockOnly, isFalse);
    });

    test('rejects what is not a bridge code', () async {
      expect(() => engine.setCustomBridge('   '), throwsA(isA<InvalidBridgeCode>()));
      expect(() => engine.setCustomBridge('hola, soy un puente'), throwsA(isA<InvalidBridgeCode>()));
      expect((await engine.bridges.first).hasCustomBridge, isFalse);
    });
  });

  group('connection and security settings', () {
    test('have the decided defaults', () async {
      final settings = await engine.settings.first;
      expect(settings.keepConnectedInBackground, isTrue);
      expect(settings.connectAfterUnlockOnly, isFalse);
      expect(settings.biometricUnlock, isFalse);
      expect(settings.reaskInterval, ReaskInterval.threeDays);
      expect(settings.reinforcedProtection, isFalse);
      expect(settings.autoLockMinutes, 5);
      expect(ReaskInterval.values, [ReaskInterval.day, ReaskInterval.threeDays, ReaskInterval.week]);
    });

    test('reinforced protection turns biometric unlock off and keeps it off', () async {
      final settings = await engine.settings.first;
      await engine.updateSettings(settings.copyWith(biometricUnlock: true, reaskInterval: ReaskInterval.week));
      expect((await engine.settings.first).biometricUnlock, isTrue);
      await engine.updateSettings((await engine.settings.first).copyWith(reinforcedProtection: true));
      expect((await engine.settings.first).biometricUnlock, isFalse);
      await engine.updateSettings((await engine.settings.first).copyWith(biometricUnlock: true));
      final updated = await engine.settings.first;
      expect((updated.biometricUnlock, updated.reaskInterval), (false, ReaskInterval.week));
    });
  });
}
