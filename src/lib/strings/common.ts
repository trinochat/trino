/**
 * Words every redesigned screen shares. Frozen after E0, so the units never
 * edit the same file: a unit that needs another shared word adds it under its
 * own prefix. The contract is common.test.ts.
 */
import type { AreaStrings } from './types';

export const common: AreaStrings = {
  es: {
    'common2.cancel': 'Cancelar',
    'common2.close': 'Cerrar',
    'common2.retry': 'Reintentar',
    'common2.back': 'Atrás',
    'common2.save': 'Guardar',
    'common2.copy': 'Copiar',
    'common2.copied': 'Copiado',
    'common2.delete': 'Eliminar',
    'common2.add': 'Agregar',
    'common2.done': 'Listo',
    'common2.more': 'Más opciones',
    'time2.today': 'Hoy',
    'time2.yesterday': 'Ayer',
    'time2.justNow': 'Ahora',
  },
  en: {
    'common2.cancel': 'Cancel',
    'common2.close': 'Close',
    'common2.retry': 'Retry',
    'common2.back': 'Back',
    'common2.save': 'Save',
    'common2.copy': 'Copy',
    'common2.copied': 'Copied',
    'common2.delete': 'Delete',
    'common2.add': 'Add',
    'common2.done': 'Done',
    'common2.more': 'More options',
    'time2.today': 'Today',
    'time2.yesterday': 'Yesterday',
    'time2.justNow': 'Just now',
  },
  pt: {
    'common2.cancel': 'Cancelar',
    'common2.close': 'Fechar',
    'common2.retry': 'Tentar novamente',
    'common2.back': 'Voltar',
    'common2.save': 'Salvar',
    'common2.copy': 'Copiar',
    'common2.copied': 'Copiado',
    'common2.delete': 'Excluir',
    'common2.add': 'Adicionar',
    'common2.done': 'Pronto',
    'common2.more': 'Mais opções',
    'time2.today': 'Hoje',
    'time2.yesterday': 'Ontem',
    'time2.justNow': 'Agora',
  },
};
