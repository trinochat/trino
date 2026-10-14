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

## Dónde se baja y dónde se verifica

Desde Tor (diseño de Tor §7, R-06):

- **Rust baja** `https://trinochat.org/updates/feed.json` por Tor, con una
  petición GET y como mucho 512 KB. Si hay más espejos, pregunta a todos, cada
  uno por su propio circuito, y se queda con el feed verificado más alto. El
  onion de la web se suma cuando exista.
- **Rust verifica** con rPGP (`crates/trino-net/src/news/`), contra la llave
  "Trino Updates" que va dentro del programa:
  `crates/trino-net/src/news/trino-updates.asc`, huella
  `4DE8E4BC5872E37566FA4114A62EE5607F666A6B`. Nunca usa una llave bajada de la
  red: quien sirve el feed podría servir también una llave que coincida.
- **El WebView solo recibe lo verificado**, por el comando `news_fetch`. Ya no
  usa openpgp.js ni `fetch`.
- **Sin Tor** ("Conectar sin Tor") no se pregunta nada: las novedades esperan.
  Con Tor sin conectar, tampoco; nunca se va directo.

Lo que recibe la app:

- `verified`: un feed verificado; sus avisos son los que se muestran.
- `bundled`: no llegó ningún feed (sin red, sin Tor o sin publicar). Se muestran
  los avisos incluidos al compilar, y no se presentan como verificados.
- `untrusted`: llegó un feed, pero no pasó la verificación, o es más viejo que
  el más alto que este equipo ya vio. Es un indicio de ataque, no un archivo
  que falta, y la app lo dice.

## Formato

`feed.json` es un sobre con el JSON exacto firmado y una firma separada:

```json
{
  "payload": "{\"announcements\":[...],\"seq\":1792065600,\"latest\":\"0.2.0\",\"validUntil\":1795953600}",
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
  ],
  "seq": 1792065600,
  "latest": "0.2.0",
  "validUntil": 1795953600
}
```

- `seq` crece con cada feed. Un feed con un `seq` menor que el más alto visto se
  rechaza, para que nadie pueda repetir un feed viejo bien firmado y esconder un
  aviso de seguridad.
- `latest` es la última versión publicada (`mayor.menor.parche`). Si las
  novedades dicen una versión que ningún espejo del actualizador ofrece, la app
  avisa que hay una versión nueva que no pudo bajar. Un feed con un `latest`
  menor que el más alto visto también se rechaza.
- `validUntil` dice hasta cuándo vale el feed, en segundos desde 1970. Pasada
  esa fecha, la app avisa que no pudo comprobar si hay versiones nuevas. Lo
  mismo pasa si lleva más de 14 días sin recibir un feed vigente. Un feed sin
  `validUntil` se muestra, pero no cuenta como vigente.

El cliente limita tamaños, cantidad de avisos (50) y longitud de campos. Los
enlaces opcionales deben usar HTTPS, y `publishedAt` es una fecha RFC 3339 con
su zona.

## Lo más alto visto, por equipo

`~/.trino/tor/seen.json` guarda, por equipo y fuera del almacén cifrado, el
`seq`, el `latest` y el `validUntil` más altos verificados, más dos días (sin
hora): el del último feed vigente y el de la primera revisión. Son números
públicos. Está fuera del almacén para que la revisión funcione también con la
app bloqueada y antes de tener cuenta. "Borrar todo" lo destruye con el resto de
`tor/`.

Antes, el `seq` más alto se guardaba en las preferencias de la cuenta
(`trino:announcements:minSeq`). Al desbloquear, Rust lo sube a `seen.json` si
es mayor, y la preferencia deja de usarse: el frontend ya no la recibe, y se
borra la próxima vez que se guardan las preferencias.

## Publicación

1. La clave privada "Trino Updates" vive en tu GnuPG, nunca en el repositorio.
   Si la tienes como archivo, impórtala una vez con `gpg --import`.
2. Crea un JSON con la lista de avisos (`announcements`).
3. Firma:

```powershell
npm run updates:sign -- --input C:\secure\announcements.json --output feed.json
```

El script:

- agrega `seq` (por defecto, la hora actual en segundos), `latest` (por
  defecto, la versión de `package.json`) y `validUntil` (por defecto, 45 días
  desde hoy). Se cambian con `--seq`, `--latest` y `--valid-days`;
- firma con `gpg --detach-sign` y la llave principal de "Trino Updates"
  (`--local-user` la cambia). GnuPG pide la frase en su propia ventana: el
  script nunca la ve ni la recibe;
- comprueba la firma con `gpg --verify` antes de escribir el archivo, y se
  niega si la firmó otra llave.

4. Publica `feed.json` en `trinochat.org/updates/feed.json` (un despliegue
   remoto, con su propia autorización).
5. **Vuelve a firmar antes de que venza `validUntil`.** La rutina de cada mes
   (la versión con el Arti nuevo) lo hace. Si no, todos los usuarios ven el
   aviso de que no se pudo comprobar si hay versiones nuevas.

## Rotación y recuperación

- La huella de la clave pública debe publicarse por un segundo canal.
- Una rotación normal debe estar firmada por la clave anterior y distribuir la
  nueva clave mediante una actualización del cliente.
- Si la clave privada se pierde o compromete, una clave ya fijada no puede
  recuperarse de forma segura solo desde el mismo feed.
- La llave "Trino Updates" vence en julio de 2028. La app no revisa el
  vencimiento de su copia fija; antes de esa fecha hay que extender el
  vencimiento y llevar la llave pública nueva en una versión.
- El motor de M4 reutiliza la verificación de `trino-net` tal cual: no depende
  de Tauri ni del WebView.
