import 'package:flutter/material.dart';

import '../theme/trino_theme.dart';
import '../widgets/identity_avatar.dart';
import 'mobile_call_screen.dart';

class CallsScreen extends StatefulWidget {
  const CallsScreen({super.key});

  @override
  State<CallsScreen> createState() => _CallsScreenState();
}

class _CallsScreenState extends State<CallsScreen> {
  bool _missedOnly = false;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Llamadas'),
        actions: [
          IconButton(
            tooltip: 'Nueva llamada',
            onPressed: () => _start(context, 'Mara', TrinoColors.green),
            icon: const Icon(Icons.add_call),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 10),
            child: SizedBox(
              width: double.infinity,
              child: SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: false, label: Text('Todas')),
                  ButtonSegment(value: true, label: Text('Perdidas')),
                ],
                selected: {_missedOnly},
                onSelectionChanged: (value) {
                  setState(() => _missedOnly = value.first);
                },
                showSelectedIcon: false,
                style: ButtonStyle(
                  visualDensity: VisualDensity.compact,
                  side: WidgetStateProperty.all(
                    BorderSide(color: palette.line),
                  ),
                  backgroundColor: WidgetStateProperty.resolveWith(
                    (states) => states.contains(WidgetState.selected)
                        ? palette.surfaceRaised
                        : palette.background,
                  ),
                  foregroundColor: WidgetStateProperty.resolveWith(
                    (states) => states.contains(WidgetState.selected)
                        ? palette.accent
                        : palette.inkMuted,
                  ),
                ),
              ),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                if (!_missedOnly)
                  _CallRow(
                    name: 'Mara',
                    detail: 'Saliente · 12 min',
                    time: '18:12',
                    color: TrinoColors.green,
                    icon: Icons.north_east_rounded,
                    iconColor: palette.accent,
                    onTap: () => _start(context, 'Mara', TrinoColors.green),
                  ),
                _CallRow(
                  name: 'Dante',
                  detail: 'No contestada',
                  time: 'Ayer',
                  color: TrinoColors.amber,
                  icon: Icons.call_missed_rounded,
                  iconColor: TrinoColors.crimson,
                  onTap: () => _start(context, 'Dante', TrinoColors.amber),
                ),
                if (!_missedOnly)
                  _CallRow(
                    name: 'Iris',
                    detail: 'Entrante · 4 min',
                    time: 'Lun',
                    color: TrinoColors.cyan,
                    icon: Icons.south_west_rounded,
                    iconColor: TrinoColors.cyan,
                    onTap: () => _start(context, 'Iris', TrinoColors.cyan),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  void _start(BuildContext context, String name, Color color) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            MobileCallScreen(name: name, color: color, video: false),
      ),
    );
  }
}

class _CallRow extends StatelessWidget {
  const _CallRow({
    required this.name,
    required this.detail,
    required this.time,
    required this.color,
    required this.icon,
    required this.iconColor,
    required this.onTap,
  });

  final String name;
  final String detail;
  final String time;
  final Color color;
  final IconData icon;
  final Color iconColor;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 72),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: palette.line)),
        ),
        child: Row(
          children: [
            IdentityAvatar(name: name, color: color, size: 48),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(icon, color: iconColor, size: 15),
                      const SizedBox(width: 5),
                      Text(
                        detail,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(time, style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 5),
                Icon(Icons.call_outlined, color: palette.inkMuted, size: 20),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
