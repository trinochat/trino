import 'package:flutter/material.dart';

import 'screens/mobile_shell.dart';
import 'theme/trino_theme.dart';
import 'theme/trino_theme_controller.dart';

void main() {
  runApp(const TrinoMobileApp());
}

class TrinoMobileApp extends StatefulWidget {
  const TrinoMobileApp({super.key});

  @override
  State<TrinoMobileApp> createState() => _TrinoMobileAppState();
}

class _TrinoMobileAppState extends State<TrinoMobileApp> {
  final _themeController = TrinoThemeController();

  @override
  void initState() {
    super.initState();
    _themeController.load();
  }

  @override
  void dispose() {
    _themeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _themeController,
      builder: (context, _) => MaterialApp(
        title: 'Trino',
        debugShowCheckedModeBanner: false,
        theme: buildTrinoTheme(_themeController.preference),
        home: TrinoThemeScope(
          controller: _themeController,
          child: const MobileShell(),
        ),
      ),
    );
  }
}
