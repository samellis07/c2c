/**
 * Deluge lexer.
 *
 * Never throws: a character that cannot start a token becomes a `bad` token and
 * an unterminated string runs to the end of the input (flagged `unterminated`).
 * Whitespace and comments are not tokens, but every token records whether a
 * newline preceded it (`nl`), which the parser uses to split `key : value`
 * parameter lists of built-in tasks (`sendmail [ from : a  to : b ]`).
 */
const OPS = ['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '<', '>', '=', '+', '-', '*', '/', '%', '!', '?'];
const PUNCT = new Set(['(', ')', '[', ']', '{', '}', ',', ';', ':', '.']);
function isIdentStart(c) {
    return /[\p{L}_$]/u.test(c);
}
function isIdentPart(c) {
    return /[\p{L}\p{N}_$]/u.test(c);
}
export function lex(src) {
    const out = [];
    let i = 0;
    let nl = false;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\n' || c === '\r') {
            nl = true;
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') {
            i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n' && src[i] !== '\r')
                i++;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const e = src.indexOf('*/', i + 2);
            const stop = e < 0 ? n : e + 2;
            if (/[\r\n]/.test(src.slice(i, stop)))
                nl = true;
            i = stop;
            continue;
        }
        const start = i;
        const push = (kind, extra = {}) => {
            out.push({ kind, text: src.slice(start, i), start, end: i, nl, ...extra });
            nl = false;
        };
        if (c === '"' || c === "'") {
            i++;
            let value = '';
            let closed = false;
            while (i < n) {
                const d = src[i];
                if (d === '\\' && i + 1 < n) {
                    const e = src[i + 1];
                    value += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
                    i += 2;
                    continue;
                }
                if (d === c) {
                    i++;
                    closed = true;
                    break;
                }
                // single-quoted literals (dates) do not span lines
                if (c === "'" && (d === '\n' || d === '\r'))
                    break;
                value += d;
                i++;
            }
            push(c === '"' ? 'string' : 'date', closed ? { value } : { value, unterminated: true });
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            while (i < n && /[0-9]/.test(src[i]))
                i++;
            if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
                i++;
                while (i < n && /[0-9]/.test(src[i]))
                    i++;
            }
            if (/[eE]/.test(src[i] ?? '') && /[0-9]/.test(src[i + 1] ?? '')) {
                i++;
                while (i < n && /[0-9]/.test(src[i]))
                    i++;
            }
            push('number');
            continue;
        }
        if (isIdentStart(c)) {
            while (i < n && isIdentPart(src[i]))
                i++;
            push('ident');
            continue;
        }
        const op = OPS.find((o) => src.startsWith(o, i));
        if (op) {
            i += op.length;
            push('op');
            continue;
        }
        if (PUNCT.has(c)) {
            i++;
            push('punct');
            continue;
        }
        i++;
        push('bad');
    }
    out.push({ kind: 'eof', text: '', start: n, end: n, nl: true });
    return out;
}
