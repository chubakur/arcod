import type { Loc } from './ast.ts';

export type TokenKind = 'ident' | 'number' | 'string' | 'version' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  raw: string;
  line: number;
  col: number;
  offset: number;
  end: number;
}

const MULTI = ['->', '==', '!=', '<=', '>=', '&&', '||', '..'];
const SINGLE = '{}()[]<>,:;.?@=|-+*/%!';

export class LexError extends Error {
  line: number;
  col: number;

  constructor(message: string, line: number, col: number) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      advance(2);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) advance();
      if (i < source.length) advance(2);
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startOffset = i;

    if (ch === '"') {
      let value = '';
      advance();
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          advance();
          const esc = source[i];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          advance();
          continue;
        }
        if (source[i] === '\n') {
          throw new LexError('unterminated string', startLine, startCol);
        }
        value += source[i];
        advance();
      }
      if (i >= source.length) throw new LexError('unterminated string', startLine, startCol);
      advance();
      tokens.push({ kind: 'string', value, raw: source.slice(startOffset, i), line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let raw = '';
      while (i < source.length && /[0-9]/.test(source[i])) {
        raw += source[i];
        advance();
      }
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        raw += '.';
        advance();
        while (i < source.length && /[0-9]/.test(source[i])) {
          raw += source[i];
          advance();
        }
      }
      while (i < source.length && /[a-zA-Z]/.test(source[i])) {
        raw += source[i];
        advance();
      }
      tokens.push({ kind: 'number', value: raw, raw, line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let raw = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        raw += source[i];
        advance();
      }
      tokens.push({ kind: 'ident', value: raw, raw, line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    if (ch === '@' && /[0-9A-Za-z]/.test(source[i + 1] ?? '')) {
      let raw = '@';
      advance();
      while (i < source.length && /[0-9A-Za-z.+\-]/.test(source[i])) {
        raw += source[i];
        advance();
      }
      tokens.push({ kind: 'version', value: raw.slice(1), raw, line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (MULTI.includes(two)) {
      advance(2);
      tokens.push({ kind: 'punct', value: two, raw: two, line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    if (SINGLE.includes(ch)) {
      advance();
      tokens.push({ kind: 'punct', value: ch, raw: ch, line: startLine, col: startCol, offset: startOffset, end: i });
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, line, col);
  }

  tokens.push({ kind: 'eof', value: '', raw: '', line, col, offset: i, end: i });
  return tokens;
}

export function locOf(token: Token): Loc {
  return {
    line: token.line,
    col: token.col,
    endLine: token.line,
    endCol: token.col + Math.max(token.raw.length, 1),
    offset: token.offset,
    end: token.end,
  };
}
