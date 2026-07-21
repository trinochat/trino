# Seguridad y privacidad de Trino

## Posicionamiento

Trino debe competir con una propuesta concreta:

- acceso sin teléfono ni correo;
- claves e historial bajo control del usuario;
- experiencia clara y llamadas fiables;
- transporte reemplazable y autoalojable;
- reducción progresiva de metadatos.

La referencia de producto combina la facilidad de uso de Signal, la identidad
local de Threema y objetivos de transporte inspirados en Session y SimpleX. No
conviene prometer anonimato o "cero metadatos" mientras la implementación siga
usando identificadores Nostr persistentes y relays capaces de observar IP,
clave pública, destinatario, hora y volumen aproximado.

## Estado actual

### Fortalezas

- Los mensajes y las señales de llamada viajan cifrados con el canal ratchet.
- WebRTC cifra el audio y video mediante DTLS-SRTP.
- La identidad no requiere un número de teléfono ni una cuenta central.
- La bóveda local usa cifrado autenticado y el historial se guarda cifrado.
- Las huellas de contactos y llamadas se pueden comparar fuera de banda.

### Límites que deben comunicarse

- Un relay Nostr todavía puede correlacionar conexiones, horarios y claves.
- Una llamada WebRTC directa revela las direcciones IP entre participantes.
- Un TURN oculta la IP entre participantes sólo si se fuerza el modo relay; el
  operador TURN sigue viendo IP, horario y tráfico cifrado.
- El TOTP actual está dentro de la misma bóveda que protege la contraseña. Tras
  acertar la contraseña sobre una copia robada, el atacante obtiene también el
  secreto TOTP; por ello no añade una segunda barrera offline independiente.
- No se debe afirmar "privacidad suiza" ni jurisdicción suiza sin una entidad,
  responsable del tratamiento o infraestructura realmente sometida a ella.

## Llamadas

### Cambios inmediatos

- Usar identificadores de llamada generados con un CSPRNG.
- Validar tipo, campos y tamaño de cada señal en TypeScript y Rust.
- Limitar SDP a 56 KiB, señales a 64 KiB y candidatos ICE pendientes.
- Intentar un reinicio ICE antes de finalizar una conexión interrumpida.
- Solicitar cancelación de eco, reducción de ruido y control automático de
  ganancia sin exigirlos al dispositivo.
- Incluir descripciones de cámara y micrófono en el `Info.plist` de macOS.
- No avanzar el ratchet ni aceptar un envío cuando todavía no hay relay.

### TURN de producción

Trino ya no debe incluir credenciales TURN públicas compartidas. La variable
`TRINO_ICE_SERVERS_JSON` permite configurar servidores por despliegue:

```json
[
  {
    "urls": [
      "turns:turn.example.net:5349?transport=tcp",
      "turn:turn.example.net:3478?transport=udp"
    ],
    "username": "credencial-temporal",
    "credential": "secreto-temporal"
  }
]
```

Para producción, coturn debe usar TLS válido, cuotas, límites por usuario y
credenciales temporales compatibles con TURN REST. El secreto HMAC maestro no
debe estar dentro de la aplicación. Un servicio mínimo de credenciales entrega
un usuario con caducidad de pocos minutos después de autenticar una sesión
local válida.

Una futura opción "ocultar mi IP en llamadas" debe establecer
`iceTransportPolicy: "relay"`. Debe explicar que aumenta latencia y ancho de
banda del operador TURN.

### Matriz mínima

- Windows 10/11 con WebView2 estable y dispositivo sin cámara.
- macOS con permisos denegados, revocados y concedidos.
- Ubuntu y Fedora con WebKitGTK, PipeWire/PulseAudio y cámara ocupada.
- NAT abierto, NAT simétrico, red corporativa, UDP bloqueado y sólo TCP 443.
- suspensión, cambio de Wi-Fi, cambio a hotspot y reconexión del relay.

## Desbloqueo rápido

### Mejora aplicada

El descifrado local se ejecuta fuera del hilo asíncrono principal y la conexión
a relays comienza en segundo plano. El usuario puede abrir el historial local
sin esperar a que terminen conexiones de red lentas.

### Formato de bóveda v2

1. Generar una clave maestra aleatoria de 256 bits.
2. Cifrar identidad e historial con esa clave maestra.
3. Derivar una clave de contraseña con Argon2id y usarla sólo para envolver la
   clave maestra.
4. Ajustar memoria y tiempo mediante benchmark por plataforma, conservando un
   mínimo de seguridad documentado.
5. Para acceso rápido, generar otra clave de envoltura aleatoria y guardarla en
   Windows Credential Manager, macOS Keychain o Linux Secret Service.
6. No guardar la contraseña. Mantener siempre el desbloqueo completo como
   recuperación.

El acceso al almacén del sistema no implica por sí solo biometría o presencia
del usuario. Windows Hello y Touch ID requieren integración específica si ese
requisito forma parte del modelo de amenaza.

La migración debe ser atómica: descifrar v1, escribir v2 en un archivo temporal,
verificarlo, reemplazar el original y conservar una copia recuperable hasta el
primer inicio correcto.

## Transporte tipo Session

La interfaz puede parecerse pronto a Session, pero la resistencia a metadatos
requiere cambios de protocolo:

1. Sustituir la identidad de transporte global por identificadores o buzones
   distintos por contacto.
2. Separar la clave de identidad de las claves visibles para los relays.
3. Encapsular el destinatario para que un relay no lea un `p_tag` estable.
4. Introducir rutas de varios saltos o un proxy onion para ocultar la IP al
   relay de almacenamiento.
5. Añadir padding por rangos, expiración estricta y límites anti-spam.
6. Diseñar grupos sin una lista global visible y con rotación al expulsar
   miembros.

Este trabajo debe versionarse como un protocolo nuevo y convivir temporalmente
con el transporte Nostr actual; no debe introducirse como un cambio silencioso.

## Privacidad suiza

La FADP revisada está vigente desde el 1 de septiembre de 2023. Alojar un relay
en Suiza no convierte por sí solo a Trino en una organización suiza ni permite
prometer protección jurídica suiza.

Antes de usar ese reclamo se necesita, como mínimo:

- identificar al responsable real del tratamiento y su jurisdicción;
- política de privacidad con finalidades, categorías, retención y derechos;
- contratos con proveedores y ubicación verificable de datos;
- registro y respuesta a incidentes;
- minimización de logs y borrado comprobable;
- revisión legal de FADP, GDPR y leyes de los países donde se distribuye.

La formulación honesta hoy es: "diseñado con privacidad por defecto, identidad
local y transporte autoalojable". En el futuro puede ofrecerse una opción de
"relays alojados en Suiza" si la operación y los contratos lo demuestran.

## Orden recomendado

### P0: antes de una beta pública

- hardening de llamadas y TURN privado;
- revisión independiente del protocolo y la bóveda;
- recuperación y copia cifrada;
- actualizaciones firmadas;
- pruebas cruzadas en los tres sistemas;
- política de privacidad sin afirmaciones absolutas.

### P1: paridad competitiva

- multi-dispositivo con autorización explícita;
- entrega, reintento y estado offline sin perder mensajes;
- llamadas grupales o SFU cifrado con modelo documentado;
- bloqueo anti-spam e invitaciones;
- builds reproducibles, SBOM y auditorías publicadas.

### P2: diferenciación

- transporte con identificadores por contacto;
- proxy onion o rutas de varios saltos;
- modo relay-only para llamadas;
- infraestructura suiza verificable o despliegue totalmente autoalojado.

## Referencias técnicas

- RFC 8827: WebRTC Security Architecture.
- W3C WebRTC: `restartIce()` e ICE restart.
- coturn TURN REST API.
- RFC 9106: Argon2.
- Signal X3DH y Double Ratchet specifications.
- Session protocol documentation.
- SimpleX Messaging Protocol.
- Swiss Federal Act on Data Protection.
