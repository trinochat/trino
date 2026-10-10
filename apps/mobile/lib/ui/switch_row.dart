// The desktop's switch: a 48×28 track and a 22 knob, chosen for WCAG 1.4.11
// (3:1): the off track is muted (the decorative line would be ~1.3:1) and each
// knob contrasts with its track. contrast_test checks all 16 appearances.
import 'package:flutter/material.dart';

import '../design/theme.dart';

class TrinoSwitch extends StatelessWidget {
  const TrinoSwitch({super.key, required this.value, required this.onChanged, this.semanticLabel});

  final bool value;

  /// Null disables it.
  final ValueChanged<bool>? onChanged;

  /// Its name when it stands alone; inside a [SwitchRow] the row names it.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final onChanged = this.onChanged;
    final duration = MediaQuery.disableAnimationsOf(context) ? Duration.zero : const Duration(milliseconds: 150);
    return Semantics(
      container: semanticLabel != null,
      label: semanticLabel,
      toggled: value,
      enabled: onChanged != null,
      child: Opacity(
        opacity: onChanged == null ? 0.5 : 1,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onChanged == null ? null : () => onChanged(!value),
            customBorder: const StadiumBorder(),
            child: SizedBox(
              width: 56,
              height: 48,
              child: TweenAnimationBuilder<double>(
                tween: Tween(end: value ? 1 : 0),
                duration: duration,
                curve: Curves.easeOut,
                builder: (context, position, _) => CustomPaint(
                  painter: SwitchPainter(
                    track: value ? t.accent : t.muted,
                    knob: value ? t.accentInk : t.surface,
                    position: position,
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

class SwitchPainter extends CustomPainter {
  SwitchPainter({required this.track, required this.knob, required this.position});

  final Color track;
  final Color knob;

  /// 0 off, 1 on.
  final double position;

  static const _trackSize = Size(48, 28);
  static const _knob = 22.0;
  static const _inset = 3.0;

  @override
  void paint(Canvas canvas, Size size) {
    final origin = Offset((size.width - _trackSize.width) / 2, (size.height - _trackSize.height) / 2);
    final trackRect = origin & _trackSize;
    canvas.drawRRect(RRect.fromRectAndRadius(trackRect, const Radius.circular(14)), Paint()..color = track);
    final travel = _trackSize.width - _knob - 2 * _inset;
    final center = Offset(trackRect.left + _inset + _knob / 2 + travel * position, trackRect.center.dy);
    canvas.drawCircle(center, _knob / 2, Paint()..color = knob);
  }

  @override
  bool shouldRepaint(SwitchPainter old) => old.track != track || old.knob != knob || old.position != position;
}

/// A setting with a switch: the title (and description) on the left, the
/// switch on the right. The whole row toggles, and reads as one switch.
class SwitchRow extends StatelessWidget {
  const SwitchRow({super.key, required this.title, this.description, required this.value, required this.onChanged});

  final String title;
  final String? description;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final text = context.text;
    final onChanged = this.onChanged;
    return MergeSemantics(
      child: Opacity(
        opacity: onChanged == null ? 0.5 : 1,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onChanged == null ? null : () => onChanged(!value),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 56),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(title, style: text.bodyStrong),
                          if (description != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(description!, style: text.secondary),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    // The row is dimmed already.
                    Opacity(
                      opacity: 1,
                      child: TrinoSwitch(value: value, onChanged: onChanged),
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
