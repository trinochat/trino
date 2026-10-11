/** The texts of the shell and the inbox. W2 owns this area; its contract is shell.test.ts. */
import type { AreaStrings } from './types';

export const shell: AreaStrings = {
  es: {
    'inbox.channel': 'Novedades de Trino',
    'inbox.preview.you': 'Tú: {text}',
    'inbox.preview.file': 'Archivo: {name}',
    'inbox.preview.sticker': 'Sticker',
  },
  en: {
    'inbox.channel': 'Trino news',
    'inbox.preview.you': 'You: {text}',
    'inbox.preview.file': 'File: {name}',
    'inbox.preview.sticker': 'Sticker',
  },
  pt: {
    'inbox.channel': 'Novidades do Trino',
    'inbox.preview.you': 'Você: {text}',
    'inbox.preview.file': 'Arquivo: {name}',
    'inbox.preview.sticker': 'Figurinha',
  },
};
