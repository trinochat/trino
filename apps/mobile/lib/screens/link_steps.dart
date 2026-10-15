// The pieces of "Ya uso Trino en mi computador", the linking of this phone to
// the computer that holds the account. The first run owns the steps and the
// engine calls; these draw them:
//
// - the instructions: the two devices, three short steps and one action;
// - the scanner, dark like a camera, with the warning against codes that
//   arrive by chat (the trick used against Signal) and, in the demo, an
//   action that says it is one;
// - the code: the six digits the computer shows too, the switch to bring the
//   chats (changeable only while waiting) and the state in words;
// - linked: what changed for your contacts, and the chats arriving.
//
// The phone never confirms by itself: the confirmation happens on the
// computer, and this phone only waits for it.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/button.dart';
import '../ui/icon_button.dart';
import '../ui/switch_row.dart';

/// The header of a linking step: back, when there is somewhere to go, and
/// "Vincular con tu computador".
class LinkStepBar extends StatelessWidget {
  const LinkStepBar({super.key, required this.title, this.onBack});

  final String title;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: context.tokens.line)),
    ),
    child: Padding(
      padding: EdgeInsets.fromLTRB(onBack == null ? 20 : 4, 4, 16, 4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Row(
          children: [
            if (onBack != null) ...[
              TrinoIconButton(icon: TrinoIcons.back, label: context.l10n.back, onPressed: onBack),
              const SizedBox(width: 4),
            ],
            Expanded(
              child: Semantics(container: true, header: true, child: Text(title, style: context.text.title)),
            ),
          ],
        ),
      ),
    ),
  );
}

/// How to start: this phone and the computer, and what to do on each.
class LinkInstructions extends StatelessWidget {
  const LinkInstructions({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    final path = l10n.linkStep2Path;
    final step2 = l10n.linkStep2(path);
    final at = step2.indexOf(path);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 8),
        ExcludeSemantics(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TrinoIcon(TrinoIcons.smartphone, size: 40, color: t.accentText),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: SizedBox(width: 40, height: 2, child: ColoredBox(color: t.line)),
              ),
              TrinoIcon(TrinoIcons.laptop, size: 40, color: t.accentText),
            ],
          ),
        ),
        const SizedBox(height: 28),
        _NumberedStep(number: 1, child: Text(l10n.linkStep1, style: text.body)),
        _NumberedStep(
          number: 2,
          child: Text.rich(
            TextSpan(
              style: text.body,
              children: at < 0
                  ? [TextSpan(text: step2)]
                  : [
                      TextSpan(text: step2.substring(0, at)),
                      TextSpan(
                        text: path,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(text: step2.substring(at + path.length)),
                    ],
            ),
          ),
        ),
        _NumberedStep(number: 3, child: Text(l10n.linkStep3, style: text.body)),
        const SizedBox(height: 8),
        Text(l10n.linkNote, style: text.secondary),
      ],
    );
  }
}

class _NumberedStep extends StatelessWidget {
  const _NumberedStep({required this.number, required this.child});

  final int number;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: t.accentSoft, shape: BoxShape.circle),
              child: Text(
                '$number',
                semanticsLabel: '$number.',
                style: context.text.caption.copyWith(color: t.accentText, fontWeight: FontWeight.w700),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Padding(padding: const EdgeInsets.only(top: 1), child: child),
            ),
          ],
        ),
      ),
    );
  }
}

/// The scanner, dark whatever the theme, like the camera it stands for.
class LinkScanPage extends StatelessWidget {
  const LinkScanPage({super.key, required this.onClose, this.error, this.onSimulate});

  final VoidCallback onClose;

  /// The last code read was not for linking: said in words.
  final String? error;

  /// Only the demo scanner: a clearly labelled "simulate" action.
  final VoidCallback? onSimulate;

  @override
  Widget build(BuildContext context) => Theme(
    data: AppScope.of(context).appearance.darkTheme,
    child: Builder(builder: _page),
  );

  Widget _page(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    final preview = context.scanner.preview(context);
    final error = this.error;
    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 4, 16, 4),
              child: Row(
                children: [
                  TrinoIconButton(icon: TrinoIcons.close, label: l10n.close, onPressed: onClose),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Semantics(container: true, header: true, child: Text(l10n.linkScanTitle, style: text.title)),
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(32, 24, 32, 24),
                child: Column(
                  children: [
                    ExcludeSemantics(
                      child: SizedBox.square(
                        dimension: 232,
                        child: CustomPaint(
                          foregroundPainter: _ViewfinderPainter(color: t.accentText),
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(t.radius),
                              child: preview ?? Center(child: TrinoIcon(TrinoIcons.qr, size: 88, color: t.line)),
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(l10n.linkScanAim, textAlign: TextAlign.center, style: text.bodyStrong),
                    const SizedBox(height: 12),
                    Text(l10n.linkScanWarning, textAlign: TextAlign.center, style: text.secondary),
                    if (error != null) ...[
                      const SizedBox(height: 16),
                      Semantics(
                        container: true,
                        liveRegion: true,
                        child: Text(
                          error,
                          textAlign: TextAlign.center,
                          style: text.secondary.copyWith(color: t.danger, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ],
                    if (onSimulate != null) ...[
                      const SizedBox(height: 24),
                      Text(l10n.linkScanDemoNote, textAlign: TextAlign.center, style: text.caption),
                      const SizedBox(height: 8),
                      TrinoButton(label: l10n.linkScanDemo, onPressed: onSimulate),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The accent corners of the viewfinder.
class _ViewfinderPainter extends CustomPainter {
  _ViewfinderPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const arm = 32.0;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round;
    final w = size.width;
    final h = size.height;
    for (final (corner, dx, dy) in [
      (Offset.zero, 1.0, 1.0),
      (Offset(w, 0), -1.0, 1.0),
      (Offset(0, h), 1.0, -1.0),
      (Offset(w, h), -1.0, -1.0),
    ]) {
      final at = corner + Offset(dx * 1.5, dy * 1.5);
      canvas
        ..drawLine(at, at + Offset(dx * arm, 0), paint)
        ..drawLine(at, at + Offset(0, dy * arm), paint);
    }
  }

  @override
  bool shouldRepaint(_ViewfinderPainter old) => old.color != color;
}

/// The code the computer shows too, the switch to bring the chats, and where
/// the linking stands, in words.
class LinkConfirmation extends StatelessWidget {
  const LinkConfirmation({super.key, required this.session, required this.onBringChats});

  final LinkSession session;
  final ValueChanged<bool> onBringChats;

  static String? failureText(LinkFailure? failure, AppLocalizations l10n) => switch (failure) {
    LinkFailure.expired => l10n.linkFailedExpired,
    LinkFailure.cancelled => l10n.linkFailedCancelled,
    LinkFailure.rejected => l10n.linkFailedRejected,
    null => null,
  };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    final waiting = session.status == LinkStatus.waitingForConfirmation;
    final failed = session.status == LinkStatus.failed;
    final digits = session.code.replaceAll(' ', '');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(container: true, header: true, child: Text(l10n.linkConfirmTitle, style: text.headline)),
        const SizedBox(height: 20),
        Center(
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: t.surface,
              border: Border.all(color: t.line),
              borderRadius: BorderRadius.circular(t.radiusLg),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              child: Text(
                session.code,
                // Read digit by digit, as they are compared.
                semanticsLabel: digits.split('').join(' '),
                style: text.code.copyWith(fontSize: 34, fontWeight: FontWeight.w700, letterSpacing: 4),
              ),
            ),
          ),
        ),
        const SizedBox(height: 20),
        Text(l10n.linkConfirmBody, style: text.body),
        const SizedBox(height: 20),
        Material(
          color: t.surface,
          clipBehavior: Clip.antiAlias,
          shape: RoundedRectangleBorder(
            side: BorderSide(color: t.line),
            borderRadius: BorderRadius.circular(t.radiusLg),
          ),
          child: SwitchRow(
            title: l10n.linkBringChats,
            description: l10n.linkBringChatsDesc,
            value: session.bringChats,
            onChanged: waiting ? onBringChats : null,
          ),
        ),
        const SizedBox(height: 16),
        Semantics(
          container: true,
          liveRegion: true,
          child: failed
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: TrinoIcon(TrinoIcons.alertCircle, size: 18, color: t.danger),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        failureText(session.failure, l10n) ?? '',
                        style: text.secondary.copyWith(color: t.danger, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                )
              : Text(l10n.linkWaiting, style: text.secondary),
        ),
      ],
    );
  }
}

/// Linked: what changed for your contacts, and the chats arriving.
class LinkDone extends StatelessWidget {
  const LinkDone({super.key, required this.session});

  final LinkSession? session;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = context.text;
    final progress = session?.bringChats == true ? session?.chatsProgress : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(container: true, header: true, child: Text(l10n.linkDoneTitle, style: text.headline)),
        const SizedBox(height: 8),
        Text(l10n.linkDoneBody, style: text.body.copyWith(color: context.tokens.muted)),
        if (progress != null) ...[
          const SizedBox(height: 20),
          Semantics(
            container: true,
            liveRegion: true,
            child: Text(
              progress >= 100 ? l10n.linkChatsDone : l10n.linkChatsProgress(progress),
              style: text.bodyStrong,
            ),
          ),
        ],
      ],
    );
  }
}
