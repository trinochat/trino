// What the info of a contact and of a group needs from the engine: calling
// with video, the members and who administers, groups in common, blocking,
// deleting a chat, leaving a group and muting one.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'helpers.dart';

void main() {
  late FakeTrinoEngine engine;
  setUp(() => engine = FakeTrinoEngine(clock: () => now));
  tearDown(() => unawaited(engine.dispose()));

  Future<ChatSummary?> chatTitled(String title) async =>
      (await engine.chats.first).where((chat) => chat.title == title).firstOrNull;

  group('calling', () {
    test('starts with the camera off, as an audio call', () async {
      await engine.startCall('ana');
      expect((await engine.call.first)!.camera, isFalse);
    });

    test('starts with the camera on when it is a video call', () async {
      await engine.startCall('ana', video: true);
      expect((await engine.call.first)!.camera, isTrue);
    });
  });

  group('group details', () {
    test('Familia: Mamá administers, then Papá, then you, marked as you', () async {
      final details = await engine.groupDetails('chat-familia');
      expect(
        [for (final m in details.members) (m.name, m.contactId, m.isAdmin, m.isYou)],
        [('Mamá', 'mama', true, false), ('Papá', 'papa', false, false), (FakeTrinoEngine.demoName, null, false, true)],
      );
      expect(details.admin!.name, 'Mamá');
      expect(details.youAdminister, isFalse);
    });

    test('a group you created is administered by you', () async {
      final id = engine.addGroup(title: 'Taller', memberIds: const ['ana', 'lucia']);
      final details = await engine.groupDetails(id);
      expect(details.youAdminister, isTrue);
      expect(details.members.first.isYou, isTrue, reason: 'who administers goes first');
      expect(details.members.map((m) => m.name), [FakeTrinoEngine.demoName, 'Ana Torres', 'Lucía']);
      expect((await chatTitled('Taller'))!.memberNames, ['Ana Torres', 'Lucía']);
    });

    test('a new group follows "Silenciar grupos por defecto"', () async {
      await engine.updateSettings(const EngineSettings(muteGroups: true));
      final id = engine.addGroup(title: 'Taller', memberIds: const ['ana'], adminId: 'ana');
      expect((await engine.chats.first).firstWhere((c) => c.id == id).muted, isTrue);
      expect((await engine.groupDetails(id)).admin!.contactId, 'ana');
    });
  });

  group('groups in common', () {
    test('Mamá and Papá are in Familia; Ana is in none', () async {
      expect((await engine.groupsInCommon('mama')).map((c) => c.title), ['Familia']);
      expect((await engine.groupsInCommon('papa')).map((c) => c.title), ['Familia']);
      expect(await engine.groupsInCommon('ana'), isEmpty);
    });

    test('counts every group the contact is in', () async {
      engine.addGroup(title: 'Taller', memberIds: const ['mama']);
      expect((await engine.groupsInCommon('mama')).map((c) => c.title), containsAll(['Familia', 'Taller']));
    });
  });

  group('muting a group', () {
    test('a chat is not muted until you mute it, and can be unmuted', () async {
      expect((await chatTitled('Familia'))!.muted, isFalse);
      await engine.setChatMuted('chat-familia', true);
      expect((await chatTitled('Familia'))!.muted, isTrue);
      await engine.setChatMuted('chat-familia', false);
      expect((await chatTitled('Familia'))!.muted, isFalse);
    });
  });

  group('blocking a contact', () {
    test('marks the contact blocked, keeps the chat and drops what they send', () async {
      await engine.blockContact('ana');
      final ana = (await engine.contacts.first).firstWhere((c) => c.id == 'ana');
      expect(ana.blocked, isTrue);
      final before = (await engine.messages('chat-ana').first).length;
      engine.receive('chat-ana', 'Hola otra vez');
      engine.missCall('ana');
      expect((await engine.messages('chat-ana').first).length, before, reason: 'nothing arrives');
      expect(await chatTitled('Ana Torres'), isNotNull, reason: 'the chat stays');
    });

    test('unblocking lets them write again', () async {
      await engine.blockContact('ana');
      await engine.unblockContact('ana');
      expect((await engine.contacts.first).firstWhere((c) => c.id == 'ana').blocked, isFalse);
      engine.receive('chat-ana', 'Hola otra vez');
      expect((await engine.messages('chat-ana').first).last.text, 'Hola otra vez');
    });
  });

  group('deleting a chat', () {
    test('removes the chat and its messages from this phone; the contact and the calls stay', () async {
      final calls = (await engine.callHistory.first).length;
      await engine.deleteChat('chat-ana');
      expect(await chatTitled('Ana Torres'), isNull);
      expect(await engine.messages('chat-ana').first, isEmpty);
      expect((await engine.contacts.first).map((c) => c.id), contains('ana'));
      expect((await engine.callHistory.first).length, calls);
    });

    test('writing to the contact again starts an empty chat', () async {
      await engine.deleteChat('chat-ana');
      final id = await engine.openChat('ana');
      expect(await engine.messages(id).first, isEmpty);
    });
  });

  group('leaving a group', () {
    test('removes the group from this phone and from the groups in common', () async {
      await engine.leaveGroup('chat-familia');
      expect(await chatTitled('Familia'), isNull);
      expect(await engine.messages('chat-familia').first, isEmpty);
      expect(await engine.groupsInCommon('mama'), isEmpty);
    });

    test('is only for groups', () async {
      expect(() => engine.leaveGroup('chat-ana'), throwsStateError);
    });
  });
}
