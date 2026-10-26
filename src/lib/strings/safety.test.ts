import { describe, expect, it } from 'vitest';
import { DICTS } from '../i18n';
import { expectAreaContract, LANG_CODES } from './contract-test-utils';
import { safety } from './safety';

// Uso responsable (UR-2): blocking by identity, its confirmation and the list
// of whom you blocked (PropBloquear, PropAjustes › Privacidad › Bloqueados;
// research_notes/Uso responsable/diseno.md §12.1). Requests (UR-4) and
// reports (UR-5) will add their prefixes to this area.
const KEYS: string[] = [
  // The confirmation (card 3).
  'block.title',
  'block.body',
  'block.groups',
  'block.iAdminister',
  'block.removeFromGroup',
  'block.removed',
  'block.theyAdminister',
  'block.leaveGroup',
  'block.left',
  'block.groupFailed',
  'block.confirm',
  'block.failed',
  'block.clash',
  'block.done',
  // Unblocking, from the details and from the list (cards 2 and 6).
  'block.unblocked',
  // In a group (cards 4 and 5).
  'block.memberBlock',
  'block.memberBlocked',
  'block.inGroup',
  // Replacing the keys of someone blocked (design test 3, R-23).
  'block.replaceBlocked',
  // Ajustes › Privacidad › Bloqueados (card 6), beside the keys of Privacidad.
  'block.listFingerprint',
  'block.listDate',
  'block.listUnnamed',
];

// Solicitudes (UR-4, PropSolicitudes, PropMovilSolicitudes; design §12.2).
const REQUEST_KEYS: string[] = [
  // The row above the chats, and the list.
  'requests.row',
  'requests.title',
  'requests.back',
  'requests.notice',
  'requests.overflow',
  'requests.empty',
  'requests.loadFailed',
  'requests.saysName',
  'requests.via.name',
  'requests.via.link',
  'requests.via.code',
  'requests.via.group',
  'requests.looksLike',
  'requests.previewFile',
  'requests.previewCall',
  // One request, open.
  'requests.paneLabel',
  'requests.backToList',
  'requests.byAdmin',
  'requests.fingerprint',
  'requests.looksLikeOpen',
  'requests.groupLine',
  'requests.linkLine',
  'requests.file',
  'requests.kind.photo',
  'requests.kind.video',
  'requests.kind.audio',
  'requests.kind.file',
  'requests.call',
  'requests.callVideo',
  'requests.dropped',
  'requests.accept',
  'requests.delete',
  'requests.deleted',
  'requests.failed',
  'requests.clash',
  'requests.gone',
  // Ajustes › Privacidad › Solicitudes eliminadas.
  'requests.deletedTitle',
  'requests.deletedBody',
  'requests.deletedEmpty',
  'requests.deletedNone',
  'requests.undo',
  'requests.undoA11y',
  'requests.undone',
  'requests.undoFailed',
];

describe('the texts of blocking', () => {
  it('have the same keys and placeholders in es, en and pt', () => {
    expectAreaContract(safety, {
      keys: [...KEYS, ...REQUEST_KEYS],
      placeholders: {
        'block.title': ['name'],
        'block.iAdminister': ['group'],
        'block.removed': ['group'],
        'block.theyAdminister': ['name', 'group'],
        'block.left': ['group'],
        'block.done': ['name'],
        'block.unblocked': ['name'],
        'block.memberBlock': ['name'],
        'block.replaceBlocked': ['name'],
        'block.listFingerprint': ['fingerprint', 'date'],
        'block.listDate': ['date'],
        'requests.row': ['n'],
        'requests.overflow': ['n'],
        'requests.saysName': ['name'],
        'requests.via.link': ['label'],
        'requests.via.code': ['label'],
        'requests.via.group': ['group'],
        'requests.looksLike': ['contact'],
        'requests.paneLabel': ['name'],
        'requests.fingerprint': ['fingerprint'],
        'requests.looksLikeOpen': ['contact'],
        'requests.groupLine': ['name', 'group'],
        'requests.linkLine': ['label'],
        'requests.file': ['kind', 'size'],
        'requests.call': ['name', 'time'],
        'requests.callVideo': ['name', 'time'],
        'requests.dropped': ['n'],
        'requests.undoA11y': ['name'],
        'requests.undone': ['name'],
        'requests.undoFailed': ['name'],
      },
    });
  });

  it('reach the app', () => {
    for (const lang of LANG_CODES) {
      for (const key of [...KEYS, ...REQUEST_KEYS]) expect(DICTS[lang][key], `${lang}: ${key}`).toBe(safety[lang][key]);
    }
  });

  // §12.1, as the board of 15 Oct says them.
  it('say in Spanish what the design says, with tú', () => {
    expect(safety.es['block.title']).toBe('¿Bloquear a {name}?');
    expect(safety.es['block.body']).toBe(
      'No te podrá escribir, llamar ni agregarte a grupos con esta cuenta, y no recibirá tu perfil. No se le avisa.',
    );
    expect(safety.es['block.groups']).toBe(
      'Tampoco recibirá lo que escribas en los grupos que tienen en común. Puede notar que faltan tus mensajes.',
    );
    expect(safety.es['block.clash']).toBe(
      'Esta persona comparte una llave con un contacto tuyo. No se bloqueó. Revisa las huellas.',
    );
    expect(safety.es['block.unblocked']).toBe(
      'Desbloqueaste a {name}. Lo que mandó mientras estaba bloqueado no te llegó, y las invitaciones que tenía contigo no vuelven.',
    );
    expect(safety.es['block.inGroup']).toBe('Hay alguien que bloqueaste en este grupo. No ves sus mensajes.');
    // The row and the list of Privacidad: "Bloqueados", no longer "Contactos bloqueados" (15 Oct).
    expect(DICTS.es['settings2.privacy.blocked']).toBe('Bloqueados');
  });

  // §12.2, as PropSolicitudes says them.
  it('say the requests in Spanish as the design does, with tú', () => {
    expect(safety.es['requests.row']).toBe('Solicitudes ({n})');
    expect(safety.es['requests.notice']).toBe('No son tus contactos. Nada de aquí suena ni se descarga hasta que aceptes.');
    expect(safety.es['requests.saysName']).toBe('dice llamarse {name}');
    expect(safety.es['requests.via.name']).toBe('por tu @nombre');
    expect(safety.es['requests.via.link']).toBe('usó tu enlace «{label}»');
    expect(safety.es['requests.via.code']).toBe('usó tu código «{label}»');
    expect(safety.es['requests.via.group']).toBe('está en «{group}» contigo');
    expect(safety.es['requests.looksLike']).toBe('Se parece a {contact}. Revisa la huella.');
    expect(safety.es['requests.file']).toBe('Mandó un archivo ({kind}, {size}). Se descarga si aceptas.');
    expect(safety.es['requests.call']).toBe('{name} intentó llamarte · {time}');
    expect(safety.es['requests.deleted']).toBe(
      'Eliminaste la solicitud. Lo que mande en los próximos 30 días no te va a llegar.',
    );
    expect(safety.es['requests.overflow']).toBe('Llegaron más solicitudes de las que caben ({n}). Revisa las que tienes.');
    expect(safety.es['requests.groupLine']).toBe('{name} está en «{group}» contigo, pero no es tu contacto.');
    expect(safety.es['requests.linkLine']).toBe('Antes de aceptar, confirma con {label} por otro medio que lo usó.');
    expect(safety.es['requests.deletedTitle']).toBe('Solicitudes eliminadas');
  });

  // Trino cannot take anyone off the network, and the person is not told (R-13, R-34).
  it('never promise to delete an account or to warn the person', () => {
    const said = LANG_CODES.flatMap(lang =>
      Object.entries(safety[lang])
        .filter(([, text]) => /borrar su cuenta|delete their account|apagar|se le avisará|will be told/i.test(text))
        .map(([key]) => `${lang} ${key}`),
    );
    expect(said).toEqual([]);
  });
});
