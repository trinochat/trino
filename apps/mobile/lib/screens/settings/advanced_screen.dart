// Avanzado: your key, the relays and their state, and the diagnostic log.
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../ui/switch_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class AdvancedScreen extends StatefulWidget {
  const AdvancedScreen({super.key});

  @override
  State<AdvancedScreen> createState() => _AdvancedScreenState();
}

class _AdvancedScreenState extends State<AdvancedScreen> {
  late final Stream<Profile> _profile = context.engine.profile;
  late final Stream<List<RelayStatus>> _relays = context.engine.relays;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = context.text;
    return SubPage(
      title: l10n.sectionAdvanced,
      children: [
        SectionLabel(l10n.yourKey),
        StreamBuilder<Profile>(
          stream: _profile,
          builder: (context, snapshot) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(snapshot.data?.fingerprint ?? '', style: text.code.copyWith(fontSize: 18, letterSpacing: 1)),
          ),
        ),
        SectionLabel(l10n.advancedRelays),
        StreamBuilder<List<RelayStatus>>(
          stream: _relays,
          builder: (context, snapshot) => Column(
            children: [
              for (final relay in snapshot.data ?? const <RelayStatus>[])
                MergeSemantics(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    child: Row(
                      children: [
                        Expanded(child: Text(relay.url, style: text.code.copyWith(fontSize: 14))),
                        const SizedBox(width: 12),
                        // Plain text, not a coloured dot.
                        Text(relay.connected ? l10n.relayConnected : l10n.relayDisconnected, style: text.secondary),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        SettingsBuilder(
          builder: (context, settings, update) => SwitchRow(
            title: l10n.advancedDiagnostic,
            description: l10n.advancedDiagnosticDesc,
            value: settings.diagnosticLog,
            onChanged: (on) => update((current) => current.copyWith(diagnosticLog: on)),
          ),
        ),
      ],
    );
  }
}
