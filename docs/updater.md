# El actualizador de Trino (TOR-9 y TOR-13)

Trino se actualiza solo, por Tor, y nunca instala nada sin preguntarte. El
plugin de Tauri no sirve aquí porque siempre usa su propio cliente de red, que
no pasa por Tor (diseño de Tor §6.1, decisión 5). Por eso Trino tiene un
actualizador propio:

- la revisión y las firmas están en `crates/trino-net/src/update/`, y el
  reemplazo del AppImage en Linux, en `update/appimage.rs`;
- el cuándo, las preguntas y la instalación, en `src-tauri/src/updater.rs`.

## Cómo funciona

- **Una vez al día, a una hora al azar**, con Trino abierto (también
  bloqueado). Revisa mientras esté encendido "Buscar actualizaciones cada día",
  que viene encendido. El interruptor y el día de la última revisión se guardan
  en `tor/update.json`, sin hora del día.
- **Cada revisión** pregunta, por Tor y en una sesión propia, a todos los
  espejos de `latest.json`:
  - `https://trinochat.org/updates/latest.json`;
  - `https://github.com/trinochat/releases/releases/latest/download/latest.json`.

  En la misma revisión baja también las novedades. Si las novedades anuncian
  una versión que ningún espejo ofrece, eso cuenta como congelamiento (§6.4).
- **GitHub siempre redirige.** Solo se siguen las redirecciones por HTTPS, como
  mucho 3 saltos y solo hacia `github.com`, `release-assets.githubusercontent.com`
  y `objects.githubusercontent.com`.
- **Manda la firma, no el espejo.** Antes de bajar nada se comprueba el
  comentario de confianza de la firma. De ahí sale la versión, que tiene que
  ser la misma que anuncia `latest.json` y mayor que la instalada. Gana la
  versión firmada más alta, y `notes` nunca se lee.
- **El instalador** se comprueba completo contra la firma antes de guardarlo.
  Después se guarda con el nombre con que se firmó y se vuelve a comprobar desde
  el disco. Queda abierto, sin que nadie pueda cambiarlo, hasta que corre.
- **Siempre pregunta antes de instalar.** Al tocar "Instalar y reiniciar":
  1. si hay una llamada, espera a que cuelgues;
  2. bloquea la sesión y detiene Tor, y con él `lyrebird`;
  3. corre el instalador NSIS por usuario con `/P /UPDATE /R`, que instala
     encima, en modo pasivo, y vuelve a abrir Trino;
  4. Trino se cierra.
- **En Linux**, si Trino corre como AppImage, lo reemplaza en su sitio después
  de preguntarte; con el `.deb` solo deja el AppImage verificado en Descargas.
  Los detalles están en [En Linux](#en-linux).
- **Sin Tor** ("Conectar sin protección") no revisa nada. Con Tor sin conectar,
  nunca sale directo: vuelve a intentar entre 30 y 90 minutos después.
- **Si Arti queda obsoleto**, la pantalla de "versión vieja" puede usar
  `update_check_without_tor`, siempre después de su confirmación. Ese comando
  usa el permiso propio del actualizador, que:
  - solo existe mientras Arti está obsoleto;
  - solo llega a trinochat.org y a GitHub, por el puerto 443;
  - nunca abre un WebSocket ni baja las novedades;
  - comprueba la firma igual que siempre.

  Esa pantalla primero recomienda Tor Browser (R-15).

Comandos para la interfaz: el aviso de "Versión nueva" en la bandeja, el
interruptor de Ajustes › Privacidad › Conexión y "Trino necesita
actualizarse" (docs/tor.md, Pantallas):

| Comando | Para qué |
|---|---|
| `update_status` | Devuelve `{ state, installed, daily, freeze }`. |
| `update_set_daily` | Enciende o apaga el interruptor. |
| `update_check_now` | "Buscar ahora". |
| `update_check_without_tor` | La salida de la pantalla de "versión vieja". |
| `update_install` | El sí de "Instalar y reiniciar". |

Cada cambio llega a la interfaz como el evento `update-changed`. Los estados
posibles son estos:

- `idle`
- `checking`
- `upToDate`
- `downloading`
- `ready`
- `saved`, con su motivo: `notAppImage`, `missing` o `notWritable` (Linux)
- `waitingForCall`
- `installing`
- `failed`, con su motivo
- `unsupported`

## En Linux

Para Linux, `latest.json` trae el AppImage (`linux-x86_64`). Lo que hace Trino
con él depende de cómo lo instalaste.

### Si Trino corre como AppImage, se actualiza solo

El AppImage pone su propia ruta en la variable `APPIMAGE` y corre Trino desde
una carpeta `.mount_…`. Trino solo reemplaza un AppImage cuando ve las dos
cosas y la ruta es completa, igual que lo comprueba Tauri. Una variable
`APPIMAGE` puesta a mano no basta.

1. **Lo baja al lado del AppImage.** La versión nueva se baja por Tor a un
   archivo oculto en la misma carpeta del AppImage, por ejemplo
   `.Trino Chat_0.2.0_amd64.AppImage.part`, que solo tú puedes leer (modo
   `600`). Así el cambio final es un solo renombre dentro del mismo disco.
   Trino crea ese archivo antes de bajar nada, así que sabe desde el principio
   si puede escribir en esa carpeta.
2. **Comprueba la firma minisign del archivo completo** antes de escribir un
   solo byte, y otra vez desde el disco.
3. **Te pregunta**, igual que en Windows: "Instalar y reiniciar". Sin tu sí no
   se reemplaza nada.
4. **Con tu sí:**
   1. si hay una llamada, espera a que cuelgues;
   2. bloquea la sesión y detiene Tor, y con él `lyrebird`;
   3. vuelve a comprobar la firma del archivo completo desde el disco, antes
      de cualquier otra cosa;
   4. le pone los permisos del AppImage viejo, más el de ejecución para quien
      pueda leerlo (nunca setuid, setgid ni sticky);
   5. lo guarda en el disco (`fsync`) y lo renombra encima del AppImage, en un
      solo paso; después guarda también la carpeta;
   6. Trino se cierra y se vuelve a abrir desde el AppImage nuevo, con la misma
      ruta y el mismo nombre que tú le diste.
- **Nunca usa `sudo`** ni pide permisos de administrador.
- **Si algo falla antes del renombre** (se va la luz, Trino se cierra o la
  firma no coincide), el AppImage viejo queda intacto. El archivo a medias se
  borra la próxima vez que abras Trino, y solo ese: Trino no toca nada más de
  la carpeta.
- **Si la comprobación final falla** o el AppImage ya no está, Trino no
  reemplaza nada, vuelve a encender Tor y queda en `failed`. La siguiente
  revisión lo baja de nuevo.
- El Trino que está abierto sigue funcionando hasta que se cierra, porque
  conserva montado el AppImage viejo.

### Si no se puede reemplazar, lo deja en Descargas

Si el AppImage está en una carpeta donde no puedes escribir (por ejemplo
`/opt`), o ya no está donde Trino lo abrió, Trino no pide permisos ni baja
nada al lado. En cambio, deja el AppImage nuevo, verificado, en tu carpeta de
Descargas, igual que con el `.deb`. El estado queda en `saved`, con el motivo
`notWritable` o `missing`.

Para que se actualice solo, guarda el AppImage en una carpeta tuya, como
`~/Aplicaciones` o `~/Descargas`.

### Con el .deb (o el .rpm), solo lo descarga

Instalar un `.deb` pide permisos de administrador, y Trino nunca los pide. Por
eso, si instalaste Trino con el `.deb`, Trino no instala nada: baja el AppImage
de la versión nueva, comprueba su firma, lo deja en tu carpeta de Descargas y
te avisa. El estado queda en `saved`, con el motivo `notAppImage`.

Puedes usar ese AppImage o instalar a mano el `.deb` de la versión nueva. Un
repositorio apt queda para más adelante.

## La llave

La llave es minisign y la creaste con `tauri signer generate`, con
contraseña. Es aparte de la GPG de versiones (`BFC6…D554`) y de "Trino
Updates" (`4DE8…6A6B`).

- **Pública**, metida en el programa (`TRINO_UPDATER_KEY`):
  - id: `2A6861FC701B75D7`;
  - línea minisign: `RWTXdRtw/GFoKsE/54ddeKJPytoWbhIXUxOdVJLEUynD5lPMpxokYMkf`.
- **Privada:** `~/.tauri/trino-updater.key`. Solo la tienes tú, con una copia en
  la USB cifrada. No va al repositorio, ni a los secretos de GitHub, ni a
  ninguna otra parte.
- **Si se pierde la privada o su contraseña,** nadie vuelve a recibir
  actualizaciones automáticas. Para cambiar de llave, una versión firmada con
  la vieja tiene que traer la pública nueva.

## Cómo firmas una versión

1. **Sube la versión.** Cambia `version` en `src-tauri/tauri.conf.json` y en
   `src-tauri/Cargo.toml`, que tienen que coincidir: una prueba lo comprueba.
   Luego crea la etiqueta, como dice `docs/release.md`.
2. **Baja el instalador de Windows y el AppImage** del borrador que arma el CI,
   por ejemplo `Trino.Chat_0.2.0_x64-setup.exe` y
   `Trino.Chat_0.2.0_amd64.AppImage`. No les cambies el nombre: lo que se firma
   es el nombre más la versión. Trino acepta `Trino Chat_`, `Trino.Chat_` y
   `TrinoChat_` seguidos de `<versión>_x64-setup.exe` en Windows, o de
   `<versión>_amd64.AppImage` en Linux. Así los nombra tauri-bundler
   (`<productName>_<versión>_amd64.AppImage`), y GitHub cambia el espacio por
   un punto.
3. **Fírmalo en PowerShell**, en tu equipo:

   ```powershell
   npx --no-install tauri signer sign -f $HOME\.tauri\trino-updater.key .\Trino.Chat_0.2.0_x64-setup.exe
   ```

   Te pide la contraseña. **Nunca la pases en la línea de comandos** (`-p`) ni
   en `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: quedaría en el historial y en el
   entorno. Corre el comando en PowerShell o en Windows Terminal, no en Git
   Bash, porque el aviso necesita una consola de verdad.

   El comando escribe `Trino.Chat_0.2.0_x64-setup.exe.sig`, una sola línea en
   base64. Su comentario de confianza queda así:
   `timestamp:…<tab>file:Trino.Chat_0.2.0_x64-setup.exe`.

   Firma el AppImage igual:

   ```powershell
   npx --no-install tauri signer sign -f $HOME\.tauri\trino-updater.key .\Trino.Chat_0.2.0_amd64.AppImage
   ```
4. **Escribe `latest.json`** con esa línea como `signature`:

   ```json
   {
     "version": "0.2.0",
     "pub_date": "2026-11-05T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "url": "https://github.com/trinochat/releases/releases/download/v0.2.0/Trino.Chat_0.2.0_x64-setup.exe",
         "signature": "<el contenido de Trino.Chat_0.2.0_x64-setup.exe.sig>"
       },
       "linux-x86_64": {
         "url": "https://github.com/trinochat/releases/releases/download/v0.2.0/Trino.Chat_0.2.0_amd64.AppImage",
         "signature": "<el contenido de Trino.Chat_0.2.0_amd64.AppImage.sig>"
       }
     }
   }
   ```

   - La `url` tiene que estar en `trinochat.org` o en `github.com` y usar
     `https://`.
   - `version` tiene que ser la misma del nombre firmado.
   - No pongas `notes`: Trino no las muestra. Lo que quieras contar va en las
     novedades firmadas (`docs/announcement-channel.md`).
   - Para Linux, `linux-x86_64` lleva el AppImage, nunca el `.deb`: el AppImage
     es lo que se reemplaza en su sitio, y lo que queda en Descargas.
5. **Publica** el instalador, el AppImage, sus `.sig` y `latest.json`:
   - en la versión de `trinochat/releases`, el repositorio público solo de
     versiones;
   - en `trinochat.org/updates/`. Eso es un despliegue remoto y lleva su propia
     autorización. El instalador va ahí solo si pesa menos de 25 MiB.

   Actualiza también las novedades: el `latest` con la versión nueva y el
   `validUntil`.
6. **Compruébalo** antes de anunciarlo, si tienes `minisign`:

   ```powershell
   [IO.File]::WriteAllBytes("$PWD\firma.minisig", [Convert]::FromBase64String((Get-Content .\Trino.Chat_0.2.0_x64-setup.exe.sig -Raw)))
   minisign -Vm .\Trino.Chat_0.2.0_x64-setup.exe -x .\firma.minisig -P RWTXdRtw/GFoKsE/54ddeKJPytoWbhIXUxOdVJLEUynD5lPMpxokYMkf
   ```

   Haz lo mismo con el AppImage y su `.sig`.

Firma cada versión también con la GPG de versiones (`SHA256SUMS.asc`), para
quien instala a mano (`docs/release.md`).

## El instalador

- **Solo NSIS y por usuario.** `bundle.targets` lleva `nsis` y ya no `msi`, y
  `installMode` es `currentUser`, así que no pide administrador.
- **Linux** sigue con `.deb`, `.rpm` y `.AppImage`. Solo el AppImage se
  actualiza solo ([En Linux](#en-linux)).
- **El gancho `src-tauri/windows/hooks.nsh`** (`NSIS_HOOK_PREINSTALL`) es un
  respaldo para cuando alguien instala a mano con Trino abierto:
  - si `lyrebird.exe` sigue corriendo, lo renombra a `lyrebird.old.exe`, porque
    un programa que corre no se puede borrar, pero sí renombrar;
  - no cierra nada por nombre, porque el `lyrebird.exe` de Tor Browser se llama
    igual;
  - el viejo se cierra solo cuando se cierra Trino;
  - la siguiente instalación y la desinstalación lo borran.
- **Todavía no se ha armado un instalador con este gancho.** Falta probarlo a
  mano: arma el instalador con
  `npx tauri build --config src-tauri/tauri.bridges.conf.json`, instálalo
  encima de uno anterior con Trino abierto y con un puente en uso, y mira que
  `lyrebird.old.exe` aparezca y que la siguiente instalación lo borre.
