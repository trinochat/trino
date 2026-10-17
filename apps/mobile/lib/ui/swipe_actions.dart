// A row that slides sideways to show its actions, as in WhatsApp: built from
// a drag and an animation, without a package.
//
// Swiping towards the end (right in Spanish) shows the start actions at the
// start edge; swiping towards the start shows the end actions. Each list goes
// from the screen's edge inwards, and a long swipe does the first one. Only
// one row of a [SwipeGroup] is open at a time; tapping anywhere else,
// scrolling or tapping the row itself closes it. With reduced motion it
// snaps instead of sliding.
//
// The gesture is never the only way: the screen also offers each action in
// the long-press sheet and as screen reader actions. Once shown, each action
// is a real button with its name.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/icons.dart';
import '../design/theme.dart';

@immutable
class SwipeAction {
  const SwipeAction({
    required this.icon,
    required this.label,
    required this.background,
    required this.foreground,
    required this.onPressed,
  });

  final TrinoIcons icon;
  final String label;
  final Color background;
  final Color foreground;
  final VoidCallback onPressed;
}

/// Keeps one [SwipeActions] of its subtree open at a time, and closes it when
/// a list inside scrolls.
class SwipeGroup extends StatefulWidget {
  const SwipeGroup({super.key, required this.child});

  final Widget child;

  @override
  State<SwipeGroup> createState() => _SwipeGroupState();
}

class _SwipeGroupState extends State<SwipeGroup> {
  _SwipeActionsState? _open;

  void _opened(_SwipeActionsState row) {
    if (_open != row) _open?.close();
    _open = row;
  }

  void _closed(_SwipeActionsState row) {
    if (_open == row) _open = null;
  }

  @override
  Widget build(BuildContext context) => NotificationListener<ScrollStartNotification>(
    onNotification: (notification) {
      _open?.close();
      return false;
    },
    child: _SwipeGroupScope(group: this, child: widget.child),
  );
}

class _SwipeGroupScope extends InheritedWidget {
  const _SwipeGroupScope({required this.group, required super.child});

  final _SwipeGroupState group;

  @override
  bool updateShouldNotify(_SwipeGroupScope oldWidget) => group != oldWidget.group;
}

class SwipeActions extends StatefulWidget {
  const SwipeActions({super.key, required this.child, this.startActions = const [], this.endActions = const []});

  final Widget child;

  /// Shown at the start edge by swiping towards the end, from the edge
  /// inwards; a long swipe does the first.
  final List<SwipeAction> startActions;

  /// Shown at the end edge by swiping towards the start, from the edge
  /// inwards; a long swipe does the first.
  final List<SwipeAction> endActions;

  /// The width of each action once the row is open.
  static const actionWidth = 76.0;

  /// A swipe past this share of the row's width does the first action.
  static const longSwipe = 0.6;

  @override
  State<SwipeActions> createState() => _SwipeActionsState();
}

class _SwipeActionsState extends State<SwipeActions> with SingleTickerProviderStateMixin {
  /// How far the row slid, in logical pixels: positive shows the start
  /// actions, negative the end ones, whatever the text direction.
  late final _offset = AnimationController.unbounded(vsync: this);
  var _width = 0.0;
  var _pastLongSwipe = false;
  _SwipeGroupState? _group;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _group = context.getInheritedWidgetOfExactType<_SwipeGroupScope>()?.group;
  }

  @override
  void didUpdateWidget(SwipeActions oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The actions changed (a chat lost its "Silenciar"): keep inside them.
    final value = _offset.value;
    if ((value > 0 && widget.startActions.isEmpty) || (value < 0 && widget.endActions.isEmpty)) _offset.value = 0;
  }

  @override
  void dispose() {
    _group?._closed(this);
    _offset.dispose();
    super.dispose();
  }

  bool get _isOpen => _offset.value != 0;
  bool get _rtl => Directionality.of(context) == TextDirection.rtl;
  double _extent(List<SwipeAction> actions) => actions.length * SwipeActions.actionWidth;
  double get _longSwipeAt => _width * SwipeActions.longSwipe;

  Duration get _duration => reduceMotionOf(context) ? Duration.zero : const Duration(milliseconds: 200);

  void _animateTo(double target) {
    if (_duration == Duration.zero) {
      _offset.value = target;
    } else {
      _offset.animateTo(target, duration: _duration, curve: Curves.easeOutCubic);
    }
    setState(() {});
  }

  void close() {
    _group?._closed(this);
    if (mounted && _isOpen) _animateTo(0);
  }

  void _open(double target) {
    _group?._opened(this);
    _animateTo(target);
  }

  void _onDragStart(DragStartDetails details) {
    _offset.stop();
    _group?._opened(this);
  }

  void _onDragUpdate(DragUpdateDetails details) {
    final delta = _rtl ? -details.primaryDelta! : details.primaryDelta!;
    final min = widget.endActions.isEmpty ? 0.0 : -_width;
    final max = widget.startActions.isEmpty ? 0.0 : _width;
    _offset.value = (_offset.value + delta).clamp(min, max);
    final past = _offset.value.abs() >= _longSwipeAt;
    if (past != _pastLongSwipe) {
      // A tick as the first action takes the whole width, and back.
      HapticFeedback.selectionClick();
      setState(() => _pastLongSwipe = past);
    }
  }

  void _onDragEnd(DragEndDetails details) {
    final value = _offset.value;
    final velocity = (_rtl ? -1 : 1) * details.primaryVelocity!;
    final actions = value >= 0 ? widget.startActions : widget.endActions;
    final sign = value >= 0 ? 1.0 : -1.0;
    setState(() => _pastLongSwipe = false);
    if (actions.isEmpty || value == 0) return close();
    if (value.abs() >= _longSwipeAt) {
      close();
      actions.first.onPressed();
      return;
    }
    final extent = _extent(actions);
    final flungOpen = velocity * sign > 300;
    final flungShut = velocity * sign < -300;
    if (!flungShut && (flungOpen || value.abs() >= extent / 2)) {
      _open(sign * extent);
    } else {
      close();
    }
  }

  void _press(SwipeAction action) {
    close();
    action.onPressed();
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      _width = constraints.maxWidth;
      return TapRegion(
        onTapOutside: (_) {
          if (_isOpen) close();
        },
        child: GestureDetector(
          onHorizontalDragStart: _onDragStart,
          onHorizontalDragUpdate: _onDragUpdate,
          onHorizontalDragEnd: _onDragEnd,
          child: ClipRect(
            child: AnimatedBuilder(
              animation: _offset,
              child: widget.child,
              builder: (context, child) {
                final value = _offset.value;
                final actions = value > 0
                    ? widget.startActions
                    : value < 0
                    ? widget.endActions
                    : const <SwipeAction>[];
                return Stack(
                  children: [
                    if (actions.isNotEmpty)
                      Positioned.fill(
                        child: Align(
                          alignment: value > 0 ? AlignmentDirectional.centerStart : AlignmentDirectional.centerEnd,
                          child: SizedBox(
                            width: value.abs(),
                            child: _Revealed(
                              actions: actions,
                              atStart: value > 0,
                              width: value.abs(),
                              long: value.abs() >= _longSwipeAt,
                              onPressed: _press,
                            ),
                          ),
                        ),
                      ),
                    Transform.translate(
                      offset: Offset(_rtl ? -value : value, 0),
                      child: ColoredBox(
                        color: context.tokens.surface,
                        child: Stack(
                          children: [
                            child!,
                            // While open, a tap on the row closes it instead of opening it.
                            if (value != 0)
                              Positioned.fill(
                                child: ExcludeSemantics(
                                  child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: close),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
}

/// The actions behind the row, from the edge inwards. Narrower than their
/// width they share the space; past a long swipe the first takes it all.
class _Revealed extends StatelessWidget {
  const _Revealed({
    required this.actions,
    required this.atStart,
    required this.width,
    required this.long,
    required this.onPressed,
  });

  final List<SwipeAction> actions;
  final bool atStart;
  final double width;
  final bool long;
  final void Function(SwipeAction) onPressed;

  @override
  Widget build(BuildContext context) {
    final full = actions.length * SwipeActions.actionWidth;
    double widthOf(int index) {
      if (long) return index == 0 ? width : 0;
      if (width <= full) return width / actions.length;
      return index == 0 ? width - full + SwipeActions.actionWidth : SwipeActions.actionWidth;
    }

    final buttons = [
      for (final (index, action) in actions.indexed)
        SizedBox(
          width: widthOf(index),
          child: widthOf(index) < 1 ? null : _ActionButton(action: action, onPressed: () => onPressed(action)),
        ),
    ];
    return Row(children: atStart ? buttons : buttons.reversed.toList());
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.action, required this.onPressed});

  final SwipeAction action;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    button: true,
    label: action.label,
    excludeSemantics: true,
    onTap: onPressed,
    child: Material(
      color: action.background,
      child: InkWell(
        onTap: onPressed,
        child: OverflowBox(
          minWidth: SwipeActions.actionWidth,
          maxWidth: SwipeActions.actionWidth,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              TrinoIcon(action.icon, size: 22, color: action.foreground),
              const SizedBox(height: 4),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  action.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: context.text.caption.copyWith(color: action.foreground, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
