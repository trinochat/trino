// "Opciones avanzadas": a header that opens and closes what is below it,
// closed at first so the technical choices stay a tap away. It reads as one
// button that says whether it is open.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';

class AdvancedSection extends StatefulWidget {
  const AdvancedSection({super.key, required this.title, required this.children, this.initiallyOpen = false});

  final String title;
  final List<Widget> children;

  /// Such as when one of the choices inside is the one in use.
  final bool initiallyOpen;

  @override
  State<AdvancedSection> createState() => _AdvancedSectionState();
}

class _AdvancedSectionState extends State<AdvancedSection> {
  late bool _open = widget.initiallyOpen;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Divider(height: 1, thickness: 1, indent: 16, endIndent: 16, color: t.line),
        MergeSemantics(
          child: Semantics(
            button: true,
            expanded: _open,
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                onTap: () => setState(() => _open = !_open),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 52),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                    child: Row(
                      children: [
                        Expanded(child: Text(widget.title, style: context.text.bodyStrong)),
                        TrinoIcon(_open ? TrinoIcons.chevronUp : TrinoIcons.chevronDown, size: 20, color: t.muted),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (_open) ...widget.children,
      ],
    );
  }
}
