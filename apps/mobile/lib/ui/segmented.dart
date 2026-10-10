// A compact single choice in one row, such as Calma or Terminal. It reads as
// a group of radio buttons; the selected segment is filled with the accent,
// which reaches 3:1 against the surface.
import 'package:flutter/material.dart';

import '../design/theme.dart';

class TrinoSegmented<T> extends StatelessWidget {
  const TrinoSegmented({
    super.key,
    required this.options,
    required this.selected,
    required this.onChanged,
    required this.semanticLabel,
  });

  final List<({T value, String label})> options;
  final T selected;
  final ValueChanged<T> onChanged;

  /// The name of the group, such as "Estilo".
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: t.surface,
          border: Border.all(color: t.line),
          borderRadius: BorderRadius.circular(t.radiusLg),
        ),
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: Row(
            children: [
              for (final option in options)
                Expanded(
                  child: Builder(
                    builder: (context) {
                      final checked = option.value == selected;
                      final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius));
                      return Semantics(
                        container: true,
                        inMutuallyExclusiveGroup: true,
                        checked: checked,
                        child: DecoratedBox(
                          decoration: ShapeDecoration(color: checked ? t.accent : Colors.transparent, shape: shape),
                          child: Material(
                            type: MaterialType.transparency,
                            child: InkWell(
                              customBorder: shape,
                              onTap: () => onChanged(option.value),
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(minHeight: 48),
                                child: Center(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                    child: Text(
                                      option.label,
                                      textAlign: TextAlign.center,
                                      style: text.tab.copyWith(color: checked ? t.accentInk : t.ink),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
