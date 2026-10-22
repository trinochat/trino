// The info of a contact, opened from the chat's header: the large avatar, the
// name with its shield and the state in words, then Mensaje, Llamar and Video;
// the key with its state and the groups in common; and at the end, in red,
// blocking and deleting the chat, each asked first.
//
// Only what the engine has is shown: no @nombre, no photos and files, no
// disappearing messages, no search and no mute for a contact, until the
// engine has them.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../engine/engine.dart';
import '../../ui/avatar.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../../ui/trust_badge.dart';
import '../call_screen.dart';
import '../chat_panes.dart';
import '../common.dart';
import 'info_parts.dart';

class ContactInfoScreen extends StatefulWidget {
  const ContactInfoScreen({super.key, required this.chat});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => ContactInfoScreen(chat: chat));

  /// The direct chat it was opened from.
  final ChatSummary chat;

  @override
  State<ContactInfoScreen> createState() => _ContactInfoScreenState();
}

class _ContactInfoScreenState extends State<ContactInfoScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<Contact>> _contacts = _engine.contacts;
  late final Future<List<ChatSummary>> _groups = _engine.groupsInCommon(widget.chat.contactId!);

  String get _contactId => widget.chat.contactId!;

  /// "Mensaje": the chat is right below.
  void _message() => Navigator.of(context).pop();

  Future<void> _call({bool video = false}) async {
    final navigator = Navigator.of(context);
    await _engine.startCall(_contactId, video: video);
    await navigator.push(CallScreen.route());
  }

  void _openGroups(List<ChatSummary> groups) {
    if (groups.length == 1) return unawaited(showChat(context, groups.single));
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CommonGroupsScreen(groups: groups))));
  }

  Future<void> _block(Contact contact) async {
    final l10n = context.l10n;
    final confirmed = await confirmDanger(
      context,
      title: l10n.requestBlockTitle(contact.name),
      body: l10n.blockContactBody(contact.name),
      confirm: l10n.requestBlock,
    );
    if (!confirmed || !mounted) return;
    await _engine.blockContact(contact.id);
    if (mounted) showNotice(context, l10n.requestBlocked(contact.name));
  }

  Future<void> _unblock(Contact contact) async {
    final l10n = context.l10n;
    await _engine.unblockContact(contact.id);
    if (mounted) showNotice(context, l10n.contactUnblocked(contact.name));
  }

  Future<void> _deleteChat(String name) async {
    final l10n = context.l10n;
    final confirmed = await confirmDanger(
      context,
      title: l10n.deleteChatTitle(name),
      body: l10n.deleteChatBody(name),
      confirm: l10n.deleteChat,
    );
    if (!confirmed || !mounted) return;
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    await _engine.deleteChat(widget.chat.id);
    // The chat is gone: back to the list, where the notice shows.
    navigator.popUntil((route) => route.isFirst);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(l10n.chatDeleted)));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const InfoBar(),
            Expanded(
              child: StreamBuilder<List<Contact>>(
                stream: _contacts,
                builder: (context, snapshot) {
                  final contact = snapshot.data?.where((c) => c.id == _contactId).firstOrNull;
                  final name = contact?.name ?? widget.chat.title;
                  final trust = contact?.trust ?? widget.chat.trust;
                  return ListView(
                    padding: const EdgeInsets.only(bottom: 24),
                    children: [
                      InfoHeader(
                        name: name,
                        kind: AvatarKind.person,
                        trust: switch (trust) {
                          Trust.verified => (kind: TrustKind.verified, label: l10n.contactVerified),
                          Trust.keyChanged => (kind: TrustKind.keyChanged, label: l10n.contactKeyChanged),
                          Trust.unverified => null,
                        },
                        subtitle: switch (trust) {
                          Trust.verified => l10n.chatVerified,
                          Trust.unverified => l10n.contactUnverified,
                          Trust.keyChanged => l10n.contactKeyChanged,
                        },
                        warn: trust == Trust.keyChanged,
                      ),
                      InfoActions(
                        children: [
                          InfoAction(icon: TrinoIcons.chats, label: l10n.infoMessage, onPressed: _message),
                          InfoAction(icon: TrinoIcons.phone, label: l10n.call, onPressed: _call),
                          InfoAction(
                            icon: TrinoIcons.video,
                            label: l10n.infoVideo,
                            onPressed: () => _call(video: true),
                          ),
                        ],
                      ),
                      SettingsGroup(
                        children: [
                          if (contact != null)
                            ListRow(
                              icon: TrinoIcons.shield,
                              title: l10n.infoKey,
                              subtitle: l10n.infoKeyValue(contact.fingerprint, switch (trust) {
                                Trust.verified => l10n.keyStateVerified,
                                Trust.unverified => l10n.keyStateUnverified,
                                Trust.keyChanged => l10n.keyStateChanged,
                              }),
                            ),
                          FutureBuilder<List<ChatSummary>>(
                            future: _groups,
                            builder: (context, groups) {
                              final list = groups.data ?? const <ChatSummary>[];
                              return ListRow(
                                icon: TrinoIcons.users,
                                title: l10n.commonGroups,
                                value: list.isEmpty ? l10n.commonGroupsNone : '${list.length}',
                                onTap: list.isEmpty ? null : () => _openGroups(list),
                              );
                            },
                          ),
                        ],
                      ),
                      SettingsGroup(
                        children: [
                          if (contact != null)
                            contact.blocked
                                ? ListRow(
                                    icon: TrinoIcons.ban,
                                    title: l10n.unblockContact(name),
                                    accent: true,
                                    chevron: false,
                                    onTap: () => _unblock(contact),
                                  )
                                : ListRow(
                                    icon: TrinoIcons.ban,
                                    title: l10n.blockContact(name),
                                    danger: true,
                                    chevron: false,
                                    onTap: () => _block(contact),
                                  ),
                          ListRow(
                            icon: TrinoIcons.trash,
                            title: l10n.deleteChat,
                            danger: true,
                            chevron: false,
                            onTap: () => _deleteChat(name),
                          ),
                        ],
                      ),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The groups you are in with a contact, when there is more than one.
class CommonGroupsScreen extends StatelessWidget {
  const CommonGroupsScreen({super.key, required this.groups});

  final List<ChatSummary> groups;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.commonGroups,
      children: [
        SettingsGroup(
          indent: 68,
          children: [
            for (final group in groups)
              ListRow(
                leading: TrinoAvatar(name: group.title, size: 40, kind: AvatarKind.group),
                title: group.title,
                subtitle: l10n.groupMembers(group.memberNames.length + 1),
                onTap: () => showChat(context, group),
              ),
          ],
        ),
      ],
    );
  }
}
