// Unread count of a chat. Screen readers get the whole phrase ("3 sin
// leer"); nothing shows at zero.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

class UnreadBadge extends StatelessWidget {
  const UnreadBadge({super.key, required this.count, required this.semanticLabel, this.max = 99});

  final int count;

  /// The count in words, such as "3 sin leer".
  final String semanticLabel;

  /// Larger counts show as "99+".
  final int max;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    final t = context.tokens;
    return Semantics(
      label: semanticLabel,
      child: ExcludeSemantics(
        child: ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 20, minHeight: 20),
          child: DecoratedBox(
            decoration: BoxDecoration(color: t.badge, borderRadius: BorderRadius.circular(999)),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
              child: Center(
                widthFactor: 1,
                heightFactor: 1,
                child: Text(count > max ? '$max+' : '$count', style: context.text.badge.copyWith(color: t.badgeInk)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
