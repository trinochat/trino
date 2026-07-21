# Canal de novedades firmado

## Objetivo

`Novedades de Trino` se comporta como un chat fijado, pero es un canal de solo
lectura:

- Los usuarios pueden leer, marcar como visto y silenciar notificaciones.
- No hay compositor, adjuntos, llamadas ni videollamadas.
- El servidor que distribuye el feed no obtiene autoridad para publicar.
- La autoridad viene de una firma OpenPGP verificada contra una clave pública
  incluida en cada cliente.

PGP no se usa como una sesión de inicio de sesión. La clave privada firma cada
publicación fuera de Trino y nunca debe copiarse al repositorio, al cliente o al
servidor de distribución.

## Archivos

El cliente de escritorio busca:

```text
public/updates/public-key.asc
public/updates/feed.json
```

Si faltan, muestra únicamente los avisos incluidos durante la compilación y los
identifica como tales. No presenta esos avisos como firmas verificadas.

`feed.json` es un sobre con el JSON exacto firmado y una firma separada:

```json
{
  "payload": "{\"announcements\":[...]}",
  "signature": "-----BEGIN PGP SIGNATURE-----\n...\n-----END PGP SIGNATURE-----"
}
```

El contenido firmado usa este esquema:

```json
{
  "announcements": [
    {
      "id": "2026-07-17-mobile-themes",
      "title": "Título corto",
      "body": "Contenido del aviso",
      "publishedAt": "2026-07-17T09:30:00-05:00",
      "version": "0.1.0",
      "url": "https://example.invalid/release"
    }
  ]
}
```

El cliente limita tamaños, cantidad de avisos y longitud de campos. Los enlaces
opcionales deben usar HTTPS.

## Publicación

1. Mantener la clave privada cifrada fuera del repositorio, preferiblemente en
   hardware o en un equipo dedicado a releases.
2. Exportar solo la clave pública a `public/updates/public-key.asc`.
3. Crear un JSON con el esquema anterior.
4. Exponer la contraseña de la clave al proceso desde un gestor de secretos.
5. Firmar el archivo:

```powershell
npm run updates:sign -- --key C:\secure\trino-updates-private.asc --input C:\secure\announcements.json --output public\updates\feed.json
```

El script lee la contraseña desde `TRINO_UPDATES_KEY_PASSPHRASE`; no acepta la
contraseña como argumento para evitar que quede en el historial del shell.

## Rotación y recuperación

- La huella de la clave pública debe publicarse por un segundo canal.
- Una rotación normal debe estar firmada por la clave anterior y distribuir la
  nueva clave mediante una actualización del cliente.
- Si la clave privada se pierde o compromete, una clave ya fijada no puede
  recuperarse de forma segura solo desde el mismo feed.
- El cliente móvil debe reutilizar el formato y los vectores de prueba desde el
  futuro `trino-core`, pero mantener su propia interfaz.
