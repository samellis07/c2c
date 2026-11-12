/**
 * Exact decimal for Deluge decimal literals and for stored currency, decimal,
 * and percent values. Catalyst Data Store has no decimal column. Those fields
 * are canonical decimal strings in varchar, not JS floats and not Double.
 * Scale is the input's own fractional digits; division keeps 20 fractional digits.
 * Quantize rounds half away from zero, matching the Deluge round shim.
 */

const DIV_SCALE = 20;

export class Decimal {
  /** Normalized integer digits and a non-negative scale (digits after the point). */
  private constructor(
    private readonly digits: bigint,
    private readonly scale: number,
    private readonly neg: boolean,
  ) {}

  static from(value: Decimal | string | number | bigint): Decimal {
    if (value instanceof Decimal) return value;
    const raw = String(value).trim();
    const m = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
    if (!m) throw new Error(`decimal: not a number: ${raw}`);
    const neg = m[1] === '-';
    const whole = m[2]!;
    const frac = m[3] ?? '';
    const exp = m[4] ? Number(m[4]) : 0;
    const digits = BigInt((whole + frac).replace(/^0+(?=\d)/, '') || '0');
    const scale = frac.length - exp;
    if (scale >= 0) return new Decimal(digits, scale, neg && digits !== 0n);
    const shifted = digits * 10n ** BigInt(-scale);
    return new Decimal(shifted, 0, neg && shifted !== 0n);
  }

  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    const ad = a.signed() * 10n ** BigInt(scale - a.scale);
    const bd = b.signed() * 10n ** BigInt(scale - b.scale);
    return [ad, bd, scale];
  }

  private signed(): bigint {
    return this.neg ? -this.digits : this.digits;
  }

  private static fromSigned(signed: bigint, scale: number): Decimal {
    return new Decimal(signed < 0n ? -signed : signed, scale, signed < 0n);
  }

  add(other: Decimal | string | number | bigint): Decimal {
    const b = Decimal.from(other);
    const [ad, bd, scale] = Decimal.align(this, b);
    return Decimal.fromSigned(ad + bd, scale);
  }

  sub(other: Decimal | string | number | bigint): Decimal {
    const b = Decimal.from(other);
    const [ad, bd, scale] = Decimal.align(this, b);
    return Decimal.fromSigned(ad - bd, scale);
  }

  mul(other: Decimal | string | number | bigint): Decimal {
    const b = Decimal.from(other);
    return Decimal.fromSigned(this.signed() * b.signed(), this.scale + b.scale);
  }

  div(other: Decimal | string | number | bigint): Decimal {
    const b = Decimal.from(other);
    if (b.digits === 0n) throw new Error('decimal: division by zero');
    const scale = Math.max(this.scale, b.scale, DIV_SCALE);
    const num = this.signed() * 10n ** BigInt(scale + b.scale - this.scale);
    const den = b.signed();
    const q = num / den;
    // round half away from zero on the next digit
    const rem = num % den;
    const twice = rem < 0n ? -rem * 2n : rem * 2n;
    const denAbs = den < 0n ? -den : den;
    const round = twice >= denAbs ? (q < 0n ? -1n : 1n) : 0n;
    return Decimal.trimmed(q + round, scale);
  }

  /** Half away from zero, then keep exactly `places` fractional digits. */
  quantize(places: number): Decimal {
    if (!Number.isInteger(places) || places < 0) throw new Error(`decimal: bad scale ${places}`);
    if (places >= this.scale) {
      const digits = this.digits * 10n ** BigInt(places - this.scale);
      return new Decimal(digits, places, this.neg && digits !== 0n);
    }
    const drop = this.scale - places;
    const factor = 10n ** BigInt(drop);
    const signed = this.signed();
    const q = signed / factor;
    const rem = signed % factor;
    const remAbs = rem < 0n ? -rem : rem;
    const round = remAbs * 2n >= factor ? (signed < 0n ? -1n : 1n) : 0n;
    return Decimal.fromSigned(q + round, places);
  }

  compare(other: Decimal | string | number | bigint): -1 | 0 | 1 {
    const [ad, bd] = Decimal.align(this, Decimal.from(other));
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  }

  /** Drop trailing fractional zeros. Division uses this; multiplication does not. */
  private static trimmed(signed: bigint, scale: number): Decimal {
    let digits = signed < 0n ? -signed : signed;
    let s = scale;
    while (s > 0 && digits % 10n === 0n) {
      digits /= 10n;
      s -= 1;
    }
    return new Decimal(digits, s, signed < 0n && digits !== 0n);
  }

  toString(): string {
    const body = this.digits.toString().padStart(this.scale + 1, '0');
    if (!this.scale) {
      const text = body.replace(/^0+(?=\d)/, '') || '0';
      return this.neg ? `-${text}` : text;
    }
    const wholeRaw = body.slice(0, body.length - this.scale);
    const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0';
    const frac = body.slice(body.length - this.scale);
    const text = `${whole}.${frac}`;
    return this.neg ? `-${text}` : text;
  }

  toJSON(): string {
    return this.toString();
  }
}

export const decimal = {
  from(value: Decimal | string | number | bigint): Decimal {
    return Decimal.from(value);
  },
  add(a: Decimal | string | number | bigint, b: Decimal | string | number | bigint): Decimal {
    return Decimal.from(a).add(b);
  },
  sub(a: Decimal | string | number | bigint, b: Decimal | string | number | bigint): Decimal {
    return Decimal.from(a).sub(b);
  },
  mul(a: Decimal | string | number | bigint, b: Decimal | string | number | bigint): Decimal {
    return Decimal.from(a).mul(b);
  },
  div(a: Decimal | string | number | bigint, b: Decimal | string | number | bigint): Decimal {
    return Decimal.from(a).div(b);
  },
  cmp(a: Decimal | string | number | bigint | null | undefined, b: Decimal | string | number | bigint | null | undefined, op: string): boolean {
    // A blank currency/decimal/percent is null in Creator, not zero. Relational
    // criteria such as `Amount >= 1000` are false and must not throw. Equality
    // is true only when both sides are blank. A non-blank side still has to parse.
    const blankA = blankDecimal(a);
    const blankB = blankDecimal(b);
    if (blankA || blankB) {
      if (!blankA) Decimal.from(a as Decimal | string | number | bigint);
      if (!blankB) Decimal.from(b as Decimal | string | number | bigint);
      if (op === '==' || op === '=') return blankA && blankB;
      if (op === '!=' || op === 'is not') return !(blankA && blankB);
      if (op === '<' || op === '>' || op === '<=' || op === '>=') return false;
      throw new Error(`decimal: bad compare ${op}`);
    }
    const rel = Decimal.from(a as Decimal | string | number | bigint).compare(b as Decimal | string | number | bigint);
    switch (op) {
      case '<':
        return rel < 0;
      case '>':
        return rel > 0;
      case '<=':
        return rel <= 0;
      case '>=':
        return rel >= 0;
      case '==':
        return rel === 0;
      case '!=':
        return rel !== 0;
      default:
        throw new Error(`decimal: bad compare ${op}`);
    }
  },
};

function blankDecimal(value: unknown): boolean {
  if (value instanceof Decimal) return false;
  if (value == null) return true;
  return typeof value === 'string' && value.trim() === '';
}

const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Stored varchar value. A JS number is already binary64, so it is refused. */
export function readExactDecimal(value: unknown): string {
  if (value instanceof Decimal) {
    const text = value.toString();
    if (!CANONICAL_DECIMAL.test(text)) throw new Error(`readExactDecimal: not canonical: ${text}`);
    return text;
  }
  if (typeof value === 'number') throw new Error('readExactDecimal: JS number is not an exact decimal');
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
    throw new Error('readExactDecimal: not a canonical decimal string');
  }
  const parsed = Decimal.from(value).toString();
  if (parsed !== value) throw new Error('readExactDecimal: not a canonical decimal string');
  return value;
}

/** Canonical string at `places` fractional digits. Longer than varchar 64 is refused, not truncated. */
export function quantizeDecimal(value: string, places: number): string {
  const text = Decimal.from(value).quantize(places).toString();
  if (text.length > 64) throw new Error(`decimal: ${text} exceeds varchar 64`);
  return text;
}
