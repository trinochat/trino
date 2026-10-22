// The chat's message field: a 40 dp pill to the eye, as in Telegram, with the
// 3:1 boundary in controlLine and the 2 dp accent ring when focused. The place
// you can tap stays 48 dp tall: the pill is drawn 4 dp inside the field, so
// the field itself keeps the full target. Calma rounds the ends; Terminal
// keeps its square corners. It grows with the text up to five lines, then
// scrolls.
import 'package:flutter/material.dart';

import '../design/theme.dart';

class ComposerField extends StatefulWidget {
  const ComposerField({
    super.key,
    required this.controller,
    required this.hint,
    required this.semanticLabel,
    this.focusNode,
  });

  static const pillKey = ValueKey('composer-pill');

  /// How far the pill sits inside the 48 dp target, above and below.
  static const inset = 4.0;

  final TextEditingController controller;
  final String hint;

  /// The field's name for screen readers: it has no visible label.
  final String semanticLabel;
  final FocusNode? focusNode;

  @override
  State<ComposerField> createState() => _ComposerFieldState();
}

class _ComposerFieldState extends State<ComposerField> {
  FocusNode? _ownFocus;
  FocusNode get _focus => widget.focusNode ?? (_ownFocus ??= FocusNode());

  @override
  void initState() {
    super.initState();
    _focus.addListener(_onFocus);
  }

  @override
  void didUpdateWidget(ComposerField old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      (old.focusNode ?? _ownFocus)?.removeListener(_onFocus);
      _focus.addListener(_onFocus);
    }
  }

  void _onFocus() => setState(() {});

  @override
  void dispose() {
    _focus.removeListener(_onFocus);
    _ownFocus?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = context.text;
    final focused = _focus.hasFocus;
    // Round ends where the theme's bubbles are round (Calma); square otherwise.
    final radius = t.bubbleRadius >= 12 ? 20.0 : t.radius;
    final pill = ShapeDecoration(
      color: t.bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: BorderSide(color: focused ? t.accentText : t.controlLine, width: focused ? 2 : 1),
      ),
    );
    return Semantics(
      container: true,
      label: widget.semanticLabel,
      child: Stack(
        children: [
          Positioned.fill(
            top: ComposerField.inset,
            bottom: ComposerField.inset,
            child: DecoratedBox(key: ComposerField.pillKey, decoration: pill),
          ),
          TextField(
            controller: widget.controller,
            focusNode: _focus,
            minLines: 1,
            maxLines: 5,
            keyboardType: TextInputType.multiline,
            textInputAction: TextInputAction.newline,
            textCapitalization: TextCapitalization.sentences,
            style: text.body.copyWith(color: t.ink, height: 22 / 16),
            // A fixed 22 dp line in both themes' fonts, so one line plus the
            // padding is exactly the 40 dp pill.
            strutStyle: const StrutStyle(fontSize: 16, height: 22 / 16, forceStrutHeight: true),
            cursorColor: t.accentText,
            decoration: InputDecoration(
              hintText: widget.hint,
              hintStyle: text.body.copyWith(color: t.muted, height: 22 / 16),
              // The theme fills text fields; filled, this one would cover the
              // pill drawn under it.
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              isCollapsed: true,
              // 4 dp of target above and below the pill, plus the pill's own
              // padding around one line of body text: 48 dp in all.
              contentPadding: const EdgeInsets.fromLTRB(16, ComposerField.inset + 9, 16, ComposerField.inset + 9),
            ),
          ),
        ],
      ),
    );
  }
}
