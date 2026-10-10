// Perfil: your name, and your code to share.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../app/scope.dart';
import '../../engine/engine.dart';
import '../../ui/button.dart';
import '../../ui/text_field.dart';
import '../common.dart';
import '../share_code_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.profile});

  final Profile profile;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late final _name = TextEditingController(text: widget.profile.name);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    if (name.isEmpty) return;
    unawaited(context.engine.setName(name));
    showNotice(context, context.l10n.saved);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.profileTitle,
      padding: const EdgeInsets.all(16),
      children: [
        TrinoTextField(
          controller: _name,
          label: l10n.nameLabel,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 12),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TrinoButton(label: l10n.save, variant: ButtonVariant.primary, onPressed: _save),
        ),
        const SizedBox(height: 28),
        const ShareCodeView(),
      ],
    );
  }
}
