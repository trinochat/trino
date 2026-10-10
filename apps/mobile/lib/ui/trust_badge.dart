// Trust state of a contact. Only "verified" uses the accent, and only when it
// really is; a changed key and a message request warn. Compact mode, for rows
// and headers, shows the icon alone and keeps the label for screen readers.
import 'package:flutter/widgets.dart';

import '../design/icons.dart';
import '../design/theme.dart';

enum TrustKind { verified, unverified, keyChanged, request }

class TrustBadge extends StatelessWidget {
  const TrustBadge({super.key, required this.kind, required this.label, this.compact = false});

  final TrustKind kind;

  /// Visible text; in compact mode, the screen-reader text.
  final String label;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (icon, color, weight, iconWithLabel) = switch (kind) {
      TrustKind.verified => (TrinoIcons.shieldCheck, t.accentText, FontWeight.w600, true),
      TrustKind.unverified => (TrinoIcons.shield, t.muted, FontWeight.w400, false),
      TrustKind.keyChanged => (TrinoIcons.shieldAlert, t.warn, FontWeight.w600, true),
      TrustKind.request => (TrinoIcons.shield, t.warn, FontWeight.w600, false),
    };
    if (compact) return TrinoIcon(icon, size: 16, color: color, semanticLabel: label);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (iconWithLabel) ...[TrinoIcon(icon, size: 16, color: color), const SizedBox(width: 4)],
        Flexible(
          child: Text(
            label,
            style: context.text.secondary.copyWith(color: color, fontWeight: weight),
          ),
        ),
      ],
    );
  }
}
