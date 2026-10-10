// Text tabs with a 2 dp accent underline under the selected one, such as the
// inbox filters. They read as tabs, like Material's TabBar ("Pestaña 2 de 4"),
// and scroll sideways rather than overflow at large text sizes.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';

import '../design/theme.dart';

class UnderlineTabs extends StatelessWidget {
  const UnderlineTabs({super.key, required this.labels, required this.selected, required this.onSelected});

  static const indicatorKey = ValueKey('underline-tabs-indicator');

  final List<String> labels;
  final int selected;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final localizations = MaterialLocalizations.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: t.line)),
      ),
      child: SizedBox(
        width: double.infinity,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Semantics(
            role: SemanticsRole.tabBar,
            container: true,
            explicitChildNodes: true,
            child: Row(
              children: [
                for (var index = 0; index < labels.length; index++)
                  MergeSemantics(
                    child: Material(
                      type: MaterialType.transparency,
                      child: InkWell(
                        onTap: () => onSelected(index),
                        child: Semantics(
                          role: SemanticsRole.tab,
                          child: Stack(
                            children: [
                              ConstrainedBox(
                                constraints: const BoxConstraints(minHeight: 48),
                                child: Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
                                  child: Text(
                                    labels[index],
                                    style: text.tab.copyWith(
                                      color: index == selected ? t.ink : t.muted,
                                      fontWeight: index == selected ? FontWeight.w700 : FontWeight.w600,
                                    ),
                                  ),
                                ),
                              ),
                              if (index == selected)
                                Positioned(
                                  left: 12,
                                  right: 12,
                                  bottom: 0,
                                  child: DecoratedBox(
                                    key: indicatorKey,
                                    decoration: BoxDecoration(
                                      color: t.accentText,
                                      borderRadius: BorderRadius.circular(1),
                                    ),
                                    child: const SizedBox(height: 2),
                                  ),
                                ),
                              Semantics(
                                selected: index == selected,
                                label: localizations.tabLabel(tabIndex: index + 1, tabCount: labels.length),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
