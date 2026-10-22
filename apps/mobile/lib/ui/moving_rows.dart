// Rows of a list that move with the theme's motion (TrinoMotion) when their
// order changes, as the inbox does when a chat is pinned or gets a message:
// each row slides from where it was to its new place. A row that goes away
// closes (its height shrinks to nothing) instead of vanishing, and a new one
// opens. With Reduce Motion nothing slides or closes: rows change place at
// once, and they only fade in and out; with Remove animations, or for a
// change asked with [MovingRows.snap], everything changes at once.
//
// A sliver, so a long list still builds only what shows. A leaving row is
// neither read nor tappable.
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import '../design/theme.dart';

/// A row of [MovingRows]: its key says which it is from one change to the next.
typedef MovingRow = ({Key key, Widget child});

class MovingRows extends StatefulWidget {
  const MovingRows({super.key, required this.rows, this.snap = false});

  final List<MovingRow> rows;

  /// Applies this change at once, such as a new filter or search: a whole new
  /// list, not rows that moved.
  final bool snap;

  @override
  State<MovingRows> createState() => _MovingRowsState();
}

class _Entry {
  _Entry(this.key, this.child);

  final Key key;
  Widget child;

  /// As last laid out, with any opening or closing; null until then.
  double? height;

  /// Slides it from [moveFrom] (how far below its place, in dp; negative is
  /// above) to its place.
  AnimationController? move;
  double moveFrom = 0;

  /// Opens it (forward) or closes it (reverse); null when it simply shows.
  AnimationController? presence;
  bool leaving = false;

  /// How far from its place it shows right now.
  double offset(Curve curve) {
    final move = this.move;
    if (move == null || moveFrom == 0) return 0;
    return moveFrom * (1 - curve.transform(move.value));
  }

  void dispose() {
    move?.dispose();
    presence?.dispose();
  }
}

class _MovingRowsState extends State<MovingRows> with TickerProviderStateMixin {
  var _entries = <_Entry>[];

  @override
  void initState() {
    super.initState();
    _entries = [for (final row in widget.rows) _Entry(row.key, row.child)];
  }

  @override
  void dispose() {
    for (final entry in _entries) {
      entry.dispose();
    }
    super.dispose();
  }

  @override
  void didUpdateWidget(MovingRows oldWidget) {
    super.didUpdateWidget(oldWidget);
    final motion = context.motion;
    if (widget.snap || motion.medium == Duration.zero) return _snap();

    final before = _entries;
    final old = {for (final entry in before) entry.key: entry};
    final fallback = _typicalHeight();
    // Where each row shows now, from the top of the rows.
    final shownAt = <Key, double>{};
    var top = 0.0;
    for (final entry in before) {
      shownAt[entry.key] = top + entry.offset(motion.curve);
      top += entry.height ?? fallback;
    }

    final keys = {for (final row in widget.rows) row.key};
    final next = <_Entry>[];
    for (final row in widget.rows) {
      final entry = old[row.key];
      if (entry == null) {
        next.add(_enter(_Entry(row.key, row.child), motion));
        continue;
      }
      entry.child = row.child;
      if (entry.leaving) {
        // Back before it finished closing: it opens again from where it is.
        entry.leaving = false;
        entry.presence?.forward();
      }
      next.add(entry);
    }
    // What went away stays where it was while it closes: after the row that
    // was above it, or at the top.
    for (final (index, entry) in before.indexed) {
      if (keys.contains(entry.key)) continue;
      final above = index == 0 ? null : before[index - 1].key;
      final at = above == null ? 0 : next.indexWhere((e) => e.key == above) + 1;
      next.insert(at, _leave(entry, motion));
    }

    // Each row that stayed slides from where it showed to its new place.
    top = 0;
    for (final entry in next) {
      final from = shownAt[entry.key];
      if (from != null && !entry.leaving && motion.travels) {
        final distance = from - top;
        if (distance.abs() > 0.5) {
          entry.moveFrom = distance;
          (entry.move ??= AnimationController(vsync: this, duration: motion.medium))
            ..duration = motion.medium
            ..forward(from: 0);
        } else {
          entry.moveFrom = 0;
          entry.move?.stop();
        }
      }
      // A row that opens takes no room yet.
      top += old[entry.key] == null ? 0 : entry.height ?? fallback;
    }
    _entries = next;
  }

  _Entry _enter(_Entry entry, TrinoMotion motion) {
    entry.presence = AnimationController(vsync: this, duration: motion.medium)..forward();
    return entry;
  }

  _Entry _leave(_Entry entry, TrinoMotion motion) {
    if (entry.leaving) return entry;
    entry.leaving = true;
    final presence = entry.presence ??= AnimationController(vsync: this, duration: motion.medium, value: 1);
    // With Reduce Motion it only fades, in the short time.
    presence.duration = motion.travels ? motion.medium : motion.short;
    presence.reverse().whenCompleteOrCancel(() {
      if (!mounted || !entry.leaving || presence.value > 0 || !_entries.contains(entry)) return;
      setState(() => _entries.remove(entry));
      entry.dispose();
    });
    return entry;
  }

  void _snap() {
    final old = {for (final entry in _entries) entry.key: entry};
    final next = <_Entry>[];
    for (final row in widget.rows) {
      final entry = old.remove(row.key) ?? _Entry(row.key, row.child);
      entry
        ..child = row.child
        ..leaving = false
        ..moveFrom = 0;
      entry.move?.dispose();
      entry.presence?.dispose();
      entry
        ..move = null
        ..presence = null;
      next.add(entry);
    }
    for (final entry in old.values) {
      entry.dispose();
    }
    _entries = next;
  }

  double _typicalHeight() {
    final known = [
      for (final entry in _entries)
        if (entry.height case final height? when !entry.leaving && entry.presence == null) height,
    ];
    return known.isEmpty ? 72 : known.reduce((a, b) => a + b) / known.length;
  }

  @override
  Widget build(BuildContext context) {
    final motion = context.motion;
    return SliverList(
      delegate: SliverChildListDelegate([
        for (final entry in _entries) _Slot(key: entry.key, entry: entry, motion: motion),
      ]),
    );
  }
}

class _Slot extends StatelessWidget {
  const _Slot({super.key, required this.entry, required this.motion});

  final _Entry entry;
  final TrinoMotion motion;

  @override
  Widget build(BuildContext context) {
    final move = entry.move;
    final presence = entry.presence;
    // The same widgets whatever happens, so the row inside keeps its state
    // (an open swipe, a pressed ink) when it starts or stops moving.
    return _Measured(
      onHeight: (height) => entry.height = height,
      child: ListenableBuilder(
        listenable: Listenable.merge([?move, ?presence]),
        builder: (context, child) {
          final shown = presence == null ? 1.0 : motion.fadeCurve.transform(presence.value);
          // Closing and opening change the height: not with Reduce Motion.
          final height = motion.travels ? shown : 1.0;
          return IgnorePointer(
            ignoring: entry.leaving,
            child: ExcludeSemantics(
              excluding: entry.leaving,
              child: Transform.translate(
                offset: Offset(0, entry.offset(motion.curve)),
                child: ClipRect(
                  clipBehavior: height < 1 ? Clip.hardEdge : Clip.none,
                  child: Align(
                    alignment: Alignment.topCenter,
                    heightFactor: height,
                    child: Opacity(opacity: shown, child: child),
                  ),
                ),
              ),
            ),
          );
        },
        child: entry.child,
      ),
    );
  }
}

/// Tells its height on each layout, without rebuilding anything.
class _Measured extends SingleChildRenderObjectWidget {
  const _Measured({required this.onHeight, super.child});

  final ValueChanged<double> onHeight;

  @override
  RenderObject createRenderObject(BuildContext context) => _RenderMeasured(onHeight);

  @override
  void updateRenderObject(BuildContext context, _RenderMeasured renderObject) => renderObject.onHeight = onHeight;
}

class _RenderMeasured extends RenderProxyBox {
  _RenderMeasured(this.onHeight);

  ValueChanged<double> onHeight;

  @override
  void performLayout() {
    super.performLayout();
    onHeight(size.height);
  }
}
