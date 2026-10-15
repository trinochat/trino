// The copy: the same messages in every language, the same placeholders, the
// approved Spanish wording, and Colombian Spanish with "tú".
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> arb(String locale) =>
    (jsonDecode(File('lib/l10n/app_$locale.arb').readAsStringSync()) as Map).cast<String, Object?>();

Map<String, String> messagesOf(Map<String, Object?> file) => {
  for (final MapEntry(:key, :value) in file.entries)
    if (!key.startsWith('@')) key: value! as String,
};

/// Placeholders a message refers to: `{name}` or `{name, plural …}`, but not
/// the text of an ICU branch such as `fox{Zorro}`.
Set<String> referencedPlaceholders(String message) => {
  for (final match in RegExp(r'(^|[^\w])\{(\w+)(?=[},])').allMatches(message))
    if (!RegExp(r'^\d').hasMatch(match[2]!)) match[2]!,
};

void main() {
  final template = arb('es');
  final spanish = messagesOf(template);

  for (final locale in ['en', 'pt']) {
    group(locale, () {
      final messages = messagesOf(arb(locale));

      test('has every message of the Spanish template, and no other', () {
        expect(messages.keys.toSet().difference(spanish.keys.toSet()), isEmpty, reason: 'extra keys');
        expect(spanish.keys.toSet().difference(messages.keys.toSet()), isEmpty, reason: 'missing keys');
      });

      test('keeps the placeholders of each message', () {
        for (final MapEntry(:key, :value) in messages.entries) {
          expect(referencedPlaceholders(value), referencedPlaceholders(spanish[key]!), reason: key);
        }
      });

      test('has no empty or padded message', () {
        for (final MapEntry(:key, :value) in messages.entries) {
          expect(value.trim(), allOf(isNotEmpty, value), reason: key);
        }
      });
    });
  }

  test('the template declares every placeholder it uses', () {
    for (final MapEntry(:key, :value) in spanish.entries) {
      final used = referencedPlaceholders(value);
      if (used.isEmpty) continue;
      final metadata = template['@$key'] as Map?;
      final declared = (metadata?['placeholders'] as Map?)?.keys.toSet() ?? const {};
      expect(declared, used, reason: key);
    }
  });

  test('keeps the approved wording of the mobile mock', () {
    expect(spanish, containsPair('chatsTitle', 'Chats'));
    expect(spanish, containsPair('netConnectingProgress', 'Conectando de forma privada… {progress} %'));
    expect(spanish, containsPair('netFailed', 'No se pudo conectar.'));
    expect(spanish, containsPair('netWhatToDo', 'Ver qué hacer'));
    expect(spanish, containsPair('netOffline', 'Esperando internet…'));
    expect(spanish, containsPair('netUnprotected', 'Sin protección hasta que cierres Trino'));
    expect(spanish, containsPair('requestsRow', 'Solicitudes ({count})'));
    expect(spanish, containsPair('newChat', 'Nuevo chat'));
    expect([spanish['filterAll'], spanish['filterUnread'], spanish['filterGroups']], ['Todos', 'No leídos', 'Grupos']);
    expect(
      [spanish['callIncoming'], spanish['callOutgoing'], spanish['callMissed']],
      ['Entrante', 'Saliente', 'Perdida'],
    );
    expect(spanish, containsPair('callBack', 'Devolver la llamada a {name}'));
    expect(spanish, containsPair('draftPrefix', 'Borrador:'));
    expect(spanish, containsPair('callKeyLabel', 'Clave'));
    expect(spanish, containsPair('keyCompareTitle', 'Comparen la clave'));
    expect(
      spanish,
      containsPair(
        'keyCompareBody',
        'Léanse las palabras en voz alta. Si son las mismas, nadie se metió en la llamada.',
      ),
    );
    expect(spanish, containsPair('keyMatch', 'Coinciden'));
    expect(spanish, containsPair('keyMismatch', 'No coinciden'));
    expect(spanish, containsPair('callVerified', 'Verificada'));
    expect(spanish, containsPair('callRelay', 'Por el servidor de llamadas'));
    expect(spanish, containsPair('callDirect', 'Conexión directa'));
    expect(spanish, containsPair('callDirectNote', '{name} puede ver tu IP mientras dure la llamada.'));
    expect(
      [spanish['callMute'], spanish['callSpeaker'], spanish['callCamera'], spanish['callHangUp']],
      ['Silenciar', 'Parlante', 'Video', 'Colgar'],
    );
    expect(spanish, containsPair('chatVerified', 'Verificada'));
    expect(
      [spanish['callEventOutgoing'], spanish['callEventIncoming'], spanish['callEventMissed']],
      ['Llamada saliente', 'Llamada entrante', 'Llamada perdida'],
    );
    expect(spanish, containsPair('composerHint', 'Mensaje'));
    expect(spanish.containsKey('sasWord'), isFalse, reason: 'the words come from the SAS v2 table, not from i18n');
    expect(spanish, containsPair('addContact', 'Agregar contacto'));
    expect(spanish, containsPair('shareMyCode', 'Compartir mi código'));
    expect(spanish, containsPair('profileSubtitle', 'Tu nombre y tu código'));
    expect(spanish, containsPair('onbTwofaLater', 'Ahora no'));
    expect(spanish, containsPair('onbDoneTitle', 'Todo listo'));
  });

  test('writes Colombian Spanish with "tú"', () {
    // Spain's vosotros and its verbs, voseo, "usted", and words of Spain the
    // user replaced: añadir → agregar, móvil → celular, vídeo → video.
    final banned = RegExp(
      r'\b(vosotros|vosotras|os|vos|usted|ustedes|habéis|tenéis|podéis|queréis|sabéis|comprobad|leed|'
      r'añadir|añade|añadido|añadida|ordenador|móvil|vídeo|fichero|coger|guay)\b',
      caseSensitive: false,
      unicode: true,
    );
    for (final MapEntry(:key, :value) in spanish.entries) {
      expect(banned.firstMatch(value)?.group(0), isNull, reason: '$key: "$value"');
    }
  });

  test('speaks of this phone, not of the desktop\'s computer', () {
    // Only Dispositivos names the computer: there it is the other device of
    // the account, never this one. Spain's "equipo" stays out everywhere.
    for (final (locale, desktopWord) in [('es', 'equipo'), ('en', 'computer'), ('pt', 'computador')]) {
      for (final MapEntry(:key, :value) in messagesOf(arb(locale)).entries) {
        if (key.startsWith('devices') && desktopWord != 'equipo') continue;
        expect(value.toLowerCase().contains(desktopWord), isFalse, reason: '$locale $key: "$value"');
      }
    }
  });

  test('promises nothing the app does not do: no message requests yet', () {
    final promise = RegExp(r'como solicitud|as a request|como solicitação', caseSensitive: false);
    for (final locale in ['es', 'en', 'pt']) {
      for (final MapEntry(:key, :value) in messagesOf(arb(locale)).entries) {
        expect(promise.hasMatch(value), isFalse, reason: '$locale $key');
      }
    }
  });
}
