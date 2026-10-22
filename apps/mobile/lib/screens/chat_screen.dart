// A conversation: the header (back; avatar and name with its shield and the
// state in words under it, one button that opens the info; call and video),
// the messages by day with the calls as
// centred lines among them, the button to go back to the newest message when
// new ones arrive out of view, and the composer. Enter writes a new line; the send button
// sends, and it turns active only when there is something to send.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/layout.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/avatar.dart';
import '../ui/button.dart';
import '../ui/call_event_line.dart';
import '../ui/composer_field.dart';
import '../ui/day_separator.dart';
import '../ui/go_to_bottom_button.dart';
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
  const ChatScreen({super.key, required this.chat, this.inPane = false, this.onInfo, this.infoOpen});

  static Route<void> route(ChatSummary chat) => MaterialPageRoute(builder: (_) => ChatScreen(chat: chat));

  static const headerKey = ValueKey('chat-header');
  static const infoToggleKey = ValueKey('chat-info-toggle');

  final ChatSummary chat;

  /// Beside the list on a tablet, rather than a page: there is nothing to go
  /// back to.
  final bool inPane;

  /// What the header does instead of pushing the info, such as opening it as
  /// a third pane.
  final VoidCallback? onInfo;

  /// Whether the info shows beside the chat; when given, the header ends in a
  /// toggle that shows and hides it.
  final bool? infoOpen;

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

  void _openInfo() {
    final onInfo = widget.onInfo;
    if (onInfo != null) return onInfo();
    unawaited(
      Navigator.of(context)
          .push(widget.chat.isGroup ? GroupInfoScreen.route(widget.chat) : ContactInfoScreen.route(widget.chat)),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          _Header(
            key: ChatScreen.headerKey,
            chat: widget.chat,
            showBack: !widget.inPane,
            infoOpen: widget.infoOpen,
            onInfo: _openInfo,
            onCall: _call,
            onVideoCall: () => _call(video: true),
          ),
          // On a wide screen the conversation keeps a readable width, in the
          // middle, so lines and bubbles do not stretch.
          Expanded(
            child: _Readable(
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
          ),
          _Composer(controller: _composer, onSend: _send),
        ],
      ),
    ),
  );
}

/// At most [readableWidth] wide, centred.
class _Readable extends StatelessWidget {
  const _Readable({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: readableWidth),
      child: child,
    ),
  );
}

class _Header extends StatelessWidget {
  const _Header({
    super.key,
    required this.chat,
    required this.showBack,
    required this.infoOpen,
    required this.onInfo,
    required this.onCall,
    required this.onVideoCall,
  });

  final ChatSummary chat;
  final bool showBack;
  final bool? infoOpen;
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
            if (showBack)
              TrinoIconButton(icon: TrinoIcons.back, label: l10n.back, onPressed: () => Navigator.maybePop(context))
            else
              const SizedBox(width: 8),
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
            if (infoOpen case final open?)
              TrinoIconButton(
                key: ChatScreen.infoToggleKey,
                icon: TrinoIcons.sidePanel,
                label: l10n.chatInfoPane,
                pressed: open,
                onPressed: onInfo,
              ),
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

  final _scroll = ScrollController();

  /// Messages from others that arrived while the chat was open and have not
  /// shown yet, each with a key to find where it is.
  final _watching = <String, GlobalKey>{};

  /// Of those, the ones below what shows, as of the last look: the count on
  /// the button.
  var _below = 0;

  /// More than a screen up from the newest message.
  var _farUp = false;
  var _lookScheduled = false;

  @override
  void initState() {
    super.initState();
    _takeIn(animate: false);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
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
    var sent = false;
    for (final message in widget.messages) {
      if (!_arriving.contains(message.id)) continue;
      if (message.outgoing) {
        sent = true;
      } else {
        _watching[message.id] = GlobalKey();
      }
    }
    // What you send arrives at the bottom: go there to see it.
    if (sent) WidgetsBinding.instance.addPostFrameCallback((_) => _goToBottom());
  }

  /// After the next frame, sees which new messages show and how far up the
  /// list is.
  void _scheduleLook() {
    if (_lookScheduled) return;
    _lookScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _lookScheduled = false;
      _look();
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _look() {
    if (!mounted || !_scroll.hasClients) return;
    final list = context.findRenderObject();
    if (list is! RenderBox || !list.hasSize) return;
    final height = list.size.height;
    final seen = <String>[];
    var below = 0;
    for (final MapEntry(key: id, value: key) in _watching.entries) {
      final box = key.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) {
        below++;
        continue;
      }
      final top = box.localToGlobal(Offset.zero, ancestor: list).dy;
      final shown = math.min(top + box.size.height, height) - math.max(top, 0.0);
      // Seen once at least half of it shows.
      if (shown >= math.min(box.size.height, height) / 2) {
        seen.add(id);
      } else {
        below++;
      }
    }
    final position = _scroll.position;
    final farUp = position.pixels > position.viewportDimension;
    if (seen.isEmpty && below == _below && farUp == _farUp) return;
    setState(() {
      seen.forEach(_watching.remove);
      _below = below;
      _farUp = farUp;
    });
  }

  void _goToBottom() {
    if (!mounted) return;
    if (_watching.isNotEmpty || _below > 0) {
      setState(() {
        _watching.clear();
        _below = 0;
      });
    }
    if (!_scroll.hasClients || _scroll.position.pixels <= 0) return;
    final motion = context.motion;
    // Nothing slides with less motion. A spring would pass the end of the
    // list, so the scroll eases out instead.
    if (!motion.travels) return _scroll.jumpTo(0);
    unawaited(_scroll.animateTo(0, duration: motion.medium, curve: Curves.easeOutCubic));
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
          child: KeyedSubtree(
            key: _watching[message.id],
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
        ),
      );
    }
    // Each item keeps its place, and its motion, as new ones come in below.
    final indexOf = {for (final (index, item) in items.indexed) item.key!: items.length - 1 - index};
    _scheduleLook();
    // Only when scrolled up with new messages out of view, or far up; never
    // while the new messages show.
    final showButton = _below > 0 || _farUp;
    return Stack(
      children: [
        NotificationListener<ScrollNotification>(
          onNotification: (_) {
            _scheduleLook();
            return false;
          },
          child: Semantics(
            container: true,
            explicitChildNodes: true,
            label: l10n.messages,
            child: ListView.builder(
              controller: _scroll,
              reverse: true,
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: items.length,
              itemBuilder: (context, index) => items[items.length - 1 - index],
              findChildIndexCallback: (key) => indexOf[key],
            ),
          ),
        ),
        PositionedDirectional(
          end: 8,
          bottom: 8,
          child: MotionSwitcher(
            grow: true,
            alignment: AlignmentDirectional.bottomEnd,
            child: showButton
                ? GoToBottomButton(
                    key: const ValueKey('go-to-bottom'),
                    count: _below,
                    label: _below > 0 ? l10n.goToBottomNew(_below) : l10n.goToBottom,
                    onPressed: _goToBottom,
                  )
                : const SizedBox.shrink(key: ValueKey('at-bottom')),
          ),
        ),
      ],
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
