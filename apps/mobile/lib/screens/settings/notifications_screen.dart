// Notificaciones: what a notification shows, and the sounds.
import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../engine/engine.dart';
import '../../ui/list_row.dart';
import '../../ui/switch_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.sectionNotifications,
      children: [
        SettingsBuilder(
          builder: (context, settings, update) {
            ChoiceRow preview(NotificationPreview value, String title, String description) => ChoiceRow(
              title: title,
              subtitle: description,
              selected: settings.notificationPreview == value,
              onTap: () => update((current) => current.copyWith(notificationPreview: value)),
            );
            return Column(
              children: [
                SectionLabel(l10n.notifPreviewTitle),
                preview(NotificationPreview.nameAndMessage, l10n.notifNameAndMessage, l10n.notifNameAndMessageDesc),
                preview(NotificationPreview.nameOnly, l10n.notifNameOnly, l10n.notifNameOnlyDesc),
                preview(NotificationPreview.nothing, l10n.notifNothing, l10n.notifNothingDesc),
                const SizedBox(height: 12),
                SwitchRow(
                  title: l10n.notifSound,
                  description: l10n.notifSoundDesc,
                  value: settings.messageSound,
                  onChanged: (on) => update((current) => current.copyWith(messageSound: on)),
                ),
                SwitchRow(
                  title: l10n.notifMuteGroups,
                  description: l10n.notifMuteGroupsDesc,
                  value: settings.muteGroups,
                  onChanged: (on) => update((current) => current.copyWith(muteGroups: on)),
                ),
              ],
            );
          },
        ),
      ],
    );
  }
}
