// Privacidad: today one row, Conexión, with the state in words. Tor is always
// on and calls go through the call server, so there is nothing to switch for
// them; how Trino connects lives in Conexión.
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../common.dart';
import '../connection/connection_screen.dart';

class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});

  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  late final Stream<NetworkState> _network = context.engine.network;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionPrivacy,
      children: [
        const SizedBox(height: 8),
        StreamBuilder<NetworkState>(
          stream: _network,
          builder: (context, snapshot) => SettingsGroup(
            children: [
              ListRow(
                icon: TrinoIcons.globe,
                title: l10n.connectionTitle,
                subtitle: snapshot.data == null ? null : networkWords(snapshot.data!, l10n),
                onTap: () => Navigator.of(context).push(ConnectionScreen.route()),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The network state as one short phrase, for a row's subtitle.
String networkWords(NetworkState state, AppLocalizations l10n) => switch (state) {
  NetworkState(tryingAnotherWay: true) => l10n.netTryingAnotherWay,
  NetworkState(status: NetworkStatus.connected) => l10n.netConnectedPrivately,
  NetworkState(status: NetworkStatus.connecting, :final progress) =>
    progress > 0 ? l10n.netConnectingProgress(progress) : l10n.netConnecting,
  NetworkState(status: NetworkStatus.failed) => l10n.netFailed,
  NetworkState(status: NetworkStatus.offline) => l10n.netOffline,
  NetworkState(status: NetworkStatus.unprotected) => l10n.netUnprotected,
};
