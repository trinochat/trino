// Privacidad: Tor, and the warning before a call that shows your IP.
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
                title: l10n.privacyTor,
                description: l10n.privacyTorDesc,
                value: settings.hideIpWithTor,
                onChanged: (on) => update((current) => current.copyWith(hideIpWithTor: on)),
              ),
              SwitchRow(
                title: l10n.privacyCallWarning,
                description: l10n.privacyCallWarningDesc,
                value: settings.warnBeforeDirectCall,
                onChanged: (on) => update((current) => current.copyWith(warnBeforeDirectCall: on)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
