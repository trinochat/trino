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

  MessageRequest stranger({String id = 'req-x', String fingerprint = '1111 2222 3333 4444'}) => MessageRequest(
    id: id,
    claimedName: 'nico',
    origin: RequestOrigin.link,
    originLabel: 'Taller',
    fingerprint: fingerprint,
    receivedAt: time,
    messages: [RequestMessage(text: 'Hola', sentAt: time)],
  );

  group('demo requests', () {
    test('are the three of the mockup, the latest first', () async {
      final requests = await engine.requests.first;
      expect(
        [for (final r in requests) (r.claimedName, r.origin, r.originLabel)],
        [
          ('ana', RequestOrigin.username, null),
          ('mara', RequestOrigin.group, 'Familia'),
          ('julián', RequestOrigin.code, 'Trabajo'),
        ],
      );
      expect(requests[1].receivedAt.day, 8, reason: 'yesterday');
      expect(requests[2].receivedAt.weekday, DateTime.monday);
      expect(requests.map((r) => r.id).toSet(), hasLength(3));
      for (final request in requests) {
        expect(request.fingerprint, matches(RegExp(r'^([0-9A-F]{4} ){3}[0-9A-F]{4}$')));
        expect(request.messages, isNotEmpty);
      }
    });

    test('ana resembles Ana Torres, sent a photo of 1.2 MB and tried to call', () async {
      final ana = (await engine.requests.first).first;
      expect(ana.resemblesContact, 'Ana Torres');
      expect(ana.messages.single.text, startsWith('Hola, soy Ana, la del taller de cerámica'));
      expect(ana.messages.single.sentAt, DateTime(2026, 10, 9, 8, 12));
      final photo = ana.attachments.single;
      expect((photo.kind, photo.sizeBytes), (AttachmentKind.photo, 1200000));
      expect((ana.triedToCall, ana.callAttemptAt), (true, DateTime(2026, 10, 9, 8, 15)));
      expect((await engine.requests.first)[1].triedToCall, isFalse);
    });

    test('nothing in a request rings: its call is not in the history', () async {
      final history = await engine.callHistory.first;
      expect(history.where((call) => call.peerName == 'ana'), isEmpty);
    });
  });

  group('actions', () {
    test('accepting adds the contact and its chat with the messages, and returns the chat', () async {
      final julian = (await engine.requests.first).last;
      final chatId = await engine.acceptRequest(julian.id);
      expect((await engine.requests.first).map((r) => r.id), isNot(contains(julian.id)));

      final contact = (await engine.contacts.first).firstWhere((c) => c.name == 'julián');
      expect((contact.trust, contact.fingerprint), (Trust.unverified, julian.fingerprint));
      final chat = (await engine.chats.first).firstWhere((c) => c.id == chatId);
      expect((chat.contactId, chat.title, chat.unread), (contact.id, 'julián', 1));
      final messages = await engine.messages(chatId).first;
      expect(messages.single.text, 'Buenas, te escribo por lo del contrato');
      expect(messages.single.outgoing, isFalse);
    });

    test('accepting a request that tried to call shows the missed call', () async {
      final ana = (await engine.requests.first).first;
      final chatId = await engine.acceptRequest(ana.id);
      final missed = (await engine.callHistory.first).firstWhere((call) => call.peerName == 'ana');
      expect((missed.direction, missed.startedAt), (CallDirection.missed, ana.callAttemptAt));
      expect((await engine.messages(chatId).first).where((m) => m.isCall), hasLength(1));
    });

    test('deleting drops what the same identity sends for 30 days, silently', () async {
      engine.receiveRequest(stranger());
      expect((await engine.requests.first).first.id, 'req-x');
      await engine.deleteRequest('req-x');
      expect((await engine.requests.first).map((r) => r.id), isNot(contains('req-x')));

      time = now.add(const Duration(days: 29));
      engine.receiveRequest(stranger(id: 'req-y'));
      expect((await engine.requests.first).map((r) => r.id), isNot(contains('req-y')));

      time = now.add(const Duration(days: 30));
      engine.receiveRequest(stranger(id: 'req-z'));
      expect((await engine.requests.first).first.id, 'req-z');
    });

    test('blocking drops everything from that identity from then on', () async {
      engine.receiveRequest(stranger());
      await engine.blockRequest('req-x');
      time = now.add(const Duration(days: 400));
      engine.receiveRequest(stranger(id: 'req-y'));
      final ids = (await engine.requests.first).map((r) => r.id);
      expect(ids, isNot(contains('req-x')));
      expect(ids, isNot(contains('req-y')));
      // Someone else still gets through.
      engine.receiveRequest(stranger(id: 'req-w', fingerprint: '5555 6666 7777 8888'));
      expect((await engine.requests.first).first.id, 'req-w');
    });

    test('reporting records the report and keeps the request', () async {
      final mara = (await engine.requests.first)[1];
      await engine.reportRequest(mara.id);
      expect(engine.reportedRequests, [mara.id]);
      expect((await engine.requests.first).map((r) => r.id), contains(mara.id));
    });

    test('an unknown request is an error', () async {
      expect(() => engine.acceptRequest('nadie'), throwsStateError);
    });

    test('wipe forgets the requests', () async {
      await engine.wipe();
      expect(await engine.requests.first, isEmpty);
    });
  });
}
