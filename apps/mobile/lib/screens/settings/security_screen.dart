// Seguridad: two-step verification, auto-lock, and locking now.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/list_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class SecurityScreen extends StatefulWidget {
  const SecurityScreen({super.key});

  @override
  State<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends State<SecurityScreen> {
  late final Future<UnlockInfo> _info = context.engine.unlockInfo();

  static const _autoLockChoices = <int?>[1, 5, 15, 60, null];

  static String autoLockLabel(int? minutes, AppLocalizations l10n) => switch (minutes) {
    null => l10n.autoLockNever,
    60 => l10n.autoLockHour,
    _ => l10n.autoLockAfter(minutes),
  };

  Future<void> _chooseAutoLock(EngineSettings settings, SettingsUpdate update) => showModalBottomSheet<void>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SectionLabel(context.l10n.securityAutoLock),
          for (final minutes in _autoLockChoices)
            ChoiceRow(
              title: autoLockLabel(minutes, context.l10n),
              selected: settings.autoLockMinutes == minutes,
              onTap: () {
                update((current) => current.copyWith(autoLockMinutes: () => minutes));
                Navigator.of(sheet).pop();
              },
            ),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionSecurity,
      children: [
        FutureBuilder<UnlockInfo>(
          future: _info,
          builder: (context, snapshot) => ListRow(
            icon: TrinoIcons.shieldCheck,
            title: l10n.securityTwoStep,
            value: switch (snapshot.data?.totpEnabled) {
              true => l10n.twoStepOn,
              false => l10n.twoStepOff,
              null => null,
            },
          ),
        ),
        SettingsBuilder(
          builder: (context, settings, update) => ListRow(
            icon: TrinoIcons.clock,
            title: l10n.securityAutoLock,
            subtitle: l10n.securityAutoLockDesc,
            value: autoLockLabel(settings.autoLockMinutes, l10n),
            onTap: () => _chooseAutoLock(settings, update),
          ),
        ),
        ListRow(
          icon: TrinoIcons.lock,
          title: l10n.securityLockNow,
          chevron: false,
          onTap: () => unawaited(context.engine.lock()),
        ),
      ],
    );
  }
}
