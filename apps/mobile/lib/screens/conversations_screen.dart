import 'package:flutter/material.dart';

import '../models/conversation.dart';
import '../theme/trino_theme.dart';
import '../widgets/identity_avatar.dart';
import 'chat_screen.dart';

class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key});

  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  String _query = '';
  bool _searching = false;

  static const _items = [
    Conversation(
      name: 'Novedades de Trino',
      preview: 'Nuevo diseño móvil y temas personalizables',
      time: 'Hoy',
      color: TrinoColors.green,
      unread: 1,
      system: true,
    ),
    Conversation(
      name: 'Mara',
      preview: 'Llegué. Te envío la clave por el otro canal.',
      time: '18:42',
      color: TrinoColors.green,
      unread: 2,
      online: true,
    ),
    Conversation(
      name: 'Nexo Norte',
      preview: 'Iris: la llamada quedó para las 20:00',
      time: '17:16',
      color: TrinoColors.cyan,
      group: true,
    ),
    Conversation(
      name: 'Dante',
      preview: 'Archivo cifrado',
      time: 'Ayer',
      color: TrinoColors.amber,
    ),
    Conversation(
      name: 'Equipo Trino',
      preview: 'Revisión de protocolo completada',
      time: 'Lun',
      color: Color(0xFFB7A1E8),
      group: true,
    ),
  ];

  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _items
        .where((item) => item.name.toLowerCase().contains(_query.toLowerCase()))
        .toList();

    return Scaffold(
      appBar: AppBar(
        leading: _searching
            ? IconButton(
                tooltip: 'Cerrar búsqueda',
                onPressed: _closeSearch,
                icon: const Icon(Icons.arrow_back_rounded),
              )
            : null,
        titleSpacing: _searching ? 0 : 16,
        title: _searching
            ? TextField(
                controller: _search,
                focusNode: _searchFocus,
                onChanged: (value) => setState(() => _query = value),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  hintText: 'Buscar chats',
                  filled: false,
                  contentPadding: EdgeInsets.zero,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                ),
              )
            : const Row(
                mainAxisSize: MainAxisSize.min,
                children: [Text('Trino'), SizedBox(width: 7), _ConnectionDot()],
              ),
        actions: [
          if (_searching && _query.isNotEmpty)
            IconButton(
              tooltip: 'Limpiar búsqueda',
              onPressed: () {
                _search.clear();
                setState(() => _query = '');
              },
              icon: const Icon(Icons.close_rounded),
            )
          else if (!_searching) ...[
            IconButton(
              tooltip: 'Buscar',
              onPressed: _openSearch,
              icon: const Icon(Icons.search_rounded),
            ),
            PopupMenuButton<String>(
              tooltip: 'Más opciones',
              onSelected: (value) => _showAction(context, value),
              itemBuilder: (context) => const [
                PopupMenuItem(
                  value: 'Nuevo grupo',
                  child: _MenuItem(
                    icon: Icons.group_add_outlined,
                    label: 'Nuevo grupo',
                  ),
                ),
                PopupMenuItem(
                  value: 'Escanear contacto',
                  child: _MenuItem(
                    icon: Icons.qr_code_scanner_rounded,
                    label: 'Escanear contacto',
                  ),
                ),
                PopupMenuItem(
                  value: 'Chats archivados',
                  child: _MenuItem(
                    icon: Icons.archive_outlined,
                    label: 'Chats archivados',
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(width: 2),
        ],
      ),
      body: filtered.isEmpty
          ? const Center(child: Text('No encontramos chats'))
          : ListView.separated(
              padding: const EdgeInsets.only(top: 4, bottom: 88),
              itemCount: filtered.length,
              separatorBuilder: (context, _) => Divider(
                height: 1,
                indent: 80,
                endIndent: 12,
                color: context.trino.line,
              ),
              itemBuilder: (context, index) {
                final item = filtered[index];
                return _ConversationRow(
                  conversation: item,
                  onTap: () {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => ChatScreen(conversation: item),
                      ),
                    );
                  },
                );
              },
            ),
      floatingActionButton: FloatingActionButton(
        tooltip: 'Nuevo chat',
        onPressed: () => _showAction(context, 'Nuevo contacto'),
        child: const Icon(Icons.chat_rounded),
      ),
    );
  }

  void _openSearch() {
    setState(() => _searching = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _searchFocus.requestFocus();
    });
  }

  void _closeSearch() {
    _search.clear();
    _searchFocus.unfocus();
    setState(() {
      _query = '';
      _searching = false;
    });
  }

  void _showAction(BuildContext context, String label) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(label)));
  }
}

class _ConnectionDot extends StatelessWidget {
  const _ConnectionDot();

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return Semantics(
      label: 'Conectado',
      child: Container(
        width: 7,
        height: 7,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
        ).copyWith(color: palette.accent),
      ),
    );
  }
}

class _MenuItem extends StatelessWidget {
  const _MenuItem({required this.icon, required this.label});

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

class _ConversationRow extends StatelessWidget {
  const _ConversationRow({required this.conversation, required this.onTap});

  final Conversation conversation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final palette = context.trino;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 72),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
          child: Row(
            children: [
              IdentityAvatar(
                name: conversation.name,
                color: conversation.color,
                online: conversation.online,
                group: conversation.group,
                system: conversation.system,
                size: 52,
              ),
              const SizedBox(width: 13),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            conversation.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        if (conversation.system) ...[
                          const SizedBox(width: 4),
                          Icon(
                            Icons.lock_outline_rounded,
                            color: palette.inkMuted,
                            size: 14,
                          ),
                        ],
                        const SizedBox(width: 8),
                        Text(
                          conversation.time,
                          style: TextStyle(
                            color: conversation.unread > 0
                                ? palette.accent
                                : palette.inkMuted,
                            fontSize: 11,
                            fontWeight: conversation.unread > 0
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            conversation.preview,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ),
                        if (conversation.unread > 0) ...[
                          const SizedBox(width: 10),
                          Container(
                            constraints: const BoxConstraints(
                              minWidth: 21,
                              minHeight: 21,
                            ),
                            alignment: Alignment.center,
                            padding: const EdgeInsets.symmetric(horizontal: 5),
                            decoration: BoxDecoration(
                              color: palette.accent,
                              shape: BoxShape.circle,
                            ),
                            child: Text(
                              '${conversation.unread}',
                              style: TextStyle(
                                color: palette.onAccent,
                                fontSize: 11,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
