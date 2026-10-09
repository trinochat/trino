import 'package:flutter/material.dart';

import '../theme/trino_theme.dart';

class IdentityAvatar extends StatelessWidget {
  const IdentityAvatar({
    required this.name,
    required this.color,
    this.size = 48,
    this.online = false,
    this.group = false,
    this.system = false,
    super.key,
  });

  final String name;
  final Color color;
  final double size;
  final bool online;
  final bool group;
  final bool system;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    final parts = name.trim().split(RegExp(r'\s+'));
    final initials = parts.take(2).map((part) => part[0]).join().toUpperCase();

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.14),
              border: Border.all(color: color.withValues(alpha: 0.46)),
              shape: BoxShape.circle,
            ),
            child: system
                ? Icon(Icons.campaign_rounded, color: color, size: size * 0.48)
                : group && size <= 40
                ? Icon(Icons.group_rounded, color: color, size: size * 0.45)
                : Text(
                    initials,
                    style: TextStyle(
                      color: color,
                      fontFamily: 'monospace',
                      fontSize: size * 0.3,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0,
                    ),
                  ),
          ),
          if (online)
            Positioned(
              right: -1,
              bottom: -1,
              child: Container(
                width: size * 0.24,
                height: size * 0.24,
                decoration: BoxDecoration(
                  color: palette.accent,
                  shape: BoxShape.circle,
                  border: Border.all(color: palette.background, width: 2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
