// A call, full screen. At the top, a small pill with the seven emojis of the
// call's key: tapping it opens the comparison ("Compara estos emojis con
// Ana"), and once both say they match it reads "Verificada". Under the name,
// the time and "Conexión directa" as plain text; tapping that explains that
// the other person sees your IP. At the bottom, the controls.
import 'dart:async';

import 'package:flutter/material.dart';

import '../app/format.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/avatar.dart';
import '../ui/banner.dart';
import '../ui/button.dart';
import '../ui/icon_button.dart';

class CallScreen extends StatefulWidget {
  const CallScreen({super.key});

  static Route<void> route() => MaterialPageRoute(fullscreenDialog: true, builder: (_) => const CallScreen());

  static const keyPillKey = ValueKey('call-key-pill');
  static const connectionKey = ValueKey('call-connection');

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final TrinoEngine _engine = context.engine;
  StreamSubscription<CallSession?>? _subscription;
  CallSession? _call;
  var _keyOpen = false;
  var _noteOpen = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= _engine.call.listen(_onCall);
  }

  void _onCall(CallSession? call) {
    if (!mounted) return;
    if (call == null) {
      // The call ended: back to where it started.
      if (_call != null) Navigator.of(context).pop();
      return;
    }
    setState(() => _call = call);
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }

  void _answerKey({required bool matches}) {
    unawaited(_engine.confirmSas(matches: matches));
    if (matches) setState(() => _keyOpen = false);
  }

  @override
  Widget build(BuildContext context) {
    final call = _call;
    final t = context.tokens;
    if (call == null) return Scaffold(backgroundColor: t.bg, body: const SizedBox.expand());
    final l10n = context.l10n;
    return PopScope(
      // A call ends with "Colgar", not with the back gesture.
      canPop: false,
      child: Semantics(
        label: l10n.callWith(call.peerName),
        explicitChildNodes: true,
        child: Scaffold(
          backgroundColor: t.bg,
          body: SafeArea(
            child: Column(
              children: [
                const SizedBox(height: 8),
                _KeyPill(
                  key: CallScreen.keyPillKey,
                  call: call,
                  open: _keyOpen,
                  onTap: () => setState(() {
                    _keyOpen = !_keyOpen;
                    _noteOpen = false;
                  }),
                ),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, viewport) => SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                      child: ConstrainedBox(
                        // Centred in the room left while the panel is closed.
                        constraints: BoxConstraints(minHeight: viewport.maxHeight - 24),
                        child: Column(
                          mainAxisAlignment: _keyOpen ? MainAxisAlignment.start : MainAxisAlignment.center,
                          children: [
                            if (_keyOpen)
                              _KeyPanel(call: call, onAnswer: _answerKey)
                            else
                              TrinoAvatar(name: call.peerName, size: 120),
                            const SizedBox(height: 20),
                            Text(call.peerName, textAlign: TextAlign.center, style: context.text.headline),
                            const SizedBox(height: 4),
                            _ConnectionLine(
                              call: call,
                              open: _noteOpen,
                              onTap: () => setState(() {
                                _noteOpen = !_noteOpen;
                                _keyOpen = false;
                              }),
                            ),
                            if (_noteOpen)
                              Padding(
                                padding: const EdgeInsets.only(top: 8),
                                child: Semantics(
                                  container: true,
                                  liveRegion: true,
                                  child: DecoratedBox(
                                    decoration: BoxDecoration(
                                      color: t.surface,
                                      border: Border.all(color: t.line),
                                      borderRadius: BorderRadius.circular(t.radius),
                                    ),
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                                      child: Text(
                                        l10n.callDirectNote(call.peerName),
                                        style: context.text.secondary.copyWith(color: t.ink),
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
                ),
                _Controls(call: call, engine: _engine),
                const SizedBox(height: 16),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _KeyPill extends StatelessWidget {
  const _KeyPill({super.key, required this.call, required this.open, required this.onTap});

  final CallSession call;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final l10n = context.l10n;
    final label = call.verified ? l10n.callKeyVerified : l10n.callKeyClosed(call.peerName);
    return Semantics(
      container: true,
      button: true,
      expanded: open,
      label: label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            customBorder: const StadiumBorder(),
            child: Padding(
              // A 48 dp target around a slimmer pill.
              padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
              child: DecoratedBox(
                decoration: ShapeDecoration(
                  color: t.surface,
                  shape: StadiumBorder(side: BorderSide(color: t.line)),
                ),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 40),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 4, 10, 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (call.verified) ...[
                          TrinoIcon(TrinoIcons.check, size: 16, color: t.accentText),
                          const SizedBox(width: 6),
                          Text(
                            l10n.callVerified,
                            style: context.text.secondary.copyWith(color: t.accentText, fontWeight: FontWeight.w700),
                          ),
                        ] else
                          for (final symbol in call.sas)
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 1.5),
                              child: Text(
                                symbol.emoji,
                                style: const TextStyle(fontSize: 17, height: 1.2, fontFamilyFallback: kEmojiFallback),
                              ),
                            ),
                        const SizedBox(width: 6),
                        TrinoIcon(open ? TrinoIcons.chevronUp : TrinoIcons.chevronDown, size: 16, color: t.muted),
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

class _KeyPanel extends StatelessWidget {
  const _KeyPanel({required this.call, required this.onAnswer});

  final CallSession call;
  final void Function({required bool matches}) onAnswer;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final l10n = context.l10n;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: t.surface,
        border: Border.all(color: t.line),
        borderRadius: BorderRadius.circular(t.radiusLg),
        boxShadow: t.shadow,
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              container: true,
              header: true,
              child: Text(l10n.keyCompareTitle(call.peerName), style: text.bodyStrong),
            ),
            const SizedBox(height: 6),
            if (call.mismatch)
              TrinoBanner(tone: BannerTone.danger, message: l10n.keyMismatchAlert)
            else
              Text(l10n.keyCompareBody(call.peerName), style: text.secondary),
            const SizedBox(height: 16),
            Semantics(
              container: true,
              label: l10n.keyList,
              explicitChildNodes: true,
              child: Wrap(
                alignment: WrapAlignment.center,
                spacing: 10,
                runSpacing: 12,
                children: [
                  for (final symbol in call.sas)
                    ConstrainedBox(
                      constraints: const BoxConstraints(minWidth: 56),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // Screen readers read the words; emoji names would differ by phone.
                          ExcludeSemantics(
                            child: Text(
                              symbol.emoji,
                              style: const TextStyle(fontSize: 26, height: 1.2, fontFamilyFallback: kEmojiFallback),
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            context.l10n.sasWord(symbol.id),
                            textAlign: TextAlign.center,
                            style: text.caption.copyWith(color: t.ink, fontWeight: FontWeight.w600),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: TrinoButton(
                    label: l10n.keyMatch,
                    variant: ButtonVariant.primary,
                    expand: true,
                    onPressed: () => onAnswer(matches: true),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TrinoButton(
                    label: l10n.keyMismatch,
                    variant: ButtonVariant.danger,
                    expand: true,
                    onPressed: () => onAnswer(matches: false),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// "03:21 · Conexión directa": the time, and the path of the call as plain
/// text that explains itself when tapped.
class _ConnectionLine extends StatelessWidget {
  const _ConnectionLine({required this.call, required this.open, required this.onTap});

  final CallSession call;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(formatDuration(call.elapsed), style: text.mono.copyWith(fontSize: 15)),
        ExcludeSemantics(child: Text('  ·  ', style: text.secondary)),
        Semantics(
          key: CallScreen.connectionKey,
          container: true,
          button: true,
          expanded: open,
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(t.radius),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Center(
                    widthFactor: 1,
                    child: Text(
                      context.l10n.callDirect,
                      style: text.secondary.copyWith(
                        fontSize: 15,
                        decoration: TextDecoration.underline,
                        decorationStyle: TextDecorationStyle.dotted,
                        decorationColor: t.muted,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({required this.call, required this.engine});

  final CallSession call;
  final TrinoEngine engine;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Control(
            icon: call.muted ? TrinoIcons.micOff : TrinoIcons.mic,
            label: l10n.callMute,
            pressed: call.muted,
            onPressed: () => engine.setMuted(!call.muted),
          ),
          _Control(
            icon: TrinoIcons.speaker,
            label: l10n.callSpeaker,
            pressed: call.speaker,
            onPressed: () => engine.setSpeaker(!call.speaker),
          ),
          _Control(
            icon: call.camera ? TrinoIcons.video : TrinoIcons.videoOff,
            label: l10n.callCamera,
            pressed: call.camera,
            onPressed: () => engine.setCamera(!call.camera),
          ),
          _Control(icon: TrinoIcons.hangUp, label: l10n.callHangUp, onPressed: engine.hangUp),
        ],
      ),
    );
  }
}

class _Control extends StatelessWidget {
  const _Control({required this.icon, required this.label, required this.onPressed, this.pressed});

  final TrinoIcons icon;
  final String label;
  final VoidCallback onPressed;

  /// Null for the hang-up button, which is no toggle.
  final bool? pressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final hangUp = pressed == null;
    return Expanded(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TrinoIconButton(
            icon: icon,
            label: label,
            circle: true,
            size: 64,
            variant: hangUp ? IconButtonVariant.dangerSolid : IconButtonVariant.secondary,
            pressed: pressed,
            onPressed: onPressed,
          ),
          const SizedBox(height: 6),
          ExcludeSemantics(
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: context.text.caption.copyWith(color: hangUp ? t.danger : t.ink, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
