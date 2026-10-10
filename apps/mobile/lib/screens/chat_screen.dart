// A conversation: the header (back, avatar, name with its shield, call), the
// messages by day, and the composer. Enter writes a new line; the send button
// sends, and it turns active only when there is something to send.
import 'dart:async';

import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/avatar.dart';
import '../ui/button.dart';
import '../ui/day_separator.dart';
import '../ui/icon_button.dart';
import '../ui/message_bubble.dart';
import '../ui/text_field.dart';
import '../ui/trust_badge.dart';
import 'call_screen.dart';
import 'chats_screen.dart';
import 'common.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.chat});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => ChatScreen(chat: chat));

  static const headerKey = ValueKey('chat-header');

  final ChatSummary chat;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<ChatMessage>> _messages = _engine.messages(widget.chat.id);
  late final _composer = TextEditingController(text: widget.chat.draft ?? '');
  var _read = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_read) {
      _read = true;
      unawaited(_engine.markRead(widget.chat.id));
    }
  }

  @override
  void dispose() {
    // What is left in the composer waits as the chat's draft.
    unawaited(_engine.saveDraft(widget.chat.id, _composer.text));
    _composer.dispose();
    super.dispose();
  }

  void _send() {
    final text = _composer.text.trim();
    if (text.isEmpty) return;
    unawaited(_engine.send(widget.chat.id, text));
    _composer.clear();
  }

  Future<void> _call() async {
    final contactId = widget.chat.contactId;
    if (contactId == null) return;
    final navigator = Navigator.of(context);
    await _engine.startCall(contactId);
    await navigator.push(CallScreen.route());
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          _Header(key: ChatScreen.headerKey, chat: widget.chat, onCall: _call),
          Expanded(
            child: StreamBuilder<List<ChatMessage>>(
              stream: _messages,
              builder: (context, snapshot) => _MessageList(
                messages: snapshot.data ?? const [],
                group: widget.chat.isGroup,
                onRetry: (message) => _engine.retry(widget.chat.id, message.id),
              ),
            ),
          ),
          _Composer(controller: _composer, onSend: _send),
        ],
      ),
    ),
  );
}

class _Header extends StatelessWidget {
  const _Header({super.key, required this.chat, required this.onCall});

  final ChatSummary chat;
  final VoidCallback onCall;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final trust = trustOf(chat, l10n);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: context.tokens.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
        child: Row(
          children: [
            TrinoIconButton(icon: TrinoIcons.back, label: l10n.back, onPressed: () => Navigator.maybePop(context)),
            TrinoAvatar(name: chat.title, size: 40, kind: chat.isGroup ? AvatarKind.group : AvatarKind.person),
            const SizedBox(width: 10),
            Expanded(
              child: MergeSemantics(
                child: Semantics(
                  header: true,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              chat.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: context.text.bodyStrong.copyWith(fontFamily: context.tokens.display, fontSize: 17),
                            ),
                          ),
                          if (trust != null) ...[
                            const SizedBox(width: 4),
                            TrustBadge(kind: trust.kind, label: trust.label, compact: true),
                          ],
                        ],
                      ),
                      if (chat.isGroup)
                        Text(l10n.groupMembers(chat.memberNames.length + 1), style: context.text.caption),
                    ],
                  ),
                ),
              ),
            ),
            // Calls are one to one for now.
            if (!chat.isGroup) TrinoIconButton(icon: TrinoIcons.phone, label: l10n.call, onPressed: onCall),
          ],
        ),
      ),
    );
  }
}

class _MessageList extends StatelessWidget {
  const _MessageList({required this.messages, required this.group, required this.onRetry});

  final List<ChatMessage> messages;
  final bool group;
  final void Function(ChatMessage message) onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (messages.isEmpty) {
      return Center(child: Text(l10n.noMessages, style: context.text.secondary));
    }
    final now = context.now();
    // Oldest first, with a separator where the day changes; drawn from the
    // bottom, as the newest message belongs there.
    final items = <Widget>[];
    DateTime? day;
    for (final message in messages) {
      final messageDay = DateUtils.dateOnly(message.sentAt);
      if (messageDay != day) {
        day = messageDay;
        items.add(DaySeparator(key: ValueKey(messageDay), label: formatDayLabel(context, message.sentAt, now)));
      }
      items.add(
        Padding(
          key: ValueKey(message.id),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
          child: MessageBubble(
            direction: message.outgoing ? BubbleDirection.outgoing : BubbleDirection.incoming,
            text: message.text,
            time: formatTime(context, message.sentAt),
            sender: group ? message.sender : null,
            status: message.outgoing
                ? (state: _delivery(message.status), label: _statusLabel(context, message.status))
                : null,
            failure: message.status == MessageStatus.failed
                ? (
                    text: l10n.failedNotice,
                    retry: TrinoButton(
                      label: l10n.retry,
                      variant: ButtonVariant.ghost,
                      onPressed: () => onRetry(message),
                    ),
                  )
                : null,
          ),
        ),
      );
    }
    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: l10n.messages,
      child: ListView.builder(
        reverse: true,
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: items.length,
        itemBuilder: (context, index) => items[items.length - 1 - index],
      ),
    );
  }

  static DeliveryState _delivery(MessageStatus status) => switch (status) {
    MessageStatus.sending => DeliveryState.sending,
    MessageStatus.sent => DeliveryState.sent,
    MessageStatus.failed => DeliveryState.failed,
  };

  static String _statusLabel(BuildContext context, MessageStatus status) => switch (status) {
    MessageStatus.sending => context.l10n.statusSending,
    MessageStatus.sent => context.l10n.statusSent,
    MessageStatus.failed => context.l10n.statusFailed,
  };
}

class _Composer extends StatelessWidget {
  const _Composer({required this.controller, required this.onSend});

  final TextEditingController controller;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    void notYet() => showNotice(context, l10n.notAvailableYet);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: context.tokens.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            TrinoIconButton(
              icon: TrinoIcons.plus,
              label: l10n.attach,
              variant: IconButtonVariant.muted,
              onPressed: notYet,
            ),
            Expanded(
              child: TrinoTextField(
                controller: controller,
                semanticLabel: l10n.messageLabel,
                hint: l10n.composerHint,
                maxLines: 5,
                keyboardType: TextInputType.multiline,
                textInputAction: TextInputAction.newline,
                textCapitalization: TextCapitalization.sentences,
              ),
            ),
            TrinoIconButton(
              icon: TrinoIcons.smile,
              label: l10n.emojiAndStickers,
              variant: IconButtonVariant.muted,
              onPressed: notYet,
            ),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: controller,
              builder: (context, value, _) {
                final ready = value.text.trim().isNotEmpty;
                return TrinoIconButton(
                  icon: TrinoIcons.send,
                  label: l10n.send,
                  variant: ready ? IconButtonVariant.primary : IconButtonVariant.muted,
                  onPressed: ready ? onSend : null,
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
