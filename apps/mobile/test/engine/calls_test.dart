import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late FakeTrinoEngine engine;
  setUp(() => engine = FakeTrinoEngine(clock: () => now));
  tearDown(() => unawaited(engine.dispose()));

  test('calls go through the call server', () async {
    final sessions = record(engine.call);
    await engine.startCall('ana');
    await pumpEventQueue();
    expect(sessions.last!.path, CallPath.relay);
  });

  group('call history', () {
    test('has the demo calls, the latest first', () async {
      final history = await engine.callHistory.first;
      expect(
        [for (final call in history) (call.peerName, call.direction, call.duration.inMinutes)],
        [
          ('Ana Torres', CallDirection.missed, 0),
          ('Ana Torres', CallDirection.outgoing, 4),
          ('Carlos Méndez', CallDirection.incoming, 12),
          ('Lucía', CallDirection.missed, 0),
          ('Mamá', CallDirection.outgoing, 25),
        ],
      );
      expect(history[0].startedAt, DateTime(2026, 10, 9, 10, 44));
      expect(history[1].startedAt, DateTime(2026, 10, 9, 10, 36));
      expect(history[2].startedAt.day, 8, reason: 'yesterday');
      expect(history[3].startedAt.weekday, DateTime.tuesday);
      expect(history[4].startedAt.weekday, DateTime.sunday);
      expect(history.map((call) => call.contactId), ['ana', 'ana', 'carlos', 'lucia', 'mama']);
      expect(history.map((call) => call.id).toSet(), hasLength(5));
    });

    test('hanging up adds the call, with its duration, first in the history', () async {
      final fake = FakeTrinoEngine(clock: () => now, callStartsAt: const Duration(minutes: 2, seconds: 5));
      addTearDown(() => unawaited(fake.dispose()));
      await fake.startCall('papa');
      await fake.hangUp();
      final latest = (await fake.callHistory.first).first;
      expect((latest.contactId, latest.peerName, latest.direction), ('papa', 'Papá', CallDirection.outgoing));
      expect((latest.startedAt, latest.duration), (now, const Duration(minutes: 2, seconds: 5)));
    });
  });

  group('missed calls not yet seen', () {
    test("the demo has one: the latest call from Ana; Lucía's was already seen", () async {
      expect(await engine.unseenMissedCalls.first, 1);
    });

    test('a missed call adds one and goes first in the history; seeing the calls clears the count', () async {
      final counts = record(engine.unseenMissedCalls);
      engine.missCall('carlos');
      await pumpEventQueue();
      expect(counts.last, 2);
      final latest = (await engine.callHistory.first).first;
      expect((latest.contactId, latest.direction, latest.startedAt), ('carlos', CallDirection.missed, now));

      await engine.markCallsSeen();
      await pumpEventQueue();
      expect(counts.last, 0);
    });

    test('calls you make or answer do not count', () async {
      await engine.markCallsSeen();
      await engine.startCall('papa');
      await engine.hangUp();
      expect(await engine.unseenMissedCalls.first, 0);
    });

    test('the attempt to call of an accepted request does not count: the request already said it', () async {
      await engine.markCallsSeen();
      await engine.acceptRequest('req-ana');
      expect((await engine.callHistory.first).first.direction, CallDirection.missed);
      expect(await engine.unseenMissedCalls.first, 0);
    });

    test('wiping the identity clears the count', () async {
      await engine.wipe();
      expect(await engine.unseenMissedCalls.first, 0);
    });
  });

  group('calls in the chat', () {
    test('show among the messages, in time order, without changing the chat preview', () async {
      final messages = await engine.messages('chat-ana').first;
      expect(
        [for (final m in messages) m.isCall ? m.call!.direction.name : m.text],
        [
          '¿Te llegó el documento que te mandé?',
          'Sí, ya lo revisé. Está todo bien.',
          'outgoing',
          '¿El jueves a las 6, entonces?',
          'Perfecto, nos vemos el jueves',
          'missed',
        ],
      );
      final outgoing = messages[2];
      expect(
        (outgoing.sentAt, outgoing.text, outgoing.call!.duration),
        (DateTime(2026, 10, 9, 10, 36), '', const Duration(minutes: 4)),
      );

      final ana = (await engine.chats.first).first;
      expect((ana.lastMessage, ana.lastActivity), ('Perfecto, nos vemos el jueves', DateTime(2026, 10, 9, 10, 42)));
      expect((await engine.messages('chat-carlos').first).where((m) => m.isCall), hasLength(1));
      expect((await engine.messages('chat-lucia').first).where((m) => m.isCall), hasLength(1));
    });

    test('a finished call is added to the chat with that contact', () async {
      await engine.startCall('lucia');
      await engine.hangUp();
      final last = (await engine.messages('chat-lucia').first).last;
      expect((last.isCall, last.call!.direction, last.sentAt), (true, CallDirection.outgoing, now));
    });
  });
}
