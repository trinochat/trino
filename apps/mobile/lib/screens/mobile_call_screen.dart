import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/trino_theme.dart';
import '../widgets/identity_avatar.dart';

class MobileCallScreen extends StatefulWidget {
  const MobileCallScreen({
    required this.name,
    required this.color,
    required this.video,
    super.key,
  });

  final String name;
  final Color color;
  final bool video;

  @override
  State<MobileCallScreen> createState() => _MobileCallScreenState();
}

class _MobileCallScreenState extends State<MobileCallScreen> {
  bool _muted = false;
  bool _speaker = false;
  bool _camera = false;
  int _seconds = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _camera = widget.video;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _seconds++);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    final minutes = (_seconds ~/ 60).toString().padLeft(2, '0');
    final seconds = (_seconds % 60).toString().padLeft(2, '0');

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Volver',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.keyboard_arrow_down_rounded),
                  ),
                  const Spacer(),
                  Row(
                    children: [
                      Icon(
                        Icons.lock_outline_rounded,
                        size: 14,
                        color: palette.accent,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        'Cifrada',
                        style: TextStyle(color: palette.inkMuted, fontSize: 11),
                      ),
                    ],
                  ),
                  const Spacer(),
                  const SizedBox(width: 48),
                ],
              ),
            ),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IdentityAvatar(
                    name: widget.name,
                    color: widget.color,
                    size: 112,
                    online: true,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    widget.name,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '$minutes:$seconds',
                    style: TextStyle(
                      color: palette.inkMuted,
                      fontFamily: 'monospace',
                      fontSize: 13,
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    'A7F2  19CD  5B80',
                    style: TextStyle(
                      color: palette.inkDim,
                      fontFamily: 'monospace',
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Código de seguridad',
                    style: TextStyle(color: palette.inkMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
            Container(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 20),
              decoration: BoxDecoration(
                color: palette.surface,
                border: Border(top: BorderSide(color: palette.line)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _CallControl(
                    icon: _muted
                        ? Icons.mic_off_rounded
                        : Icons.mic_none_rounded,
                    label: _muted ? 'Activar' : 'Silenciar',
                    active: _muted,
                    onTap: () => setState(() => _muted = !_muted),
                  ),
                  _CallControl(
                    icon: _speaker
                        ? Icons.volume_up_rounded
                        : Icons.hearing_rounded,
                    label: 'Audio',
                    active: _speaker,
                    onTap: () => setState(() => _speaker = !_speaker),
                  ),
                  _CallControl(
                    icon: _camera
                        ? Icons.videocam_rounded
                        : Icons.videocam_off_rounded,
                    label: 'Cámara',
                    active: _camera,
                    onTap: () => setState(() => _camera = !_camera),
                  ),
                  _CallControl(
                    icon: Icons.call_end_rounded,
                    label: 'Colgar',
                    danger: true,
                    onTap: () => Navigator.pop(context),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CallControl extends StatelessWidget {
  const _CallControl({
    required this.icon,
    required this.label,
    required this.onTap,
    this.active = false,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool active;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    final background = danger
        ? TrinoColors.crimson
        : active
        ? palette.ink
        : palette.surfaceRaised;
    final foreground = danger || active ? palette.background : palette.ink;

    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: SizedBox(
          width: 68,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 52,
                height: 52,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: background,
                  border: danger ? null : Border.all(color: palette.line),
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: foreground, size: 23),
              ),
              const SizedBox(height: 7),
              Text(
                label,
                maxLines: 1,
                style: TextStyle(color: palette.inkMuted, fontSize: 10),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
