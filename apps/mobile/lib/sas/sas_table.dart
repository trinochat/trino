// The SAS v2 table (docs/sas-v2.md on the desktop): the 64 outline symbols two
// people compare during a call, each with its word in es, en and pt.
//
// assets/sas/sas-v2.json is a byte-for-byte copy of the desktop's file, taken
// from feat/rediseno @ 7b3d454 ("feat(sas): carry the drawing rules in
// sas-v2.json"), so the phone draws and names exactly what the computer does.
// The table is part of the human protocol, not of the translations: never edit
// the copy, copy it again. The drawings come from Lucide (ISC License, beside
// the file in LICENSE-lucide.txt).
//
// Which 7 symbols a call shows is not decided here: the engine derives the
// indices from the call (SHA-256 over the call id, both identities and both
// DTLS fingerprints), as it owns those inputs.
import 'dart:convert';
import 'dart:ui' show Offset, Path, RRect, Radius, Rect;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show AssetBundle;

import '../design/icons.dart' show parseSvgPath;

/// The commit of feat/rediseno the asset was copied from.
const kSasSourceCommit = '7b3d454f9cc4b6bdda3aee19c10c016cc34e13fd';

/// Where the table lives in the app bundle.
const kSasAsset = 'assets/sas/sas-v2.json';

/// How many symbols a call shows, and how many the table has.
const kSasLength = 7;
const kSasAlphabetSize = 64;

/// One SVG element of a drawing: its tag and its attributes.
@immutable
class SasNode {
  const SasNode(this.tag, this.attrs);

  final String tag;
  final Map<String, String> attrs;

  /// Drawn filled as well as stroked (the die's dot).
  bool get filled => attrs['fill'] == 'currentColor';

  double _number(String name) {
    final value = attrs[name];
    if (value == null) throw FormatException('<$tag> needs "$name"');
    return double.parse(value);
  }

  /// The element as a path in the 24 × 24 box. Throws a [FormatException] on
  /// an element the table does not use.
  Path path() {
    switch (tag) {
      case 'path':
        return parseSvgPath(attrs['d'] ?? '');
      case 'circle':
        return Path()..addOval(Rect.fromCircle(center: Offset(_number('cx'), _number('cy')), radius: _number('r')));
      case 'ellipse':
        return Path()..addOval(
          Rect.fromCenter(
            center: Offset(_number('cx'), _number('cy')),
            width: _number('rx') * 2,
            height: _number('ry') * 2,
          ),
        );
      case 'rect':
        final rect = Rect.fromLTWH(_number('x'), _number('y'), _number('width'), _number('height'));
        // SVG: a missing rx or ry takes the other's value.
        final rx = attrs.containsKey('rx') ? _number('rx') : (attrs.containsKey('ry') ? _number('ry') : 0.0);
        final ry = attrs.containsKey('ry') ? _number('ry') : rx;
        return Path()..addRRect(RRect.fromRectAndRadius(rect, Radius.elliptical(rx, ry)));
      case 'line':
        return Path()
          ..moveTo(_number('x1'), _number('y1'))
          ..lineTo(_number('x2'), _number('y2'));
      case 'polyline' || 'polygon':
        final numbers = (attrs['points'] ?? '')
            .trim()
            .split(RegExp(r'[\s,]+'))
            .where((part) => part.isNotEmpty)
            .map(double.parse)
            .toList();
        if (numbers.length < 4 || numbers.length.isOdd) throw FormatException('<$tag> has bad points');
        final path = Path()..moveTo(numbers[0], numbers[1]);
        for (var i = 2; i < numbers.length; i += 2) {
          path.lineTo(numbers[i], numbers[i + 1]);
        }
        if (tag == 'polygon') path.close();
        return path;
      default:
        throw FormatException('The SAS table has no drawing for <$tag>');
    }
  }
}

/// A symbol ready to paint: everything stroked, and the few filled parts.
@immutable
class SasDrawing {
  const SasDrawing(this.stroke, this.fill);

  final Path stroke;
  final Path fill;
}

@immutable
class SasSymbolData {
  SasSymbolData({required this.index, required this.lucide, required this.nodes, required this.words});

  final int index;

  /// The lucide-react component the drawing comes from.
  final String lucide;
  final List<SasNode> nodes;

  /// By language code: es, en and pt.
  final Map<String, String> words;

  /// The word in [language], or in English when Trino does not speak it.
  String word(String language) => words[language] ?? words['en']!;

  /// Built once, on first use.
  late final SasDrawing drawing = () {
    final stroke = Path();
    final fill = Path();
    for (final node in nodes) {
      final path = node.path();
      stroke.addPath(path, Offset.zero);
      if (node.filled) fill.addPath(path, Offset.zero);
    }
    return SasDrawing(stroke, fill);
  }();
}

@immutable
class SasTable {
  const SasTable({required this.version, required this.source, required this.strokeWidth, required this.symbols});

  /// Reads the JSON of sas-v2.json. Throws a [FormatException] unless it is
  /// version 2 with 64 symbols in index order, each with its three words.
  factory SasTable.parse(String json) {
    final Object? decoded = jsonDecode(json);
    if (decoded is! Map<String, Object?>) throw const FormatException('The SAS table is not an object');
    if (decoded['version'] != 2) throw FormatException('Not a SAS v2 table: version ${decoded['version']}');
    final symbols = <SasSymbolData>[];
    for (final (i, Object? raw) in ((decoded['symbols'] as List?) ?? const []).indexed) {
      final symbol = raw! as Map<String, Object?>;
      if (symbol['index'] != i) throw FormatException('SAS symbol $i is out of order');
      final words = (symbol['words']! as Map).cast<String, String>();
      for (final language in const ['es', 'en', 'pt']) {
        if ((words[language] ?? '').trim().isEmpty) throw FormatException('SAS symbol $i has no $language word');
      }
      symbols.add(
        SasSymbolData(
          index: i,
          lucide: symbol['lucide']! as String,
          words: Map.unmodifiable(words),
          nodes: List.unmodifiable([
            for (final node in symbol['nodes']! as List)
              SasNode((node as List)[0] as String, Map.unmodifiable((node[1] as Map).cast<String, String>())),
          ]),
        ),
      );
    }
    if (symbols.length != kSasAlphabetSize) {
      throw FormatException('A SAS v2 table has $kSasAlphabetSize symbols, not ${symbols.length}');
    }
    return SasTable(
      version: 2,
      source: decoded['source']! as String,
      strokeWidth: (decoded['strokeWidth']! as num).toDouble(),
      symbols: List.unmodifiable(symbols),
    );
  }

  final int version;

  /// Where the drawings come from: `lucide-react@<version>`.
  final String source;
  final double strokeWidth;
  final List<SasSymbolData> symbols;

  /// The symbol at an index from 0 to 63.
  SasSymbolData symbol(int index) {
    if (index < 0 || index >= symbols.length) throw RangeError.range(index, 0, symbols.length - 1, 'index');
    return symbols[index];
  }

  /// The words of a call's symbols, in order: what people read aloud.
  List<String> words(List<int> indices, String language) => [for (final i in indices) symbol(i).word(language)];

  static final _loaded = Expando<SasTable>();

  /// The table of [bundle] if it was read already, so a screen can draw it at
  /// once instead of waiting a frame.
  static SasTable? loaded(AssetBundle bundle) => _loaded[bundle];

  /// The table in [bundle], read once per bundle. Keeps the table, not the
  /// future, so a later caller never waits on another zone's future.
  static Future<SasTable> load(AssetBundle bundle) async {
    final cached = _loaded[bundle];
    if (cached != null) return cached;
    return _loaded[bundle] = SasTable.parse(await bundle.loadString(kSasAsset));
  }
}
