// The app: the theme and language the user chose, and the gate that shows the
// first run, the unlock screen or the tabs, as the engine's lock state says.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/appearance.dart';
import '../engine/engine.dart';
import '../l10n/app_localizations.dart';
import '../screens/home_shell.dart';
import '../screens/onboarding_screen.dart';
import '../screens/unlock_screen.dart';
import 'language.dart';
import 'scope.dart';

class TrinoApp extends StatefulWidget {
  const TrinoApp({super.key, required this.engine, this.appearance, this.language, this.clock = DateTime.now});

  final TrinoEngine engine;

  /// Given by tests; created otherwise.
  final AppearanceController? appearance;
  final LanguageController? language;
  final DateTime Function() clock;

  @override
  State<TrinoApp> createState() => _TrinoAppState();
}

class _TrinoAppState extends State<TrinoApp> {
  late final AppearanceController _appearance = widget.appearance ?? AppearanceController();
  late final LanguageController _language = widget.language ?? LanguageController();

  @override
  void dispose() {
    if (widget.appearance == null) _appearance.dispose();
    if (widget.language == null) _language.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AppScope(
    engine: widget.engine,
    appearance: _appearance,
    language: _language,
    clock: widget.clock,
    child: ListenableBuilder(
      listenable: Listenable.merge([_appearance, _language]),
      builder: (context, _) => MaterialApp(
        onGenerateTitle: (context) => AppLocalizations.of(context).appTitle,
        debugShowCheckedModeBanner: false,
        theme: _appearance.lightTheme,
        darkTheme: _appearance.darkTheme,
        themeMode: _appearance.themeMode,
        // Themes switch at once; mixed token sets were never checked.
        themeAnimationDuration: Duration.zero,
        locale: _language.locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        builder: (context, child) => AnnotatedRegion<SystemUiOverlayStyle>(
          // Status bar icons that stay visible on the theme's background.
          value: Theme.of(context).brightness == Brightness.dark
              ? SystemUiOverlayStyle.light
              : SystemUiOverlayStyle.dark,
          child: child!,
        ),
        home: const AppGate(),
      ),
    ),
  );
}

/// Shows the first run, the unlock screen or the tabs. Nothing of the chats
/// stays on screen once the app locks.
class AppGate extends StatefulWidget {
  const AppGate({super.key});

  @override
  State<AppGate> createState() => _AppGateState();
}

class _AppGateState extends State<AppGate> {
  StreamSubscription<IdentityState>? _subscription;
  IdentityState? _state;

  /// The first run stays on screen until the user leaves its last step, even
  /// though the identity exists (and is unlocked) before that.
  bool _onboarding = false;
  bool _openAddContact = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscription ??= AppScope.read(context).engine.identityState.listen(_onLockState);
  }

  void _onLockState(IdentityState state) {
    if (!mounted) return;
    final leaving = _state == IdentityState.unlocked && state != IdentityState.unlocked;
    setState(() {
      _state = state;
      if (state == IdentityState.needsOnboarding) _onboarding = true;
      if (state == IdentityState.locked) _onboarding = false;
      if (state != IdentityState.unlocked) _openAddContact = false;
    });
    // Chats, calls and dialogs above the gate go away with the lock.
    if (leaving) Navigator.of(context).popUntil((route) => route.isFirst);
  }

  void _finishOnboarding({required bool addContact}) => setState(() {
    _onboarding = false;
    _openAddContact = addContact;
  });

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    if (state == null) return const Scaffold(body: SizedBox.expand());
    if (state == IdentityState.needsOnboarding || (state == IdentityState.unlocked && _onboarding)) {
      return OnboardingScreen(key: const ValueKey('onboarding'), onFinished: _finishOnboarding);
    }
    if (state == IdentityState.locked) return const UnlockScreen();
    return HomeShell(openAddContact: _openAddContact);
  }
}
