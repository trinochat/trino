# Tor en Trino (TOR-5)

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

Revela que usas Tor con Trino y tu guarda, no tus contactos ni tus mensajes.
"Borrar todo" detiene Tor y destruye cada archivo de `tor/` (sobrescrito y
borrado, uno por uno, también los `-wal`, `-journal` y candados), así que la
cuenta nueva entra a Tor por otra guarda.

## Cuándo corre

| Momento | Tor |
|---|---|
| Abrir Trino | Arranca, salvo la primera vez (sin cuenta) o si arranca al desbloquear |
| Desbloquear | Arranca si no había arrancado, y se despierta |
| Bloquear | Se duerme; si arranca al desbloquear, se detiene |
| Salir | Se detiene |
| Borrar todo | Se detiene y se destruye `tor/` |

La primera vez espera a la persona: el paso "Conexión" (TOR-6) o crear la
cuenta lo arrancan, para que quien necesita un puente lo elija antes de
cualquier conexión a Tor.

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
| `ptMissing` | El transporte necesita el programa de puentes y no está (TOR-7) |
| `obsolete` (`confirmed`) | Arti es muy viejo para la red |
| `direct` | "Conectar sin Tor (solo esta vez)" |

`net_start` arranca Tor (el paso "Conexión") y `net_retry` lo detiene y lo
arranca otra vez ("Volver a intentar", "Intentar de nuevo"). Los comandos de
"Conectar sin Tor" y "Volver a usar Tor" llegan con sus pantallas (TOR-6).

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

## Lo que falta

- Los puentes y `lyrebird` (TOR-7): Trino lo lanzará él mismo, sin ventana.
- Las pantallas (TOR-6).
- La prueba con la red real de Tor se corre a mano:
  `cargo test -p trino-net -- --ignored network_`.
