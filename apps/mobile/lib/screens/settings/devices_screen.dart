// Dispositivos: the devices of your account, this phone first. Each device can
// unlink itself; the computer, which holds the account key, can remove any.
// So "Desvincular" shows only on this phone's row, and not at all when this
// phone created the account and holds the key. There is no "Vincular" here:
// a phone links only at its first run.
import 'package:flutter/material.dart';

import '../../app/format.dart';
import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../common.dart';

class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  late final TrinoEngine _engine = context.engine;
  late final Stream<List<LinkedDevice>> _devices = _engine.devices;

  Future<void> _unlink() async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => Dialog(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(container: true, header: true, child: Text(l10n.devicesUnlinkTitle, style: dialog.text.title)),
              const SizedBox(height: 8),
              Text(l10n.devicesUnlinkBody, style: dialog.text.body),
              const SizedBox(height: 20),
              TrinoButton(
                label: l10n.devicesUnlink,
                variant: ButtonVariant.danger,
                expand: true,
                onPressed: () => Navigator.of(dialog).pop(true),
              ),
              const SizedBox(height: 8),
              TrinoButton(
                label: l10n.cancel,
                variant: ButtonVariant.ghost,
                expand: true,
                onPressed: () => Navigator.of(dialog).pop(false),
              ),
            ],
          ),
        ),
      ),
    );
    if (confirmed != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      // The app goes back to the first run once the engine says so.
      await _engine.unlinkThisDevice();
    } on StateError {
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.devicesUnlinkFailed)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionDevices,
      children: [
        StreamBuilder<List<LinkedDevice>>(
          stream: _devices,
          builder: (context, snapshot) {
            final devices = snapshot.data;
            if (devices == null) return const SizedBox.shrink();
            final self = devices.where((device) => device.isThisDevice).firstOrNull;
            final holdsKey = self?.isPrimary ?? false;
            final computerHoldsKey = devices.any((device) => device.isPrimary && !device.isThisDevice);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 8),
                SettingsGroup(
                  children: [
                    for (final device in devices)
                      _DeviceRow(
                        key: ValueKey(device.id),
                        device: device,
                        onUnlink: device.isThisDevice && !device.isPrimary ? _unlink : null,
                      ),
                  ],
                ),
                if (holdsKey) _Note(l10n.devicesHoldsKeyNote),
                if (computerHoldsKey) ...[_Note(l10n.devicesNoteSelf), _Note(l10n.devicesNoteLost)],
              ],
            );
          },
        ),
      ],
    );
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({super.key, required this.device, this.onUnlink});

  final LinkedDevice device;
  final VoidCallback? onUnlink;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final now = context.now();
    final lastSeen = device.lastSeen;
    final model = device.isThisDevice ? device.name : platformName(device.platform);
    final when = device.isThisDevice && device.isPrimary
        ? l10n.devicesHoldsKey
        : lastSeen != null
        ? lastSeenLabel(context, lastSeen, now)
        : linkedLabel(context, device.linkedAt, now);
    final onUnlink = this.onUnlink;
    return Row(
      children: [
        Expanded(
          child: ListRow(
            icon: switch (device.platform) {
              DevicePlatform.android || DevicePlatform.ios => TrinoIcons.smartphone,
              _ => TrinoIcons.laptop,
            },
            title: device.isThisDevice ? l10n.devicesThisPhone : device.name,
            subtitle: '$model · $when',
          ),
        ),
        if (onUnlink != null) _UnlinkButton(label: l10n.devicesUnlink, onPressed: onUnlink),
      ],
    );
  }
}

/// "Desvincular" as words in the danger colour, with a full tap target.
class _UnlinkButton extends StatelessWidget {
  const _UnlinkButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      button: true,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onPressed,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: Center(
                widthFactor: 1,
                child: Text(label, style: context.text.bodyStrong.copyWith(color: t.danger)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 8, 20, 4),
    child: Text(text, style: context.text.secondary),
  );
}

/// The name of a platform, the same in every language.
String platformName(DevicePlatform platform) => switch (platform) {
  DevicePlatform.android => 'Android',
  DevicePlatform.ios => 'iPhone',
  DevicePlatform.windows => 'Windows',
  DevicePlatform.macos => 'Mac',
  DevicePlatform.linux => 'Linux',
};

/// "vinculado hoy", "vinculado ayer" or "vinculado el 2 sept".
String linkedLabel(BuildContext context, DateTime linkedAt, DateTime now) {
  final l10n = context.l10n;
  return switch (daysBetween(linkedAt, now)) {
    <= 0 => l10n.devicesLinkedToday,
    1 => l10n.devicesLinkedYesterday,
    _ => l10n.devicesLinkedOn(formatShortDate(context, linkedAt)),
  };
}

/// "activo ahora", "activo hace 5 min", "activo ayer" or "activo el 30 ago".
String lastSeenLabel(BuildContext context, DateTime seen, DateTime now) {
  final l10n = context.l10n;
  final days = daysBetween(seen, now);
  if (days == 1) return l10n.devicesActiveYesterday;
  if (days > 1) return l10n.devicesActiveOn(formatShortDate(context, seen));
  final elapsed = now.difference(seen);
  return l10n.devicesActive(
    elapsed.inMinutes < 1
        ? l10n.agoNow
        : elapsed.inHours < 1
        ? l10n.agoMinutes(elapsed.inMinutes)
        : l10n.agoHours(elapsed.inHours),
  );
}
