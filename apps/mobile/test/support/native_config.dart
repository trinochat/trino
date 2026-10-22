// Reads the native projects as the stores see them: the Xcode project's build
// settings, Info.plist values and PNG headers. Only the shapes these files take
// here are understood, and anything else throws, so a test fails loudly instead
// of passing on a misread file. Line endings may be LF or CRLF.
import 'dart:io';
import 'dart:typed_data';

/// The build settings of each configuration of [target] (Debug, Release,
/// Profile) in a project.pbxproj, by configuration name. Only one-line
/// `KEY = value;` settings are read; lists such as LD_RUNPATH_SEARCH_PATHS are
/// left out. With [isa] `PBXProject`, the project's own settings, which every
/// target inherits unless it sets its own.
Map<String, Map<String, String>> xcodeBuildSettings(
  String pbxproj, {
  required String target,
  String isa = 'PBXNativeTarget',
}) {
  final list = RegExp(
    '/\\* Build configuration list for $isa "${RegExp.escape(target)}" \\*/ = \\{'
    r'[^}]*?buildConfigurations = \(([^)]*)\);',
  ).firstMatch(pbxproj);
  if (list == null) throw FormatException('No build configuration list for the target $target');
  return {
    for (final configuration in RegExp(r'([0-9A-F]{24}) /\* (\w+) \*/').allMatches(list[1]!))
      configuration[2]!: _buildSettings(pbxproj, configuration[1]!),
  };
}

Map<String, String> _buildSettings(String pbxproj, String id) {
  final configuration = RegExp(
    '\\b$id /\\* \\w+ \\*/ = \\{\\s*isa = XCBuildConfiguration;.*?buildSettings = \\{(.*?)\\n\\s*\\};\\s*name = ',
    dotAll: true,
  ).firstMatch(pbxproj);
  if (configuration == null) throw FormatException('No build configuration $id');
  return {
    for (final setting in RegExp(
      r'^\s*"?([^"\s=]+(?:\[[^\]]*\])?)"? = "?([^"\r\n;]*)"?;$',
      multiLine: true,
    ).allMatches(configuration[1]!))
      setting[1]!: setting[2]!,
  };
}

/// The string and boolean values of an XML plist (Info.plist,
/// ExportOptions.plist), by key. Comments are dropped first, so a key that
/// only appears in one does not count.
class Plist {
  Plist(String xml) : _xml = xml.replaceAll(RegExp('<!--.*?-->', dotAll: true), '');

  factory Plist.read(String path) => Plist(File(path).readAsStringSync());

  final String _xml;

  String? string(String key) =>
      RegExp('<key>${RegExp.escape(key)}</key>\\s*<string>([^<]*)</string>').firstMatch(_xml)?[1];

  bool? boolean(String key) =>
      switch (RegExp('<key>${RegExp.escape(key)}</key>\\s*<(true|false)\\s*/>').firstMatch(_xml)?[1]) {
        'true' => true,
        'false' => false,
        _ => null,
      };
}

/// What the tests need from a PNG file: its size, whether it can hold
/// transparency, and its first pixel.
class PngInfo {
  PngInfo._(this.width, this.height, this.colorType, this.hasTransparencyChunk, this.firstPixel);

  factory PngInfo.read(String path) {
    final bytes = File(path).readAsBytesSync();
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || !Iterable<int>.generate(8).every((i) => bytes[i] == signature[i])) {
      throw FormatException('Not a PNG file: $path');
    }
    final data = ByteData.sublistView(bytes);
    // IHDR comes first: width, height, bit depth, colour type, compression,
    // filter and interlace method.
    final (bitDepth, colorType, interlaced) = (bytes[24], bytes[25], bytes[28] != 0);
    var hasTransparencyChunk = false;
    final imageData = BytesBuilder(copy: false);
    for (var offset = 8; offset + 8 <= bytes.length;) {
      final length = data.getUint32(offset);
      final type = String.fromCharCodes(bytes, offset + 4, offset + 8);
      if (type == 'tRNS') hasTransparencyChunk = true;
      if (type == 'IDAT') imageData.add(Uint8List.sublistView(bytes, offset + 8, offset + 8 + length));
      if (type == 'IEND') break;
      offset += 12 + length;
    }
    int? firstPixel;
    if (bitDepth == 8 && !interlaced && (colorType == 2 || colorType == 6)) {
      // The first row starts with its filter type. No filter changes the first
      // pixel: they predict from pixels to the left and above, and it has none.
      final row = zlib.decode(imageData.takeBytes());
      final alpha = colorType == 6 ? row[4] : 0xFF;
      firstPixel = alpha << 24 | row[1] << 16 | row[2] << 8 | row[3];
    }
    return PngInfo._(data.getUint32(16), data.getUint32(20), colorType, hasTransparencyChunk, firstPixel);
  }

  final int width;
  final int height;

  /// 0 grey, 2 RGB, 3 indexed, 4 grey with alpha, 6 RGB with alpha.
  final int colorType;

  /// A tRNS chunk makes some pixels of a grey, RGB or indexed image
  /// transparent.
  final bool hasTransparencyChunk;

  /// As 0xAARRGGBB, for 8-bit RGB and RGBA images that are not interlaced.
  final int? firstPixel;

  bool get hasAlpha => colorType == 4 || colorType == 6 || hasTransparencyChunk;
}
