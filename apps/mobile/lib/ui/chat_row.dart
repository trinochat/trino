// A chat in the inbox, as one button: avatar, name, trust, a one-line preview
// (with the draft prefix in the accent), time with the pin of a pinned chat,
// and the unread count, or the closed envelope of a chat marked unread.
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'avatar.dart';
import 'trust_badge.dart';
import 'unread_badge.dart';

class ChatRow extends StatelessWidget {
  const ChatRow({
    super.key,
    required this.name,
    required this.onTap,
    this.avatarKind = AvatarKind.person,
    this.preview,
    this.draftPrefix,
    this.time,
    this.unread,
    this.trust,
    this.pinnedLabel,
    this.markedUnreadLabel,
    this.onLongPress,
    this.longPressHint,
    this.actions = const {},
  });

  final String name;
  final VoidCallback onTap;
  final AvatarKind avatarKind;

  /// The last message, or the draft; cut to one line.
  final String? preview;

  /// Before the preview when it is a draft, such as "Borrador:".
  final String? draftPrefix;

  /// Time or day of the last message, as the screen formats it.
  final String? time;

  /// Unread count and its phrase for screen readers; nothing shows at 0.
  final ({int count, String label})? unread;

  /// The compact badge after the name, such as verified.
  final ({TrustKind kind, String label})? trust;

  /// A pinned chat: a small grey pin before the time, read as this word,
  /// such as "Fijado".
  final String? pinnedLabel;

  /// Marked unread with nothing new: the closed envelope where the count
  /// goes, read as this phrase, such as "Marcado como no leído". The count
  /// wins when there is one.
  final String? markedUnreadLabel;

  /// Opens the chat's actions: a long press, the semantics long press, or
  /// the menu key or Shift+F10 on the focused row.
  final VoidCallback? onLongPress;

  /// What [onLongPress] does, for screen readers, such as "Más opciones".
  final String? longPressHint;

  /// The same actions as the swipe and the sheet, as screen reader actions.
  final Map<CustomSemanticsAction, VoidCallback> actions;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final unread = this.unread;
    final trust = this.trust;
    final pinnedLabel = this.pinnedLabel;
    final hasCount = unread != null && unread.count > 0;
    final markedUnreadLabel = hasCount ? null : this.markedUnreadLabel;
    final onLongPress = this.onLongPress;
    return MergeSemantics(
      child: Semantics(
        button: true,
        onLongPressHint: onLongPress == null ? null : longPressHint,
        customSemanticsActions: actions.isEmpty ? null : actions,
        child: Material(
          type: MaterialType.transparency,
          child: CallbackShortcuts(
            bindings: {
              if (onLongPress != null) ...{
                const SingleActivator(LogicalKeyboardKey.contextMenu): onLongPress,
                const SingleActivator(LogicalKeyboardKey.f10, shift: true): onLongPress,
              },
            },
            child: InkWell(
              onTap: onTap,
              onLongPress: onLongPress,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 72),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Row(
                    children: [
                      TrinoAvatar(name: name, kind: avatarKind),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.bodyStrong,
                                  ),
                                ),
                                if (trust != null) ...[
                                  const SizedBox(width: 4),
                                  TrustBadge(kind: trust.kind, label: trust.label, compact: true),
                                ],
                              ],
                            ),
                            if (draftPrefix != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Text.rich(
                                  TextSpan(
                                    children: [
                                      TextSpan(
                                        text: '$draftPrefix ',
                                        style: text.secondary.copyWith(
                                          color: t.accentText,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                      TextSpan(text: preview ?? '', style: text.secondary),
                                    ],
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              )
                            else if (preview != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 2),
                                child: Text(
                                  preview!,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: text.secondary,
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (time != null || pinnedLabel != null || hasCount || markedUnreadLabel != null) ...[
                        const SizedBox(width: 12),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (pinnedLabel != null) ...[
                                  TrinoIcon(TrinoIcons.pin, size: 14, color: t.muted, semanticLabel: pinnedLabel),
                                  const SizedBox(width: 4),
                                ],
                                if (time != null) Text(time!, style: text.mono),
                              ],
                            ),
                            if (hasCount)
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: UnreadBadge(count: unread.count, semanticLabel: unread.label),
                              )
                            else if (markedUnreadLabel != null)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: TrinoIcon(
                                  TrinoIcons.mail,
                                  size: 20,
                                  color: t.accentText,
                                  semanticLabel: markedUnreadLabel,
                                ),
                              ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
