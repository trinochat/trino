// Text fields with their label above (never a floating label), a 3:1
// boundary in controlLine (WCAG 1.4.11), a 2 dp accent ring when focused, and
// the error below with an icon, so it is not told by colour alone.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'icon_button.dart';

class TrinoTextField extends StatelessWidget {
  const TrinoTextField({
    super.key,
    this.controller,
    this.label,
    this.semanticLabel,
    this.hint,
    this.helper,
    this.error,
    this.leadingIcon,
    this.trailing,
    this.mono = false,
    this.minLines,
    this.maxLines = 1,
    this.keyboardType,
    this.textInputAction,
    this.onChanged,
    this.onSubmitted,
    this.focusNode,
    this.autofocus = false,
    this.enabled = true,
    this.autofillHints,
    this.textCapitalization = TextCapitalization.none,
    this.obscureText = false,
    this.autocorrect = true,
    this.enableSuggestions = true,
    this.inputFormatters,
  });

  final TextEditingController? controller;

  /// Shown above the field, and its name for screen readers.
  final String? label;

  /// The name for screen readers when there is no visible label, such as the
  /// search field or the composer.
  final String? semanticLabel;
  final String? hint;

  /// Help below the field.
  final String? helper;

  /// While present, the field is invalid: a danger boundary and this message.
  final String? error;
  final TrinoIcons? leadingIcon;

  /// Inside the field, at the end: such as the password toggle.
  final Widget? trailing;

  /// The monospace font, for keys and codes only.
  final bool mono;
  final int? minLines;

  /// More than one lets the field grow with its text, then scroll.
  final int? maxLines;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final FocusNode? focusNode;
  final bool autofocus;
  final bool enabled;
  final Iterable<String>? autofillHints;
  final TextCapitalization textCapitalization;
  final bool obscureText;
  final bool autocorrect;
  final bool enableSuggestions;
  final List<TextInputFormatter>? inputFormatters;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final invalid = error != null;
    OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
      borderRadius: BorderRadius.circular(t.radius),
      borderSide: BorderSide(color: color, width: width),
    );

    final field = TextField(
      controller: controller,
      focusNode: focusNode,
      autofocus: autofocus,
      enabled: enabled,
      keyboardType: keyboardType,
      textInputAction: textInputAction,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      // A multiline field starts at one line and grows up to maxLines.
      minLines: minLines ?? (maxLines != null && maxLines! > 1 ? 1 : null),
      maxLines: obscureText ? 1 : maxLines,
      obscureText: obscureText,
      autocorrect: autocorrect,
      enableSuggestions: enableSuggestions,
      autofillHints: autofillHints,
      textCapitalization: textCapitalization,
      inputFormatters: inputFormatters,
      style: (mono ? text.code : text.body).copyWith(color: t.ink),
      cursorColor: t.accentText,
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: (mono ? text.code : text.body).copyWith(color: t.muted),
        filled: true,
        fillColor: t.bg,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        prefixIcon: leadingIcon == null
            ? null
            : Padding(
                padding: const EdgeInsetsDirectional.only(start: 12, end: 8),
                child: TrinoIcon(leadingIcon!, size: 20, color: t.muted),
              ),
        prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 40),
        suffixIcon: trailing,
        enabledBorder: border(invalid ? t.danger : t.controlLine, 1),
        focusedBorder: border(invalid ? t.danger : t.accentText, 2),
        disabledBorder: border(t.line, 1),
        border: border(t.controlLine, 1),
      ),
    );

    // One node for screen readers: the label, the field and its error or
    // help. The trailing button keeps its own node inside it.
    return Semantics(
      container: true,
      label: semanticLabel ?? label,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (label != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: ExcludeSemantics(child: Text(label!, style: text.fieldLabel)),
            ),
          field,
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: TrinoIcon(TrinoIcons.alertCircle, size: 18, color: t.danger),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      error!,
                      style: text.secondary.copyWith(color: t.danger, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            )
          else if (helper != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(helper!, style: text.caption),
            ),
        ],
      ),
    );
  }
}

/// A password field with a show/hide toggle. The shown password is kept away
/// from suggestions and autocorrection.
class TrinoPasswordField extends StatefulWidget {
  const TrinoPasswordField({
    super.key,
    required this.label,
    required this.showLabel,
    this.controller,
    this.error,
    this.helper,
    this.onChanged,
    this.onSubmitted,
    this.textInputAction,
    this.focusNode,
    this.autofocus = false,
    this.autofillHints = const [AutofillHints.password],
  });

  final String label;

  /// The toggle's name, such as "Mostrar contraseña". It stays the same; its
  /// toggled state tells whether the password shows.
  final String showLabel;
  final TextEditingController? controller;
  final String? error;
  final String? helper;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final TextInputAction? textInputAction;
  final FocusNode? focusNode;
  final bool autofocus;
  final Iterable<String>? autofillHints;

  @override
  State<TrinoPasswordField> createState() => _TrinoPasswordFieldState();
}

class _TrinoPasswordFieldState extends State<TrinoPasswordField> {
  bool _visible = false;

  @override
  Widget build(BuildContext context) => TrinoTextField(
    label: widget.label,
    controller: widget.controller,
    error: widget.error,
    helper: widget.helper,
    onChanged: widget.onChanged,
    onSubmitted: widget.onSubmitted,
    textInputAction: widget.textInputAction,
    focusNode: widget.focusNode,
    autofocus: widget.autofocus,
    autofillHints: widget.autofillHints,
    obscureText: !_visible,
    autocorrect: false,
    enableSuggestions: false,
    keyboardType: TextInputType.visiblePassword,
    trailing: TrinoIconButton(
      icon: _visible ? TrinoIcons.eyeOff : TrinoIcons.eye,
      label: widget.showLabel,
      variant: IconButtonVariant.muted,
      pressed: _visible,
      onPressed: () => setState(() => _visible = !_visible),
    ),
  );
}
