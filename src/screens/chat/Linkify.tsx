/**
 * The text of a message with its web addresses as real links. A link opens
 * in the system browser through `onOpenLink`, never inside the app. It is
 * underlined and takes the colour of the text around it, so it reads in your
 * bubble and in theirs: what marks it is the underline, not a colour
 * (accesibilidad.md §3.2).
 */
import { Fragment, type MouseEvent } from 'react';
import { cx } from '../../ui';
import { BUBBLE_RING } from './bubble-ring';

export interface LinkPart {
  text: string;
  /** Set when this part is a web address. */
  url?: string;
}

/** A web address up to the next space; quotes and angle brackets end it too. */
const ADDRESS = /\bhttps?:\/\/[^\s<>"]+/gi;
/** What may close a sentence after an address without being part of it. */
const TRAILING = '.,;:!?\'"»”’';
/** An address with something after the scheme. */
const HAS_HOST = /^https?:\/\/[^/?#]/i;

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * The address without the punctuation after it: "https://a.co/x." ends at
 * the x. A closing parenthesis or bracket stays when the address opened it,
 * as in Wikipedia's "Trino_(música)".
 */
function trimAddress(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.charAt(url.length - 1);
    const unbalanced =
      (last === ')' && count(url, ')') > count(url, '(')) || (last === ']' && count(url, ']') > count(url, '['));
    if (!last || !(TRAILING.includes(last) || unbalanced)) return url;
    url = url.slice(0, -1);
  }
}

/** The text cut into plain parts and http(s) addresses, in order; no other scheme makes a link. */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let index = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index ?? 0;
    const url = trimAddress(match[0]);
    if (start < index || !HAS_HOST.test(url)) continue;
    if (start > index) parts.push({ text: text.slice(index, start) });
    parts.push({ text: url, url });
    index = start + url.length;
  }
  if (index < text.length || parts.length === 0) parts.push({ text: text.slice(index) });
  return parts;
}

export interface LinkifyProps {
  text: string;
  /** Opens an address in the system browser. */
  onOpenLink(url: string): void;
}

export function Linkify({ text, onOpenLink }: LinkifyProps) {
  const open = (url: string) => (event: MouseEvent) => {
    // The webview never follows the link itself.
    event.preventDefault();
    if (event.type === 'click' || event.button === 1) onOpenLink(url);
  };
  return (
    <>
      {splitLinks(text).map((part, index) =>
        part.url === undefined ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <a
            key={index}
            href={part.url}
            onClick={open(part.url)}
            onAuxClick={open(part.url)}
            className={cx('rounded-sm underline [overflow-wrap:anywhere]', BUBBLE_RING)}
          >
            {part.text}
          </a>
        ),
      )}
    </>
  );
}
