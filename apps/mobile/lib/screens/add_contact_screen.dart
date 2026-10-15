// "Agregar contacto": paste the code the other person shared. Scanning a QR
// needs the camera, which this version does not have yet.
import 'package:flutter/material.dart';

import '../app/scope.dart';
import '../design/icons.dart';
import '../design/theme.dart';
import '../engine/engine.dart';
import '../ui/button.dart';
import '../ui/text_field.dart';
import 'common.dart';

class AddContactScreen extends StatefulWidget {
  const AddContactScreen({super.key});

  static Route<void> route() => MaterialPageRoute(builder: (_) => const AddContactScreen());

  @override
  State<AddContactScreen> createState() => _AddContactScreenState();
}

class _AddContactScreenState extends State<AddContactScreen> {
  final _code = TextEditingController();
  String? _error;
  var _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    final l10n = context.l10n;
    final engine = context.engine;
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final contact = await engine.addContact(_code.text.trim());
      navigator.pop();
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(l10n.contactAdded(contact.name))));
    } on InvalidContactCode {
      if (mounted) setState(() => _error = l10n.addContactInvalid);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return SubPage(
      title: l10n.addContact,
      padding: const EdgeInsets.all(16),
      children: [
        Text(l10n.addContactBody, style: context.text.body),
        const SizedBox(height: 16),
        TrinoTextField(
          controller: _code,
          label: l10n.contactCodeLabel,
          hint: 'trino2:…',
          error: _error,
          mono: true,
          maxLines: 4,
          autocorrect: false,
          enableSuggestions: false,
        ),
        const SizedBox(height: 16),
        TrinoButton(
          label: l10n.addContactButton,
          variant: ButtonVariant.primary,
          expand: true,
          loading: _busy,
          onPressed: _add,
        ),
        const SizedBox(height: 8),
        // The camera comes with its own interface later; until then, say so.
        TrinoButton(
          label: l10n.addContactScanQr,
          icon: TrinoIcons.qr,
          variant: ButtonVariant.ghost,
          expand: true,
          onPressed: () => showNotice(context, l10n.notAvailableYet),
        ),
      ],
    );
  }
}
