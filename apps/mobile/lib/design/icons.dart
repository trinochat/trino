// The app's icons: the stroke icons of the approved prototype (24×24, round
// caps and joins), drawn from their SVG path data, so the app shares the
// desktop's look instead of the stock Material set.
import 'package:flutter/widgets.dart';

enum TrinoIcons {
  back([_P('M15 6l-6 6 6 6')]),
  chevronRight([_P('M9 6l6 6-6 6')]),
  chevronDown([_P('M6 9l6 6 6-6')]),
  chevronUp([_P('M6 15l6-6 6 6')]),
  close([_P('M6 6l12 12'), _P('M18 6L6 18')]),
  plus([_P('M12 5v14'), _P('M5 12h14')]),
  search([_C(11, 11, 6.5), _P('M16 16l4 4')]),
  compose([
    _P('M12 4.5H6.5a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2V12'),
    _P('M17.5 3.5a2 2 0 012.8 2.8L12 14.6l-3.6.8.8-3.6 8.3-8.3z'),
  ]),
  chats([
    _P('M5 5h14a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0119 17h-9l-4.5 3.5V17H5a1.5 1.5 0 01-1.5-1.5v-9A1.5 1.5 0 015 5z'),
  ]),
  contacts([_C(12, 8.5, 3.5), _P('M5 20c.9-3.6 3.7-5.5 7-5.5s6.1 1.9 7 5.5')]),
  userPlus([_C(10, 8.5, 3.5), _P('M3.5 20c.8-3.5 3.4-5.5 6.5-5.5 1.6 0 3 .5 4.1 1.4'), _P('M18 13v6'), _P('M15 16h6')]),
  users([
    _C(9, 8.5, 3.5),
    _P('M2.5 19.5c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5'),
    _P('M15.5 5.2a3.5 3.5 0 010 6.6'),
    _P('M17.5 14.8c2.1.6 3.5 2.2 4 4.7'),
  ]),
  settings([
    _P(
      'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 '
      '11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 '
      '1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 '
      '1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 '
      '2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    ),
    _C(12, 12, 3),
  ]),
  phone([
    _P('M6.5 4h3l1.5 4-2 1.3a10.5 10.5 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 6.2 2 2 0 016.5 4z'),
  ]),
  // The phone with an arrow into it, out of it, or crossed: the direction of
  // a call in the history, always beside its word.
  phoneIncoming([
    _P('M6.5 4h3l1.5 4-2 1.3a10.5 10.5 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 6.2 2 2 0 016.5 4z'),
    _P('M20.5 3.5L15 9'),
    _P('M15 5v4h4'),
  ]),
  phoneOutgoing([
    _P('M6.5 4h3l1.5 4-2 1.3a10.5 10.5 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 6.2 2 2 0 016.5 4z'),
    _P('M15 9l5.5-5.5'),
    _P('M16.5 3.5h4v4'),
  ]),
  phoneMissed([
    _P('M6.5 4h3l1.5 4-2 1.3a10.5 10.5 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 6.2 2 2 0 016.5 4z'),
    _P('M15 3.5l5 5'),
    _P('M20 3.5l-5 5'),
  ]),
  inbox([
    _P('M21.5 12h-5.5l-2 3h-4l-2-3H2.5'),
    _P('M5.5 5.1L2.5 12v6a2 2 0 002 2h15a2 2 0 002-2v-6l-3-6.9A2 2 0 0016.7 4H7.3a2 2 0 00-1.8 1.1z'),
  ]),
  trash([
    _P('M4 6.5h16'),
    _P('M18 6.5V19a2 2 0 01-2 2H8a2 2 0 01-2-2V6.5'),
    _P('M9 6.5V4.5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 4.5v2'),
  ]),
  ban([_C(12, 12, 8.5), _P('M6 6l12 12')]),
  flag([_P('M5.5 21V4'), _P('M5.5 4h12l-2.5 4.5 2.5 4.5h-12')]),
  file([_P('M14 3.5H7.5a2 2 0 00-2 2v13a2 2 0 002 2h9a2 2 0 002-2V8z'), _P('M14 3.5V8h4.5')]),
  video([_R(3.5, 6.5, 12, 11, 2), _P('M15.5 10.5l5-3v9l-5-3')]),
  videoOff([_R(3.5, 6.5, 12, 11, 2), _P('M15.5 10.5l5-3v9l-5-3'), _P('M3 3l18 18')]),
  mic([_R(9, 3, 6, 11, 3), _P('M5 11a7 7 0 0014 0'), _P('M12 18v3')]),
  micOff([_R(9, 3, 6, 11, 3), _P('M5 11a7 7 0 0014 0'), _P('M12 18v3'), _P('M4 4l16 16')]),
  speaker([_P('M4 9.5h3.5L12 5.5v13l-4.5-4H4z'), _P('M15.5 9a4 4 0 010 6'), _P('M18 6.5a7.5 7.5 0 010 11')]),
  hangUp([_P('M3 14.5c5-4.7 13-4.7 18 0l-2.3 2.6-3.5-1.5.2-2.4a10.5 10.5 0 00-6.8 0l.2 2.4-3.5 1.5L3 14.5z')]),
  send([_P('M4 12l16-8-6 16-2.5-6.5L4 12z')]),
  smile([_C(12, 12, 8.5), _P('M8.5 14.5a4.5 4.5 0 007 0'), _P('M9 9.5v.01'), _P('M15 9.5v.01')]),
  sticker([
    _P('M20 12.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h6.5'),
    _P('M20 12.5L12.5 20a7.5 7.5 0 017.5-7.5z'),
  ]),
  check([_P('M5 12.5l4.5 4.5L19 7.5')], stroke: 2.2),
  clock([_C(12, 12, 8.5), _P('M12 7.5V12l3 2')], stroke: 2),
  alertCircle([_C(12, 12, 8.5), _P('M12 7.5v5.5'), _P('M12 16.5v.01')], stroke: 2),
  info([_C(12, 12, 8.5), _P('M12 11v5'), _P('M12 8v.01')]),
  warning([_P('M12 4l9 16H3l9-16z'), _P('M12 10v4'), _P('M12 17v.01')]),
  shield([_P('M12 3l7 3v5.5c0 4.2-2.9 7.8-7 9.5-4.1-1.7-7-5.3-7-9.5V6l7-3z')], stroke: 2),
  shieldCheck([
    _P('M12 3l7 3v5.5c0 4.2-2.9 7.8-7 9.5-4.1-1.7-7-5.3-7-9.5V6l7-3z'),
    _P('M8.8 12.2l2.3 2.3 4.3-4.6'),
  ], stroke: 2),
  shieldAlert([
    _P('M12 3l7 3v5.5c0 4.2-2.9 7.8-7 9.5-4.1-1.7-7-5.3-7-9.5V6l7-3z'),
    _P('M12 8v4.5'),
    _P('M12 16v.01'),
  ], stroke: 2),
  // The corners of a viewfinder: "Escanear el código".
  scan([
    _P('M4 8V6a2 2 0 012-2h2'),
    _P('M16 4h2a2 2 0 012 2v2'),
    _P('M20 16v2a2 2 0 01-2 2h-2'),
    _P('M8 20H6a2 2 0 01-2-2v-2'),
  ]),
  qr([
    _R(4, 4, 6, 6, 1),
    _R(14, 4, 6, 6, 1),
    _R(4, 14, 6, 6, 1),
    _P('M14 14h2v2h-2z'),
    _P('M18 18h2v2h-2z'),
    _P('M18 14h2'),
    _P('M14 18v2'),
  ]),
  copy([_R(8.5, 8.5, 11, 11, 2), _P('M15.5 8.5v-2a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2')]),
  lock([_R(5, 10.5, 14, 9.5, 2), _P('M8 10.5v-3a4 4 0 018 0v3')]),
  eye([_P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), _C(12, 12, 3)]),
  eyeOff([_P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), _C(12, 12, 3), _P('M4 4l16 16')]),
  bell([_P('M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z'), _P('M10 21h4')]),
  bellOff([_P('M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z'), _P('M10 21h4'), _P('M4 4l16 16')]),
  // Lucide's pin, mail and mail-open: a pinned chat, "No leído" and "Leído".
  pin([
    _P('M12 17v5'),
    _P(
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79'
      'l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    ),
  ]),
  mail([_R(2, 4, 20, 16, 2), _P('m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7')]),
  mailOpen([
    _P('M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z'),
    _P('m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10'),
  ]),
  palette([
    _P(
      'M12 3.5a8.5 8.5 0 100 17c1.2 0 1.8-.9 1.4-1.9-.5-1.2.3-2.6 1.6-2.6h1.8a3.7 3.7 0 003.7-3.7C20.5 7.2 16.7 3.5 12 3.5z',
    ),
    _P('M7.5 11.5v.01'),
    _P('M10 7.5v.01'),
    _P('M14.5 7.5v.01'),
  ]),
  globe([
    _C(12, 12, 8.5),
    _P('M3.5 12h17'),
    _P('M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5z'),
  ]),
  atSign([_C(12, 12, 4), _P('M16 8v4.5a1.75 1.75 0 003.5 0V12a7.5 7.5 0 10-3 6')]),
  key([_P('M15.5 7.5l2.3 2.3a1 1 0 001.4 0l2.1-2.1a1 1 0 000-1.4L19 4'), _P('M21 2l-9.6 9.6'), _C(7.5, 15.5, 5.5)]),
  // A window with its right side marked off: the info beside the chat.
  sidePanel([_R(3, 3, 18, 18, 2), _P('M15 3v18')]),
  smartphone([_R(5, 2, 14, 20, 2), _P('M12 18h.01')]),
  door([_P('M18 20V6a2 2 0 00-2-2H8a2 2 0 00-2 2v14'), _P('M3 20h18'), _P('M14 12v.01')]),
  laptop([
    _P('M20 16V7a2 2 0 00-2-2H6a2 2 0 00-2 2v9'),
    _P('M20 16H4'),
    _P('M20 16l1.28 2.55a1 1 0 01-.9 1.45H3.62a1 1 0 01-.9-1.45L4 16'),
  ]),
  sliders([
    _P('M4 6h10'),
    _P('M18 6h2'),
    _C(16, 6, 2),
    _P('M4 12h3'),
    _P('M11 12h9'),
    _C(9, 12, 2),
    _P('M4 18h10'),
    _P('M18 18h2'),
    _C(16, 18, 2),
  ]);

  const TrinoIcons(this._parts, {this.stroke = 1.8});

  final List<_Part> _parts;

  /// Stroke width in the 24×24 box.
  final double stroke;

  static final _paths = <TrinoIcons, Path>{};

  /// The outline in its 24×24 box, parsed once.
  Path get path => _paths[this] ??= _parts.fold(Path(), (path, part) => part.addTo(path));
}

sealed class _Part {
  const _Part();
  Path addTo(Path path);
}

/// SVG path data.
class _P extends _Part {
  const _P(this.data);
  final String data;
  @override
  Path addTo(Path path) => path..addPath(parseSvgPath(data), Offset.zero);
}

/// A circle.
class _C extends _Part {
  const _C(this.cx, this.cy, this.r);
  final double cx, cy, r;
  @override
  Path addTo(Path path) => path..addOval(Rect.fromCircle(center: Offset(cx, cy), radius: r));
}

/// A rectangle with rounded corners.
class _R extends _Part {
  const _R(this.x, this.y, this.width, this.height, this.rx);
  final double x, y, width, height, rx;
  @override
  Path addTo(Path path) =>
      path..addRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x, y, width, height), Radius.circular(rx)));
}

/// An icon of the set. It is decoration, hidden from screen readers, unless
/// it gets a [semanticLabel]. Size and colour default to the [IconTheme].
class TrinoIcon extends StatelessWidget {
  const TrinoIcon(this.icon, {super.key, this.size, this.color, this.semanticLabel});

  final TrinoIcons icon;
  final double? size;
  final Color? color;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final theme = IconTheme.of(context);
    final dimension = size ?? theme.size ?? 24;
    // Centred, so a larger box (a prefix slot, a tight constraint) keeps it in the middle.
    final painted = Center(
      widthFactor: 1,
      heightFactor: 1,
      child: SizedBox.square(
        dimension: dimension,
        child: CustomPaint(painter: TrinoIconPainter(icon, color ?? theme.color ?? const Color(0xFF000000))),
      ),
    );
    final label = semanticLabel;
    if (label == null) return ExcludeSemantics(child: painted);
    return Semantics(
      image: true,
      label: label,
      child: ExcludeSemantics(child: painted),
    );
  }
}

class TrinoIconPainter extends CustomPainter {
  TrinoIconPainter(this.icon, this.color);

  final TrinoIcons icon;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.shortestSide / 24;
    canvas.scale(scale);
    canvas.drawPath(
      icon.path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = icon.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..isAntiAlias = true,
    );
  }

  @override
  bool shouldRepaint(TrinoIconPainter oldDelegate) => oldDelegate.icon != icon || oldDelegate.color != color;
}

/// A [Path] from SVG path data: every command (M L H V C S Q T A Z), absolute
/// and relative, with implicit repeats and numbers written together, as
/// minified SVG has them. Throws a [FormatException] on malformed data.
Path parseSvgPath(String data) {
  final scanner = _PathScanner(data);
  final path = Path();
  var command = '';
  var current = Offset.zero;
  var start = Offset.zero;
  // The last control point, which S and T reflect.
  Offset? cubicControl;
  Offset? quadControl;

  while (!scanner.atEnd) {
    if (scanner.atCommand) {
      command = scanner.command();
    } else if (command.isEmpty || command == 'Z' || command == 'z') {
      throw FormatException('Expected a path command', data, scanner.index);
    }
    final relative = command == command.toLowerCase();
    final base = relative ? current : Offset.zero;
    Offset point() => base + Offset(scanner.number(), scanner.number());

    switch (command.toUpperCase()) {
      case 'M':
        current = start = point();
        path.moveTo(current.dx, current.dy);
        // Further coordinates are lines.
        command = relative ? 'l' : 'L';
        cubicControl = quadControl = null;
      case 'L':
        current = point();
        path.lineTo(current.dx, current.dy);
        cubicControl = quadControl = null;
      case 'H':
        final x = scanner.number();
        current = Offset(relative ? current.dx + x : x, current.dy);
        path.lineTo(current.dx, current.dy);
        cubicControl = quadControl = null;
      case 'V':
        final y = scanner.number();
        current = Offset(current.dx, relative ? current.dy + y : y);
        path.lineTo(current.dx, current.dy);
        cubicControl = quadControl = null;
      case 'C':
        final first = point();
        final second = point();
        current = point();
        path.cubicTo(first.dx, first.dy, second.dx, second.dy, current.dx, current.dy);
        cubicControl = second;
        quadControl = null;
      case 'S':
        final first = cubicControl == null ? current : current * 2 - cubicControl;
        final second = point();
        final end = point();
        path.cubicTo(first.dx, first.dy, second.dx, second.dy, end.dx, end.dy);
        current = end;
        cubicControl = second;
        quadControl = null;
      case 'Q':
        final control = point();
        current = point();
        path.quadraticBezierTo(control.dx, control.dy, current.dx, current.dy);
        quadControl = control;
        cubicControl = null;
      case 'T':
        final control = quadControl == null ? current : current * 2 - quadControl;
        current = point();
        path.quadraticBezierTo(control.dx, control.dy, current.dx, current.dy);
        quadControl = control;
        cubicControl = null;
      case 'A':
        final radius = Radius.elliptical(scanner.number(), scanner.number());
        final rotation = scanner.number();
        final largeArc = scanner.flag();
        final sweep = scanner.flag();
        current = point();
        // SVG's positive sweep is clockwise on screen, as in Flutter.
        path.arcToPoint(current, radius: radius, rotation: rotation, largeArc: largeArc, clockwise: sweep);
        cubicControl = quadControl = null;
      case 'Z':
        path.close();
        current = start;
        cubicControl = quadControl = null;
      default:
        throw FormatException('Unknown path command "$command"', data, scanner.index);
    }
  }
  return path;
}

class _PathScanner {
  _PathScanner(this.source);

  final String source;
  int index = 0;

  static const _commands = 'MmLlHhVvCcSsQqTtAaZz';

  void _skipSeparators() {
    while (index < source.length && ' ,\t\r\n'.contains(source[index])) {
      index++;
    }
  }

  bool get atEnd {
    _skipSeparators();
    return index >= source.length;
  }

  bool get atCommand {
    _skipSeparators();
    return index < source.length && _commands.contains(source[index]);
  }

  String command() => source[index++];

  double number() {
    _skipSeparators();
    final begin = index;
    if (index < source.length && '+-'.contains(source[index])) index++;
    var digits = false;
    var dot = false;
    while (index < source.length) {
      final char = source[index];
      if (_isDigit(char)) {
        digits = true;
      } else if (char == '.' && !dot) {
        dot = true;
      } else {
        break;
      }
      index++;
    }
    if (digits && index < source.length && 'eE'.contains(source[index])) {
      final mark = index;
      index++;
      if (index < source.length && '+-'.contains(source[index])) index++;
      if (index < source.length && _isDigit(source[index])) {
        while (index < source.length && _isDigit(source[index])) {
          index++;
        }
      } else {
        index = mark;
      }
    }
    if (!digits) throw FormatException('Expected a number', source, begin);
    return double.parse(source.substring(begin, index));
  }

  /// An arc flag: a single 0 or 1, which may touch the next number.
  bool flag() {
    _skipSeparators();
    if (index < source.length) {
      final char = source[index++];
      if (char == '0') return false;
      if (char == '1') return true;
    }
    throw FormatException('Expected an arc flag', source, index - 1);
  }

  static bool _isDigit(String char) => char.codeUnitAt(0) >= 0x30 && char.codeUnitAt(0) <= 0x39;
}
