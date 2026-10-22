// A conversation: the header (back; avatar and name with its shield and the
// state in words under it, one button that opens the info; call and video),
// the messages by day with the calls as
// centred lines among them, and the composer. Enter writes a new line; the send button
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
import '../ui/call_event_line.dart';
import '../ui/composer_field.dart';
import '../ui/day_separator.dart';
import '../ui/icon_button.dart';
import '../ui/message_arrival.dart';
import '../ui/message_bubble.dart';
import '../ui/motion_switcher.dart';
import '../ui/trust_badge.dart';
import 'call_screen.dart';
import 'chats_screen.dart';
import 'common.dart';
import 'info/contact_info_screen.dart';
import 'info/group_info_screen.dart';

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

  Future<void> _call({bool video = false}) async {
    final contactId = widget.chat.contactId;
    if (contactId == null) return;
    final navigator = Navigator.of(context);
    await _engine.startCall(contactId, video: video);
    await navigator.push(CallScreen.route());
  }

  void _openInfo() => unawaited(
    Navigator.of(context)
        .push(widget.chat.isGroup ? GroupInfoScreen.route(widget.chat) : ContactInfoScreen.route(widget.chat)),
  );

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          _Header(
            key: ChatScreen.headerKey,
            chat: widget.chat,
            onInfo: _openInfo,
            onCall: _call,
            onVideoCall: () => _call(video: true),
          ),
          Expanded(
            child: StreamBuilder<List<ChatMessage>>(
              stream: _messages,
              builder: (context, snapshot) => _MessageList(
                messages: snapshot.data ?? const [],
                loaded: snapshot.hasData,
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
  const _Header({super.key, required this.chat, required this.onInfo, required this.onCall, required this.onVideoCall});

  final ChatSummary chat;
  final VoidCallback onInfo;
  final VoidCallback onCall;
  final VoidCallback onVideoCall;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final trust = trustOf(chat, l10n);
    final subtitle = chat.isGroup
        ? l10n.groupMembers(chat.memberNames.length + 1)
        : switch (chat.trust) {
            Trust.verified => l10n.chatVerified,
            Trust.unverified => l10n.contactUnverified,
            Trust.keyChanged => l10n.contactKeyChanged,
          };
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: context.tokens.line)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
        child: Row(
          children: [
            TrinoIconButton(icon: TrinoIcons.back, label: l10n.back, onPressed: () => Navigator.maybePop(context)),
            Expanded(
              // One button: it reads its name and, as its value, the state.
              child: Semantics(
                container: true,
                button: true,
                label: l10n.chatInfoOpen(chat.title),
                value: subtitle,
                onTap: onInfo,
                excludeSemantics: true,
                child: Material(
                  type: MaterialType.transparency,
                  child: InkWell(
                    onTap: onInfo,
                    borderRadius: BorderRadius.circular(context.tokens.radius),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 48),
                      child: Row(
                        children: [
                          TrinoAvatar(
                            name: chat.title,
                            size: 40,
                            kind: chat.isGroup ? AvatarKind.group : AvatarKind.person,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
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
                                        style: context.text.bodyStrong.copyWith(
                                          fontFamily: context.tokens.display,
                                          fontSize: 17,
                                        ),
                                      ),
                                    ),
                                    if (trust != null) ...[
                                      const SizedBox(width: 4),
                                      TrustBadge(kind: trust.kind, label: trust.label, compact: true),
                                    ],
                                  ],
                                ),
                                Text(
                                  subtitle,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: context.text.caption.copyWith(
                                    color: chat.trust == Trust.keyChanged && !chat.isGroup
                                        ? context.tokens.warn
                                        : context.tokens.muted,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            // Calls are one to one for now.
            if (!chat.isGroup) ...[
              TrinoIconButton(icon: TrinoIcons.phone, label: l10n.call, onPressed: onCall),
              TrinoIconButton(icon: TrinoIcons.video, label: l10n.videoCall, onPressed: onVideoCall),
            ],
          ],
        ),
      ),
    );
  }
}

class _MessageList extends StatefulWidget {
  const _MessageList({required this.messages, required this.loaded, required this.group, required this.onRetry});

  final List<ChatMessage> messages;

  /// Whether [messages] came from the engine yet: what is there then is the
  /// history, which does not move.
  final bool loaded;
  final bool group;
  final void Function(ChatMessage message) onRetry;

  @override
  State<_MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<_MessageList> {
  /// Every message shown so far; what is not here yet arrives now.
  final _known = <String>{};

  /// What arrived with the last change, to move in once.
  var _arriving = const <String>{};

  @override
  void initState() {
    super.initState();
    _takeIn(animate: false);
  }

  @override
  void didUpdateWidget(_MessageList oldWidget) {
    super.didUpdateWidget(oldWidget);
    _takeIn(animate: oldWidget.loaded);
  }

  void _takeIn({required bool animate}) {
    if (!widget.loaded) return;
    final fresh = {
      for (final message in widget.messages)
        if (_known.add(message.id)) message.id,
    };
    _arriving = animate ? fresh : const {};
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final messages = widget.messages;
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
      final call = message.call;
      if (call != null) {
        items.add(_callLine(context, message, call));
        continue;
      }
      items.add(
        MessageArrival(
          key: ValueKey(message.id),
          animate: _arriving.contains(message.id),
          // Yours rise as they appear; theirs only fade in.
          rise: message.outgoing,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            child: MessageBubble(
              direction: message.outgoing ? BubbleDirection.outgoing : BubbleDirection.incoming,
              text: message.text,
              time: formatTime(context, message.sentAt),
              sender: widget.group ? message.sender : null,
              status: message.outgoing
                  ? (state: _delivery(message.status), label: _statusLabel(context, message.status))
                  : null,
              failure: message.status == MessageStatus.failed
                  ? (
                      text: l10n.failedNotice,
                      retry: TrinoButton(
                        label: l10n.retry,
                        variant: ButtonVariant.ghost,
                        onPressed: () => widget.onRetry(message),
                      ),
                    )
                  : null,
            ),
          ),
        ),
      );
    }
    // Each item keeps its place, and its motion, as new ones come in below.
    final indexOf = {for (final (index, item) in items.indexed) item.key!: items.length - 1 - index};
    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: l10n.messages,
      child: ListView.builder(
        reverse: true,
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: items.length,
        itemBuilder: (context, index) => items[items.length - 1 - index],
        findChildIndexCallback: (key) => indexOf[key],
      ),
    );
  }

  /// "Llamada saliente · 4 min · 10:36", "Llamada entrante · 12 min · 17:05"
  /// or "Llamada perdida · 10:44".
  static Widget _callLine(BuildContext context, ChatMessage message, CallRecord call) {
    final l10n = context.l10n;
    final (icon, word) = switch (call.direction) {
      CallDirection.outgoing => (TrinoIcons.phoneOutgoing, l10n.callEventOutgoing),
      CallDirection.incoming => (TrinoIcons.phoneIncoming, l10n.callEventIncoming),
      CallDirection.missed => (TrinoIcons.phoneMissed, l10n.callEventMissed),
    };
    final missed = call.direction == CallDirection.missed;
    return CallEventLine(
      key: ValueKey(message.id),
      icon: icon,
      missed: missed,
      text: [
        word,
        if (!missed) formatCallLength(context, call.duration),
        formatTime(context, message.sentAt),
      ].join(' · '),
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
              child: ComposerField(controller: controller, semanticLabel: l10n.messageLabel, hint: l10n.composerHint),
            ),
            TrinoIconButton(
              icon: TrinoIcons.smile,
              label: l10n.emojiAndStickers,
              variant: IconButtonVariant.muted,
              onPressed: notYet,
            ),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: controller,
              // As in WhatsApp and Signal: a voice message while the field is
              // empty, and send once there is something to send. Voice
              // messages do not exist yet, so the microphone says so. They
              // swap with a short grow and fade (the theme's motion).
              builder: (context, value, _) => MotionSwitcher(
                grow: true,
                child: value.text.trim().isNotEmpty
                    ? TrinoIconButton(
                        key: const ValueKey('composer-send'),
                        icon: TrinoIcons.send,
                        label: l10n.send,
                        variant: IconButtonVariant.primary,
                        onPressed: onSend,
                      )
                    : TrinoIconButton(
                        key: const ValueKey('composer-mic'),
                        icon: TrinoIcons.mic,
                        label: l10n.voiceMessage,
                        variant: IconButtonVariant.muted,
                        onPressed: notYet,
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
