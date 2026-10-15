// Cuenta y seguridad: the auto-lock ("Al dejar de usar Trino") and two-step
// verification; the optional fingerprint or Face ID with how often the
// password (and the code) is asked anyway; Protección reforzada, which takes
// the fingerprint away; and locking now.
//
// The interval only shows while the fingerprint is on: without it the
// password is asked every time, so there is nothing to choose.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../../ui/switch_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class AccountSecurityScreen extends StatefulWidget {
  const AccountSecurityScreen({super.key});

  @override
  State<AccountSecurityScreen> createState() => _AccountSecurityScreenState();
}

class _AccountSecurityScreenState extends State<AccountSecurityScreen> {
  late final Future<UnlockInfo> _info = context.engine.unlockInfo();
  late final Future<bool> _biometricsAvailable = context.biometrics.isAvailable();

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
        crossAxisAlignment: CrossAxisAlignment.stretch,
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
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
            child: Text(context.l10n.securityAutoLockDesc, style: context.text.caption),
          ),
        ],
      ),
    ),
  );

  Future<void> _chooseReask(EngineSettings settings, SettingsUpdate update, {required bool withCode}) {
    final l10n = context.l10n;
    return showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
              child: Semantics(
                container: true,
                header: true,
                child: Text(withCode ? l10n.securityReask : l10n.securityReaskPassword, style: sheet.text.title),
              ),
            ),
            for (final interval in ReaskInterval.values)
              ChoiceRow(
                title: reaskLabel(interval, l10n),
                subtitle: switch (interval) {
                  ReaskInterval.threeDays => l10n.reaskRecommended,
                  ReaskInterval.week => l10n.reaskLongest,
                  ReaskInterval.day => null,
                },
                selected: settings.reaskInterval == interval,
                onTap: () {
                  update((current) => current.copyWith(reaskInterval: interval));
                  Navigator.of(sheet).pop();
                },
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Text(withCode ? l10n.reaskNote : l10n.reaskNotePassword, style: sheet.text.caption),
            ),
          ],
        ),
      ),
    );
  }

  /// The phone confirms it is you before the fingerprint can open Trino.
  Future<void> _setBiometric(bool on, SettingsUpdate update) async {
    final l10n = context.l10n;
    if (on && !await context.biometrics.authenticate(l10n.securityBiometricReason)) {
      if (mounted) showNotice(context, l10n.securityBiometricNotConfirmed);
      return;
    }
    update((current) => current.copyWith(biometricUnlock: on));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionAccountSecurity,
      children: [
        FutureBuilder<UnlockInfo>(
          future: _info,
          builder: (context, info) => FutureBuilder<bool>(
            future: _biometricsAvailable,
            builder: (context, available) => SettingsBuilder(
              builder: (context, settings, update) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SizedBox(height: 8),
                  SettingsGroup(
                    children: [
                      ListRow(
                        icon: TrinoIcons.lock,
                        title: l10n.securityAutoLock,
                        subtitle: l10n.securityAutoLockWhen,
                        value: autoLockLabel(settings.autoLockMinutes, l10n),
                        onTap: () => _chooseAutoLock(settings, update),
                      ),
                      ListRow(
                        icon: TrinoIcons.shieldCheck,
                        title: l10n.securityTwoStep,
                        value: switch (info.data?.totpEnabled) {
                          true => l10n.twoStepOn,
                          false => l10n.twoStepOff,
                          null => null,
                        },
                      ),
                    ],
                  ),
                  if (settings.reinforcedProtection)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                      child: Text(l10n.securityReinforcedNote, style: context.text.secondary),
                    )
                  else
                    _biometricGroup(
                      settings,
                      update,
                      available: available.data,
                      withCode: info.data?.totpEnabled ?? false,
                    ),
                  SettingsGroup(
                    children: [
                      SwitchRow(
                        title: l10n.securityReinforced,
                        description: l10n.securityReinforcedDesc,
                        value: settings.reinforcedProtection,
                        onChanged: (on) => update((current) => current.copyWith(reinforcedProtection: on)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: TrinoButton(
            label: l10n.securityLockNow,
            expand: true,
            onPressed: () => unawaited(context.engine.lock()),
          ),
        ),
      ],
    );
  }

  /// The fingerprint switch, and the interval while it is on. [available] is
  /// null while the phone has not answered.
  Widget _biometricGroup(
    EngineSettings settings,
    SettingsUpdate update, {
    required bool? available,
    required bool withCode,
  }) {
    final l10n = context.l10n;
    final usable = available ?? false;
    return SettingsGroup(
      indent: 16,
      children: [
        SwitchRow(
          title: l10n.securityBiometric,
          description: available == false ? l10n.securityBiometricUnavailable : l10n.securityBiometricDesc,
          value: settings.biometricUnlock && usable,
          onChanged: usable ? (on) => _setBiometric(on, update) : null,
        ),
        if (settings.biometricUnlock && usable)
          ListRow(
            title: withCode ? l10n.securityReask : l10n.securityReaskPassword,
            subtitle: l10n.securityReaskDesc,
            value: reaskLabel(settings.reaskInterval, l10n),
            onTap: () => _chooseReask(settings, update, withCode: withCode),
          ),
      ],
    );
  }
}

String reaskLabel(ReaskInterval interval, AppLocalizations l10n) => switch (interval) {
  ReaskInterval.day => l10n.reaskDay,
  ReaskInterval.threeDays => l10n.reaskThreeDays,
  ReaskInterval.week => l10n.reaskWeek,
};
