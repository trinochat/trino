// A text button in four variants. Text on its fill reaches 4.5:1 in every
// theme (accentInk on accent); the others sit on any surface.
import 'package:flutter/material.dart';

import '../design/icons.dart';
import '../design/theme.dart';

/// `secondary` by default, so a screen has to choose its one primary action.
enum ButtonVariant { primary, secondary, ghost, danger }

class TrinoButton extends StatelessWidget {
  const TrinoButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = ButtonVariant.secondary,
    this.icon,
    this.loading = false,
    this.expand = false,
    this.expanded,
    this.compact = false,
  });

  final String label;

  /// Null disables the button, which then shows dimmed.
  final VoidCallback? onPressed;
  final ButtonVariant variant;

  /// A decorative icon before the label.
  final TrinoIcons? icon;

  /// Shows progress in place of the icon and ignores taps, without dimming:
  /// the button is busy, not unavailable.
  final bool loading;

  /// Fills the available width.
  final bool expand;

  /// For a button that shows or hides something below it: whether it shows.
  final bool? expanded;

  /// Less room around the label and the icon, for buttons side by side.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (Color? fill, Color ink, Color? border, FontWeight weight) = switch (variant) {
      ButtonVariant.primary => (t.accent, t.accentInk, null, FontWeight.w700),
      ButtonVariant.secondary => (null, t.ink, t.line, FontWeight.w600),
      ButtonVariant.ghost => (null, t.ink, null, FontWeight.w600),
      ButtonVariant.danger => (null, t.danger, t.danger, FontWeight.w700),
    };
    final enabled = onPressed != null && !loading;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(t.radius),
      side: border == null ? BorderSide.none : BorderSide(color: border),
    );
    final leading = loading
        ? SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: ink))
        : icon == null
        ? null
        : TrinoIcon(icon!, size: compact ? 18 : 20, color: ink);

    return MergeSemantics(
      child: Semantics(
        button: true,
        enabled: enabled,
        expanded: expanded,
        child: Opacity(
          opacity: onPressed == null && !loading ? 0.5 : 1,
          child: DecoratedBox(
            decoration: ShapeDecoration(color: fill, shape: shape),
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                onTap: enabled ? onPressed : null,
                customBorder: shape,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 18, vertical: 10),
                    child: Row(
                      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        if (leading != null) ...[leading, SizedBox(width: compact ? 6 : 8)],
                        Flexible(
                          child: Text(
                            label,
                            textAlign: TextAlign.center,
                            style: context.text.button.copyWith(color: ink, fontWeight: weight),
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
