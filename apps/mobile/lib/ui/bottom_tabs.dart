// The app's bottom tabs: an icon and its label, the selected one in the accent
// with a short bar above it, so the choice is not told by colour alone.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';

class BottomTabs extends StatelessWidget {
  const BottomTabs({super.key, required this.items, required this.selected, required this.onSelected});

  static const indicatorKey = ValueKey('bottom-tabs-indicator');

  final List<({TrinoIcons icon, String label})> items;
  final int selected;
  final ValueChanged<int> onSelected;

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
                                      TrinoIcon(items[index].icon, color: index == selected ? t.accentText : t.muted),
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
}
