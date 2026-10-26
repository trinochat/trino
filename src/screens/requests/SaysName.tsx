/**
 * "dice llamarse **ana**": the words of the language around the name, and
 * the name in bold, wherever the language puts it.
 */
import { useT } from '../../lib/i18n';

const MARK = '\u0000';

export function SaysName({ name, className, as: Tag = 'span' }: { name: string; className?: string; as?: 'span' | 'h2' }) {
  const t = useT();
  const [before = '', after = ''] = t('requests.saysName', { name: MARK }).split(MARK);
  return (
    <Tag className={className}>
      {before}
      <strong className="font-semibold">{name}</strong>
      {after}
    </Tag>
  );
}
