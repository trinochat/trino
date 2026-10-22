// The sections on a tablet: a rail down the left edge, near the thumb when
// the tablet is held lying down, in place of the bottom tabs. Each section is
// a button with its outline icon and label; the one shown sits on the soft
// accent, in the accent, and bolder, so the choice is not told by colour
// alone. A section can carry a count on its icon, such as the missed calls.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/layout.dart';
import '../design/theme.dart';
import 'unread_badge.dart';

class NavRail extends StatelessWidget {
  const NavRail({
    super.key,
    required this.label,
    required this.items,
    required this.selected,
    required this.onSelected,
    this.badges = const {},
  });

  /// The name of the whole rail, for screen readers, such as "Secciones".
  final String label;
  final List<({TrinoIcons icon, String label})> items;
  final int selected;
  final ValueChanged<int> onSelected;

  /// A count by section index, and its phrase for screen readers; nothing
  /// shows at 0.
  final Map<int, ({int count, String label})> badges;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      role: SemanticsRole.navigation,
      label: label,
      container: true,
      explicitChildNodes: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: t.side,
          border: Border(right: BorderSide(color: t.line)),
        ),
        child: SizedBox(
          width: railWidth,
          child: SafeArea(
            right: false,
            child: Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Column(
                children: [
                  for (var index = 0; index < items.length; index++) ...[
                    if (index > 0) const SizedBox(height: 6),
                    _RailItem(
                      icon: items[index].icon,
                      label: items[index].label,
                      selected: index == selected,
                      badge: badges[index],
                      onTap: () => onSelected(index),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RailItem extends StatelessWidget {
  const _RailItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.badge,
    required this.onTap,
  });

  final TrinoIcons icon;
  final String label;
  final bool selected;
  final ({int count, String label})? badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final ink = selected ? t.accentText : t.muted;
    final badge = this.badge;
    final radius = BorderRadius.circular(t.radius);
    return MergeSemantics(
      child: Semantics(
        button: true,
        selected: selected,
        child: DecoratedBox(
          decoration: BoxDecoration(color: selected ? t.accentSoft : null, borderRadius: radius),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: onTap,
              borderRadius: radius,
              child: SizedBox(
                width: 64,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 60),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(2, 8, 2, 6),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Stack(
                          clipBehavior: Clip.none,
                          children: [
                            TrinoIcon(icon, size: 22, color: ink),
                            if (badge != null && badge.count > 0)
                              Positioned(
                                left: 12,
                                top: -8,
                                child: UnreadBadge(count: badge.count, semanticLabel: badge.label),
                              ),
                          ],
                        ),
                        const SizedBox(height: 3),
                        // Whole, if a little smaller, rather than cut: a
                        // wide font (Terminal's) or a long word.
                        FittedBox(
                          fit: BoxFit.scaleDown,
                          child: Text(
                            label,
                            maxLines: 1,
                            textAlign: TextAlign.center,
                            style: context.text.caption.copyWith(
                              color: ink,
                              fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
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
