// Privacidad: how Trino stays connected. Tor is always on and calls go
// through the call server, so there is nothing to switch for them.
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../ui/switch_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class PrivacyScreen extends StatelessWidget {
  const PrivacyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionPrivacy,
      children: [
        SettingsBuilder(
          builder: (context, settings, update) => Column(
            children: [
              const SizedBox(height: 8),
              SwitchRow(
                title: l10n.privacyKeepConnected,
                description: l10n.privacyKeepConnectedDesc,
                value: settings.keepConnectedInBackground,
                onChanged: (on) => update((current) => current.copyWith(keepConnectedInBackground: on)),
              ),
              SwitchRow(
                title: l10n.privacyConnectAfterUnlock,
                description: l10n.privacyConnectAfterUnlockDesc,
                value: settings.connectAfterUnlockOnly,
                onChanged: (on) => update((current) => current.copyWith(connectAfterUnlockOnly: on)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
