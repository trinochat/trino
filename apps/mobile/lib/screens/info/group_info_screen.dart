// The info of a group, opened from the chat's header: the avatar, the name,
// how many are in it and who administers; Silenciar, and Agregar for who
// administers (with "Editar" in the bar); the members, with "Administra" and
// "(tú)", and the note that only who administers changes them, signed; and
// "Salir del grupo" in red, asked first.
//
// Adding members and editing the group are not in the engine yet: their
// buttons say so. Search, photos and files, disappearing messages and group
// calls are not shown until the engine has them.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../ui/avatar.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../common.dart';
import 'info_parts.dart';

class GroupInfoScreen extends StatefulWidget {
  const GroupInfoScreen({super.key, required this.chat});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => GroupInfoScreen(chat: chat));

  final ChatSummary chat;

  @override
  State<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends State<GroupInfoScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<ChatSummary>> _chats = _engine.chats;
  late final Future<GroupDetails> _details = _engine.groupDetails(widget.chat.id);

  void _notYet() => showNotice(context, context.l10n.notAvailableYet);

  Future<void> _leave() async {
    final l10n = context.l10n;
    final title = widget.chat.title;
    final confirmed = await confirmDanger(
      context,
      title: l10n.leaveGroupTitle(title),
      body: l10n.leaveGroupBody(title),
      confirm: l10n.leaveGroup,
    );
    if (!confirmed || !mounted) return;
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    await _engine.leaveGroup(widget.chat.id);
    // The group is gone: back to the list, where the notice shows.
    navigator.popUntil((route) => route.isFirst);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(l10n.leftGroup(title))));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return FutureBuilder<GroupDetails>(
      future: _details,
      builder: (context, snapshot) {
        final details = snapshot.data;
        final youAdminister = details?.youAdminister ?? false;
        return Scaffold(
          body: SafeArea(
            child: Column(
              children: [
                InfoBar(
                  actions: [
                    if (youAdminister)
                      TrinoButton(
                        label: l10n.groupEdit,
                        variant: ButtonVariant.ghost,
                        compact: true,
                        onPressed: _notYet,
                      ),
                  ],
                ),
                Expanded(
                  child: StreamBuilder<List<ChatSummary>>(
                    stream: _chats,
                    builder: (context, chats) {
                      final chat = chats.data?.where((c) => c.id == widget.chat.id).firstOrNull ?? widget.chat;
                      return ListView(
                        padding: const EdgeInsets.only(bottom: 24),
                        children: [
                          InfoHeader(
                            name: chat.title,
                            kind: AvatarKind.group,
                            subtitle: _subtitle(context, chat, details),
                          ),
                          InfoActions(
                            children: [
                              InfoAction(
                                icon: chat.muted ? TrinoIcons.bellOff : TrinoIcons.bell,
                                label: chat.muted ? l10n.groupMuted : l10n.groupMute,
                                pressed: chat.muted,
                                onPressed: () => unawaited(_engine.setChatMuted(chat.id, !chat.muted)),
                              ),
                              if (youAdminister)
                                InfoAction(icon: TrinoIcons.userPlus, label: l10n.groupAdd, onPressed: _notYet),
                            ],
                          ),
                          if (details != null) ...[
                            SectionLabel(l10n.groupMembersLabel),
                            SettingsGroup(
                              indent: 66,
                              children: [for (final member in details.members) _MemberRow(member: member)],
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                              child: Text(l10n.groupMembersNote, style: context.text.caption),
                            ),
                          ],
                          SettingsGroup(
                            children: [
                              ListRow(
                                icon: TrinoIcons.door,
                                title: l10n.leaveGroup,
                                danger: true,
                                chevron: false,
                                onTap: _leave,
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
      },
    );
  }

  /// "3 miembros · Administra Mamá", or "· Administras tú".
  static String _subtitle(BuildContext context, ChatSummary chat, GroupDetails? details) {
    final l10n = context.l10n;
    final count = details?.members.length ?? chat.memberNames.length + 1;
    final admin = details?.admin;
    return [
      l10n.groupMembers(count),
      if (admin != null) admin.isYou ? l10n.groupAdminYou : l10n.groupAdminBy(admin.name),
    ].join(' · ');
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.member});

  final GroupMember member;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return ListRow(
      leading: TrinoAvatar(name: member.name, size: 36),
      title: member.name,
      titleBadge: member.isYou
          ? Text(l10n.memberYou, style: context.text.body.copyWith(color: context.tokens.muted))
          : null,
      subtitle: member.isAdmin ? l10n.memberAdmin : null,
      chevron: false,
    );
  }
}
