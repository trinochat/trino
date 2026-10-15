// A row of a list or a settings screen: an icon or avatar, the title and a
// subtitle, a value on the right, and a chevron when it opens something.
// It reads as one button. ChoiceRow is its single-choice sibling.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';

class ListRow extends StatelessWidget {
  const ListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.leading,
    this.titleBadge,
    this.value,
    this.trailing,
    this.onTap,
    this.chevron = true,
    this.accent = false,
    this.danger = false,
  });

  final String title;
  final String? subtitle;
  final TrinoIcons? icon;

  /// In place of [icon], such as an avatar.
  final Widget? leading;

  /// Right after the title, such as a contact's verified shield.
  final Widget? titleBadge;

  /// The current choice, such as "Tras 5 minutos".
  final String? value;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool chevron;

  /// The title and icon in the accent: an action such as "Agregar contacto".
  final bool accent;

  /// The title and icon in danger: a destructive action.
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final color = danger
        ? t.danger
        : accent
        ? t.accentText
        : t.ink;
    final showChevron = chevron && onTap != null && trailing == null;
    return MergeSemantics(
      child: Semantics(
        button: onTap != null,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 56),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Row(
                  children: [
                    if (leading != null) ...[
                      leading!,
                      const SizedBox(width: 14),
                    ] else if (icon != null) ...[
                      TrinoIcon(icon!, size: 22, color: accent || danger ? color : t.muted),
                      const SizedBox(width: 14),
                    ],
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (titleBadge == null)
                            Text(title, style: text.bodyStrong.copyWith(color: color))
                          else
                            Row(
                              children: [
                                Flexible(
                                  child: Text(title, style: text.bodyStrong.copyWith(color: color)),
                                ),
                                const SizedBox(width: 4),
                                titleBadge!,
                              ],
                            ),
                          if (subtitle != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(subtitle!, style: text.secondary),
                            ),
                        ],
                      ),
                    ),
                    if (value != null) ...[
                      const SizedBox(width: 12),
                      ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.4),
                        child: Text(value!, textAlign: TextAlign.end, style: text.secondary),
                      ),
                    ],
                    if (trailing != null) ...[const SizedBox(width: 12), trailing!],
                    if (showChevron) ...[
                      const SizedBox(width: 6),
                      TrinoIcon(TrinoIcons.chevronRight, size: 20, color: t.muted),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// One option of a single choice, such as what notifications show: a radio
/// mark, the title and a description. It reads as one checked or unchecked
/// option of its group.
class ChoiceRow extends StatelessWidget {
  const ChoiceRow({
    super.key,
    required this.title,
    this.subtitle,
    required this.selected,
    required this.onTap,
    this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
  });

  final String title;
  final String? subtitle;
  final bool selected;
  final VoidCallback onTap;

  /// Around the content: a list's 16 by default, or none inside a padded page.
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    return MergeSemantics(
      child: Semantics(
        inMutuallyExclusiveGroup: true,
        checked: selected,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 56),
              child: Padding(
                padding: padding,
                child: Row(
                  children: [
                    SizedBox.square(
                      dimension: 22,
                      // The ring keeps 3:1 on every surface: muted, or accentText when chosen.
                      child: CustomPaint(
                        painter: RadioPainter(ring: selected ? t.accentText : t.muted, selected: selected),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(title, style: text.bodyStrong),
                          if (subtitle != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(subtitle!, style: text.secondary),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class RadioPainter extends CustomPainter {
  RadioPainter({required this.ring, required this.selected});

  final Color ring;
  final bool selected;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide / 2;
    canvas.drawCircle(
      center,
      radius - 1,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = ring,
    );
    if (selected) canvas.drawCircle(center, radius * 0.45, Paint()..color = ring);
  }

  @override
  bool shouldRepaint(RadioPainter old) => old.ring != ring || old.selected != selected;
}
