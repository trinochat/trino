import 'package:flutter/material.dart';

import '../theme/trino_theme.dart';
import '../theme/trino_theme_controller.dart';
import '../widgets/identity_avatar.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _quickUnlock = true;
  bool _hidePreviews = true;
  bool _relayCalls = false;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    final themeController = TrinoThemeScope.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Ajustes')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 28),
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 20),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: palette.line)),
            ),
            child: Row(
              children: [
                IdentityAvatar(
                  name: 'Identidad local',
                  color: palette.accent,
                  size: 62,
                  online: true,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Identidad local',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'trino:7d4f...a921',
                        style: TextStyle(
                          color: palette.accent,
                          fontFamily: 'monospace',
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Compartir contacto',
                  onPressed: () => _notice('Código de contacto'),
                  icon: const Icon(Icons.qr_code_2_rounded),
                ),
              ],
            ),
          ),
          const _SectionLabel('Apariencia'),
          _AppearanceSection(controller: themeController),
          const _SectionLabel('Acceso'),
          SwitchListTile(
            value: _quickUnlock,
            onChanged: (value) => setState(() => _quickUnlock = value),
            secondary: Icon(Icons.fingerprint_rounded, color: palette.accent),
            title: const Text('Desbloqueo rápido'),
            subtitle: const Text('Usa la protección segura del dispositivo'),
          ),
          Divider(height: 1, indent: 56, color: palette.line),
          ListTile(
            minTileHeight: 64,
            leading: Icon(Icons.lock_reset_rounded, color: palette.inkMuted),
            title: const Text('Bloquear ahora'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => _notice('Bóveda bloqueada'),
          ),
          const _SectionLabel('Privacidad'),
          SwitchListTile(
            value: _hidePreviews,
            onChanged: (value) => setState(() => _hidePreviews = value),
            secondary: const Icon(
              Icons.visibility_off_outlined,
              color: TrinoColors.cyan,
            ),
            title: const Text('Ocultar vistas previas'),
            subtitle: const Text('No mostrar mensajes en notificaciones'),
          ),
          Divider(height: 1, indent: 56, color: palette.line),
          SwitchListTile(
            value: _relayCalls,
            onChanged: (value) => setState(() => _relayCalls = value),
            secondary: const Icon(
              Icons.route_outlined,
              color: TrinoColors.amber,
            ),
            title: const Text('Ocultar IP en llamadas'),
            subtitle: const Text('Usar solo servidores relay configurados'),
          ),
          const _SectionLabel('Datos'),
          ListTile(
            minTileHeight: 64,
            leading: Icon(Icons.backup_outlined, color: palette.inkMuted),
            title: const Text('Copia cifrada'),
            subtitle: const Text('Sin configurar'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => _notice('Copia cifrada'),
          ),
          Divider(height: 1, indent: 56, color: palette.line),
          ListTile(
            minTileHeight: 64,
            leading: Icon(Icons.hub_outlined, color: palette.inkMuted),
            title: const Text('Transporte'),
            subtitle: const Text('Relays predeterminados'),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () => _notice('Configuración de transporte'),
          ),
        ],
      ),
    );
  }

  void _notice(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }
}

class _AppearanceSection extends StatelessWidget {
  const _AppearanceSection({required this.controller});

  final TrinoThemeController controller;

  static const _accents = [
    Color(0xFF35E875),
    Color(0xFF55A7F1),
    Color(0xFFF0BE55),
    Color(0xFFE56C78),
    Color(0xFFAA8BE8),
    Color(0xFF9BAA9F),
  ];

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    final preference = controller.preference;
    return Padding(
      padding: const EdgeInsets.fromLTRB(11, 2, 11, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: TrinoThemePreset.values.map((preset) {
              final selected = preference.preset == preset;
              return Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Semantics(
                    selected: selected,
                    button: true,
                    label: _presetLabel(preset),
                    child: InkWell(
                      onTap: () => controller.setPreset(preset),
                      borderRadius: BorderRadius.circular(8),
                      child: Container(
                        height: 92,
                        padding: const EdgeInsets.all(9),
                        decoration: BoxDecoration(
                          color: selected
                              ? palette.accent.withValues(alpha: 0.08)
                              : palette.surface,
                          border: Border.all(
                            color: selected ? palette.accent : palette.line,
                            width: selected ? 1.5 : 1,
                          ),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _PresetPreview(
                              preset: preset,
                              accent: preference.accent,
                            ),
                            const Spacer(),
                            Text(
                              _presetLabel(preset),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: selected
                                    ? palette.accent
                                    : palette.inkDim,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 14),
          Text('Color de acento', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 9),
          Wrap(
            spacing: 12,
            runSpacing: 10,
            children: _accents.map((color) {
              final selected = preference.accent.toARGB32() == color.toARGB32();
              return Semantics(
                selected: selected,
                button: true,
                label: 'Elegir color',
                child: InkWell(
                  onTap: () => controller.setAccent(color),
                  customBorder: const CircleBorder(),
                  child: Container(
                    width: 38,
                    height: 38,
                    padding: const EdgeInsets.all(4),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? palette.ink : Colors.transparent,
                        width: 2,
                      ),
                    ),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: color,
                        shape: BoxShape.circle,
                        border: Border.all(
                          color: Colors.black.withValues(alpha: 0.12),
                        ),
                      ),
                      child: selected
                          ? Icon(
                              Icons.check_rounded,
                              color: color.computeLuminance() > 0.5
                                  ? Colors.black
                                  : Colors.white,
                              size: 18,
                            )
                          : null,
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
        ],
      ),
    );
  }

  String _presetLabel(TrinoThemePreset preset) {
    return switch (preset) {
      TrinoThemePreset.hacker => 'Trino',
      TrinoThemePreset.corporate => 'Corporativo',
      TrinoThemePreset.simple => 'Simple',
    };
  }
}

class _PresetPreview extends StatelessWidget {
  const _PresetPreview({required this.preset, required this.accent});

  final TrinoThemePreset preset;
  final Color accent;

  @override
  Widget build(BuildContext context) {
    final colors = switch (preset) {
      TrinoThemePreset.hacker => (
        const Color(0xFF070A08),
        const Color(0xFF141B16),
        const Color(0xFFE0EAE3),
      ),
      TrinoThemePreset.corporate => (
        const Color(0xFFF3F6F4),
        const Color(0xFFFFFFFF),
        const Color(0xFF17201A),
      ),
      TrinoThemePreset.simple => (
        const Color(0xFF121513),
        const Color(0xFF222824),
        const Color(0xFFF0F4F1),
      ),
    };
    return Container(
      height: 46,
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: colors.$1,
        borderRadius: BorderRadius.circular(5),
      ),
      child: Row(
        children: [
          Container(
            width: 12,
            decoration: BoxDecoration(
              color: accent,
              borderRadius: BorderRadius.circular(3),
            ),
          ),
          const SizedBox(width: 5),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(height: 5, color: colors.$3),
                const SizedBox(height: 5),
                FractionallySizedBox(
                  widthFactor: 0.7,
                  child: Container(height: 5, color: colors.$2),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 22, 18, 8),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          color: context.trino.inkMuted,
          fontFamily: 'monospace',
          fontSize: 10,
          fontWeight: FontWeight.w600,
          letterSpacing: 0,
        ),
      ),
    );
  }
}
