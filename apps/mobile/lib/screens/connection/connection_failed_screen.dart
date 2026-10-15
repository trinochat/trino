// "No se pudo conectar", from the inbox's "Ver qué hacer": the reason in
// words, what still works, one big action, "Volver a intentar", and the small
// grey way out without protection, which always asks.
//
// The screen follows the network: while it retries it says how far it got,
// and once connected it says so with a way back to the chats, rather than
// closing under the user's finger. Connecting without protection goes back
// to the chats, whose line says it in the warning colour.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/button.dart';
import '../common.dart';
import 'unprotected_dialog.dart';

class ConnectionFailedScreen extends StatefulWidget {
  const ConnectionFailedScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const ConnectionFailedScreen());

  @override
  State<ConnectionFailedScreen> createState() => _ConnectionFailedScreenState();
}

class _ConnectionFailedScreenState extends State<ConnectionFailedScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<NetworkState> _network = _engine.network;
  late final Stream<EngineSettings> _settings = _engine.settings;

  /// The last reason the engine gave, kept while it retries.
  NetworkProblem? _problem;

  Future<void> _connectUnprotected() async {
    if (await confirmUnprotected(context) && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            SubPageBar(title: l10n.connectionTitle),
            Expanded(
              child: StreamBuilder<NetworkState>(
                stream: _network,
                builder: (context, snapshot) {
                  final state = snapshot.data;
                  if (state == null) return const SizedBox.shrink();
                  if (state.status == NetworkStatus.failed) _problem = state.problem;
                  return StreamBuilder<EngineSettings>(
                    stream: _settings,
                    builder: (context, settings) => _body(context, state, settings.data),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, NetworkState state, EngineSettings? settings) {
    final l10n = context.l10n;
    final t = context.tokens;
    final text = context.text;
    final failed = state.status == NetworkStatus.failed;
    final trying = state.tryingAnotherWay;
    final heading = switch (state) {
      NetworkState(status: NetworkStatus.connected) => l10n.netConnectedPrivately,
      NetworkState(status: NetworkStatus.unprotected) => l10n.netUnprotected,
      NetworkState(status: NetworkStatus.offline) => l10n.netOffline,
      NetworkState(status: NetworkStatus.connecting, :final progress) when !trying =>
        progress > 0 ? l10n.netConnectingProgress(progress) : l10n.netConnecting,
      _ => l10n.netFailedTitle,
    };
    final unprotected = state.status == NetworkStatus.unprotected;
    final settled = state.status == NetworkStatus.connected || unprotected;
    // Messages go out with the app closed only if Trino keeps connecting then.
    final evenClosed = settings != null && settings.keepConnectedInBackground && !settings.connectAfterUnlockOnly;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 16),
            children: [
              Semantics(
                container: true,
                header: true,
                liveRegion: true,
                child: Text(heading, style: text.title.copyWith(fontSize: 24, color: unprotected ? t.warn : null)),
              ),
              if (failed || trying) ...[const SizedBox(height: 12), Text(_reason(l10n), style: text.body)],
              if (trying) ...[
                const SizedBox(height: 12),
                Semantics(
                  container: true,
                  liveRegion: true,
                  child: Text(l10n.netTryingAnotherWay, style: text.body.copyWith(color: t.accentText)),
                ),
              ],
              if (!settled) ...[
                const SizedBox(height: 12),
                Text(evenClosed ? l10n.netFailedEvenClosed : l10n.netFailedWhileOpen, style: text.secondary),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: settled
                ? [
                    TrinoButton(
                      label: l10n.netBackToChats,
                      variant: ButtonVariant.primary,
                      expand: true,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ]
                : _actions(l10n, busy: !failed || trying, trying: trying),
          ),
        ),
      ],
    );
  }

  String _reason(AppLocalizations l10n) => switch (_problem) {
    NetworkProblem.blocked => l10n.netFailedBlocked,
    NetworkProblem.clock => l10n.netFailedClock,
    null => l10n.netFailedUnknown,
  };

  /// While connecting or trying, the buttons wait; the one that runs shows it.
  /// A wrong clock has one way out: fixing it and trying again.
  List<Widget> _actions(AppLocalizations l10n, {required bool busy, required bool trying}) {
    void retry() => unawaited(_engine.retryConnection());
    if (_problem == NetworkProblem.clock) {
      return [
        TrinoButton(
          label: l10n.netRetry,
          variant: ButtonVariant.primary,
          expand: true,
          loading: busy,
          onPressed: retry,
        ),
      ];
    }
    return [
      TrinoButton(
        label: l10n.netTryAnotherWay,
        variant: ButtonVariant.primary,
        expand: true,
        loading: trying,
        onPressed: busy ? null : () => unawaited(_engine.tryAnotherWay()),
      ),
      const SizedBox(height: 8),
      TrinoButton(label: l10n.netRetry, expand: true, loading: busy && !trying, onPressed: busy ? null : retry),
      const SizedBox(height: 4),
      TrinoButton(
        label: l10n.netConnectUnprotectedAsk,
        variant: ButtonVariant.quiet,
        expand: true,
        onPressed: () => unawaited(_connectUnprotected()),
      ),
    ];
  }
}
