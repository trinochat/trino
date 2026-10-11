/**
 * The texts of the settings (settings2.*) and of the contact details
 * (contactInfo.*). W5 owns this area; its contract is settings.test.ts.
 * Spanish is natural Colombian Spanish with "tú".
 */
import type { AreaStrings } from './types';

export const settings: AreaStrings = {
  es: {
    // What a message notification says (notification-content.ts).
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'Nuevo mensaje',
    'settings2.notif.newFile': 'Te envió un archivo',
    'settings2.notif.newSticker': 'Te envió un sticker',

    // Perfil (PropAjustes:123-166, plan-cambios-11oct §6.1).
    'settings2.profile.title': 'Perfil',
    'settings2.profile.editPhoto': 'Editar foto',
    'settings2.profile.removePhoto': 'Quitar foto',
    'settings2.profile.photoAlt': 'Tu foto',
    'settings2.profile.name': 'Nombre',
    'settings2.profile.about': 'Sobre mí',
    'settings2.profile.aboutCount': '{n} / 140',
    'settings2.profile.shared':
      'Tu nombre, tu foto y lo que escribas en «Sobre mí» les llegan cifrados a tus contactos y a tus grupos. Los servidores de Trino no los ven.',
    'settings2.profile.sharedPending':
      'Todavía no les llega a {n} de tus contactos: les llegará cuando te escriban desde una versión nueva de Trino.',
    'settings2.profile.sharedPendingOne':
      'Todavía no le llega a 1 de tus contactos: le llegará cuando te escriba desde una versión nueva de Trino.',
    'settings2.profile.local':
      'Tu foto y tu nombre se quedan en este equipo. Tus contactos te ven con el nombre que tenía tu código cuando te agregaron.',
    'settings2.profile.findYou': 'Cómo te encuentran',
    'settings2.profile.qrRow': 'Tu código QR',
    'settings2.profile.qrRowBody': 'Para que te agreguen sin escribir nada.',
    'settings2.profile.saved': 'Perfil guardado.',
    'settings2.profile.errInvalid': 'No se pudo guardar: tu nombre, tu foto o «Sobre mí» pasan del límite.',
    'settings2.profile.errSave': 'No se pudo guardar tu perfil. Inténtalo de nuevo.',
    'settings2.profile.errPhoto': 'No se pudo usar esa imagen. Prueba con otra foto.',
    'settings2.profile.errName': 'Escribe tu nombre.',

    // Tu código QR (PropAjustes:168-191).
    'settings2.qr.title': 'Tu código QR',
    'settings2.qr.back': 'Volver al perfil',

    // Privacidad (plan-cambios-11oct §4 W5).
    'settings2.privacy.title': 'Privacidad',
    'settings2.privacy.blocked': 'Contactos bloqueados',
    'settings2.privacy.blockedNone': 'Ninguno',
    'settings2.privacy.blockedEmpty': 'No tienes contactos bloqueados.',
    'settings2.privacy.unblock': 'Desbloquear',
    'settings2.privacy.unblockA11y': 'Desbloquear a {name}',
    'settings2.privacy.errUnblock': 'No se pudo desbloquear a {name}.',
    'settings2.privacy.errLoad': 'No se pudo cargar la lista de contactos.',
    'settings2.privacy.back': 'Volver a Privacidad',
    'settings2.privacy.callsLine':
      'Tus llamadas pasan por un servidor de Cloudflare: tu contacto no ve tu IP, pero Cloudflare sí. Si una llamada no se puede proteger, Trino te pregunta antes de llamar directo.',
  },
  en: {
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'New message',
    'settings2.notif.newFile': 'Sent you a file',
    'settings2.notif.newSticker': 'Sent you a sticker',

    'settings2.profile.title': 'Profile',
    'settings2.profile.editPhoto': 'Edit photo',
    'settings2.profile.removePhoto': 'Remove photo',
    'settings2.profile.photoAlt': 'Your photo',
    'settings2.profile.name': 'Name',
    'settings2.profile.about': 'About me',
    'settings2.profile.aboutCount': '{n} / 140',
    'settings2.profile.shared':
      'Your name, your photo and what you write in “About me” reach your contacts and your groups encrypted. Trino’s servers don’t see them.',
    'settings2.profile.sharedPending':
      'It doesn’t reach {n} of your contacts yet: it will when they write to you from a new version of Trino.',
    'settings2.profile.sharedPendingOne':
      'It doesn’t reach 1 of your contacts yet: it will when they write to you from a new version of Trino.',
    'settings2.profile.local':
      'Your photo and your name stay on this device. Your contacts see you with the name your code had when they added you.',
    'settings2.profile.findYou': 'How people find you',
    'settings2.profile.qrRow': 'Your QR code',
    'settings2.profile.qrRowBody': 'So people can add you without typing anything.',
    'settings2.profile.saved': 'Profile saved.',
    'settings2.profile.errInvalid': 'Couldn’t save: your name, your photo or “About me” is over the limit.',
    'settings2.profile.errSave': 'Your profile couldn’t be saved. Try again.',
    'settings2.profile.errPhoto': 'That picture couldn’t be used. Try another photo.',
    'settings2.profile.errName': 'Write your name.',

    'settings2.qr.title': 'Your QR code',
    'settings2.qr.back': 'Back to profile',

    'settings2.privacy.title': 'Privacy',
    'settings2.privacy.blocked': 'Blocked contacts',
    'settings2.privacy.blockedNone': 'None',
    'settings2.privacy.blockedEmpty': 'You have no blocked contacts.',
    'settings2.privacy.unblock': 'Unblock',
    'settings2.privacy.unblockA11y': 'Unblock {name}',
    'settings2.privacy.errUnblock': 'Couldn’t unblock {name}.',
    'settings2.privacy.errLoad': 'The list of contacts couldn’t be loaded.',
    'settings2.privacy.back': 'Back to Privacy',
    'settings2.privacy.callsLine':
      'Your calls go through a Cloudflare server: your contact doesn’t see your IP, but Cloudflare does. If a call can’t be protected, Trino asks you before calling directly.',
  },
  pt: {
    'settings2.notif.appName': 'Trino Chat',
    'settings2.notif.newMessage': 'Nova mensagem',
    'settings2.notif.newFile': 'Enviou um arquivo para você',
    'settings2.notif.newSticker': 'Enviou uma figurinha para você',

    'settings2.profile.title': 'Perfil',
    'settings2.profile.editPhoto': 'Editar foto',
    'settings2.profile.removePhoto': 'Remover foto',
    'settings2.profile.photoAlt': 'Sua foto',
    'settings2.profile.name': 'Nome',
    'settings2.profile.about': 'Sobre mim',
    'settings2.profile.aboutCount': '{n} / 140',
    'settings2.profile.shared':
      'Seu nome, sua foto e o que você escrever em “Sobre mim” chegam criptografados aos seus contatos e aos seus grupos. Os servidores do Trino não os veem.',
    'settings2.profile.sharedPending':
      'Ainda não chega a {n} dos seus contatos: vai chegar quando eles escreverem para você de uma versão nova do Trino.',
    'settings2.profile.sharedPendingOne':
      'Ainda não chega a 1 dos seus contatos: vai chegar quando essa pessoa escrever para você de uma versão nova do Trino.',
    'settings2.profile.local':
      'Sua foto e seu nome ficam neste dispositivo. Seus contatos veem você com o nome que seu código tinha quando adicionaram você.',
    'settings2.profile.findYou': 'Como encontram você',
    'settings2.profile.qrRow': 'Seu código QR',
    'settings2.profile.qrRowBody': 'Para que adicionem você sem digitar nada.',
    'settings2.profile.saved': 'Perfil salvo.',
    'settings2.profile.errInvalid': 'Não foi possível salvar: seu nome, sua foto ou “Sobre mim” passa do limite.',
    'settings2.profile.errSave': 'Não foi possível salvar seu perfil. Tente novamente.',
    'settings2.profile.errPhoto': 'Não foi possível usar essa imagem. Tente outra foto.',
    'settings2.profile.errName': 'Escreva seu nome.',

    'settings2.qr.title': 'Seu código QR',
    'settings2.qr.back': 'Voltar ao perfil',

    'settings2.privacy.title': 'Privacidade',
    'settings2.privacy.blocked': 'Contatos bloqueados',
    'settings2.privacy.blockedNone': 'Nenhum',
    'settings2.privacy.blockedEmpty': 'Você não tem contatos bloqueados.',
    'settings2.privacy.unblock': 'Desbloquear',
    'settings2.privacy.unblockA11y': 'Desbloquear {name}',
    'settings2.privacy.errUnblock': 'Não foi possível desbloquear {name}.',
    'settings2.privacy.errLoad': 'Não foi possível carregar a lista de contatos.',
    'settings2.privacy.back': 'Voltar para Privacidade',
    'settings2.privacy.callsLine':
      'Suas chamadas passam por um servidor da Cloudflare: seu contato não vê seu IP, mas a Cloudflare vê. Se uma chamada não puder ser protegida, o Trino pergunta antes de ligar diretamente.',
  },
};
