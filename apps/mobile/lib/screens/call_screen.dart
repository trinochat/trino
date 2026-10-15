// A call, full screen. At the top, the key, small: "Clave" and the first
// symbols of the call's SAS v2 as outline icons. Tapping it opens "Comparen la
// clave" with the 7 symbols and their words, "Coinciden" and "No coinciden";
// once matched, the key reads "Verificada". Under the name, the time and how
// the call travels in words: "Por el servidor de llamadas", which needs no
// note, or, if a direct path ever shows up, "Conexión directa", which explains
// on a tap that the other person sees your IP. At the bottom, the controls.
//
// Before it connects there is no key yet (it comes from the connection) and no
// time: a call you make says "Llamando…" with the controls, and one that rings
// in says "te está llamando por Trino" with Rechazar (the danger edge, as
// Colgar) and Contestar (filled with the accent).
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
import '../ui/sas_symbol.dart';

class CallScreen extends StatefulWidget {
  const CallScreen({super.key});

  static Route<void> route() => MaterialPageRoute(fullscreenDialog: true, builder: (_) => const CallScreen());

  static const keyPillKey = ValueKey('call-key-pill');
  static const keyDialogKey = ValueKey('call-key-dialog');
  static const connectionKey = ValueKey('call-connection');

  /// How many symbols the small key shows; the dialog shows all 7.
  static const keyPreviewLength = 4;

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  late final TrinoEngine _engine = context.engine;
  StreamSubscription<CallSession?>? _subscription;

  /// The call, for this screen and for the comparison dialog above it.
  final _call = ValueNotifier<CallSession?>(null);
  var _dialogOpen = false;
  var _noteOpen = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= _engine.call.listen(_onCall);
  }

  void _onCall(CallSession? call) {
    if (!mounted) return;
    if (call == null) {
      // The call ended: back to where it started, closing the comparison first.
      if (_call.value != null) {
        final navigator = Navigator.of(context);
        if (_dialogOpen) navigator.pop();
        navigator.pop();
      }
      return;
    }
    _call.value = call;
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    _call.dispose();
    super.dispose();
  }

  Future<void> _openKey() async {
    setState(() => _noteOpen = false);
    _dialogOpen = true;
    await showDialog<void>(
      context: context,
      builder: (context) => ValueListenableBuilder<CallSession?>(
        valueListenable: _call,
        builder: (context, call, _) => call == null
            ? const SizedBox.shrink()
            : _KeyDialog(
                key: CallScreen.keyDialogKey,
                call: call,
                onAnswer: ({required matches}) {
                  unawaited(_engine.confirmSas(matches: matches));
                  if (matches) Navigator.of(context).pop();
                },
              ),
      ),
    );
    _dialogOpen = false;
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<CallSession?>(
    valueListenable: _call,
    builder: (context, call, _) {
      final t = context.tokens;
      if (call == null) return Scaffold(backgroundColor: t.bg, body: const SizedBox.expand());
      final l10n = context.l10n;
      final connected = call.phase == CallPhase.connected;
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
                  if (connected)
                    _KeyPill(key: CallScreen.keyPillKey, call: call, onTap: _openKey)
                  else
                    const SizedBox(height: 48),
                  Expanded(
                    child: LayoutBuilder(
                      builder: (context, viewport) => SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                        child: ConstrainedBox(
                          constraints: BoxConstraints(minHeight: viewport.maxHeight - 24),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              TrinoAvatar(name: call.peerName, size: 120),
                              const SizedBox(height: 20),
                              Text(call.peerName, textAlign: TextAlign.center, style: context.text.headline),
                              const SizedBox(height: 4),
                              if (connected)
                                _PathLine(
                                  call: call,
                                  open: _noteOpen,
                                  onTap: () => setState(() => _noteOpen = !_noteOpen),
                                )
                              else
                                _RingingLine(call: call),
                              if (connected && _noteOpen && call.path == CallPath.direct)
                                _DirectNote(peerName: call.peerName),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (call.phase == CallPhase.incoming)
                    _AnswerControls(engine: _engine)
                  else
                    _Controls(call: call, engine: _engine),
                  const SizedBox(height: 16),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

/// "Clave" and the first symbols, small; "Verificada" once matched. A plain
/// bordered box, as the desktop's key: no colour carries the state.
class _KeyPill extends StatelessWidget {
  const _KeyPill({super.key, required this.call, required this.onTap});

  final CallSession call;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final l10n = context.l10n;
    return SasTableBuilder(
      // Holds the place while the table loads, so nothing jumps.
      placeholder: const SizedBox(height: 48),
      builder: (context, table) {
        final words = table.words(call.sas, Localizations.localeOf(context).languageCode).join(', ');
        return Semantics(
          container: true,
          button: true,
          label: call.verified ? l10n.callKeyVerified : l10n.callKeyClosed(words, call.peerName),
          onTap: onTap,
          child: ExcludeSemantics(
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(t.radius),
                child: Padding(
                  // A 48 dp target around a slimmer box.
                  padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: t.surface,
                      border: Border.all(color: t.line),
                      borderRadius: BorderRadius.circular(t.radius),
                    ),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 40),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            if (call.verified) ...[
                              TrinoIcon(TrinoIcons.check, size: 16, color: t.accentText),
                              const SizedBox(width: 6),
                              Text(
                                l10n.callVerified,
                                style: context.text.secondary.copyWith(
                                  color: t.accentText,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ] else ...[
                              Text(l10n.callKeyLabel, style: context.text.secondary),
                              const SizedBox(width: 8),
                              for (final index in call.sas.take(CallScreen.keyPreviewLength))
                                Padding(
                                  padding: const EdgeInsets.symmetric(horizontal: 3),
                                  child: SasIcon(symbol: table.symbol(index), size: 16),
                                ),
                            ],
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
      },
    );
  }
}

/// "Comparen la clave": the 7 symbols with their words, read aloud by both
/// people. "No coinciden" keeps it open with the warning; the last answer
/// counts.
class _KeyDialog extends StatelessWidget {
  const _KeyDialog({super.key, required this.call, required this.onAnswer});

  final CallSession call;
  final void Function({required bool matches}) onAnswer;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final l10n = context.l10n;
    return Dialog(
      backgroundColor: t.surface,
      surfaceTintColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(t.radiusLg),
        side: BorderSide(color: t.line),
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(container: true, header: true, child: Text(l10n.keyCompareTitle, style: text.title)),
            const SizedBox(height: 8),
            if (call.mismatch)
              TrinoBanner(tone: BannerTone.danger, message: l10n.keyMismatchAlert)
            else
              Text(l10n.keyCompareBody, style: text.secondary),
            const SizedBox(height: 16),
            SasTableBuilder(
              builder: (context, table) => Semantics(
                container: true,
                label: l10n.keyList,
                explicitChildNodes: true,
                child: Wrap(
                  alignment: WrapAlignment.center,
                  spacing: 4,
                  runSpacing: 12,
                  children: [
                    for (final index in call.sas)
                      ConstrainedBox(
                        constraints: const BoxConstraints(minWidth: 64),
                        child: SasSymbolTile(symbol: table.symbol(index)),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),
            TrinoButton(
              label: l10n.keyMatch,
              variant: ButtonVariant.primary,
              expand: true,
              onPressed: () => onAnswer(matches: true),
            ),
            const SizedBox(height: 8),
            TrinoButton(
              label: l10n.keyMismatch,
              variant: ButtonVariant.secondary,
              expand: true,
              onPressed: () => onAnswer(matches: false),
            ),
          ],
        ),
      ),
    );
  }
}

/// "04:12 · Por el servidor de llamadas": the time and how the call travels,
/// as plain text. Only a direct path, which shows your IP, can be tapped for
/// its note.
class _PathLine extends StatelessWidget {
  const _PathLine({required this.call, required this.open, required this.onTap});

  final CallSession call;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final l10n = context.l10n;
    final style = text.secondary.copyWith(fontSize: 15);
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(formatDuration(call.elapsed), style: text.mono.copyWith(fontSize: 15)),
        ExcludeSemantics(child: Text('  ·  ', style: text.secondary)),
        switch (call.path) {
          CallPath.relay => Text(l10n.callRelay, textAlign: TextAlign.center, style: style),
          CallPath.direct => Semantics(
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
                        l10n.callDirect,
                        style: style.copyWith(
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
        },
      ],
    );
  }
}

/// "Llamando…", or "te está llamando por Trino" after the name, read out as
/// it changes.
class _RingingLine extends StatelessWidget {
  const _RingingLine({required this.call});

  final CallSession call;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = call.phase == CallPhase.calling
        ? l10n.callCalling
        : call.camera
        ? l10n.callRingingInVideo
        : l10n.callRingingIn;
    return Semantics(
      container: true,
      liveRegion: true,
      label: call.phase == CallPhase.calling ? text : '${call.peerName} $text',
      child: ExcludeSemantics(
        child: Text(text, textAlign: TextAlign.center, style: context.text.secondary.copyWith(fontSize: 15)),
      ),
    );
  }
}

class _DirectNote extends StatelessWidget {
  const _DirectNote({required this.peerName});

  final String peerName;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
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
            child: Text(context.l10n.callDirectNote(peerName), style: context.text.secondary.copyWith(color: t.ink)),
          ),
        ),
      ),
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
          _Control(
            icon: TrinoIcons.hangUp,
            label: l10n.callHangUp,
            variant: IconButtonVariant.dangerSoft,
            onPressed: engine.hangUp,
          ),
        ],
      ),
    );
  }
}

/// Rechazar and Contestar, while a call rings in.
class _AnswerControls extends StatelessWidget {
  const _AnswerControls({required this.engine});

  final TrinoEngine engine;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 24),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Control(
            icon: TrinoIcons.hangUp,
            label: l10n.callReject,
            variant: IconButtonVariant.dangerSoft,
            onPressed: engine.rejectCall,
          ),
          _Control(
            icon: TrinoIcons.phone,
            label: l10n.callAnswer,
            variant: IconButtonVariant.primary,
            onPressed: engine.answerCall,
          ),
        ],
      ),
    );
  }
}

class _Control extends StatelessWidget {
  const _Control({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.pressed,
    this.variant = IconButtonVariant.secondary,
  });

  final TrinoIcons icon;
  final String label;
  final VoidCallback onPressed;

  /// Null for the buttons that are no toggle: Colgar, Rechazar, Contestar.
  final bool? pressed;

  /// Secondary for the toggles; dangerSoft for hanging up or rejecting
  /// (its word in danger); primary for answering (its word in the accent).
  final IconButtonVariant variant;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final wordColor = switch (variant) {
      IconButtonVariant.dangerSoft => t.danger,
      IconButtonVariant.primary => t.accentText,
      _ => t.ink,
    };
    return Expanded(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TrinoIconButton(
            icon: icon,
            label: label,
            circle: true,
            size: 64,
            variant: variant,
            pressed: pressed,
            onPressed: onPressed,
          ),
          const SizedBox(height: 6),
          ExcludeSemantics(
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: context.text.caption.copyWith(color: wordColor, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
