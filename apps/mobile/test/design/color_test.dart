import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/color.dart';

void main() {
  group('WCAG 2.x relative luminance and contrast ratio', () {
    test('spans 0 to 1 and 1:1 to 21:1', () {
      expect(relativeLuminance(const Color(0xFF000000)), 0);
      expect(relativeLuminance(const Color(0xFFFFFFFF)), 1);
      expect(contrastRatio(const Color(0xFF000000), const Color(0xFFFFFFFF)), closeTo(21, 1e-10));
      expect(contrastRatio(const Color(0xFF0F7B4A), const Color(0xFF0F7B4A)), 1);
    });

    test('matches reference values', () {
      // The sRGB transfer function: 128/255 linearises to 0.2158605.
      expect(relativeLuminance(const Color(0xFF808080)), closeTo(0.21586, 1e-5));
      // #777 on white is the classic grey that just misses AA.
      expect(contrastRatio(const Color(0xFF777777), const Color(0xFFFFFFFF)), closeTo(4.48, 0.005));
      expect(contrastRatio(const Color(0xFF767676), const Color(0xFFFFFFFF)), greaterThanOrEqualTo(4.5));
    });

    test('does not depend on the order of the colours', () {
      expect(
        contrastRatio(const Color(0xFFFFFFFF), const Color(0xFF0F7B4A)),
        contrastRatio(const Color(0xFF0F7B4A), const Color(0xFFFFFFFF)),
      );
    });

    test('rejects translucent colours, whose contrast depends on the backdrop', () {
      expect(() => relativeLuminance(const Color(0x80FFFFFF)), throwsArgumentError);
    });
  });

  group('hex colours', () {
    test('parses #RRGGBB in any case into an opaque colour', () {
      expect(parseHexColor('#0f7b4a'), const Color(0xFF0F7B4A));
      expect(parseHexColor('#F5F7F6'), const Color(0xFFF5F7F6));
    });

    test('rejects anything but #RRGGBB', () {
      expect(() => parseHexColor('#FFF'), throwsFormatException);
      expect(() => parseHexColor('white'), throwsFormatException);
      expect(() => parseHexColor('#GGGGGG'), throwsFormatException);
    });

    test('prints an opaque colour back as #RRGGBB', () {
      expect(hexOf(const Color(0xFF0F7B4A)), '#0F7B4A');
    });
  });
}
