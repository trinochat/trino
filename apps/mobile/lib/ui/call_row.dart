// A call in the history: avatar, name (in the danger colour when missed), the
// direction with its icon and its word, and the button that calls back. The
// word carries the meaning; the colour and the icon only repeat it.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'avatar.dart';
import 'icon_button.dart';

class CallRow extends StatelessWidget {
  const CallRow({
    super.key,
    required this.name,
    required this.icon,
    required this.detail,
    required this.callBackLabel,
    required this.onCallBack,
    this.missed = false,
  });

  final String name;

  /// The direction: [TrinoIcons.phoneIncoming], [TrinoIcons.phoneOutgoing] or
  /// [TrinoIcons.phoneMissed].
  final TrinoIcons icon;

  /// The direction in words, the duration and the time, such as
  /// "Saliente · 4 min · 10:36".
  final String detail;
  final bool missed;

  /// The name of the call-back button, such as "Devolver la llamada a Ana".
  final String callBackLabel;
  final VoidCallback onCallBack;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 64),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
        child: Row(
          children: [
            TrinoAvatar(name: name),
            const SizedBox(width: 12),
            Expanded(
              child: MergeSemantics(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text.bodyStrong.copyWith(color: missed ? t.danger : t.ink),
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        TrinoIcon(icon, size: 15, color: t.muted),
                        const SizedBox(width: 6),
                        Expanded(child: Text(detail, style: text.secondary)),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 4),
            TrinoIconButton(
              icon: TrinoIcons.phone,
              label: callBackLabel,
              variant: IconButtonVariant.accent,
              onPressed: onCallBack,
            ),
          ],
        ),
      ),
    );
  }
}
