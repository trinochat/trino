/**
 * The texts of the emergency key (clave de emergencia CE-5), from the
 * approved mockups (PropClaveEmergencia, canvas version 45) and design
 * §11: Settings › Cuenta y seguridad › Clave de emergencia, configuring or
 * changing it, testing it without erasing, removing it, and what happens
 * on the network.
 *
 * Honest by design (§11.7): none says it is unrecoverable, leaves no
 * trace, is safe as a promise, or gives plausible deniability, and there
 * is no legal note (CE-D7). Nothing here tells whether a key is set
 * (CE-D6). Its contract is emergency.test.ts.
 */
import type { AreaStrings } from './types';

export const emergency: AreaStrings = {
  es: {
    'emergency.row.title': 'Clave de emergencia',
    'emergency.row.body': 'Para cuando alguien te obligue a abrir Trino.',

    'emergency.page.title': 'Clave de emergencia',
    'emergency.page.back': 'Volver a Cuenta y seguridad',
    'emergency.page.what':
      'Es una segunda contraseña para cuando alguien te obligue a abrir Trino. Si la escribes en lugar de tu contraseña, Trino borra en ese momento tu identidad, tus chats y tus contactos de este computador, y abre una cuenta nueva y vacía con tu mismo nombre. Si te piden abrirlo otra vez, esa misma clave abre la cuenta vacía.',
    'emergency.page.totp': 'Si usas verificación en dos pasos, la clave de emergencia también pide el código de tu app.',
    'emergency.page.setup': 'Configurar o cambiar',
    'emergency.page.test': 'Probar',
    'emergency.page.remove': 'Quitar',
    'emergency.page.more': 'Más',
    'emergency.page.network': 'Qué pasa en la red',
    'emergency.page.networkBody': 'Pide tu contraseña antes de mostrar nada.',

    'emergency.setup.title': 'Configurar la clave de emergencia',
    'emergency.setup.back': 'Volver a Clave de emergencia',
    'emergency.setup.step': 'Paso {n} de 4',
    'emergency.setup.limits': 'Antes de configurarla',
    'emergency.setup.undoTitle': 'No se puede deshacer.',
    'emergency.setup.undo':
      'Para volver a hablar con tus contactos desde este computador, tendrán que agregarse otra vez, o tendrás que recuperar tu cuenta con tus 12 palabras.',
    'emergency.setup.onlyUnlock': 'Solo funciona en la pantalla de desbloqueo. Si Trino está abierto, no sirve: usa el bloqueo automático.',
    'emergency.setup.notTheirs': 'No borra lo que tus contactos tienen en sus equipos, ni lo que vieron los relays.',
    'emergency.setup.copies': 'Si alguien ya copió tu disco, esa copia no se borra: sigue protegida por tu contraseña real. No se la des a nadie.',
    'emergency.setup.otherDevices':
      'Si usas Trino en otro dispositivo, solo se borra este. La cuenta sigue en los demás, y quien vea los dos lo puede notar.',
    'emergency.setup.forensic':
      'Un análisis forense puede mostrar que se borraron datos en ese momento. Y como el código de Trino es público, quien lo conozca sabe que esta función existe.',
    'emergency.setup.installed': 'Trino sigue instalado: quien revise el computador verá que lo usas, ahora con una cuenta vacía.',
    'emergency.setup.kit':
      'Si tienes un kit de recuperación, no se borra: con tu hoja se puede volver a abrir tu cuenta. Si alguien puede obligarte a entregarla, no la tengas cerca.',
    'emergency.setup.memorize':
      'Memorízala. No uses una contraseña que ya hayas usado en Trino, y no la guardes en un gestor de contraseñas que la escriba solo: podrías borrarlo todo sin querer.',
    'emergency.setup.understood': 'Entiendo que no se puede deshacer.',
    'emergency.setup.continue': 'Seguir',
    'emergency.setup.passFirst': 'Primero, tu contraseña de siempre.',
    'emergency.setup.replaces': 'Si ya tenías una clave de emergencia, la nueva la reemplaza. No hace falta que recuerdes la anterior.',
    'emergency.setup.passphrase': 'Tu contraseña',
    'emergency.setup.showPassphrase': 'Mostrar contraseña',
    'emergency.setup.code': 'Código de tu app autenticadora',
    'emergency.setup.key': 'Clave de emergencia',
    'emergency.setup.showKey': 'Mostrar clave',
    'emergency.setup.keyRule': 'Al menos {min} caracteres. Distinta de tu contraseña, y que no se le parezca.',
    'emergency.setup.repeat': 'Repite la clave de emergencia',
    'emergency.setup.save': 'Guardar',
    'emergency.setup.saved': 'Tu clave de emergencia quedó guardada.',
    'emergency.setup.tryNow': 'Pruébala ahora, sin borrar nada, para comprobar que la recuerdas.',
    'emergency.setup.tryButton': 'Probar sin borrar',
    'emergency.setup.better': 'Para que te proteja mejor',
    'emergency.setup.reinforced': 'Protección reforzada',
    'emergency.setup.reinforcedBody': 'Bloqueo al minuto, avisos sin nombre, capturas en negro y portapapeles que se borra.',
    'emergency.setup.networkBody': 'Por defecto, nada sale a internet.',
    'emergency.setup.done': 'Listo',

    'emergency.err.short': 'La clave de emergencia necesita al menos {min} caracteres.',
    'emergency.err.common': 'Esa clave es muy común o muy simple. Elige otra.',
    'emergency.err.same': 'Tiene que ser distinta de tu contraseña.',
    'emergency.err.like': 'Se parece demasiado a tu contraseña: podrías escribirla sin querer.',
    'emergency.err.another': 'Elige otra clave de emergencia.',
    'emergency.err.mismatch': 'Las dos no coinciden. Escríbela otra vez.',
    'emergency.err.wrong': 'La contraseña no es correcta.',
    'emergency.err.wrongCode': 'La contraseña o el código no son correctos.',
    'emergency.err.save': 'No se pudo guardar. Inténtalo de nuevo.',
    'emergency.err.test': 'No se pudo probar. Inténtalo de nuevo.',
    'emergency.err.open': 'No se pudo abrir. Inténtalo de nuevo.',

    'emergency.test.title': 'Probar mi clave de emergencia',
    'emergency.test.body': 'Escríbela aquí para comprobar que la recuerdas. Aquí no borra nada.',
    'emergency.test.lockNote': 'Si Trino se bloquea mientras pruebas, no escribas la clave de emergencia en la pantalla de desbloqueo.',
    'emergency.test.field': 'Clave que quieres probar',
    'emergency.test.run': 'Probar',
    'emergency.test.yes': 'Esa es tu clave de emergencia. En la pantalla de desbloqueo borraría todo.',
    'emergency.test.no': 'No coincide con tu clave de emergencia.',

    'emergency.remove.title': '¿Quitar la clave de emergencia?',
    'emergency.remove.body': 'Si tienes una, deja de servir.',
    'emergency.remove.confirm': 'Quitar',
    'emergency.remove.done': 'Listo. Si tenías una clave de emergencia, ya no sirve.',
    'emergency.remove.ok': 'Entendido',

    'emergency.net.title': 'Qué pasa en la red',
    'emergency.net.locked': 'Escribe tu contraseña para ver y cambiar esto.',
    'emergency.net.intro': 'Lo que hace Trino en internet cuando alguien escribe tu clave de emergencia. Puedes avisar a un contacto, o no hacer nada.',
    'emergency.net.none': 'Ninguna',
    'emergency.net.noneBody': 'Nada sale a internet. Es lo más discreto.',
    'emergency.net.alert': 'Avisar a un contacto de confianza',
    'emergency.net.alertBody':
      'Le llega un aviso a una persona que elijas, si ella lo acepta. Puede delatar que la usaste: esa persona lo sabrá, y quien la presione o le revise el equipo también puede saberlo. El aviso sale solo si Trino tiene conexión en ese momento; si no, no sale, y Trino no te muestra si salió.',
    'emergency.net.alertSoon':
      'Todavía no se puede elegir: tu contacto tiene que poder aceptar el aviso desde su Trino, y eso llega en una próxima versión.',
  },
  en: {
    'emergency.row.title': 'Emergency key',
    'emergency.row.body': 'For when someone forces you to open Trino.',

    'emergency.page.title': 'Emergency key',
    'emergency.page.back': 'Back to Account and security',
    'emergency.page.what':
      'It is a second password for when someone forces you to open Trino. If you type it instead of your password, Trino erases your identity, your chats and your contacts from this computer right then, and opens a new, empty account with your same name. If you are asked to open it again, the same key opens the empty account.',
    'emergency.page.totp': 'If you use two-step verification, the emergency key asks for the code from your app too.',
    'emergency.page.setup': 'Set up or change',
    'emergency.page.test': 'Test',
    'emergency.page.remove': 'Remove',
    'emergency.page.more': 'More',
    'emergency.page.network': 'What happens on the network',
    'emergency.page.networkBody': 'Asks for your password before showing anything.',

    'emergency.setup.title': 'Set up the emergency key',
    'emergency.setup.back': 'Back to Emergency key',
    'emergency.setup.step': 'Step {n} of 4',
    'emergency.setup.limits': 'Before you set it up',
    'emergency.setup.undoTitle': 'It cannot be undone.',
    'emergency.setup.undo':
      'To talk to your contacts from this computer again, they will have to add you again, or you will have to recover your account with your 12 words.',
    'emergency.setup.onlyUnlock': 'It only works on the unlock screen. If Trino is open, it does nothing: use the auto-lock.',
    'emergency.setup.notTheirs': 'It does not erase what your contacts have on their devices, or what the relays saw.',
    'emergency.setup.copies':
      'If someone already copied your disk, that copy is not erased: it is still protected by your real password. Do not give it to anyone.',
    'emergency.setup.otherDevices':
      'If you use Trino on another device, only this one is erased. The account stays on the others, and someone who sees both can notice.',
    'emergency.setup.forensic':
      'A forensic analysis can show that data was erased at that moment. And since Trino’s code is public, anyone who knows it knows this feature exists.',
    'emergency.setup.installed': 'Trino stays installed: someone who checks the computer will see you use it, now with an empty account.',
    'emergency.setup.kit':
      'If you have a recovery kit, it is not erased: your sheet can open your account again. If someone could force you to hand it over, do not keep it nearby.',
    'emergency.setup.memorize':
      'Memorize it. Do not use a password you have used in Trino before, and do not keep it in a password manager that types it for you: you could erase everything by mistake.',
    'emergency.setup.understood': 'I understand it cannot be undone.',
    'emergency.setup.continue': 'Continue',
    'emergency.setup.passFirst': 'First, your usual password.',
    'emergency.setup.replaces': 'If you already had an emergency key, the new one replaces it. You do not need to remember the old one.',
    'emergency.setup.passphrase': 'Your password',
    'emergency.setup.showPassphrase': 'Show password',
    'emergency.setup.code': 'Code from your authenticator app',
    'emergency.setup.key': 'Emergency key',
    'emergency.setup.showKey': 'Show key',
    'emergency.setup.keyRule': 'At least {min} characters. Different from your password, and not like it.',
    'emergency.setup.repeat': 'Repeat the emergency key',
    'emergency.setup.save': 'Save',
    'emergency.setup.saved': 'Your emergency key is saved.',
    'emergency.setup.tryNow': 'Test it now, without erasing anything, to check that you remember it.',
    'emergency.setup.tryButton': 'Test without erasing',
    'emergency.setup.better': 'So it protects you better',
    'emergency.setup.reinforced': 'Reinforced protection',
    'emergency.setup.reinforcedBody': 'Lock after a minute, notifications without names, black screenshots and a clipboard that clears.',
    'emergency.setup.networkBody': 'By default, nothing goes out to the internet.',
    'emergency.setup.done': 'Done',

    'emergency.err.short': 'The emergency key needs at least {min} characters.',
    'emergency.err.common': 'That key is too common or too simple. Choose another one.',
    'emergency.err.same': 'It has to be different from your password.',
    'emergency.err.like': 'It is too much like your password: you could type it by mistake.',
    'emergency.err.another': 'Choose another emergency key.',
    'emergency.err.mismatch': 'The two do not match. Type it again.',
    'emergency.err.wrong': 'The password is not correct.',
    'emergency.err.wrongCode': 'The password or the code is not correct.',
    'emergency.err.save': 'Couldn’t save. Try again.',
    'emergency.err.test': 'Couldn’t test it. Try again.',
    'emergency.err.open': 'Couldn’t open it. Try again.',

    'emergency.test.title': 'Test my emergency key',
    'emergency.test.body': 'Type it here to check that you remember it. Here it erases nothing.',
    'emergency.test.lockNote': 'If Trino locks while you test, do not type the emergency key on the unlock screen.',
    'emergency.test.field': 'Key you want to test',
    'emergency.test.run': 'Test',
    'emergency.test.yes': 'That is your emergency key. On the unlock screen it would erase everything.',
    'emergency.test.no': 'It does not match your emergency key.',

    'emergency.remove.title': 'Remove the emergency key?',
    'emergency.remove.body': 'If you have one, it stops working.',
    'emergency.remove.confirm': 'Remove',
    'emergency.remove.done': 'Done. If you had an emergency key, it no longer works.',
    'emergency.remove.ok': 'Got it',

    'emergency.net.title': 'What happens on the network',
    'emergency.net.locked': 'Type your password to see and change this.',
    'emergency.net.intro': 'What Trino does on the internet when someone types your emergency key. You can warn a contact, or do nothing.',
    'emergency.net.none': 'None',
    'emergency.net.noneBody': 'Nothing goes out to the internet. It is the most discreet.',
    'emergency.net.alert': 'Warn a trusted contact',
    'emergency.net.alertBody':
      'A warning reaches a person you choose, if they accept it. It can give away that you used it: that person will know, and so can whoever pressures them or checks their device. The warning only goes out if Trino has a connection at that moment; if not, it does not go out, and Trino does not show you whether it did.',
    'emergency.net.alertSoon':
      'It cannot be chosen yet: your contact has to be able to accept the warning from their Trino, and that comes in a later version.',
  },
  pt: {
    'emergency.row.title': 'Chave de emergência',
    'emergency.row.body': 'Para quando alguém obrigar você a abrir o Trino.',

    'emergency.page.title': 'Chave de emergência',
    'emergency.page.back': 'Voltar para Conta e segurança',
    'emergency.page.what':
      'É uma segunda senha para quando alguém obrigar você a abrir o Trino. Se você digitar essa chave no lugar da sua senha, o Trino apaga na hora a sua identidade, as suas conversas e os seus contatos deste computador, e abre uma conta nova e vazia com o mesmo nome. Se pedirem para abrir de novo, a mesma chave abre a conta vazia.',
    'emergency.page.totp': 'Se você usa verificação em duas etapas, a chave de emergência também pede o código do seu app.',
    'emergency.page.setup': 'Configurar ou mudar',
    'emergency.page.test': 'Testar',
    'emergency.page.remove': 'Remover',
    'emergency.page.more': 'Mais',
    'emergency.page.network': 'O que acontece na rede',
    'emergency.page.networkBody': 'Pede a sua senha antes de mostrar qualquer coisa.',

    'emergency.setup.title': 'Configurar a chave de emergência',
    'emergency.setup.back': 'Voltar para Chave de emergência',
    'emergency.setup.step': 'Passo {n} de 4',
    'emergency.setup.limits': 'Antes de configurar',
    'emergency.setup.undoTitle': 'Não dá para desfazer.',
    'emergency.setup.undo':
      'Para voltar a falar com os seus contatos deste computador, eles vão ter que adicionar você de novo, ou você vai ter que recuperar a sua conta com as suas 12 palavras.',
    'emergency.setup.onlyUnlock': 'Só funciona na tela de desbloqueio. Se o Trino estiver aberto, não serve: use o bloqueio automático.',
    'emergency.setup.notTheirs': 'Não apaga o que os seus contatos têm nos aparelhos deles, nem o que os relays viram.',
    'emergency.setup.copies':
      'Se alguém já copiou o seu disco, essa cópia não é apagada: continua protegida pela sua senha real. Não passe a senha para ninguém.',
    'emergency.setup.otherDevices':
      'Se você usa o Trino em outro dispositivo, só este é apagado. A conta continua nos outros, e quem vir os dois pode perceber.',
    'emergency.setup.forensic':
      'Uma análise forense pode mostrar que dados foram apagados naquele momento. E como o código do Trino é público, quem o conhece sabe que essa função existe.',
    'emergency.setup.installed': 'O Trino continua instalado: quem revisar o computador vai ver que você usa, agora com uma conta vazia.',
    'emergency.setup.kit':
      'Se você tem um kit de recuperação, ele não é apagado: com a sua folha dá para abrir a sua conta de novo. Se alguém puder obrigar você a entregá-la, não a deixe por perto.',
    'emergency.setup.memorize':
      'Decore a chave. Não use uma senha que você já usou no Trino, e não a guarde num gerenciador de senhas que a digite sozinho: você poderia apagar tudo sem querer.',
    'emergency.setup.understood': 'Entendo que não dá para desfazer.',
    'emergency.setup.continue': 'Continuar',
    'emergency.setup.passFirst': 'Primeiro, a sua senha de sempre.',
    'emergency.setup.replaces': 'Se você já tinha uma chave de emergência, a nova a substitui. Não precisa lembrar da anterior.',
    'emergency.setup.passphrase': 'Sua senha',
    'emergency.setup.showPassphrase': 'Mostrar senha',
    'emergency.setup.code': 'Código do seu app autenticador',
    'emergency.setup.key': 'Chave de emergência',
    'emergency.setup.showKey': 'Mostrar chave',
    'emergency.setup.keyRule': 'Pelo menos {min} caracteres. Diferente da sua senha, e sem se parecer com ela.',
    'emergency.setup.repeat': 'Repita a chave de emergência',
    'emergency.setup.save': 'Salvar',
    'emergency.setup.saved': 'Sua chave de emergência foi salva.',
    'emergency.setup.tryNow': 'Teste agora, sem apagar nada, para confirmar que você lembra dela.',
    'emergency.setup.tryButton': 'Testar sem apagar',
    'emergency.setup.better': 'Para proteger você melhor',
    'emergency.setup.reinforced': 'Proteção reforçada',
    'emergency.setup.reinforcedBody': 'Bloqueio em um minuto, avisos sem nome, capturas em preto e área de transferência que se apaga.',
    'emergency.setup.networkBody': 'Por padrão, nada sai para a internet.',
    'emergency.setup.done': 'Pronto',

    'emergency.err.short': 'A chave de emergência precisa de pelo menos {min} caracteres.',
    'emergency.err.common': 'Essa chave é comum ou simples demais. Escolha outra.',
    'emergency.err.same': 'Tem que ser diferente da sua senha.',
    'emergency.err.like': 'Parece demais com a sua senha: você poderia digitá-la sem querer.',
    'emergency.err.another': 'Escolha outra chave de emergência.',
    'emergency.err.mismatch': 'As duas não são iguais. Digite de novo.',
    'emergency.err.wrong': 'A senha não está certa.',
    'emergency.err.wrongCode': 'A senha ou o código não estão certos.',
    'emergency.err.save': 'Não foi possível salvar. Tente novamente.',
    'emergency.err.test': 'Não foi possível testar. Tente novamente.',
    'emergency.err.open': 'Não foi possível abrir. Tente novamente.',

    'emergency.test.title': 'Testar minha chave de emergência',
    'emergency.test.body': 'Digite aqui para confirmar que você lembra dela. Aqui não apaga nada.',
    'emergency.test.lockNote': 'Se o Trino bloquear enquanto você testa, não digite a chave de emergência na tela de desbloqueio.',
    'emergency.test.field': 'Chave que você quer testar',
    'emergency.test.run': 'Testar',
    'emergency.test.yes': 'Essa é a sua chave de emergência. Na tela de desbloqueio, apagaria tudo.',
    'emergency.test.no': 'Não é igual à sua chave de emergência.',

    'emergency.remove.title': 'Remover a chave de emergência?',
    'emergency.remove.body': 'Se você tem uma, ela deixa de funcionar.',
    'emergency.remove.confirm': 'Remover',
    'emergency.remove.done': 'Pronto. Se você tinha uma chave de emergência, ela não funciona mais.',
    'emergency.remove.ok': 'Entendi',

    'emergency.net.title': 'O que acontece na rede',
    'emergency.net.locked': 'Digite a sua senha para ver e mudar isto.',
    'emergency.net.intro': 'O que o Trino faz na internet quando alguém digita a sua chave de emergência. Você pode avisar um contato, ou não fazer nada.',
    'emergency.net.none': 'Nenhuma',
    'emergency.net.noneBody': 'Nada sai para a internet. É o mais discreto.',
    'emergency.net.alert': 'Avisar um contato de confiança',
    'emergency.net.alertBody':
      'Um aviso chega a uma pessoa que você escolher, se ela aceitar. Pode denunciar que você a usou: essa pessoa vai saber, e quem a pressionar ou revisar o aparelho dela também pode saber. O aviso só sai se o Trino tiver conexão nesse momento; se não, não sai, e o Trino não mostra se saiu.',
    'emergency.net.alertSoon':
      'Ainda não dá para escolher: o seu contato precisa poder aceitar o aviso no Trino dele, e isso chega numa próxima versão.',
  },
};
