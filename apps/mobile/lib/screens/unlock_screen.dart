// Desbloqueo: greets by name, says why it is locked, asks for the password
// (and the code, with two-step verification), and explains honestly what a
// forgotten password means.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/scope.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../ui/avatar.dart';
import '../ui/banner.dart';
import '../ui/button.dart';
import '../ui/text_field.dart';

class UnlockScreen extends StatefulWidget {
  const UnlockScreen({super.key});

  @override
  State<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends State<UnlockScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Future<UnlockInfo> _info = _engine.unlockInfo();
  final _pass = TextEditingController();
  final _code = TextEditingController();
  String? _error;
  var _busy = false;
  var _forgotOpen = false;

  @override
  void dispose() {
    _pass.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _unlock(UnlockInfo info) async {
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await _engine.unlock(_pass.text, code: info.totpEnabled ? _code.text.trim() : null);
      if (!mounted) return;
      setState(() {
        _error = switch (result) {
          UnlockResult.ok => null,
          UnlockResult.wrongPassphrase => l10n.unlockErrPass,
          UnlockResult.wrongPassphraseOrCode => l10n.unlockErrPassOrCode,
          UnlockResult.codeRequired => l10n.unlockCodeRequired,
        };
      });
    } on Object {
      if (mounted) setState(() => _error = l10n.unlockErrUnlock);
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

  static String _reason(UnlockInfo info, AppLocalizations l10n) => switch (info.reason) {
    LockReason.coldStart => l10n.unlockColdStart,
    LockReason.manual => l10n.unlockLockedManual,
    LockReason.idle => l10n.unlockLockedIdle(info.idleMinutes ?? 1),
  };

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = context.text;
    return Scaffold(
      body: SafeArea(
        child: FutureBuilder<UnlockInfo>(
          future: _info,
          builder: (context, snapshot) {
            final info = snapshot.data;
            if (info == null) return const SizedBox.expand();
            return ListView(
              padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
              children: [
                Center(child: TrinoAvatar(name: info.name, size: 72)),
                const SizedBox(height: 16),
                Semantics(
                  container: true,
                  header: true,
                  child: Text(l10n.unlockTitle(info.name), textAlign: TextAlign.center, style: text.headline),
                ),
                const SizedBox(height: 8),
                Text(_reason(info, l10n), textAlign: TextAlign.center, style: text.secondary),
                const SizedBox(height: 28),
                AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TrinoPasswordField(
                        controller: _pass,
                        label: l10n.unlockPassLabel,
                        showLabel: l10n.showPassword,
                        textInputAction: info.totpEnabled ? TextInputAction.next : TextInputAction.done,
                        onSubmitted: info.totpEnabled ? null : (_) => _unlock(info),
                      ),
                      if (info.totpEnabled) ...[
                        const SizedBox(height: 16),
                        TrinoTextField(
                          controller: _code,
                          label: l10n.unlockCodeLabel,
                          helper: l10n.unlockCodeHint,
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
                const SizedBox(height: 8),
                TrinoButton(
                  label: l10n.unlockForgot,
                  variant: ButtonVariant.ghost,
                  expand: true,
                  expanded: _forgotOpen,
                  onPressed: () => setState(() => _forgotOpen = !_forgotOpen),
                ),
                if (_forgotOpen) ...[
                  const SizedBox(height: 8),
                  Text(l10n.unlockForgotBody, style: text.body),
                  const SizedBox(height: 8),
                  Text(l10n.unlockForgotLoss, style: text.secondary),
                  const SizedBox(height: 16),
                  TrinoButton(
                    label: l10n.unlockWipe,
                    variant: ButtonVariant.danger,
                    expand: true,
                    onPressed: _busy ? null : () => unawaited(_wipe()),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}
