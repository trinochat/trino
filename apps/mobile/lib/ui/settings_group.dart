// Rows that belong together, as in the approved mock's settings: a thin
// outline around them and a hairline between rows, indented past the icons.
// It is a Material, so the rows' ink shows on it.
import 'package:flutter/material.dart';

import '../design/theme.dart';

class SettingsGroup extends StatelessWidget {
  const SettingsGroup({super.key, required this.children, this.indent = 52});

  final List<Widget> children;

  /// Where the hairline between rows starts: past a row's icon.
  final double indent;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Material(
        color: t.surface,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: t.line),
          borderRadius: BorderRadius.circular(t.radiusLg),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (index, child) in children.indexed) ...[
              if (index > 0) Divider(height: 1, thickness: 1, indent: indent, color: t.line),
              child,
            ],
          ],
        ),
      ),
    );
  }
}
