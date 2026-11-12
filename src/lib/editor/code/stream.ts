/**
 * Stream modes as languages of the code view, made safe for any file.
 *
 * The modes were written for editors, where the text is the user's own. A viewer opens
 * whatever is in the folder, and a tokenizer that loops forever, throws or stops moving
 * would take the view down with it, or the whole app. Two guards:
 *
 * - U+2028 and U+2029 are read as spaces. CodeMirror keeps both inside a line, but a
 *   regular expression's "." does not match them, so several modes loop on one or cannot
 *   get past it.
 * - A tokenizer that throws leaves the rest of its line unstyled, and one that does not
 *   advance yields one unstyled character. CodeMirror would give up on the document with
 *   an exception instead.
 */
import type { Extension } from "@codemirror/state";
import { StreamLanguage, type StreamParser } from "@codemirror/language";

const SEPARATOR = /[\u2028\u2029]/;
const SEPARATORS = /[\u2028\u2029]/g;
/** As many calls as CodeMirror itself gives a tokenizer to move on. */
const TRIES = 10;

/** Modes whose failure was logged already: one line each, not one per token. */
const reported = new WeakSet<object>();

/** `mode` with a tokenizer that always returns and always advances. */
export function hardened<State>(mode: StreamParser<State>): StreamParser<State> {
  return {
    ...mode,
    token(stream, state) {
      if (stream.sol() && SEPARATOR.test(stream.string)) stream.string = stream.string.replace(SEPARATORS, " ");
      const start = stream.pos;
      try {
        for (let i = 0; i < TRIES; i++) {
          const style = mode.token(stream, state);
          // A token never reaches past its line, whatever the mode counted.
          if (stream.pos > stream.string.length) stream.pos = stream.string.length;
          if (stream.pos > start) return style;
        }
      } catch (e) {
        if (!reported.has(mode)) {
          reported.add(mode);
          console.error(`code view: the "${mode.name ?? "unnamed"}" tokenizer failed`, e);
        }
        stream.skipToEnd();
        return null;
      }
      stream.pos = start;
      stream.next();
      return null;
    },
  };
}

/** A CodeMirror 5 style mode as a language. */
export function streamLanguage<State>(mode: StreamParser<State>): Extension {
  return StreamLanguage.define(hardened(mode));
}
