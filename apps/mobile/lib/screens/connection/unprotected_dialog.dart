// "¿Conectar sin protección?": asked every time, with Cancelar as the primary
// button. Nothing is remembered: the engine connects without Tor only until
// Trino closes.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/theme.dart';
import '../../ui/button.dart';

/// Asks, and connects without Tor only if the user confirms. Says whether it
/// did.
Future<bool> confirmUnprotected(BuildContext context) async {
  final l10n = context.l10n;
  final engine = context.engine;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialog) => Dialog(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(container: true, header: true, child: Text(l10n.unprotectedTitle, style: dialog.text.title)),
            const SizedBox(height: 8),
            Text(l10n.unprotectedBody, style: dialog.text.body),
            const SizedBox(height: 20),
            TrinoButton(
              label: l10n.cancel,
              variant: ButtonVariant.primary,
              expand: true,
              onPressed: () => Navigator.of(dialog).pop(false),
            ),
            const SizedBox(height: 8),
            TrinoButton(
              label: l10n.unprotectedConfirm,
              variant: ButtonVariant.ghost,
              expand: true,
              onPressed: () => Navigator.of(dialog).pop(true),
            ),
          ],
        ),
      ),
    ),
  );
  if (confirmed != true) return false;
  unawaited(engine.connectUnprotected());
  return true;
}
