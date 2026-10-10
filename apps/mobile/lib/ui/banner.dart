// A banner across a screen, such as a changed security code: info (accent
// tint), warning or danger, with an icon, the text and an optional action.
// Danger is a live region, so screen readers announce it.
import 'package:flutter/widgets.dart';

import '../design/icons.dart';
import '../design/theme.dart';

enum BannerTone { info, warn, danger }

class TrinoBanner extends StatelessWidget {
  const TrinoBanner({super.key, required this.tone, required this.message, this.title, this.action});

  final BannerTone tone;
  final String message;

  /// A bold first line, such as "Nadie puede recuperarla".
  final String? title;

  /// Such as a "Comprobar código" button.
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (fill, iconColor, icon) = switch (tone) {
      BannerTone.info => (t.accentSoft, t.accentText, TrinoIcons.info),
      BannerTone.warn => (t.warnBg, t.warn, TrinoIcons.warning),
      BannerTone.danger => (t.dangerBg, t.danger, TrinoIcons.alertCircle),
    };
    return Semantics(
      container: true,
      liveRegion: tone == BannerTone.danger,
      child: DecoratedBox(
        decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(t.radius)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TrinoIcon(icon, size: 20, color: iconColor),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (title != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 2),
                        child: Text(
                          title!,
                          style: context.text.secondary.copyWith(color: t.ink, fontWeight: FontWeight.w700),
                        ),
                      ),
                    Text(message, style: context.text.secondary.copyWith(color: t.ink)),
                    if (action != null) Padding(padding: const EdgeInsets.only(top: 8), child: action),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
