/**
 * Uso responsable (UR-2…): blocking by identity, its confirmation and the
 * list of whom you blocked (PropBloquear, PropAjustes › Privacidad ›
 * Bloqueados; `research_notes/Uso responsable/diseno.md` §12.1). Requests
 * (UR-4) and reports (UR-5) add their own prefixes here.
 */
import type { AreaStrings } from './types';

export const safety: AreaStrings = {
  es: {
    'block.title': '¿Bloquear a {name}?',
    'block.body': 'No te podrá escribir, llamar ni agregarte a grupos con esta cuenta, y no recibirá tu perfil. No se le avisa.',
    'block.groups': 'Tampoco recibirá lo que escribas en los grupos que tienen en común. Puede notar que faltan tus mensajes.',
    'block.iAdminister': 'También puedes sacarlo de «{group}».',
    'block.removeFromGroup': 'Sacar del grupo',
    'block.removed': 'Lo sacaste de «{group}».',
    'block.theyAdminister': '{name} administra «{group}». Seguirás viendo quién entra y quién sale, pero no sus mensajes.',
    'block.leaveGroup': 'Salir del grupo',
    'block.left': 'Saliste de «{group}».',
    'block.groupFailed': 'No se pudo. Inténtalo de nuevo.',
    'block.confirm': 'Bloquear',
    'block.failed': 'No se pudo bloquear. Inténtalo de nuevo.',
    'block.clash': 'Esta persona comparte una llave con un contacto tuyo. No se bloqueó. Revisa las huellas.',
    'block.done': 'Bloqueaste a {name}.',
    'block.unblocked':
      'Desbloqueaste a {name}. Lo que mandó mientras estaba bloqueado no te llegó, y las invitaciones que tenía contigo no vuelven.',
    'block.memberBlock': 'Bloquear a {name}',
    'block.memberBlocked': 'Bloqueado',
    'block.inGroup': 'Hay alguien que bloqueaste en este grupo. No ves sus mensajes.',
    'block.replaceBlocked':
      'Bloqueaste a {name}. Su identidad anterior sigue bloqueada; esta clave es otra identidad y no queda bloqueada.',
    'block.listFingerprint': 'Huella {fingerprint} · {date}',
    'block.listDate': 'Desde el {date}',
    'block.listUnnamed': 'Sin nombre',
  },
  en: {
    'block.title': 'Block {name}?',
    'block.body': 'They won’t be able to write to you, call you or add you to groups with this account, and they won’t get your profile. They aren’t told.',
    'block.groups': 'Nor will they get what you write in the groups you share. They may notice your messages are missing.',
    'block.iAdminister': 'You can also remove them from “{group}”.',
    'block.removeFromGroup': 'Remove from group',
    'block.removed': 'You removed them from “{group}”.',
    'block.theyAdminister': '{name} runs “{group}”. You’ll still see who joins and who leaves, but not their messages.',
    'block.leaveGroup': 'Leave group',
    'block.left': 'You left “{group}”.',
    'block.groupFailed': 'That didn’t work. Try again.',
    'block.confirm': 'Block',
    'block.failed': 'Couldn’t block. Try again.',
    'block.clash': 'This person shares a key with one of your contacts. They weren’t blocked. Compare the fingerprints.',
    'block.done': 'You blocked {name}.',
    'block.unblocked':
      'You unblocked {name}. What they sent while blocked didn’t reach you, and the invitations they had with you don’t come back.',
    'block.memberBlock': 'Block {name}',
    'block.memberBlocked': 'Blocked',
    'block.inGroup': 'Someone you blocked is in this group. You don’t see their messages.',
    'block.replaceBlocked':
      'You blocked {name}. Their old identity stays blocked; this key is another identity and is not blocked.',
    'block.listFingerprint': 'Fingerprint {fingerprint} · {date}',
    'block.listDate': 'Since {date}',
    'block.listUnnamed': 'No name',
  },
  pt: {
    'block.title': 'Bloquear {name}?',
    'block.body': 'Essa pessoa não poderá te escrever, ligar nem te adicionar a grupos com esta conta, e não vai receber seu perfil. Ela não é avisada.',
    'block.groups': 'Também não vai receber o que você escrever nos grupos em comum. Pode perceber que faltam suas mensagens.',
    'block.iAdminister': 'Você também pode removê-la de “{group}”.',
    'block.removeFromGroup': 'Remover do grupo',
    'block.removed': 'Você a removeu de “{group}”.',
    'block.theyAdminister': '{name} administra “{group}”. Você continuará vendo quem entra e quem sai, mas não as mensagens dessa pessoa.',
    'block.leaveGroup': 'Sair do grupo',
    'block.left': 'Você saiu de “{group}”.',
    'block.groupFailed': 'Não deu certo. Tente novamente.',
    'block.confirm': 'Bloquear',
    'block.failed': 'Não foi possível bloquear. Tente novamente.',
    'block.clash': 'Essa pessoa compartilha uma chave com um contato seu. Ela não foi bloqueada. Compare as impressões digitais.',
    'block.done': 'Você bloqueou {name}.',
    'block.unblocked':
      'Você desbloqueou {name}. O que essa pessoa mandou enquanto estava bloqueada não chegou, e os convites que ela tinha com você não voltam.',
    'block.memberBlock': 'Bloquear {name}',
    'block.memberBlocked': 'Bloqueado',
    'block.inGroup': 'Há alguém que você bloqueou neste grupo. Você não vê as mensagens dessa pessoa.',
    'block.replaceBlocked':
      'Você bloqueou {name}. A identidade anterior continua bloqueada; esta chave é outra identidade e não fica bloqueada.',
    'block.listFingerprint': 'Impressão digital {fingerprint} · {date}',
    'block.listDate': 'Desde {date}',
    'block.listUnnamed': 'Sem nome',
  },
};
