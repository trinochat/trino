// The SAS v2 symbols on screen: the outline drawing from the desktop's table,
// stroked in a theme colour (never an emoji, whose look changes from phone to
// phone), and its word in the app's language. Screen readers hear the word;
// the drawing is decoration.
import 'package:flutter/widgets.dart';

import '../design/theme.dart';
import '../sas/sas_table.dart';

/// Builds [builder] once the table is read from the app bundle; until then,
/// [placeholder] (nothing by default). The table is read once per bundle.
class SasTableBuilder extends StatefulWidget {
  const SasTableBuilder({super.key, required this.builder, this.placeholder = const SizedBox.shrink()});

  final Widget Function(BuildContext context, SasTable table) builder;
  final Widget placeholder;

  @override
  State<SasTableBuilder> createState() => _SasTableBuilderState();
}

class _SasTableBuilderState extends State<SasTableBuilder> {
  Future<SasTable>? _table;
  SasTable? _ready;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bundle = DefaultAssetBundle.of(context);
    _ready = SasTable.loaded(bundle);
    _table = _ready == null ? SasTable.load(bundle) : null;
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<SasTable>(
    future: _table,
    initialData: _ready,
    builder: (context, snapshot) {
      // A table that fails to load is a broken build, not a state to show.
      if (snapshot.hasError) Error.throwWithStackTrace(snapshot.error!, snapshot.stackTrace ?? StackTrace.empty);
      final table = snapshot.data;
      return table == null ? widget.placeholder : widget.builder(context, table);
    },
  );
}

/// The drawing alone, for a row of symbols that is named as a whole.
class SasIcon extends StatelessWidget {
  const SasIcon({super.key, required this.symbol, this.size = 24, this.color});

  final SasSymbolData symbol;
  final double size;

  /// Default: the accent text colour, which reaches 3:1 on every surface.
  final Color? color;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox.square(
      dimension: size,
      child: CustomPaint(painter: SasIconPainter(symbol, color ?? context.tokens.accentText)),
    ),
  );
}

class SasIconPainter extends CustomPainter {
  SasIconPainter(this.symbol, this.color, {this.strokeWidth = 2});

  final SasSymbolData symbol;
  final Color color;

  /// In the 24 × 24 box, as the table says.
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.shortestSide / 24);
    final drawing = symbol.drawing;
    canvas.drawPath(drawing.fill, Paint()..color = color);
    canvas.drawPath(
      drawing.stroke,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(SasIconPainter oldDelegate) =>
      oldDelegate.symbol != symbol || oldDelegate.color != color || oldDelegate.strokeWidth != strokeWidth;
}

/// The drawing above its word, in the app's language.
class SasSymbolTile extends StatelessWidget {
  const SasSymbolTile({super.key, required this.symbol, this.size = 28});

  final SasSymbolData symbol;
  final double size;

  @override
  Widget build(BuildContext context) {
    final word = symbol.word(Localizations.localeOf(context).languageCode);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SasIcon(symbol: symbol, size: size),
        const SizedBox(height: 4),
        Text(
          word,
          textAlign: TextAlign.center,
          style: context.text.caption.copyWith(color: context.tokens.ink, fontWeight: FontWeight.w600),
        ),
      ],
    );
  }
}
