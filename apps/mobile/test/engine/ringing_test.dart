import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  group('calling out', () {
    test('without a delay the other phone answers at once, as before', () async {
      final engine = FakeTrinoEngine(clock: () => now);
      addTearDown(() => unawaited(engine.dispose()));
      await engine.startCall('ana');
      expect((await engine.call.first)!.phase, CallPhase.connected);
    });

    test('rings ("Llamando…") until the other phone answers, and the clock waits', () async {
      final engine = FakeTrinoEngine(clock: () => now, answerAfter: null);
      addTearDown(() => unawaited(engine.dispose()));
      final sessions = record(engine.call);
      await engine.startCall('ana');
      await pumpEventQueue();
      expect(sessions.last!.phase, CallPhase.calling);
      expect(sessions.last!.isIncoming, isFalse);

      engine.answerOutgoing();
      await pumpEventQueue();
      expect(sessions.last!.phase, CallPhase.connected);
    });

    testWidgets('with answerAfter, the demo answers by itself after that long', (tester) async {
      final engine = FakeTrinoEngine(clock: () => now, answerAfter: const Duration(seconds: 3));
      final sessions = record(engine.call);
      await engine.startCall('ana');
      await tester.pump();
      expect(sessions.last!.phase, CallPhase.calling);
      await tester.pump(const Duration(seconds: 2));
      expect(sessions.last!.phase, CallPhase.calling);
      expect(sessions.last!.elapsed, Duration.zero, reason: 'the time runs once connected');
      await tester.pump(const Duration(seconds: 1));
      expect(sessions.last!.phase, CallPhase.connected);
      await tester.pump(const Duration(seconds: 2));
      expect(sessions.last!.elapsed, const Duration(seconds: 2));
      await engine.hangUp();
      await engine.dispose();
    });

    test('hanging up before they answer leaves an outgoing call of no length', () async {
      final engine = FakeTrinoEngine(clock: () => now, answerAfter: null);
      addTearDown(() => unawaited(engine.dispose()));
      await engine.startCall('papa');
      await engine.hangUp();
      final latest = (await engine.callHistory.first).first;
      expect((latest.contactId, latest.direction, latest.duration), ('papa', CallDirection.outgoing, Duration.zero));
      expect(await engine.call.first, isNull);
    });
  });

  group('a call comes in', () {
    late FakeTrinoEngine engine;
    setUp(() => engine = FakeTrinoEngine(clock: () => now));
    tearDown(() => unawaited(engine.dispose()));

    test('rings with who calls, and whether with video', () async {
      expect(engine.receiveCall('carlos', video: true), isTrue);
      final call = (await engine.call.first)!;
      expect(
        (call.contactId, call.peerName, call.phase, call.isIncoming),
        ('carlos', 'Carlos Méndez', CallPhase.incoming, true),
      );
      expect(call.camera, isTrue);
    });

    test('answering connects it; hanging up later keeps it as incoming, with its length', () async {
      final fake = FakeTrinoEngine(clock: () => now, callStartsAt: const Duration(seconds: 40));
      addTearDown(() => unawaited(fake.dispose()));
      fake.receiveCall('carlos');
      await fake.answerCall();
      expect((await fake.call.first)!.phase, CallPhase.connected);
      await fake.hangUp();
      final latest = (await fake.callHistory.first).first;
      expect(
        (latest.contactId, latest.direction, latest.duration),
        ('carlos', CallDirection.incoming, const Duration(seconds: 40)),
      );
    });

    test('rejecting ends it and leaves a missed call, already seen: you saw it ring', () async {
      await engine.markCallsSeen();
      engine.receiveCall('carlos');
      await engine.rejectCall();
      expect(await engine.call.first, isNull);
      final latest = (await engine.callHistory.first).first;
      expect((latest.contactId, latest.direction, latest.duration), ('carlos', CallDirection.missed, Duration.zero));
      expect(await engine.unseenMissedCalls.first, 0);
      final event = (await engine.messages('chat-carlos').first).last;
      expect(event.call?.direction, CallDirection.missed, reason: 'in the chat too');
    });

    test('if the caller gives up first, it is a missed call that counts as unseen', () async {
      await engine.markCallsSeen();
      engine.receiveCall('carlos');
      engine.remoteHangUp();
      expect(await engine.call.first, isNull);
      expect((await engine.callHistory.first).first.direction, CallDirection.missed);
      expect(await engine.unseenMissedCalls.first, 1);
    });

    test('a blocked contact never rings, and nothing is recorded', () async {
      await engine.blockContact('carlos');
      final before = await engine.callHistory.first;
      expect(engine.receiveCall('carlos'), isFalse);
      expect(await engine.call.first, isNull);
      expect(await engine.callHistory.first, before);
    });

    test('while on another call, it does not ring: it is a missed call', () async {
      await engine.startCall('ana');
      await engine.markCallsSeen();
      expect(engine.receiveCall('carlos'), isFalse);
      expect((await engine.call.first)!.contactId, 'ana');
      expect((await engine.callHistory.first).first.contactId, 'carlos');
      expect(await engine.unseenMissedCalls.first, 1);
    });

    test('answering or rejecting with nothing ringing does nothing', () async {
      await engine.answerCall();
      await engine.rejectCall();
      await engine.startCall('ana');
      await engine.rejectCall();
      expect((await engine.call.first)!.phase, CallPhase.connected, reason: 'reject is only for a ringing call');
    });

    test('locking while it rings ends it as missed', () async {
      engine.receiveCall('carlos');
      await engine.lock();
      expect(await engine.call.first, isNull);
      expect((await engine.callHistory.first).first.direction, CallDirection.missed);
    });
  });
}
