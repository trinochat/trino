# Llamadas protegidas con TURN (etapa 1)

Desde L2a, todas las llamadas pasan por el TURN de Cloudflare en modo **solo
relay**. Tu contacto nunca ve tu IP y el STUN de Google ya no se usa. Cloudflare
sí ve las IP de los dos; eso está aceptado. La etapa 2 hará pasar este mismo
TURN por Tor (hito M5).

## Cómo funciona

1. Al **llamar** o al **contestar** (nunca mientras suena), el frontend
   (`src/lib/call.ts`) pide `get_turn_servers`. Antes de esa respuesta no se
   abre el micrófono.
2. El backend (`src-tauri/src/turn.rs`):
   - firma un evento NIP-98 (kind 27235) con la llave Nostr de la identidad
     desbloqueada, con las etiquetas `u`, `method`, `payload` (sha256 del
     cuerpo) y `nonce`;
   - mina una prueba de trabajo NIP-13 de 16 bits (unos 0,1 s, fuera de los
     hilos async, con un tope de unos 4 millones de intentos);
   - hace `POST https://trinochat.org/api/v1/turn/credentials` con el cuerpo
     exacto `{"v":1}`: reqwest con rustls, 10 s de límite, sin seguir
     redirecciones y con la respuesta limitada a 16 KiB.
3. La respuesta se valida estrictamente. Solo se aceptan URLs `turn:`/`turns:`
   en exactamente `turn.cloudflare.com`, nunca el puerto 53 (los navegadores lo
   bloquean), y un `username` y un `credential` que no estén vacíos. Si cualquier
   servidor incumple, se rechaza la respuesta entera y la llamada pregunta antes
   de ir directa: un Worker roto o manipulado no puede colar un STUN.
4. Las credenciales quedan en memoria, por identidad, hasta la **mitad** de su
   vida: con el `ttl` de 4 h del Worker, toda llamada empieza con al menos 2 h
   de credenciales. Las peticiones van de una en una, así que dos llamadas
   seguidas gastan una sola petición del cupo diario. Los fallos no se guardan.
   - **Bloquear o borrar** (`lock_vault`, `wipe`) vacía la caché y cancela la
     petición que esté en curso: esa petición devuelve `no_vault` y no guarda
     nada, aunque la respuesta llegue después. Desbloquear y crear identidad
     también la vacían.
   - La sesión se toma junto con la llave, bajo el mismo candado que usan
     `lock_vault` y `wipe`, así que ningún bloqueo se cuela entre las dos.
   - La credencial (y el cuerpo de la respuesta) se borran de la memoria al
     soltarse (`ZeroizeOnDrop`). Es un esfuerzo razonable: reqwest y el puente
     IPC con la WebView guardan sus propias copias, que no controlamos.
5. El frontend crea la conexión con `iceTransportPolicy: 'relay'`,
   `bundlePolicy: 'max-bundle'` y solo los servidores TURN, y activa el filtro
   `relay-only` de `src/lib/ice-privacy.ts`. Solo salen candidatos `typ relay`,
   con `raddr`/`rport` en cero. El interruptor de desarrollo para la LAN no
   cambia nada en una llamada protegida.

El frontend pide credenciales en **cada** llamada. Quien guarda la caché y sabe
cuándo vencen es el backend; el frontend no guarda copia.

### Reloj del equipo desfasado

`created_at` sale del reloj local y el Worker solo acepta ±60 s. Si el Worker
contesta 401 con una cabecera `Date` a más de 30 s del reloj local, el backend
firma **una vez más** un evento nuevo con la hora del Worker (otro id, así que
no choca con la protección contra repeticiones). Si vuelve a fallar, es un
error `io` y la llamada pregunta como siempre.

La caducidad también se calcula con la `Date` del Worker: `expiresAt − Date`,
nunca más que el `ttl`, y se devuelve en hora local. Así un reloj adelantado o
atrasado no rechaza credenciales buenas ni las guarda de más. Sin `Date`, solo
cuenta el `ttl`.

## Credenciales durante la llamada

Cloudflare corta un relay poco después de que vencen sus credenciales, y las
peticiones de refresco del relay necesitan una credencial vigente
(<https://developers.cloudflare.com/realtime/turn/faq/>). Por eso, en una
llamada protegida:

- 10 minutos antes de que venzan, el frontend pide credenciales nuevas y las
  aplica con `pc.setConfiguration()`, con las mismas políticas, como recomienda
  Cloudflare
  (<https://developers.cloudflare.com/realtime/turn/generate-credentials/>).
  Luego programa la siguiente renovación.
- Antes de un reinicio de ICE también las renueva, para que los relays nuevos
  nazcan con credenciales que duren.
- Si la renovación falla, se reintenta cada minuto, hasta 3 veces seguidas.
  **Nunca** pasa a directa ni pregunta: si el relay se cae, la llamada termina
  como cualquier llamada rota.

## Nunca vuelve en silencio a la conexión directa

Si no hay TURN (sin red, Worker caído, cupo agotado, respuesta inválida o bóveda
bloqueada), la UI pregunta:

> No se pudo proteger la llamada. ¿Llamar directo? Tu contacto verá tu IP.

- Cancelar es la opción por defecto: tiene el foco y Escape también cancela.
- Al **llamar**, "no" cancela la llamada sin abrir el micrófono ni enviar nada.
- Colgar (o bloquear, o cerrar Trino) mientras se piden las credenciales
  tampoco envía nada: solo se manda `bye` si la oferta o la respuesta ya
  salieron. Lo mismo vale para quien contestó y cuelga antes de responder.
- Al **contestar**, "no" rechaza la llamada (`reject`).
- Solo con un "sí" explícito se usa el camino directo de antes:
  `get_call_config`, que da el STUN, y el filtro `public`. El consentimiento vale
  para esa llamada y no se recuerda.
- Si la llamada termina mientras la pregunta está abierta (el otro cuelga, se
  bloquea Trino…), la pregunta se cierra y un clic tardío no hace nada.

Durante la llamada, la línea de estado dice "0:42 · Conexión protegida" o
"0:42 · Conexión directa". Es texto simple, sin pastilla; el rediseño (L2b) lo
cambiará de estilo.

Si un lado está protegido y el otro aceptó ir directo, la IP del lado protegido
sigue oculta. La del lado directo la ve el otro, que es justo a lo que esa
persona dio permiso.

## Contrato con el Worker (`trino-infra/turn`)

- `POST https://trinochat.org/api/v1/turn/credentials`.
- `Authorization: Nostr <base64 del evento NIP-98>`. El evento lleva:
  - kind 27235 y `created_at` a ±60 s;
  - las etiquetas `["u", <esa URL>]`, `["method","POST"]`,
    `["payload", <sha256 hex del cuerpo>]` y `["nonce","<contador>","16"]`;
  - un id con al menos `POW_BITS` bits a cero (16 por defecto) y la firma
    BIP-340.
- Cuerpo: exactamente `{"v":1}`, con `Content-Type: application/json`.
- 200: `{"iceServers":[{"urls":[…solo turn:/turns:…],"username","credential"}],"ttl":14400,"expiresAt":<unix s>}`.
- Errores `{"error":"<código>"}`:
  - 400 `bad_request`, 401 `bad_auth`, 403 `low_pow`, 409 `replay` y
    413 `too_large`;
  - 429 `rate_limited`, con `Retry-After`;
  - 502 `upstream` y 503 `disabled`.
- Límites del Worker:
  - 30 credenciales por clave al día y un tope global diario (3.000);
  - no guarda IPs ni el user agent, solo `sha256(pepper || pubkey)`.

En el backend, los errores llegan a la UI como `CommandError`:
- `no_vault`: la bóveda está bloqueada;
- `io`: red, rechazo, límite, `disabled`, `upstream` o reloj desfasado;
- `internal`: firma, prueba de trabajo o respuesta inválida.

El mensaje (en inglés, para el log) empieza por `turn:`. La UI no distingue
entre ellos: cualquier fallo lleva a la pregunta anterior.

## Costo y abuso

El plan gratuito de Cloudflare Realtime incluye 1.000 GB al mes. Cada GB de más
cuesta US$0,05 y se cobra a la tarjeta de David. La firma NIP-98, la prueba de
trabajo y los límites diarios existen por eso.

## Pruebas

- Backend: `cargo test turn::` (35 pruebas) y
  `commands::tests::locking_or_wiping_forgets_the_turn_credentials`. Cubren:
  - la firma y la prueba de trabajo, y la validación de la respuesta;
  - un servidor HTTP local de prueba: cuerpo, cabeceras, errores, redirección,
    tamaño, límite de tiempo y reloj desfasado;
  - la caché: renovación a mitad de vida, bloqueo con una petición en curso;
  - el mapeo de errores.
- Frontend: `src/lib/call.test.ts`, con un `RTCPeerConnection` falso, y
  `src/lib/ice-privacy.test.ts`. Cubren:
  - la configuración y el filtro solo relay;
  - el consentimiento sin vuelta silenciosa;
  - la interacción con la caché y el camino de quien contesta;
  - colgar antes de enviar nada;
  - la renovación de credenciales durante la llamada.
- `src/call-confirm-dialog.test.tsx`: el lector de pantalla anuncia el aviso
  de la IP, no solo el título, y los textos de la llamada protegida existen en
  los tres idiomas. Están en `src/lib/strings/legacy.ts`, con los de la
  pantalla de llamada actual.

## Pendiente

- Etapa 2: el TURN por Tor (M5).
- Comprobar en WebView2 (L2a.5) que `setConfiguration` renueva las credenciales
  de un relay ya asignado. Si no lo hace, el relay se cae al vencer, la
  conexión pasa a `disconnected` y, tras 12 s, el reinicio de ICE (que ya
  renueva las credenciales) lo recupera una vez. Más reinicios son de L3.
- Subir `POW_BITS` en el Worker exige actualizar la app, que siempre mina 16
  bits.
