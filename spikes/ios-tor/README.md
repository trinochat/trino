# Spike: Tor (Arti) dentro de una app de iPhone

**La pregunta:** ¿el motor de red de Trino (`crates/trino-net`, con Arti 0.47) compila como librería estática de iOS y funciona dentro de una app de iPhone? Si funciona, ¿cuánto tarda en arrancar, cuánta memoria usa y qué pasa cuando la app se va a segundo plano?

Es desechable: no es el diseño del motor del celular. Cuando tengamos la respuesta, se borra.

## Qué hay aquí

- `spike-ios/`: un crate de Rust (`staticlib`) que usa `trino-net` tal como lo usa el escritorio (`Net::with_arti`, `start`, `ready`, `ws_connect` y `stop`). Expone funciones de C (`include/spike_ios.h`) que responden JSON:
  - arrancar Tor en una carpeta, en frío (la borra antes) o en caliente;
  - el estado y el avance;
  - un WebSocket a `wss://nos.lol` por Tor: un `REQ` de solo lectura hasta su `EOSE`, **nunca publica**;
  - detener Tor;
  - un informe con tiempos, memoria (`phys_footprint`, la cifra por la que iOS cierra una app) y errores.
  - Tiene su propio `Cargo.lock`, copiado del de la raíz: Arti y el resto quedan en las mismas versiones del escritorio. Lleva el mismo parche de `saturating-time` (`vendor/`).
- `app/`: una app de Flutter de una sola pantalla, con botones y el JSON. Swift (`ios/Runner/AppDelegate.swift`) llama a las funciones de C fuera del hilo principal.
- `.github/workflows/ios-tor-spike.yml`: compila la librería en el runner de macOS, la enlaza en la app y la sube a TestFlight. Firma y sube igual que `ios-testflight.yml`.

### Por qué usa el mismo app id de la demo

TestFlight sube cada build a una app de App Store Connect, y esa app se identifica por el bundle id. Un id aparte (`org.trinochat.app.torspike`) exigiría registrar otro App ID y crear otra app en App Store Connect, con otro nombre, y eso es tocar la cuenta de Apple. Por eso el spike usa **`org.trinochat.app`**, con los mismos secretos y el mismo `ExportOptions.plist`. Para no chocar con la demo:

- tiene su propia versión, **0.1.1**, mayor que la 0.1.0 de la demo. Con la 0.0.1, TestFlight mostraba la build pero no la dejaba instalar («La app solicitada no está disponible o no existe»); la sospecha es que fuera por ser una versión menor que la de la demo;
- sus builds van de **1001** en adelante (1000 + el número de corrida).

**Consecuencia:** en el iPhone, instalar el spike **reemplaza la demo**, porque es la misma app. Para volver a la demo, borra el spike del iPhone y luego instala una build 0.1.0 desde TestFlight; como es una versión menor, puede fallar igual que la 0.0.1, y en ese caso hay que subir otra build de la demo. En la pantalla de inicio el spike se llama «Trino Tor».

## Lo que tienes que hacer tú

1. **Autorizar el push** de la rama, que es nueva (sin forzar y sin tocar `main` ni `feat/motor`):
   ```sh
   git -C C:/Users/david/dev/wt/spike-ios push github spike/ios-tor
   ```
2. **Que el workflow aparezca en GitHub.** GitHub solo muestra «Run workflow» si el archivo está también en la rama por defecto. Es lo mismo que pasó con `ios-testflight.yml` (el commit `4f02490` en `main`). Hace falta otro commit en `main` que agregue solo `.github/workflows/ios-tor-spike.yml`, y eso es otro push que autorizas aparte.
3. En GitHub: **Actions › iOS Tor spike › Run workflow**. En «Use workflow from» eliges **`spike/ios-tor`**; si eliges `main`, falla en el primer paso y te lo dice.
4. **En App Store Connect, la pregunta de cifrado.** El spike no declara `ITSAppUsesNonExemptEncryption`, a propósito: usa Tor y TLS, así que el «no» de la demo no sería cierto. App Store Connect te va a preguntar por el cifrado antes de dejar probar la build. La respuesta la decides tú.
5. Instalas la build 0.1.1 (la de número más alto) desde TestFlight y mides lo de abajo.

### Instalar sin TestFlight (Ad Hoc)
El 21 oct 2026 TestFlight mostraba las builds, tanto la del spike como una demo nueva, pero no dejaba instalarlas («La app solicitada no está disponible o no existe»). Por eso el workflow también exporta un `.ipa` firmado Ad Hoc, que solo se instala en los iPhone registrados en la cuenta de desarrollador.

1. **Registrar el iPhone, antes de correr el workflow.** Conecta el iPhone por cable al PC y abre la app «Dispositivos Apple» de Windows. Al hacer clic en el número de serie aparece el UDID. Regístralo en developer.apple.com › Certificates, IDs & Profiles › Devices. El perfil Ad Hoc solo incluye los equipos registrados cuando corre el workflow.
2. **Correr el workflow** como siempre. En el resumen sale «Ad Hoc .ipa» y, en los artefactos de la corrida, `trino-tor-adhoc-<n>`, que se guarda 7 días. Si ese paso falla, la subida a TestFlight sigue igual.
3. **Servirlo por HTTPS.** iOS solo instala desde un manifiesto servido por HTTPS con un certificado válido. Se sirve con `tailscale serve` en georgia, así que solo se alcanza desde tu red de Tailscale; el iPhone tiene que estar conectado a Tailscale. Hace falta activar HTTPS una vez en el panel de Tailscale (DNS › HTTPS Certificates). El nombre `georgia.<tu-red>.ts.net` queda en los registros públicos de certificados.
4. **Instalar:** abres en Safari del iPhone el enlace `itms-services://…` de la página que sirve georgia, y luego, si iOS lo pide, confías en el perfil en Ajustes › General › VPN y gestión de dispositivos.

## Qué medir en el iPhone

Cada botón muestra el JSON. **«Copiar informe»** copia todo (corridas, pruebas, notas, memoria y errores) para pegarlo en el chat.

1. **Arranque en frío:** «Prueba completa en frío», tres veces. Ese botón borra la carpeta, arranca Tor, espera a que esté listo y abre el WebSocket. Anota:
   - `readyMs`, el tiempo hasta listo;
   - `states`, por dónde pasó el porcentaje;
   - `startCallMs`.
   - En Windows fue de 9 a 19 s (`research_notes/Tor en Trino/spike.md`, S3).
2. **Arranque en caliente:** «Detener Tor» y luego «Prueba completa en caliente», tres veces. En Windows tardó unos 6 s.
3. **Memoria:**
   - `memoryAtReady` y `memory` del informe: `physFootprintMb` (lo que cuenta iOS), `residentPeakMb` y `availableMb`, lo que queda antes de que iOS cierre la app;
   - la cifra de Ajustes › General › Almacenamiento no sirve para esto.
4. **El WebSocket:** en `probes[].result` mira:
   - `ok`;
   - `openMs`, que es circuito + TLS + WebSocket;
   - `eoseMs` y `events`.
   - En Windows, nos.lol abrió en 2,5 s de mediana. Si falla, «Probar WebSocket» otra vez (cada prueba usa un circuito nuevo).
5. **Segundo plano:** con Tor listo, ve a la pantalla de inicio y vuelve después de **10 s, 30 s, 2 min y 10 min**; prueba también a bloquear la pantalla.
   - Al volver, la app anota la salida y la vuelta, y prueba el WebSocket sola.
   - Debe decir «Sobrevivió» o «el WebSocket falló».
   - Anota también si la app se reinició, es decir, si el informe empieza de cero.
   - La app no pide tiempo extra en segundo plano: esto mide lo que hace iOS por defecto.
6. **Si es posible, con datos móviles** además del Wi-Fi.
7. **Si no arranca** (el estado queda en `blocked` con `cantBootstrap` y 0 %): el informe trae `diagnosis`, el error completo de Arti. Prueba también con «En frío sin revisar permisos», que apaga la revisión de permisos de carpetas de Arti. Si así arranca, el problema son los permisos de la carpeta del sandbox.

## Qué se comprobó en Windows y qué solo se ve en el runner

- **En Windows (21 oct 2026):**
  - `cargo check`, `cargo test` (4 pruebas), `cargo clippy` y `cargo fmt` del crate, para el host;
  - `flutter analyze` y `flutter test` (2 pruebas, con el lado nativo simulado);
  - se instaló el target `aarch64-apple-ios` de rustup;
  - `cargo check --target aarch64-apple-ios` **falla en Windows**, como se esperaba: `ring`, `libsqlite3-sys`, `zstd-sys` y `liblzma-sys` compilan C y necesitan `xcrun` y el SDK de iOS. Por eso el código de Arti y de trino-net para iOS no se pudo revisar aquí;
  - solo se revisó para iOS el módulo de memoria (`task_info` y `os_proc_available_memory`).
- **Solo en el runner de macOS:**
  - que todo el árbol compile para `aarch64-apple-ios`;
  - qué librerías del sistema pide (`native-static-libs`);
  - que el Swift compile y la app enlace;
  - el archive, la firma en la nube y la subida.
- **Solo en el iPhone:**
  - que Arti arranque dentro del sandbox, incluidos los permisos de carpetas;
  - los tiempos, la memoria y el segundo plano.

## Fuera del spike

- **Sin puentes:** en iOS no se pueden lanzar procesos (lyrebird). Los puentes en el iPhone necesitan una librería, como IPtProxy, y eso es otro trabajo.
- **No publica nada:** solo un `REQ` de lectura a nos.lol.
- **No toca notificaciones ni modos de segundo plano.**
- No guarda contenido de relays: solo cuenta eventos y bytes.
