/**
 * Lossless tokenizer for Zoho Creator `.ds` files.
 *
 * Every character of the input belongs to exactly one token, so concatenating
 * `token.text` in order always equals the input. Malformed input (an
 * unterminated string or comment) never throws: the offending character is
 * emitted as a `bad` token and lexing continues.
 */
export function isTrivia(t) {
    return t.kind === 'ws' || t.kind === 'nl' || t.kind === 'lineComment' || t.kind === 'blockComment';
}
const MULTI_PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '->', '+=', '-=', '*=', '/=', '::'];
const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
export function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    const push = (kind, end) => {
        out.push({ kind, text: src.slice(i, end), start: i });
        i = end;
    };
    while (i < n) {
        const c = src[i];
        if (c === '\r') {
            push('nl', src[i + 1] === '\n' ? i + 2 : i + 1);
            continue;
        }
        if (c === '\n') {
            push('nl', i + 1);
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') {
            let j = i + 1;
            while (j < n && /[ \t\f\v ﻿]/.test(src[j]))
                j++;
            push('ws', j);
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            let j = i + 2;
            while (j < n && src[j] !== '\n' && src[j] !== '\r')
                j++;
            push('lineComment', j);
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) {
                push('bad', i + 1);
                continue;
            }
            push('blockComment', end + 2);
            continue;
        }
        if (c === '"') {
            let j = i + 1;
            while (j < n && src[j] !== '"')
                j += src[j] === '\\' ? 2 : 1;
            if (j >= n) {
                push('bad', i + 1);
                continue;
            }
            push('string', j + 1);
            continue;
        }
        if (c === "'") {
            let j = i + 1;
            while (j < n && src[j] !== "'" && src[j] !== '\n' && src[j] !== '\r')
                j += src[j] === '\\' && src[j + 1] !== '\n' ? 2 : 1;
            if (j >= n || src[j] !== "'") {
                push('bad', i + 1);
                continue;
            }
            push('string', j + 1);
            continue;
        }
        if (c >= '0' && c <= '9') {
            let j = i + 1;
            while (j < n && (/[0-9A-Za-z_]/.test(src[j]) || (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? ''))))
                j++;
            push('number', j);
            continue;
        }
        if (IDENT_START.test(c)) {
            let j = i + 1;
            while (j < n && IDENT_PART.test(src[j]))
                j++;
            push('ident', j);
            continue;
        }
        // Surrogate pairs (emoji etc.) are kept together as one punct token.
        const code = src.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
            const two = src.slice(i, i + 2);
            push(IDENT_START.test(two) ? 'ident' : 'punct', i + 2);
            continue;
        }
        const two = src.slice(i, i + 2);
        push('punct', MULTI_PUNCT.includes(two) ? i + 2 : i + 1);
    }
    return out;
}
