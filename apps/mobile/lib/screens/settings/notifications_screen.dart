// Notificaciones: the calls first, as in the approved mock (the tone, its
// volume, vibrating and what silent mode does), then what a notification
// shows and the message sounds. In the demo app, a labelled entry rings a
// call so the ring can be heard.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../design/icons.dart';
import '../../design/theme.dart';
import '../../engine/engine.dart';
import '../../l10n/app_localizations.dart';
import '../../ui/button.dart';
import '../../ui/list_row.dart';
import '../../ui/settings_group.dart';
import '../../ui/switch_row.dart';
import '../common.dart';
import '../settings_screen.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key});

  static String ringtoneLabel(Ringtone tone, AppLocalizations l10n) => switch (tone) {
    Ringtone.soft => l10n.ringtoneSoft,
    Ringtone.silent => l10n.ringtoneSilent,
  };

  Future<void> _chooseRingtone(BuildContext context, EngineSettings settings, SettingsUpdate update) {
    final l10n = context.l10n;
    return showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SectionLabel(l10n.notifRingtone),
            for (final tone in Ringtone.values)
              ChoiceRow(
                title: ringtoneLabel(tone, l10n),
                selected: settings.ringtone == tone,
                onTap: () {
                  update((current) => current.copyWith(ringtone: tone));
                  Navigator.of(sheet).pop();
                },
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final demoIncomingCall = AppScope.of(context).demoIncomingCall;
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
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SectionLabel(l10n.notifCalls),
                SettingsGroup(
                  children: [
                    ListRow(
                      icon: TrinoIcons.bell,
                      title: l10n.notifRingtone,
                      value: ringtoneLabel(settings.ringtone, l10n),
                      onTap: () => _chooseRingtone(context, settings, update),
                    ),
                  ],
                ),
                SettingsGroup(
                  children: [_RingVolume(settings: settings, update: update)],
                ),
                SettingsGroup(
                  children: [
                    SwitchRow(
                      title: l10n.notifVibrateOnRing,
                      value: settings.vibrateOnRing,
                      onChanged: (on) => update((current) => current.copyWith(vibrateOnRing: on)),
                    ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                  child: Text(l10n.notifSilentNote, style: context.text.caption),
                ),
                if (demoIncomingCall != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                    child: TrinoButton(
                      label: l10n.notifDemoIncomingCall,
                      icon: TrinoIcons.phoneIncoming,
                      expand: true,
                      onPressed: demoIncomingCall,
                    ),
                  ),
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

/// "Volumen del tono": a slider from 0 to 100 in steps of 5. Letting go plays
/// one ring at the new volume, unless the tone is "Silencio" (then the volume
/// is only the ringback's).
class _RingVolume extends StatelessWidget {
  const _RingVolume({required this.settings, required this.update});

  final EngineSettings settings;
  final SettingsUpdate update;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExcludeSemantics(child: Text(l10n.notifRingVolume, style: context.text.bodyStrong)),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              trackHeight: 4,
              activeTrackColor: t.accent,
              // The off part in muted, which reaches 3:1 like the switch's off track.
              inactiveTrackColor: t.muted,
              thumbColor: t.accent,
              overlayColor: t.accent.withValues(alpha: 0.12),
              activeTickMarkColor: Colors.transparent,
              inactiveTickMarkColor: Colors.transparent,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 9),
              trackShape: const RoundedRectSliderTrackShape(),
              showValueIndicator: ShowValueIndicator.never,
            ),
            // One node: the slider, named after its title.
            child: MergeSemantics(
              child: Semantics(
                label: l10n.notifRingVolume,
                child: Slider(
                  value: settings.ringVolume.clamp(0, 100).toDouble(),
                  max: 100,
                  divisions: 20,
                  semanticFormatterCallback: (value) => '${value.round()} %',
                  onChanged: (value) => update((current) => current.copyWith(ringVolume: value.round())),
                  onChangeEnd: (value) {
                    if (settings.ringtone == Ringtone.soft && value > 0) {
                      unawaited(context.callSounds.previewRingtone(value.round()));
                    }
                  },
                ),
              ),
            ),
          ),
          Text(l10n.notifRingVolumeDesc, style: context.text.caption),
        ],
      ),
    );
  }
}
