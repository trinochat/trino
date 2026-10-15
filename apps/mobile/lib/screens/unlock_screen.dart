// Desbloqueo: the wordmark and "Hola de nuevo", the same for everyone (no
// name, no photo: nothing personal shows before unlocking), why it is
// locked, the password (and the code, with two-step verification), and the
// fingerprint or Face ID when the engine allows it now and the phone has one.
// Errors are said in words under the field they are about, which takes the
// focus. "Borrar todo y empezar de nuevo…" stays small and grey at the
// bottom, and asks first, saying honestly what is lost.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/scope.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/banner.dart';
import '../ui/button.dart';
import '../ui/text_field.dart';

class UnlockScreen extends StatefulWidget {
  const UnlockScreen({super.key});

  @override
  State<UnlockScreen> createState() => _UnlockScreenState();
}

/// What the screen shows before anything is typed.
typedef _Gate = ({UnlockInfo info, bool biometric});

class _UnlockScreenState extends State<UnlockScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Future<_Gate> _gate = _load();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  final _passFocus = FocusNode();
  final _codeFocus = FocusNode();
  String? _passError;
  String? _codeError;

  /// Not about one field: the fingerprint, or the engine failing.
  String? _error;
  var _busy = false;

  @override
  void dispose() {
    _pass.dispose();
    _code.dispose();
    _passFocus.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  /// The fingerprint is offered only when the engine allows it now (never
  /// after a restart, with reinforced protection, or once the interval
  /// passed) and the phone has one set up.
  Future<_Gate> _load() async {
    final biometrics = context.biometrics;
    final info = await _engine.unlockInfo();
    final biometric = info.biometricAllowed && await biometrics.isAvailable();
    return (info: info, biometric: biometric);
  }

  void _clearErrors() {
    _passError = null;
    _codeError = null;
    _error = null;
  }

  Future<void> _unlock(UnlockInfo info) async {
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _clearErrors();
    });
    try {
      final result = await _engine.unlock(_pass.text, code: info.totpEnabled ? _code.text.trim() : null);
      if (!mounted) return;
      setState(() {
        switch (result) {
          case UnlockResult.ok:
            break;
          case UnlockResult.wrongPassphrase:
            _passError = l10n.unlockErrPass;
          case UnlockResult.wrongPassphraseOrCode:
            _passError = l10n.unlockErrPassOrCode;
          case UnlockResult.codeRequired:
            _codeError = l10n.unlockCodeRequired;
        }
      });
      if (_passError != null) _passFocus.requestFocus();
      if (_codeError != null) _codeFocus.requestFocus();
    } on Object {
      if (mounted) setState(() => _error = l10n.unlockErrUnlock);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlockWithBiometrics() async {
    final l10n = context.l10n;
    final biometrics = context.biometrics;
    setState(() {
      _busy = true;
      _clearErrors();
    });
    try {
      final opened = await biometrics.authenticate(l10n.unlockBiometricReason) && await _engine.unlockWithBiometrics();
      if (!opened && mounted) {
        setState(() => _error = l10n.unlockErrBiometric);
        _passFocus.requestFocus();
      }
    } on Object {
      if (mounted) setState(() => _error = l10n.unlockErrBiometric);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _wipe() async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => Dialog(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(container: true, header: true, child: Text(l10n.unlockWipeTitle, style: dialog.text.title)),
              const SizedBox(height: 8),
              Text(l10n.unlockWipeBody, style: dialog.text.body),
              const SizedBox(height: 8),
              Text(l10n.linkedWipeNote, style: dialog.text.secondary),
              const SizedBox(height: 20),
              TrinoButton(
                label: l10n.unlockWipeConfirm,
                variant: ButtonVariant.danger,
                expand: true,
                onPressed: () => Navigator.of(dialog).pop(true),
              ),
              const SizedBox(height: 8),
              TrinoButton(
                label: l10n.cancel,
                variant: ButtonVariant.ghost,
                expand: true,
                onPressed: () => Navigator.of(dialog).pop(false),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await _engine.wipe();
    } on Object {
      if (mounted) setState(() => _error = l10n.unlockErrWipe);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Why it is locked; after a manual lock or a restart, a plain line.
  static String _reason(UnlockInfo info, AppLocalizations l10n) => switch (info.reason) {
    LockReason.coldStart => l10n.unlockColdStart,
    LockReason.manual => l10n.unlockLockedManual,
    LockReason.idle => l10n.unlockLockedIdle(info.idleMinutes ?? 1),
    LockReason.reask => l10n.unlockReask,
  };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    return Scaffold(
      body: SafeArea(
        child: FutureBuilder<_Gate>(
          future: _gate,
          builder: (context, snapshot) {
            final gate = snapshot.data;
            if (gate == null) return const SizedBox.expand();
            final info = gate.info;
            return Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(24, 40, 24, 16),
                    children: [
                      ExcludeSemantics(
                        child: Text(t.wordmark, style: text.largeTitle.copyWith(color: t.accentText)),
                      ),
                      const SizedBox(height: 16),
                      Semantics(container: true, header: true, child: Text(l10n.unlockTitle, style: text.headline)),
                      const SizedBox(height: 8),
                      Text(_reason(info, l10n), style: text.secondary),
                      const SizedBox(height: 24),
                      AutofillGroup(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            TrinoPasswordField(
                              controller: _pass,
                              focusNode: _passFocus,
                              label: l10n.unlockPassLabel,
                              showLabel: l10n.showPassword,
                              error: _passError,
                              textInputAction: info.totpEnabled ? TextInputAction.next : TextInputAction.done,
                              onSubmitted: info.totpEnabled ? null : (_) => _unlock(info),
                            ),
                            if (info.totpEnabled) ...[
                              const SizedBox(height: 16),
                              TrinoTextField(
                                controller: _code,
                                focusNode: _codeFocus,
                                label: l10n.unlockCodeLabel,
                                helper: l10n.unlockCodeHint,
                                error: _codeError,
                                mono: true,
                                keyboardType: TextInputType.number,
                                textInputAction: TextInputAction.done,
                                autofillHints: const [AutofillHints.oneTimeCode],
                                inputFormatters: [
                                  FilteringTextInputFormatter.digitsOnly,
                                  LengthLimitingTextInputFormatter(6),
                                ],
                                onSubmitted: (_) => _unlock(info),
                              ),
                            ],
                          ],
                        ),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 16),
                        TrinoBanner(tone: BannerTone.danger, message: _error!),
                      ],
                      const SizedBox(height: 20),
                      TrinoButton(
                        label: _busy ? l10n.unlockUnlocking : l10n.unlockSubmit,
                        variant: ButtonVariant.primary,
                        expand: true,
                        loading: _busy,
                        onPressed: () => unawaited(_unlock(info)),
                      ),
                      if (gate.biometric) ...[
                        const SizedBox(height: 8),
                        TrinoButton(
                          label: l10n.unlockBiometric,
                          expand: true,
                          onPressed: _busy ? null : () => unawaited(_unlockWithBiometrics()),
                        ),
                      ],
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
                  child: TrinoButton(
                    label: l10n.unlockWipe,
                    variant: ButtonVariant.quiet,
                    onPressed: _busy ? null : () => unawaited(_wipe()),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
