// How the home is laid out by the width of the window, as the approved tablet
// mock: under 600 dp the phone app; from 600 dp a rail of the sections and two
// panes, the list and what was opened from it; from 1200 dp the info of a
// chat can open as a third pane. The width, not the device, decides, so a
// tablet in split screen or a phone lying down gets what fits.
import 'dart:ui' show clampDouble;

enum HomeLayout {
  /// The phone: bottom tabs, and everything opens as a page.
  phone,

  /// The rail, the list and the detail beside it.
  twoPanes,

  /// As [twoPanes], and the info of the open chat beside the chat.
  threePanes;

  static HomeLayout forWidth(double width) => width >= threePaneMinWidth
      ? threePanes
      : width >= twoPaneMinWidth
      ? twoPanes
      : phone;
}

const twoPaneMinWidth = 600.0;
const threePaneMinWidth = 1200.0;

/// The rail of the four sections.
const railWidth = 76.0;

/// The info of a chat as the third pane.
const infoPaneWidth = 320.0;

/// How wide a conversation grows: past it, lines get too long to read.
const readableWidth = 720.0;

/// The list beside the detail: 340 dp lying down, about 300 standing up, and
/// never so wide that the detail is left without room.
double listPaneWidth(double width) => clampDouble((width - railWidth) * 0.4, 260, 340);
