// A chat in the inbox, as one button: avatar, name, trust, a one-line preview
// (with the draft prefix in the accent), time and unread count.
import 'package:flutter/material.dart';

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

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final unread = this.unread;
    final trust = this.trust;
    return MergeSemantics(
      child: Semantics(
        button: true,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
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
                                child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: text.bodyStrong),
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
                                      style: text.secondary.copyWith(color: t.accentText, fontWeight: FontWeight.w600),
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
                    if (time != null || (unread != null && unread.count > 0)) ...[
                      const SizedBox(width: 12),
                      Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          if (time != null) Text(time!, style: text.mono),
                          if (unread != null && unread.count > 0)
                            Padding(
                              padding: const EdgeInsets.only(top: 6),
                              child: UnreadBadge(count: unread.count, semanticLabel: unread.label),
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
    );
  }
}
