/**
 * The text of a message with its web addresses as links. A link opens in
 * the system browser through `onOpenLink`, never inside the app, and has no
 * href (Tor design §4, R-10): a span with the role of a link, reached with
 * Tab and opened with Enter or a click, so the WebView has no address to
 * resolve, prefetch, preconnect or drag. Its address is in `data-link`, for
 * the message's menu. It is
 * underlined and takes the colour of the text around it, so it reads in your
 * bubble and in theirs: what marks it is the underline, not a colour
 * (accesibilidad.md §3.2).
 */
import { Fragment, type KeyboardEvent, type MouseEvent } from 'react';
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
    event.preventDefault();
    if (event.type === 'click' || event.button === 1) onOpenLink(url);
  };
  // A link answers Enter, as a native one does; Space scrolls.
  const key = (url: string) => (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onOpenLink(url);
  };
  return (
    <>
      {splitLinks(text).map((part, index) =>
        part.url === undefined ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <span
            key={index}
            role="link"
            tabIndex={0}
            data-link={part.url}
            onClick={open(part.url)}
            onAuxClick={open(part.url)}
            onKeyDown={key(part.url)}
            className={cx('cursor-pointer rounded-sm underline [overflow-wrap:anywhere]', BUBBLE_RING)}
          >
            {part.text}
          </span>
        ),
      )}
    </>
  );
}
