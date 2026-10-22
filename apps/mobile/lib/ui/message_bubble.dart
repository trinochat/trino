// One message of a conversation. Incoming and outgoing bubbles have their own
// tokens, and yours follow the accent. The text keeps its line breaks. Under
// a failed message, a row says so and holds the screen's retry button.
import 'package:flutter/widgets.dart';

import '../design/icons.dart';
import '../design/theme.dart';
import 'motion_switcher.dart';

enum BubbleDirection { incoming, outgoing }

/// Delivery of your own message. There is no "read" state: the protocol does
/// not report one, and the app shows only what it knows.
enum DeliveryState { sending, sent, failed }

/// A clock while sending, a check once sent, an alert if it failed. The icon
/// is decoration; screen readers get the state from [label].
class StatusTicks extends StatelessWidget {
  const StatusTicks({super.key, required this.state, required this.label, this.color});

  final DeliveryState state;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) => TrinoIcon(
    switch (state) {
      DeliveryState.sending => TrinoIcons.clock,
      DeliveryState.sent => TrinoIcons.check,
      DeliveryState.failed => TrinoIcons.alertCircle,
    },
    size: 15,
    color: color,
    semanticLabel: label,
  );
}

class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.direction,
    required this.text,
    required this.time,
    this.sender,
    this.status,
    this.failure,
  });

  /// The bubble itself, for tests and scrolling.
  static const bubbleKey = ValueKey('message-bubble');

  final BubbleDirection direction;
  final String text;

  /// As the screen formats it, such as "10:42".
  final String time;

  /// The author in a group; incoming messages only.
  final String? sender;
  final ({DeliveryState state, String label})? status;

  /// Under a failed message: what happened, and the retry button.
  final ({String text, Widget? retry})? failure;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final styles = context.text;
    final outgoing = direction == BubbleDirection.outgoing;
    final (fill, ink, line, meta) = outgoing
        ? (t.bubbleMe, t.bubbleMeInk, t.bubbleMeLine, t.bubbleMeMuted)
        : (t.bubbleIn, t.bubbleInInk, t.bubbleInLine, t.muted);
    final status = this.status;
    final failure = this.failure;

    return LayoutBuilder(
      builder: (context, constraints) => SizedBox(
        // Their side of the screen, whatever the parent does with its children.
        width: constraints.hasBoundedWidth ? constraints.maxWidth : null,
        child: Column(
          crossAxisAlignment: outgoing ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            ConstrainedBox(
              // Leaves room on the other side, so who said what stays clear.
              constraints: BoxConstraints(maxWidth: constraints.maxWidth * 0.78),
              child: MergeSemantics(
                key: bubbleKey,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: fill,
                    border: Border.all(color: line),
                    borderRadius: BorderRadius.circular(t.bubbleRadius),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
                    // As wide as its widest line, so the time ends where the text's room ends.
                    child: IntrinsicWidth(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // accentText is checked on the incoming bubble only (contrast_test).
                          if (!outgoing && sender != null)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 2),
                              child: Text(
                                sender!,
                                style: styles.caption.copyWith(color: t.accentText, fontWeight: FontWeight.w700),
                              ),
                            ),
                          Text(text, style: styles.body.copyWith(color: ink)),
                          const SizedBox(height: 2),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              Text(time, style: styles.mono.copyWith(color: meta)),
                              if (status != null) ...[
                                const SizedBox(width: 4),
                                // A new state fades in (the check once sent) instead of popping.
                                MotionSwitcher(
                                  child: StatusTicks(
                                    key: ValueKey(status.state),
                                    state: status.state,
                                    label: status.label,
                                    color: meta,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (status?.state == DeliveryState.failed && failure != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  children: [
                    Text(
                      failure.text,
                      style: styles.secondary.copyWith(color: t.danger, fontWeight: FontWeight.w600),
                    ),
                    if (failure.retry != null) failure.retry!,
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
