// "Otra forma de conectarse": the bridges, in plain words. One action, the
// automatic search, with what the Tor Project sees. The built-in ways and a
// code someone gave you wait under "Opciones avanzadas", closed at first
// unless one of them is in use, so the user sees the choice they made.
//
// A stored code is never shown back: the screen only says there is one, and
// lets you remove it.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/advanced_section.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/text_field.dart';
import '../common.dart';

class BridgesScreen extends StatefulWidget {
  const BridgesScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const BridgesScreen());

  @override
  State<BridgesScreen> createState() => _BridgesScreenState();
}

class _BridgesScreenState extends State<BridgesScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<BridgeSettings> _bridges = _engine.bridges;
  late final Stream<NetworkState> _network = _engine.network;
  final _code = TextEditingController();

  /// The search started here, so its result is said here too.
  var _searched = false;

  /// "Tengo un código que me dieron" chosen before there is a code: the
  /// engine keeps its way until one is saved.
  var _wantsCode = false;
  String? _codeError;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _search() {
    setState(() {
      _searched = true;
      _wantsCode = false;
    });
    unawaited(_engine.tryAnotherWay());
  }

  void _choose(BridgeMode mode, BridgeSettings bridges) {
    if (mode == BridgeMode.custom && !bridges.hasCustomBridge) {
      setState(() => _wantsCode = true);
      return;
    }
    setState(() => _wantsCode = false);
    unawaited(_engine.setBridgeMode(mode));
  }

  Future<void> _saveCode() async {
    final l10n = context.l10n;
    try {
      await _engine.setCustomBridge(_code.text);
    } on InvalidBridgeCode {
      if (mounted) setState(() => _codeError = l10n.bridgeCodeInvalid);
      return;
    }
    if (!mounted) return;
    _code.clear();
    setState(() {
      _codeError = null;
      _wantsCode = false;
    });
  }

  Future<void> _removeCode() async {
    final l10n = context.l10n;
    await _engine.removeCustomBridge();
    if (mounted) showNotice(context, l10n.bridgeCodeRemoved);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final text = context.text;
    return SubPage(
      title: l10n.bridgesTitle,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
          child: Text(l10n.bridgesIntro, style: text.body),
        ),
        StreamBuilder<NetworkState>(
          stream: _network,
          builder: (context, snapshot) {
            final state = snapshot.data;
            final status = switch (state) {
              NetworkState(tryingAnotherWay: true) => l10n.netTryingAnotherWay,
              NetworkState(status: NetworkStatus.connected) when _searched => l10n.netConnectedPrivately,
              NetworkState(status: NetworkStatus.failed) when _searched => l10n.netFailed,
              _ => null,
            };
            return Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TrinoButton(
                    label: l10n.bridgesSearch,
                    variant: ButtonVariant.primary,
                    expand: true,
                    loading: state?.tryingAnotherWay ?? false,
                    onPressed: _search,
                  ),
                  if (status != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Semantics(
                        container: true,
                        liveRegion: true,
                        child: Text(status, style: text.body.copyWith(color: context.tokens.accentText)),
                      ),
                    ),
                  const SizedBox(height: 12),
                  Text(l10n.bridgesSearchNote, style: text.secondary),
                  const SizedBox(height: 16),
                ],
              ),
            );
          },
        ),
        StreamBuilder<BridgeSettings>(
          stream: _bridges,
          builder: (context, snapshot) {
            final bridges = snapshot.data;
            if (bridges == null) return const SizedBox.shrink();
            return AdvancedSection(
              title: l10n.advancedOptions,
              initiallyOpen: bridges.mode != BridgeMode.automatic || bridges.hasCustomBridge,
              children: _advanced(context, bridges),
            );
          },
        ),
      ],
    );
  }

  List<Widget> _advanced(BuildContext context, BridgeSettings bridges) {
    final l10n = context.l10n;
    final text = context.text;
    final selected = _wantsCode ? BridgeMode.custom : bridges.mode;
    return [
      for (final mode in BridgeMode.values)
        ChoiceRow(
          title: bridgeChoiceName(mode, l10n),
          selected: selected == mode,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
          onTap: () => _choose(mode, bridges),
        ),
      Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
        child: Text(l10n.bridgesBuiltInNote, style: text.secondary),
      ),
      if (selected == BridgeMode.custom)
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
          child: bridges.hasCustomBridge && !_wantsCode
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(l10n.bridgeCodeStored, style: text.body),
                    const SizedBox(height: 12),
                    TrinoButton(label: l10n.bridgeCodeRemove, expand: true, onPressed: () => unawaited(_removeCode())),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TrinoTextField(
                      controller: _code,
                      semanticLabel: l10n.bridgeCodeField,
                      hint: l10n.bridgeCodeField,
                      helper: l10n.bridgeCodeHelp,
                      error: _codeError,
                      mono: true,
                      minLines: 3,
                      maxLines: 6,
                      keyboardType: TextInputType.multiline,
                      autocorrect: false,
                      enableSuggestions: false,
                      onChanged: (_) {
                        if (_codeError != null) setState(() => _codeError = null);
                      },
                    ),
                    const SizedBox(height: 12),
                    TrinoButton(label: l10n.bridgeCodeSave, expand: true, onPressed: () => unawaited(_saveCode())),
                  ],
                ),
        ),
    ];
  }
}

/// A way to reach Tor, as the options name it.
String bridgeChoiceName(BridgeMode mode, AppLocalizations l10n) => switch (mode) {
  BridgeMode.automatic => l10n.bridgeAutomatic,
  BridgeMode.snowflake => l10n.bridgeSnowflake,
  BridgeMode.obfs4 => l10n.bridgeObfs4,
  BridgeMode.custom => l10n.bridgeCustom,
};

/// The way in use, short, as the value of "Si en tu red bloquean Tor".
String bridgeShortName(BridgeMode mode, AppLocalizations l10n) => switch (mode) {
  BridgeMode.automatic => l10n.bridgeAutomaticShort,
  BridgeMode.snowflake => 'Snowflake',
  BridgeMode.obfs4 => 'obfs4',
  BridgeMode.custom => l10n.bridgeCustomShort,
};
