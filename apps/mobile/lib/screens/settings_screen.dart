// Ajustes: your profile row, then one row per section.
import 'dart:async';

import 'package:flutter/material.dart';

import '../app/language.dart';
import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/avatar.dart';
import '../ui/list_row.dart';
import 'common.dart';
import 'settings/account_security_screen.dart';
import 'settings/advanced_screen.dart';
import 'settings/appearance_screen.dart';
import 'settings/devices_screen.dart';
import 'settings/language_screen.dart';
import 'settings/notifications_screen.dart';
import 'settings/privacy_screen.dart';
import 'settings/profile_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final Stream<Profile> _profile = context.engine.profile;
  late final Stream<List<LinkedDevice>> _devices = context.engine.devices;

  void _open(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SafeArea(
      bottom: false,
      child: Column(
        children: [
          LargeTitleBar(title: l10n.settingsTitle),
          Expanded(
            child: ListView(
              children: [
                StreamBuilder<Profile>(
                  stream: _profile,
                  builder: (context, snapshot) {
                    final profile = snapshot.data;
                    if (profile == null) return const SizedBox(height: 72);
                    return ListRow(
                      leading: TrinoAvatar(name: profile.name, size: 52),
                      title: profile.name,
                      subtitle: l10n.profileSubtitle,
                      onTap: () => _open(ProfileScreen(profile: profile)),
                    );
                  },
                ),
                Divider(color: context.tokens.line),
                ListRow(
                  icon: TrinoIcons.bell,
                  title: l10n.sectionNotifications,
                  onTap: () => _open(const NotificationsScreen()),
                ),
                ListRow(icon: TrinoIcons.shield, title: l10n.sectionPrivacy, onTap: () => _open(const PrivacyScreen())),
                ListRow(
                  icon: TrinoIcons.key,
                  title: l10n.sectionAccountSecurity,
                  onTap: () => _open(const AccountSecurityScreen()),
                ),
                StreamBuilder<List<LinkedDevice>>(
                  stream: _devices,
                  builder: (context, snapshot) => ListRow(
                    icon: TrinoIcons.smartphone,
                    title: l10n.sectionDevices,
                    value: snapshot.data == null ? null : '${snapshot.data!.length}',
                    onTap: () => _open(const DevicesScreen()),
                  ),
                ),
                ListRow(
                  icon: TrinoIcons.palette,
                  title: l10n.sectionAppearance,
                  onTap: () => _open(const AppearanceScreen()),
                ),
                ListRow(
                  icon: TrinoIcons.globe,
                  title: l10n.sectionLanguage,
                  value: languageName(Localizations.localeOf(context)),
                  onTap: () => _open(const LanguageScreen()),
                ),
                ListRow(
                  icon: TrinoIcons.sliders,
                  title: l10n.sectionAdvanced,
                  onTap: () => _open(const AdvancedScreen()),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Changes to the settings, applied on top of their latest value, so two
/// quick changes never undo each other.
typedef SettingsUpdate = void Function(EngineSettings Function(EngineSettings current) change);

/// Builds from the engine's settings, and gives a way to change them.
class SettingsBuilder extends StatefulWidget {
  const SettingsBuilder({super.key, required this.builder});

  final Widget Function(BuildContext context, EngineSettings settings, SettingsUpdate update) builder;

  @override
  State<SettingsBuilder> createState() => _SettingsBuilderState();
}

class _SettingsBuilderState extends State<SettingsBuilder> {
  late final TrinoEngine _engine = context.engine;
  StreamSubscription<EngineSettings>? _subscription;
  EngineSettings? _settings;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= _engine.settings.listen((settings) {
      if (mounted) setState(() => _settings = settings);
    });
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    super.dispose();
  }

  void _update(EngineSettings Function(EngineSettings current) change) {
    final current = _settings;
    if (current == null) return;
    final next = change(current);
    setState(() => _settings = next);
    unawaited(_engine.updateSettings(next));
  }

  @override
  Widget build(BuildContext context) {
    final settings = _settings;
    if (settings == null) return const SizedBox.shrink();
    return widget.builder(context, settings, _update);
  }
}
