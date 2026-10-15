# Tor en Trino (TOR-5, TOR-6, TOR-7, TOR-9 y TOR-10)

Todo lo que Trino abre en la red, salvo el audio y el video de las llamadas,
sale por Tor. Lo hace `crates/trino-net`, que no depende de Tauri: dentro va
Arti 0.47, el cliente de Tor escrito en Rust. Nunca se vuelve en silencio a la
conexión directa: si Tor no está listo, la conexión espera o falla con
`tor_not_ready`.

## Arti y su runtime

- Arti corre en **su propio runtime de tokio, en su propio hilo**
  (`crates/trino-net/src/tor/arti.rs`). `TorClient` no tiene cómo detenerse, así
  que detener Tor es soltar la copia del cliente que tiene la app y apagar ese
  runtime: se acaban las tareas de Arti y se cierran su SQLite y sus candados.
  En el spike (S13) eso tomó 11 ms.
- Antes de crear Arti se instala `ring` como proveedor de rustls.
- Trino no instala ningún registro de `tracing`: lo que Arti anota no va a
  ningún lado y nada llega al disco. Una prueba lo vigila.
- `saturating-time` va parchado (`vendor/`), porque sin el parche Arti no
  arranca en Windows (spike S0).

## La carpeta `tor/`

Vive en la carpeta de datos (`~/.trino/tor/`, o `TRINO_HOME/tor/`), en claro,
porque Tor puede arrancar antes del desbloqueo:

- `settings.json`: el tipo de transporte (`none`, `snowflake`, `obfs4`,
  `webtunnel` o `meek`) y cuándo arranca (`open` u `on_unlock`). Nada más:
  nunca una línea de puente ni si los puentes son privados.
- `state/` y `cache/`: las carpetas de Arti (guardas, tiempos de circuito y el
  directorio público de la red).
- `run.marker`: ver "Arti obsoleto".
- `run-<azar>/`: solo con puentes privados, ver "Puentes".
- `seen.json`: lo más alto que este equipo vio de las novedades, ver
  "Novedades".

Revela que usas Tor con Trino y tu guarda, no tus contactos ni tus mensajes.
"Borrar todo" detiene Tor y destruye cada archivo de `tor/` (sobrescrito y
borrado, uno por uno, también los `-wal`, `-journal` y candados), así que la
cuenta nueva entra a Tor por otra guarda.

## Cuándo corre

| Momento | Tor |
|---|---|
| Abrir Trino | Destruye los `run-*` que dejó un corte; arranca, salvo la primera vez (sin cuenta) o si arranca al desbloquear |
| Desbloquear | Recibe los puentes privados del almacén; arranca si no había arrancado, y se despierta |
| Bloquear | Se duerme; si arranca al desbloquear o usa puentes privados, se detiene (y `lyrebird` con él) y los olvida |
| Salir | Se detiene, y `lyrebird` con él |
| Borrar todo | Se detiene, olvida los puentes privados y se destruye `tor/` |

La primera vez espera a la persona: el paso "Conexión" de la bienvenida o
crear la cuenta lo arrancan, para que quien necesita un puente lo elija antes
de cualquier conexión a Tor. Ese paso guarda primero cómo entrar (sin puente,
o el Snowflake integrado si marcas "No quiero que mi proveedor note que uso
Trino", que tarda de 1 a 2 minutos la primera vez) y después arranca Tor; si
no se puede guardar, no arranca de otra forma.

Solo puede haber un Trino abierto por usuario: si abres otro, le pasa el
turno al que ya estaba (que muestra su ventana) y se cierra. Con `TRINO_HOME`
cada carpeta tiene su `tor/` y se pueden abrir varias cuentas de prueba.

## Estados

La interfaz los recibe con el evento `net-changed` y los pide con
`net_status`:

| Estado | Cuándo |
|---|---|
| `off` | Tor no ha arrancado |
| `starting` (`pct`) | Arrancando |
| `ready` (`transport`) | Listo |
| `blocked` (`kind`, `pct`) | Arti dice que algo lo bloquea (`offline`, `filtering`, `cantReachTor`, `clockSkewed`, `cantBootstrap`), o no avanza en el tiempo de su transporte (`noProgress`): 45 s directo, 90 s con obfs4 o WebTunnel, 120 s con Snowflake o meek (spike S3). Tor sigue intentando debajo |
| `ptMissing` | El transporte necesita el programa de puentes (`lyrebird`) y no está, o no es el que trae Trino |
| `obsolete` (`confirmed`) | Arti es muy viejo para la red |
| `direct` | "Conectar sin protección (solo esta vez)" |

`net_start` arranca Tor (el paso "Conexión") y `net_retry` lo detiene y lo
arranca otra vez ("Volver a intentar", "Intentar de nuevo").

## Conectar sin protección

- `net_connect_without_tor` ("Conectar sin protección", después de su
  pregunta, cuyo botón principal es Cancelar): todo sale sin Tor hasta cerrar
  Trino. Vive en memoria y nunca se guarda; la próxima vez Trino se conecta
  por Tor. Es el único lugar de la app que construye el permiso de la sesión.
- `net_back_to_tor` ("Volver a conectarse de forma privada"): todo vuelve a
  Tor, y lo arranca si no estaba corriendo.
- En los dos casos se mueven también los WebSockets ya abiertos: cada relay
  (y el inspector) sigue `Net::route()`, cierra el socket abierto por el
  camino anterior y lo abre en el acto por el nuevo. Un intento que termina
  después del cambio se descarta y se repite. Nada más sale por el camino
  viejo.
- `net_set_start_on_unlock` (`on`): "Conectarse solo después de desbloquear"
  en `settings.json`. Con puentes privados queda encendida y no se puede
  apagar. Elegir un puente integrado o ninguno ya no la cambia; dejar los
  puentes privados sí vuelve a "al abrir".

## Pantallas (TOR-6)

Siguen las maquetas aprobadas (`PropTorSimple`): palabras sencillas por
defecto y lo técnico en "Opciones avanzadas".

- **Bienvenida, paso "Conexión"**: después del idioma; Tor se explica una vez.
- **Bandeja**: una línea de texto bajo el nombre, sin pastilla ni punto:
  "Conectando de forma privada… 40 %", "Esperando internet…", "No se pudo
  conectar." con "Ver qué hacer", o "Sin protección" mientras dure.
  Conectado, desaparece.
- **No se pudo conectar**: el motivo en palabras sencillas, "Probar otra
  forma de conectarse" (el primer integrado, Snowflake), "Volver a intentar",
  y al final, pequeño, "Conectar sin protección…". Con la hora mal, solo
  "Volver a intentar".
- **Ajustes › Privacidad › Conexión**: el estado, "Qué ven los demás",
  "Buscar actualizaciones cada día" y, en "Opciones avanzadas",
  "Conectarse solo después de desbloquear".
- **Versión nueva** (tarjeta 8): un aviso compacto en la bandeja, bajo la
  línea de Tor, con una acción principal. "Instalar y reiniciar" y "Más
  tarde" cuando está lista; "Intentar de nuevo" si no se pudo descargar;
  "Revisar ahora" si hace días que no se puede revisar (el congelamiento de
  las novedades, TOR-10). Nada se instala sin ese botón.
- **Trino necesita actualizarse** (tarjeta 9): con Arti obsoleto se abre una
  vez sola, y después desde "Ver qué hacer". Primero Tor Browser ("Ver
  cómo": tres pasos, la dirección para copiar y, en "Opciones avanzadas",
  la huella de la llave de versiones); después, pequeño, "Descargarla sin
  protección…", que pregunta antes (Cancelar es el botón principal) y usa
  `update_check_without_tor`. Sin confirmar dice "Puede que…" y ofrece
  "Volver a intentar".
- **Llamadas** (tarjeta 12): mientras Tor se conecta, la llamada sigue
  sonando con "Todavía conectando de forma privada…" y **nunca** ofrece
  llamar sin protección (R-11); eso solo se pregunta con Tor listo y el
  servidor fallando. Cada petición de TURN nombra su llamada, y sus
  renovaciones usan la llave y el circuito de esa llamada
  (`docs/llamadas-turn.md`).
- **Abrir un enlace** (tarjeta 10): los enlaces no tienen `href`; el chat los
  pinta como `<span role="link">` y los abre `open_link`, en Rust, que
  pregunta antes ("Este enlace se abre en tu navegador, sin protección…")
  hasta que marques "No volver a preguntar". Esa casilla queda en la cuenta,
  fuera del alcance del frontend.

## El WebView

No pide nada a la red (la CSP) y ahora tampoco puede navegar: la ventana
principal y cada ventana renovada solo van al origen de la app
(`tauri://localhost` o `http(s)://tauri.localhost`; en `tauri dev`, el
servidor de Vite) y a `blob:`, `data:` y `about:blank`, que no salen a la red
(`src-tauri/src/navigation.rs`). Por eso la ventana la crea la app
(`create: false` en `tauri.conf.json`). El JS ya no puede abrir direcciones:
la capability no tiene `opener:allow-open-url`, y `index.html` apaga el DNS
anticipado.

## Plazos

Cada conexión cuenta su plazo desde que Tor está listo. Un relay espera a
Tor sin límite antes de cada intento y después tiene 30 s; si tiene un onion,
primero 45 s en el onion y después su dominio por una salida de Tor, nunca
directo. Una petición HTTP (Blossom, TURN) espera a un Tor que está arrancando
hasta 30 s y después cuenta sus propios plazos; si Tor no arrancó, falla en el
acto con `tor_not_ready`.

## Aislamiento

Cada desbloqueo es una sesión, y cada conexión lleva un token (sesión, clase
y llave): dos conexiones comparten circuito solo si su token es igual. Así,
dos relays no comparten salida, ni una sesión con la siguiente, ni una subida
con una bajada.

## Arti obsoleto

Si Arti dice al arrancar que su versión es muy vieja (`SoftwareDeprecated`),
el estado es `obsolete` confirmado. Con Trino abierto, Arti cierra todo el
proceso sin aviso. Para eso está `tor/run.marker`: se escribe al arrancar
Tor, anota cuando Tor quedó listo y se borra al detenerlo bien o después de
10 minutos listo. Si Trino murió dos veces seguidas en esos 10 minutos, Tor
ya no arranca solo y el estado es `obsolete` sin confirmar ("Puede que…");
`net_retry` lo intenta de nuevo.

## Relays por defecto

nos.lol, relay.snort.social y nostr.mom: ninguno detrás de Cloudflare, que
también ve las llamadas, y los tres respondieron por Tor 9 o 10 veces de 10
(spike S6). relay.damus.io solo si lo agregas; una cuenta con los tres de
antes (damus, nos.lol y snort) pasa a los nuevos, con los que comparte nos.lol
y snort.

## Puentes (TOR-7)

Un puente es una entrada a Tor que no está en la lista pública; el programa
que disfraza el tráfico hacia él es `lyrebird` (obfs4, Snowflake, WebTunnel y
meek), del Proyecto Tor.

### De dónde sale `lyrebird`

- `scripts/fetch-lyrebird.sh <target>` baja el Tor Expert Bundle de
  torproject.org, comprueba su firma OpenPGP con la llave de "Tor Browser
  Developers" (`EF6E 286D DA85 EA2A 4BA7 DE68 4E2C 6E87 9329 8290`) en un
  llavero propio que borra al terminar, y solo entonces saca `lyrebird`, su
  licencia (GPL-3.0) y el `pt_config.json` de Tor Browser.
- `src-tauri/binaries/lyrebird.pin` fija, por plataforma, la versión del
  bundle y el SHA-256 de `lyrebird`. El script rechaza una descarga que no
  coincida; `--update <versión>` reescribe el pin (y los puentes integrados)
  para revisarlos y hacer commit. Hoy: Windows, bundle 15.0.25, lyrebird 0.8.1.
  Linux no tiene pin todavía, así que esa versión no ofrece puentes.
- El binario nunca va al repositorio. Una versión para publicar se arma con
  `tauri build --config src-tauri/tauri.bridges.conf.json`, que lo agrega como
  `externalBin` (queda al lado de `TrinoChat.exe` como `lyrebird.exe`) junto
  con su licencia. El `tauri.conf.json` de siempre no lo nombra, así que
  compilar y probar sin él funciona igual. El flujo de versiones de GitHub lo
  hace en Windows.
- Sin conexión, el script acepta `--bundle-dir` (el `.tar.gz` y su `.asc` ya
  bajados) y `--key` (la llave pública): se comprueban igual.

### Cómo lo corre Trino

- Arti lanzaría `lyrebird` con una consola visible y lo dejaría vivo al
  detenerse (spike S2 y S13). Por eso lo lanza Trino (`trino-net`,
  `tor/pt.rs`): sin ventana (`CREATE_NO_WINDOW`), con el protocolo de
  transportes, y le da a Arti el puerto SOCKS de cada transporte como
  transporte no gestionado.
- **Antes de cada lanzamiento** calcula el SHA-256 de `lyrebird.exe` y lo
  compara con el pin, con el archivo abierto sin permitir escribirlo ni
  borrarlo hasta lanzarlo. Si falta o no coincide, no lo lanza: el estado es
  `ptMissing`, nunca una conexión sin el puente.
- Al detener Tor (bloquear, salir, "Borrar todo") le cierra la entrada, y si
  en 2 s no salió, lo mata.
- `lyrebird.exe` queda excluido de los informes de errores de Windows en cada
  arranque, uses o no puentes.

### Integrados, privados y lo que funcionó

- **Integrados**: los 7 obfs4 y los 2 Snowflake de Tor Browser
  (`crates/trino-net/src/tor/pt_config.json`, copia exacta del bundle). El
  meek integrado no sirve con Arti (le falta la huella) y no hay WebTunnel
  integrado. "Probar con un puente" va en orden: Snowflake y obfs4.
- **Privados** (pegados): se validan línea por línea (transporte conocido, IP
  y puerto, huella de 40 hexadecimales, argumentos `clave=valor`, a lo sumo
  510 bytes de argumentos y 20 líneas) y se guardan **cifrados** en
  `prefs.bin` (`net.bridges`). La interfaz nunca recibe las líneas ni puede
  cambiarlas con sus preferencias. `settings.json` solo dice el tipo y
  `on_unlock`. Antes de tener cuenta viven en memoria y se guardan al crearla.
- **Con puentes privados** Tor usa `tor/run-<azar>/state` y `cache`, porque
  Arti guarda ahí la línea completa del puente. Al detenerse, cada archivo se
  sobrescribe con bytes al azar y se borra; cada arranque usa una carpeta
  nueva, y al abrir Trino se destruyen las que dejó un corte.
- **Lo que funcionó se recuerda**: un puente integrado que se prueba con un
  toque queda en `settings.json` cuando Tor conecta por él. Nada cambia sin un
  toque: un arranque bloqueado sigue con su transporte.

### Comandos (las pantallas son TOR-8)

| Comando | Qué hace |
|---|---|
| `net_bridges_get` | El tipo en uso, si hay privados (y cuántos; desconocido si la cuenta está bloqueada), cuándo arranca Tor, si esta versión trae `lyrebird` y los integrados en orden. Nunca las líneas |
| `net_bridges_check` (`text`) | Valida lo pegado sin guardar: cuántas líneas o los errores con su número de línea |
| `net_bridges_set` (`choice`: `none`, `builtin` con `transport`, o `private` con `text`) | Guarda la elección y, si Tor estaba corriendo, lo arranca otra vez con ella. Con líneas malas no guarda nada |
| `net_bridges_try` (`transport`) | "Probar con un puente": arranca otra vez por ese integrado y lo guarda si conecta. `net_retry` vuelve a lo guardado |

## Novedades (TOR-10)

"Novedades de Trino" ya no se bajan ni se verifican en el WebView:

- `crates/trino-net/src/news/` baja `https://trinochat.org/updates/feed.json`
  por Tor (un GET, como mucho 512 KB), cada espejo por su propio circuito, y lo
  verifica con rPGP contra la llave "Trino Updates" que va dentro del programa
  (`4DE8E4BC5872E37566FA4114A62EE5607F666A6B`). Nunca usa una llave de la red.
- Si hay varios espejos, pregunta a todos y gana el feed verificado más alto.
- `tor/seen.json` guarda, por equipo, el `seq`, el `latest` y el `validUntil`
  más altos verificados, más dos días sin hora. Un feed por debajo es una
  repetición y queda como `untrusted`. Funciona con la app bloqueada.
- Congelamiento: un feed vencido (`validUntil`), más de 14 días sin un feed
  vigente o un `latest` que ningún espejo ofrece; esto último lo dice la
  revisión diaria del actualizador, que pregunta a los espejos. La app recibe el motivo en `freeze`; el aviso en pantalla
  llega con las maquetas.
- Sin Tor ("Conectar sin Tor") no se pregunta nada. Con Tor sin conectar,
  tampoco; nunca se va directo.
- El WebView pide `news_fetch` y recibe `{ status, items, signerFingerprint,
  latest, freeze }`, con avisos solo si están verificados. openpgp.js salió del
  frontend.

El formato y la publicación están en `docs/announcement-channel.md`.

## Actualizador (TOR-9)

Trino revisa una vez al día, a una hora al azar y por Tor, las novedades y
todos los espejos de `latest.json`; comprueba la firma minisign de la versión
antes de bajar y la del instalador después, y siempre pregunta antes de
instalar. Con Arti obsoleto, la pantalla de "versión vieja" tiene un permiso
propio sin Tor que solo llega a trinochat.org y a GitHub. Todo, y cómo firmas
una versión, está en `docs/updater.md`.

## Lo que falta

- Las pantallas de los puentes (TOR-8): "En mi red bloquean Tor", la búsqueda
  automática y pegar un código; hasta entonces, "Probar otra forma de
  conectarse" usa el primer integrado.
- `lyrebird` para Linux (un pin con su SHA-256).
- El WebView sigue pidiendo las novedades al desbloquear, como antes, además
  de la revisión diaria.
- "Trino necesita actualizarse" sale sobre los chats, después de desbloquear;
  la maqueta técnica la ponía en lugar del desbloqueo.
- Las invitaciones y el @nombre (TOR-11): hoy la app no tiene el canje de
  enlaces ni la búsqueda por @nombre, así que sus textos de espera (tarjeta 11)
  llegan con ellas.
- Pruebas a mano:
  - con la red real de Tor: `cargo test -p trino-net -- --ignored network_`;
  - con un `lyrebird` real, sin red:
    `TRINO_LYREBIRD=<ruta> cargo test -p trino-net -- --ignored local_lyrebird`.
