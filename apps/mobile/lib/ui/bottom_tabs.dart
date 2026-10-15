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
          child: Row(
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
                                        TrinoIcon(items[index].icon, color: index == selected ? t.accentText : t.muted),
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
                              if (index == selected)
                                Positioned(
                                  top: 0,
                                  left: 0,
                                  right: 0,
                                  child: Center(
                                    child: DecoratedBox(
                                      key: indicatorKey,
                                      decoration: BoxDecoration(
                                        color: t.accentText,
                                        borderRadius: const BorderRadius.vertical(bottom: Radius.circular(2)),
                                      ),
                                      child: const SizedBox(width: 32, height: 3),
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
