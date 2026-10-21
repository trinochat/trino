// Copyright 2014 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in LICENSE-flutter.txt beside this file (Flutter's LICENSE).
//
// Android's predictive back preview, shown only while the system back gesture
// is being dragged (Android 14+). Adapted from Flutter 3.47.5's
// `_PredictiveBackGestureDetector` and `_PredictiveBackSharedElementPageTransition`
// (packages/flutter/lib/src/material/predictive_back_page_transitions_builder.dart),
// which are private. Flutter's own builder falls back to a sideways fade when
// there is no gesture; Trino keeps its full slide instead, so only the gesture
// part is taken.
//
// Android sends the gesture only when the manifest has
// android:enableOnBackInvokedCallback="true" and the phone runs Android 14 or
// later. On older phones, and for the back button, nothing reaches the
// detector: the back press pops the page with the ordinary slide.
import 'dart:ui' show clampDouble;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Builds a page's transition, told whether the system back gesture is being
/// dragged on its navigator right now (the page being closed and the one
/// revealed below it both are).
typedef PredictiveBackTransitionBuilder = Widget Function(BuildContext context, PredictiveBackGesture? gesture);

/// The state of an Android back gesture, as one page sees it.
@immutable
class PredictiveBackGesture {
  const PredictiveBackGesture({required this.phase, this.start, this.current});

  final PredictiveBackPhase phase;

  /// The event that started the gesture, on the page being closed only.
  final PredictiveBackEvent? start;

  /// The latest event of the gesture, on the page being closed only.
  final PredictiveBackEvent? current;
}

enum PredictiveBackPhase {
  /// This page is not the one being dragged (the one revealed below it).
  idle,

  /// The finger touched the edge.
  start,

  /// The finger moved.
  update,

  /// Released far enough: the page closes.
  commit,

  /// Released back near the edge: the page stays.
  cancel,
}

/// The navigators whose current gesture came from Android's back gesture, as
/// opposed to the Cupertino edge drag, which also counts as a user gesture.
final Expando<bool> _predictiveGestures = Expando<bool>('predictive back gesture');

/// Hooks [route] to Android's system back gesture: while it is dragged, the
/// route's animation follows the finger, then the route closes on commit or
/// returns on cancel. [builder] is told whether such a gesture is underway.
class PredictiveBackGestureDetector extends StatefulWidget {
  const PredictiveBackGestureDetector({super.key, required this.route, required this.builder});

  final PageRoute<dynamic> route;
  final PredictiveBackTransitionBuilder builder;

  @override
  State<PredictiveBackGestureDetector> createState() => _PredictiveBackGestureDetectorState();
}

class _PredictiveBackGestureDetectorState extends State<PredictiveBackGestureDetector> with WidgetsBindingObserver {
  NavigatorState? _navigator;
  PredictiveBackPhase _phase = PredictiveBackPhase.idle;
  PredictiveBackEvent? _start;
  PredictiveBackEvent? _current;

  bool get _isEnabled => widget.route.isCurrent && widget.route.popGestureEnabled;

  void _set({required PredictiveBackPhase phase, PredictiveBackEvent? start, PredictiveBackEvent? current}) {
    if (!mounted) return;
    setState(() {
      _phase = phase;
      _start = start;
      _current = current;
    });
  }

  @override
  bool handleStartBackGesture(PredictiveBackEvent backEvent) {
    if (backEvent.isButtonEvent || !_isEnabled) return false;
    final navigator = widget.route.navigator!;
    // Before the route starts the gesture, so that every page rebuilt for it
    // already knows it is a predictive one.
    _predictiveGestures[navigator] = true;
    _set(phase: PredictiveBackPhase.start, start: backEvent, current: backEvent);
    widget.route.handleStartBackGesture(progress: 1 - backEvent.progress);
    return true;
  }

  @override
  void handleUpdateBackGestureProgress(PredictiveBackEvent backEvent) {
    _set(phase: PredictiveBackPhase.update, start: _start, current: backEvent);
    widget.route.handleUpdateBackGestureProgress(progress: 1 - backEvent.progress);
  }

  @override
  void handleCancelBackGesture() {
    _set(phase: PredictiveBackPhase.cancel);
    widget.route.handleCancelBackGesture();
  }

  @override
  void handleCommitBackGesture() {
    _set(phase: PredictiveBackPhase.commit);
    widget.route.handleCommitBackGesture();
  }

  /// The route keeps the user gesture on until its commit or cancel animation
  /// ends; then the page goes back to its ordinary transition.
  void _onUserGestureChanged() {
    final navigator = _navigator;
    if (navigator == null || navigator.userGestureInProgress) return;
    _predictiveGestures[navigator] = null;
    if (_phase != PredictiveBackPhase.idle) _set(phase: PredictiveBackPhase.idle);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _navigator = widget.route.navigator;
    _navigator?.userGestureInProgressNotifier.addListener(_onUserGestureChanged);
  }

  @override
  void dispose() {
    _navigator?.userGestureInProgressNotifier.removeListener(_onUserGestureChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final navigator = widget.route.navigator;
    final predictive =
        navigator != null && navigator.userGestureInProgress && (_predictiveGestures[navigator] ?? false);
    return widget.builder(
      context,
      predictive ? PredictiveBackGesture(phase: _phase, start: _start, current: _current) : null,
    );
  }
}

/// Android's shared-element predictive back preview: the page being closed
/// shrinks to 90 %, moves a little towards the edge the gesture came from and
/// follows the finger up or down, with rounded corners; on commit it fades out.
/// The page revealed below stays where it is.
///
/// See https://developer.android.com/design/ui/mobile/guides/patterns/predictive-back#shared-element-transition
class PredictiveBackPreview extends StatefulWidget {
  const PredictiveBackPreview({
    super.key,
    required this.animation,
    required this.gesture,
    required this.transitionDuration,
    required this.child,
  });

  final Animation<double> animation;
  final PredictiveBackGesture gesture;

  /// The route's transition duration, which the commit animation runs on.
  final Duration transitionDuration;
  final Widget child;

  @override
  State<PredictiveBackPreview> createState() => _PredictiveBackPreviewState();
}

class _PredictiveBackPreviewState extends State<PredictiveBackPreview> {
  // Constants as per the motion specs
  // https://developer.android.com/design/ui/mobile/guides/patterns/predictive-back#motion-specs
  static const double _kMinScale = 0.90;
  static const double _kDivisionFactor = 20.0;
  static const double _kMargin = 8.0;
  static const double _kYPositionFactor = 0.1;

  // The commit takes this long of the route's transition; eyeballed by Flutter
  // on a Pixel 9 running Android 16.
  static const int _kCommitMilliseconds = 400;
  static const Curve _kCurve = Curves.easeInOutCubicEmphasized;

  // Used when the phone does not report its display corners (before Android 12).
  static const double _kDeviceBorderRadius = 32.0;

  final Tween<double> _borderRadiusTween = Tween<double>(begin: 0.0, end: _kDeviceBorderRadius);
  final Tween<double> _opacityTween = Tween<double>(begin: 1.0, end: 0.0);
  final Tween<double> _scaleTween = Tween<double>(begin: 1.0, end: _kMinScale);

  // Zero before the commit; after it, from zero to one.
  final ProxyAnimation _commitAnimation = ProxyAnimation();

  // Up to one while dragged; at commit, from its last value back to zero.
  final ProxyAnimation _bounceAnimation = ProxyAnimation();
  double _lastBounceAnimationValue = 0.0;

  // The route's animation while dragged, then the commit animation.
  final ProxyAnimation _animation = ProxyAnimation();

  CurvedAnimation? _curvedAnimation;
  CurvedAnimation? _curvedAnimationReversed;
  late Animation<Offset> _positionAnimation;
  Offset _lastDrag = Offset.zero;

  PredictiveBackPhase get _phase => widget.gesture.phase;

  Interval get _commitInterval => Interval(
    0.0,
    clampDouble(_kCommitMilliseconds / widget.transitionDuration.inMilliseconds, 0.0, 1.0),
    curve: _kCurve,
  );

  // Follows the vertical drag, not the progress of the gesture.
  double _getYShiftPosition(double screenHeight) {
    final startTouchY = widget.gesture.start?.touchOffset?.dy ?? 0;
    final currentTouchY = widget.gesture.current?.touchOffset?.dy ?? 0;
    final yShiftMax = (screenHeight / _kDivisionFactor) - _kMargin;
    if (yShiftMax <= 0) return 0;
    final rawYShift = currentTouchY - startTouchY;
    final easedYShift =
        Curves.easeOut.transform(clampDouble(rawYShift.abs() / screenHeight, 0.0, 1.0)) * rawYShift.sign * yShiftMax;
    return clampDouble(easedYShift, -yShiftMax, yShiftMax);
  }

  void _updateAnimations(Size screenSize) {
    final committed = _phase == PredictiveBackPhase.commit;
    _animation.parent = committed ? _curvedAnimationReversed : widget.animation;
    _bounceAnimation.parent = committed
        ? Tween<double>(begin: 0.0, end: _lastBounceAnimationValue).animate(_curvedAnimation!)
        : ReverseAnimation(widget.animation);
    _commitAnimation.parent = committed ? _animation : kAlwaysDismissedAnimation;

    final xShift = (screenSize.width / _kDivisionFactor) - _kMargin;
    final yShift = _getYShiftPosition(screenSize.height);
    _positionAnimation = _animation.drive(
      committed
          ? Tween<Offset>(begin: _lastDrag, end: Offset(screenSize.height * _kYPositionFactor, 0.0))
          : Tween<Offset>(
              begin: switch (widget.gesture.current?.swipeEdge) {
                SwipeEdge.right => Offset(-xShift, yShift),
                SwipeEdge.left || null => Offset(xShift, yShift),
              },
              end: Offset.zero,
            ),
    );
  }

  void _updateCurvedAnimations() {
    _curvedAnimation?.dispose();
    _curvedAnimationReversed?.dispose();
    _curvedAnimation = CurvedAnimation(parent: widget.animation, curve: _commitInterval);
    _curvedAnimationReversed = CurvedAnimation(parent: ReverseAnimation(widget.animation), curve: _commitInterval);
  }

  @override
  void didUpdateWidget(PredictiveBackPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.animation != oldWidget.animation || widget.transitionDuration != oldWidget.transitionDuration) {
      _updateCurvedAnimations();
    }
    if (_phase != oldWidget.gesture.phase && _phase == PredictiveBackPhase.commit) {
      _updateAnimations(MediaQuery.sizeOf(context));
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _updateCurvedAnimations();
    _updateAnimations(MediaQuery.sizeOf(context));
  }

  @override
  void dispose() {
    _curvedAnimation?.dispose();
    _curvedAnimationReversed?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.animation,
      builder: (context, child) {
        _lastBounceAnimationValue = _bounceAnimation.value;
        return Transform.scale(
          scale: _scaleTween.evaluate(_bounceAnimation),
          child: Transform.translate(
            offset: switch (_phase) {
              PredictiveBackPhase.commit => _positionAnimation.value,
              _ => _lastDrag = Offset(_positionAnimation.value.dx, _getYShiftPosition(MediaQuery.heightOf(context))),
            },
            child: Opacity(
              opacity: _opacityTween.evaluate(_commitAnimation),
              child: ClipRRect(
                borderRadius:
                    MediaQuery.displayCornerRadiiOf(context) ??
                    BorderRadius.circular(_borderRadiusTween.evaluate(_bounceAnimation)),
                child: child,
              ),
            ),
          ),
        );
      },
      child: widget.child,
    );
  }
}
