// Ajustes › Privacidad › Conexión: the state in words (and the way back when
// it is unprotected), what others see, what to do if the network blocks Tor,
// staying connected with Trino closed (on by default, with what it costs),
// connecting only after unlocking under "Opciones avanzadas", and the small
// grey way out without protection, which always asks and is never
// remembered.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../ui/advanced_section.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../../ui/switch_row.dart';
import '../chats_screen.dart';
import '../common.dart';
import '../settings_screen.dart';
import 'bridges_screen.dart';
import 'connection_failed_screen.dart';
import 'unprotected_dialog.dart';
import 'what_others_see_screen.dart';

class ConnectionScreen extends StatefulWidget {
  const ConnectionScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const ConnectionScreen());

  @override
  State<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends State<ConnectionScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<NetworkState> _network = _engine.network;
  late final Stream<BridgeSettings> _bridges = _engine.bridges;

  void _push(Route<void> route) => Navigator.of(context).push(route);

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.connectionTitle,
      children: [
        const SizedBox(height: 12),
        StreamBuilder<NetworkState>(
          stream: _network,
          builder: (context, snapshot) {
            final state = snapshot.data;
            if (state == null) return const SizedBox(height: 28);
            final unprotected = state.status == NetworkStatus.unprotected;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                NetworkStatusLine(
                  state: state,
                  showConnected: true,
                  onHelp: () => _push(ConnectionFailedScreen.route()),
                ),
                if (unprotected)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                    child: TrinoButton(
                      label: l10n.connectionReconnectPrivately,
                      variant: ButtonVariant.primary,
                      expand: true,
                      onPressed: () => unawaited(_engine.reconnectPrivately()),
                    ),
                  ),
              ],
            );
          },
        ),
        StreamBuilder<BridgeSettings>(
          stream: _bridges,
          builder: (context, snapshot) {
            final bridges = snapshot.data;
            return SettingsGroup(
              children: [
                ListRow(
                  icon: TrinoIcons.eye,
                  title: l10n.connectionWhatOthersSee,
                  onTap: () => _push(WhatOthersSeeScreen.route()),
                ),
                ListRow(
                  icon: TrinoIcons.door,
                  title: l10n.connectionIfBlocked,
                  value: bridges == null ? null : bridgeShortName(bridges.mode, l10n),
                  onTap: () => _push(BridgesScreen.route()),
                ),
              ],
            );
          },
        ),
        StreamBuilder<BridgeSettings>(
          stream: _bridges,
          builder: (context, bridges) => SettingsBuilder(
            builder: (context, settings, update) {
              final forced = bridges.data?.hasCustomBridge ?? false;
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SettingsGroup(
                    children: [
                      SwitchRow(
                        title: l10n.privacyKeepConnected,
                        description: l10n.privacyKeepConnectedDesc,
                        value: settings.keepConnectedInBackground,
                        onChanged: (on) => update((current) => current.copyWith(keepConnectedInBackground: on)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  AdvancedSection(
                    title: l10n.advancedOptions,
                    children: [
                      SettingsGroup(
                        children: [
                          SwitchRow(
                            title: l10n.privacyConnectAfterUnlock,
                            description: l10n.privacyConnectAfterUnlockDesc,
                            value: settings.connectAfterUnlockOnly || forced,
                            onChanged: forced
                                ? null
                                : (on) => update((current) => current.copyWith(connectAfterUnlockOnly: on)),
                          ),
                        ],
                      ),
                      // Below the dimmed row, at full contrast.
                      if (forced)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                          child: Text(l10n.privacyConnectAfterUnlockForced, style: context.text.secondary),
                        ),
                    ],
                  ),
                ],
              );
            },
          ),
        ),
        StreamBuilder<NetworkState>(
          stream: _network,
          builder: (context, snapshot) {
            final status = snapshot.data?.status;
            if (status == null || status == NetworkStatus.unprotected) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
              child: TrinoButton(
                label: l10n.connectionUnprotectedOnce,
                variant: ButtonVariant.quiet,
                expand: true,
                onPressed: () => unawaited(confirmUnprotected(context)),
              ),
            );
          },
        ),
      ],
    );
  }
}
