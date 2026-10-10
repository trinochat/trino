// An icon-only button: its label is its only name, for screen readers and as
// a long-press tooltip. It can be a toggle, such as mute.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';

/// `ghost` for header actions, `muted` for secondary tools such as the
/// composer's, `secondary` outlined, `primary` for the one main action (send),
/// `danger` for removals, and `dangerSolid` for hanging up: dangerBg on danger,
/// which keeps 3:1 in every theme where white on danger does not.
enum IconButtonVariant { ghost, muted, secondary, primary, danger, dangerSolid }

class TrinoIconButton extends StatelessWidget {
  const TrinoIconButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.variant = IconButtonVariant.ghost,
    this.pressed,
    this.size = 48,
    this.iconSize,
    this.circle = false,
  });

  final TrinoIcons icon;

  /// The accessible name: an icon-only button has no other.
  final String label;

  /// Null disables the button, which then shows dimmed.
  final VoidCallback? onPressed;
  final IconButtonVariant variant;

  /// Makes it a toggle: reports the state and, when on, takes the accent tint
  /// (accentText on accentSoft reaches 4.5:1 in every theme).
  final bool? pressed;

  /// Side of the target; never under 48.
  final double size;
  final double? iconSize;

  /// Round, as the call controls; otherwise the theme's radius.
  final bool circle;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (Color? fill, Color ink, Color? border) = pressed == true
        ? (t.accentSoft, t.accentText, null)
        : switch (variant) {
            IconButtonVariant.ghost => (null, t.ink, null),
            IconButtonVariant.muted => (null, t.muted, null),
            IconButtonVariant.secondary => (t.surface, t.ink, t.line),
            IconButtonVariant.primary => (t.accent, t.accentInk, null),
            IconButtonVariant.danger => (null, t.danger, null),
            IconButtonVariant.dangerSolid => (t.danger, t.dangerBg, null),
          };
    final side = border == null ? BorderSide.none : BorderSide(color: border);
    final ShapeBorder shape = circle
        ? CircleBorder(side: side)
        : RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius), side: side);
    final dimension = size < 48 ? 48.0 : size;

    return Semantics(
      container: true,
      button: true,
      enabled: onPressed != null,
      toggled: pressed,
      label: label,
      child: Opacity(
        opacity: onPressed == null ? 0.5 : 1,
        child: Tooltip(
          message: label,
          excludeFromSemantics: true,
          child: SizedBox.square(
            dimension: dimension,
            child: DecoratedBox(
              decoration: ShapeDecoration(color: fill, shape: shape),
              child: Material(
                type: MaterialType.transparency,
                child: InkWell(
                  onTap: onPressed,
                  customBorder: shape,
                  child: Center(
                    child: TrinoIcon(icon, size: iconSize ?? (dimension >= 60 ? 28 : 24), color: ink),
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
