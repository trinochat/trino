import 'package:flutter/material.dart';

import '../models/conversation.dart';
import '../theme/trino_theme.dart';
import '../widgets/identity_avatar.dart';
import 'mobile_call_screen.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({required this.conversation, super.key});

  final Conversation conversation;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  late final List<ChatEntry> _messages;
  bool _systemMuted = false;

  @override
  void initState() {
    super.initState();
    _messages = widget.conversation.system
        ? [
            const ChatEntry(
              text:
                  'El cliente móvil estrena una interfaz más familiar, temas y color de acento configurable.',
              mine: false,
              time: '09:30',
            ),
            const ChatEntry(
              text:
                  'Los avisos oficiales serán de solo lectura y deberán superar la verificación de firma antes de mostrarse.',
              mine: false,
              time: '09:31',
            ),
          ]
        : [
            const ChatEntry(
              text: '¿Puedes confirmar la huella antes de enviar el archivo?',
              mine: false,
              time: '18:34',
            ),
            const ChatEntry(
              text: 'Sí. La comparo contigo por llamada.',
              mine: true,
              time: '18:36',
            ),
            const ChatEntry(
              text: 'Llegué. Te envío la clave por el otro canal.',
              mine: false,
              time: '18:42',
            ),
          ];
  }

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _composer.text.trim();
    if (text.isEmpty) return;
    setState(() {
      _messages.add(ChatEntry(text: text, mine: true, time: _now()));
      _composer.clear();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
        );
      }
    });
  }

  String _now() {
    final now = DateTime.now();
    return '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.conversation;
    final palette = context.trino;
    return Scaffold(
      backgroundColor: palette.chatBackground,
      appBar: AppBar(
        titleSpacing: 0,
        title: Row(
          children: [
            IdentityAvatar(
              name: item.name,
              color: item.color,
              size: 38,
              online: item.online,
              group: item.group,
              system: item.system,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 16),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    item.system
                        ? 'canal oficial · solo lectura'
                        : item.online
                        ? 'en línea'
                        : 'últ. vez recientemente',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: item.system || item.online
                          ? palette.accent
                          : palette.inkMuted,
                      fontSize: 11,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          if (item.system)
            IconButton(
              tooltip: _systemMuted
                  ? 'Activar notificaciones'
                  : 'Silenciar novedades',
              onPressed: () => setState(() => _systemMuted = !_systemMuted),
              icon: Icon(
                _systemMuted
                    ? Icons.notifications_off_outlined
                    : Icons.notifications_outlined,
              ),
            )
          else ...[
            IconButton(
              tooltip: 'Llamar',
              onPressed: () => _openCall(video: false),
              icon: const Icon(Icons.call_outlined),
            ),
            IconButton(
              tooltip: 'Videollamada',
              onPressed: () => _openCall(video: true),
              icon: const Icon(Icons.videocam_outlined),
            ),
          ],
          PopupMenuButton<String>(
            tooltip: 'Más opciones',
            onSelected: (value) {
              if (value == 'details') {
                _showDetails();
              } else {
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(SnackBar(content: Text(value)));
              }
            },
            itemBuilder: (context) => [
              PopupMenuItem(
                value: 'details',
                child: _ChatMenuItem(
                  icon: item.system
                      ? Icons.info_outline_rounded
                      : Icons.person_outline_rounded,
                  label: item.system ? 'Información del canal' : 'Ver contacto',
                ),
              ),
              const PopupMenuItem(
                value: 'Buscar en el chat',
                child: _ChatMenuItem(
                  icon: Icons.search_rounded,
                  label: 'Buscar',
                ),
              ),
              if (!item.system)
                const PopupMenuItem(
                  value: 'Notificaciones silenciadas',
                  child: _ChatMenuItem(
                    icon: Icons.notifications_off_outlined,
                    label: 'Silenciar',
                  ),
                ),
            ],
          ),
        ],
      ),
      body: Stack(
        children: [
          Positioned.fill(
            child: CustomPaint(
              painter: _ChatBackdrop(
                color: palette.accent,
                visible: palette.showChatPattern,
              ),
            ),
          ),
          Column(
            children: [
              Expanded(
                child: ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.fromLTRB(10, 12, 10, 12),
                  itemCount: _messages.length + 1,
                  itemBuilder: (context, index) {
                    if (index == 0) {
                      return const _DayMarker(label: 'Hoy');
                    }
                    final message = _messages[index - 1];
                    return _MessageBubble(entry: message);
                  },
                ),
              ),
              if (item.system)
                _ReadOnlyBar(
                  muted: _systemMuted,
                  onToggleMute: () =>
                      setState(() => _systemMuted = !_systemMuted),
                )
              else
                _Composer(
                  controller: _composer,
                  onSend: _send,
                  onAttach: _showAttachments,
                  onEmoji: _showEmojiPicker,
                  onCamera: () => _showNotice('Cámara'),
                  onVoice: () => _showNotice('Mantén pulsado para grabar'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  void _showNotice(String label) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(label)));
  }

  void _showEmojiPicker() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: SizedBox(
          height: 330,
          child: DefaultTabController(
            length: 2,
            child: Column(
              children: [
                const TabBar(
                  tabs: [
                    Tab(
                      icon: Icon(Icons.emoji_emotions_outlined),
                      text: 'Emoji',
                    ),
                    Tab(
                      icon: Icon(Icons.sticky_note_2_outlined),
                      text: 'Stickers',
                    ),
                  ],
                ),
                Expanded(
                  child: TabBarView(
                    children: [
                      _EmojiGrid(
                        onSelected: (emoji) {
                          _composer.text += emoji;
                          _composer.selection = TextSelection.collapsed(
                            offset: _composer.text.length,
                          );
                          Navigator.pop(context);
                        },
                      ),
                      const _StickerPlaceholder(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _openCall({required bool video}) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => MobileCallScreen(
          name: widget.conversation.name,
          color: widget.conversation.color,
          video: video,
        ),
      ),
    );
  }

  void _showDetails() {
    final palette = context.trino;
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 38,
                    height: 4,
                    decoration: BoxDecoration(
                      color: palette.line,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    IdentityAvatar(
                      name: widget.conversation.name,
                      color: widget.conversation.color,
                      size: 54,
                      online: widget.conversation.online,
                      group: widget.conversation.group,
                      system: widget.conversation.system,
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Text(
                        widget.conversation.name,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 22),
                if (widget.conversation.system) ...[
                  _DetailRow(
                    icon: Icons.inventory_2_outlined,
                    title: 'Canal oficial',
                    subtitle: 'Contenido incluido con esta versión de Trino.',
                    color: palette.inkDim,
                  ),
                  const _DetailRow(
                    icon: Icons.key_outlined,
                    title: 'Clave pública PGP',
                    subtitle: 'Se activará al conectar el feed firmado.',
                  ),
                  _DetailRow(
                    icon: _systemMuted
                        ? Icons.notifications_off_outlined
                        : Icons.notifications_outlined,
                    title: 'Notificaciones',
                    subtitle: _systemMuted ? 'Silenciadas' : 'Activadas',
                  ),
                ] else ...[
                  const _DetailRow(
                    icon: Icons.shield_outlined,
                    title: 'Verificación pendiente',
                    subtitle: 'Compara el código de seguridad con tu contacto.',
                    color: TrinoColors.amber,
                  ),
                  const _DetailRow(
                    icon: Icons.timer_outlined,
                    title: 'Mensajes temporales',
                    subtitle: 'Desactivados',
                  ),
                  const _DetailRow(
                    icon: Icons.notifications_outlined,
                    title: 'Notificaciones',
                    subtitle: 'Activadas',
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  void _showAttachments() {
    final palette = context.trino;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        final actions = [
          (Icons.insert_drive_file_outlined, 'Archivo', TrinoColors.cyan),
          (Icons.photo_outlined, 'Galería', Color(0xFFB18AE8)),
          (Icons.camera_alt_outlined, 'Cámara', TrinoColors.crimson),
          (Icons.person_outline_rounded, 'Contacto', palette.accent),
          (Icons.location_on_outlined, 'Ubicación', TrinoColors.amber),
          (Icons.poll_outlined, 'Encuesta', Color(0xFF78B7F0)),
        ];
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 2, 14, 20),
            child: GridView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: 3,
                childAspectRatio: 1.18,
              ),
              itemCount: actions.length,
              itemBuilder: (context, index) {
                final action = actions[index];
                return _AttachmentAction(
                  icon: action.$1,
                  label: action.$2,
                  color: action.$3,
                  onTap: () => Navigator.pop(context),
                );
              },
            ),
          ),
        );
      },
    );
  }
}

class _ChatBackdrop extends CustomPainter {
  const _ChatBackdrop({required this.color, required this.visible});

  final Color color;
  final bool visible;

  @override
  void paint(Canvas canvas, Size size) {
    if (!visible) return;
    final paint = Paint()
      ..color = color.withValues(alpha: 0.022)
      ..strokeWidth = 1
      ..style = PaintingStyle.stroke;
    const spacing = 72.0;

    for (double y = 24; y < size.height; y += spacing) {
      for (double x = 24; x < size.width; x += spacing) {
        canvas.drawCircle(Offset(x, y), 1.6, paint);
        if ((x / spacing + y / spacing).round().isEven) {
          canvas.drawLine(Offset(x + 8, y), Offset(x + 20, y), paint);
          canvas.drawLine(Offset(x + 20, y), Offset(x + 20, y + 8), paint);
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant _ChatBackdrop oldDelegate) {
    return oldDelegate.color != color || oldDelegate.visible != visible;
  }
}

class _DayMarker extends StatelessWidget {
  const _DayMarker({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Center(
      child: Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: palette.surfaceRaised.withValues(alpha: 0.94),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ).copyWith(color: palette.inkDim),
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.entry});

  final ChatEntry entry;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Align(
      alignment: entry.mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.82,
        ),
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.fromLTRB(11, 7, 8, 5),
        decoration: BoxDecoration(
          color: entry.mine ? palette.accentDeep : palette.surfaceRaised,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(15),
            topRight: const Radius.circular(15),
            bottomLeft: Radius.circular(entry.mine ? 15 : 4),
            bottomRight: Radius.circular(entry.mine ? 4 : 15),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              entry.text,
              style: TextStyle(
                color: palette.ink,
                fontSize: 15.5,
                height: 1.28,
              ),
            ),
            const SizedBox(height: 2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  entry.time,
                  style: const TextStyle(
                    fontSize: 9.5,
                  ).copyWith(color: palette.inkMuted),
                ),
                if (entry.mine) ...[
                  const SizedBox(width: 3),
                  Icon(Icons.done_all_rounded, color: palette.accent, size: 13),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ReadOnlyBar extends StatelessWidget {
  const _ReadOnlyBar({required this.muted, required this.onToggleMute});

  final bool muted;
  final VoidCallback onToggleMute;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return SafeArea(
      top: false,
      child: Container(
        constraints: const BoxConstraints(minHeight: 60),
        padding: const EdgeInsets.fromLTRB(14, 6, 8, 7),
        decoration: BoxDecoration(
          color: palette.surface,
          border: Border(top: BorderSide(color: palette.line)),
        ),
        child: Row(
          children: [
            Icon(Icons.lock_outline_rounded, color: palette.accent, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Canal de solo lectura',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Solo Trino puede publicar avisos aquí',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: muted ? 'Activar notificaciones' : 'Silenciar novedades',
              onPressed: onToggleMute,
              color: muted ? palette.inkMuted : palette.accent,
              icon: Icon(
                muted
                    ? Icons.notifications_off_outlined
                    : Icons.notifications_outlined,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.onSend,
    required this.onAttach,
    required this.onEmoji,
    required this.onCamera,
    required this.onVoice,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback onAttach;
  final VoidCallback onEmoji;
  final VoidCallback onCamera;
  final VoidCallback onVoice;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(7, 6, 7, 7),
        color: palette.surface,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Container(
                constraints: const BoxConstraints(minHeight: 48),
                decoration: BoxDecoration(
                  color: palette.surfaceRaised,
                  borderRadius: BorderRadius.circular(24),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    IconButton(
                      tooltip: 'Emoji y stickers',
                      onPressed: onEmoji,
                      color: palette.inkMuted,
                      icon: const Icon(Icons.emoji_emotions_outlined),
                    ),
                    Expanded(
                      child: TextField(
                        controller: controller,
                        minLines: 1,
                        maxLines: 5,
                        textCapitalization: TextCapitalization.sentences,
                        onSubmitted: (_) => onSend(),
                        decoration: const InputDecoration(
                          hintText: 'Mensaje',
                          filled: false,
                          isDense: true,
                          contentPadding: EdgeInsets.symmetric(vertical: 13),
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Adjuntar',
                      onPressed: onAttach,
                      color: palette.inkMuted,
                      icon: const Icon(Icons.attach_file_rounded),
                    ),
                    IconButton(
                      tooltip: 'Cámara',
                      onPressed: onCamera,
                      color: palette.inkMuted,
                      icon: const Icon(Icons.camera_alt_outlined),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 5),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: controller,
              builder: (context, value, _) {
                final canSend = value.text.trim().isNotEmpty;
                return IconButton.filled(
                  tooltip: canSend ? 'Enviar' : 'Mensaje de voz',
                  onPressed: canSend ? onSend : onVoice,
                  style: IconButton.styleFrom(
                    backgroundColor: palette.accent,
                    foregroundColor: palette.onAccent,
                    minimumSize: const Size(48, 48),
                    maximumSize: const Size(48, 48),
                    shape: const CircleBorder(),
                  ),
                  icon: Icon(
                    canSend ? Icons.send_rounded : Icons.mic_rounded,
                    size: 22,
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.color,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Container(
      constraints: const BoxConstraints(minHeight: 68),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: palette.line)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color ?? palette.inkMuted, size: 21),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 3),
                Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
          Icon(Icons.chevron_right_rounded, color: palette.inkMuted),
        ],
      ),
    );
  }
}

class _AttachmentAction extends StatelessWidget {
  const _AttachmentAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        height: 88,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 48,
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.13),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: color, size: 24),
            ),
            const SizedBox(height: 7),
            Text(label, style: Theme.of(context).textTheme.labelLarge),
          ],
        ),
      ),
    );
  }
}

class _ChatMenuItem extends StatelessWidget {
  const _ChatMenuItem({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Row(
      children: [
        Icon(icon, size: 20, color: palette.inkDim),
        const SizedBox(width: 12),
        Text(label),
      ],
    );
  }
}

class _EmojiGrid extends StatelessWidget {
  const _EmojiGrid({required this.onSelected});

  final ValueChanged<String> onSelected;

  static const emojis = [
    '😀',
    '😂',
    '😊',
    '😍',
    '🤔',
    '😎',
    '👍',
    '👎',
    '👏',
    '🙏',
    '🔥',
    '❤️',
    '✅',
    '🔐',
    '👀',
    '🎉',
    '💬',
    '📎',
    '📍',
    '⚡',
    '🛡️',
    '🔑',
    '📡',
    '🚀',
  ];

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      padding: const EdgeInsets.all(12),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 8,
      ),
      itemCount: emojis.length,
      itemBuilder: (context, index) {
        final emoji = emojis[index];
        return InkWell(
          onTap: () => onSelected(emoji),
          borderRadius: BorderRadius.circular(8),
          child: Center(
            child: Text(emoji, style: const TextStyle(fontSize: 26)),
          ),
        );
      },
    );
  }
}

class _StickerPlaceholder extends StatelessWidget {
  const _StickerPlaceholder();

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.sticky_note_2_outlined, color: palette.inkMuted, size: 34),
          const SizedBox(height: 10),
          Text(
            'Tus stickers aparecerán aquí',
            style: TextStyle(color: palette.inkDim),
          ),
          const SizedBox(height: 4),
          Text(
            'Los paquetes se guardan en el dispositivo',
            style: TextStyle(color: palette.inkMuted, fontSize: 12),
          ),
        ],
      ),
    );
  }
}
