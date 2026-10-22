// A message as it arrives in the conversation, with the theme's motion
// (TrinoMotion): yours rises a little as it fades in (12 dp with a hint of
// spring in Calma, 6 dp crisp in Terminal); theirs only fade in. With Reduce
// Motion both only fade, and with Remove animations they are there at once.
// The history shown when a chat opens does not move: only what arrives while
// it is open.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

class MessageArrival extends StatefulWidget {
  const MessageArrival({super.key, required this.animate, this.rise = false, required this.child});

  /// Whether it arrives now. Read once, when it first shows: rebuilding it
  /// never starts the motion again.
  final bool animate;

  /// Whether it rises as it fades in, as your own messages do.
  final bool rise;

  final Widget child;

  @override
  State<MessageArrival> createState() => _MessageArrivalState();
}

class _MessageArrivalState extends State<MessageArrival> with SingleTickerProviderStateMixin {
  AnimationController? _controller;
  late TrinoMotion _motion;
  var _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _motion = context.motion;
    if (!widget.animate || _motion.medium == Duration.zero) return;
    _controller = AnimationController(vsync: this, duration: _motion.medium)..forward();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return widget.child;
    final motion = _motion;
    // The fade is over within the short time; the rise takes the medium one.
    final fadeEnd = motion.short.inMicroseconds / motion.medium.inMicroseconds;
    final faded = FadeTransition(
      opacity: CurvedAnimation(
        parent: controller,
        curve: Interval(0, fadeEnd.clamp(0.0, 1.0), curve: motion.fadeCurve),
      ),
      // Read from its first frame, while still clear.
      alwaysIncludeSemantics: true,
      child: widget.child,
    );
    final distance = widget.rise ? motion.rise : 0.0;
    return RepaintBoundary(
      child: distance == 0
          ? faded
          : AnimatedBuilder(
              animation: controller,
              builder: (context, child) => Transform.translate(
                offset: Offset(0, distance * (1 - motion.curve.transform(controller.value))),
                child: child,
              ),
              child: faded,
            ),
    );
  }
}
