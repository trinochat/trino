// The app's bottom tabs: an icon and its label, the selected one in the accent
// with a short bar above it, so the choice is not told by colour alone. A tab
// can carry a count on its icon, such as the missed calls: numbers only.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'unread_badge.dart';

class BottomTabs extends StatelessWidget {
  const BottomTabs({
    super.key,
    required this.items,
    required this.selected,
    required this.onSelected,
    this.badges = const {},
  });

  static const indicatorKey = ValueKey('bottom-tabs-indicator');

  final List<({TrinoIcons icon, String label})> items;
  final int selected;
  final ValueChanged<int> onSelected;

  /// A count by tab index, and its phrase for screen readers; nothing shows
  /// at 0.
  final Map<int, ({int count, String label})> badges;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final localizations = MaterialLocalizations.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: t.side,
        border: Border(top: BorderSide(color: t.line)),
      ),
      child: SafeArea(
        top: false,
        child: Semantics(
          role: SemanticsRole.tabBar,
          container: true,
          explicitChildNodes: true,
          child: Stack(
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var index = 0; index < items.length; index++)
                    Expanded(
                      child: MergeSemantics(
                        child: Material(
                          type: MaterialType.transparency,
                          child: InkWell(
                            onTap: () => onSelected(index),
                            child: Semantics(
                              role: SemanticsRole.tab,
                              child: Stack(
                                children: [
                                  ConstrainedBox(
                                    constraints: const BoxConstraints(minHeight: 60, minWidth: double.infinity),
                                    child: Padding(
                                      padding: const EdgeInsets.fromLTRB(4, 10, 4, 8),
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          _iconWithBadge(
                                            TrinoIcon(
                                              items[index].icon,
                                              color: index == selected ? t.accentText : t.muted,
                                            ),
                                            badges[index],
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            items[index].label,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            textAlign: TextAlign.center,
                                            style: text.caption.copyWith(
                                              color: index == selected ? t.accentText : t.muted,
                                              fontWeight: index == selected ? FontWeight.w700 : FontWeight.w600,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  Semantics(
                                    selected: index == selected,
                                    label: localizations.tabLabel(tabIndex: index + 1, tabCount: items.length),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              _Indicator(selected: selected, count: items.length, color: t.accentText),
            ],
          ),
        ),
      ),
    );
  }

  Widget _iconWithBadge(Widget icon, ({int count, String label})? badge) {
    if (badge == null || badge.count <= 0) return icon;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        icon,
        Positioned(
          left: 14,
          top: -8,
          child: UnreadBadge(count: badge.count, semanticLabel: badge.label),
        ),
      ],
    );
  }
}

/// The short bar above the selected tab. On a change only it moves, sliding
/// to the new tab with the theme's motion; the screens switch at once. With
/// Reduce Motion or Remove animations it is at the new tab at once.
class _Indicator extends StatelessWidget {
  const _Indicator({required this.selected, required this.count, required this.color});

  final int selected;
  final int count;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final motion = context.motion;
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      child: AnimatedAlign(
        alignment: AlignmentDirectional(count == 1 ? 0 : -1 + 2 * selected / (count - 1), -1),
        duration: motion.travels ? motion.medium : Duration.zero,
        curve: motion.curve,
        child: FractionallySizedBox(
          widthFactor: 1 / count,
          child: Center(
            child: DecoratedBox(
              key: BottomTabs.indicatorKey,
              decoration: BoxDecoration(
                color: color,
                borderRadius: const BorderRadius.vertical(bottom: Radius.circular(2)),
              ),
              child: const SizedBox(width: 32, height: 3),
            ),
          ),
        ),
      ),
    );
  }
}
