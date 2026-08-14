/**
 * 分数序（fractional indexing）。
 *
 * 每个可排序项持有一个字符串 order 键，按字典序排列即为显示顺序。在两项之间插入时
 * 只生成一个新键、不触碰兄弟节点，因此多窗口/多设备并发插入在按记录合并（LWW）的
 * 存储层里不会互相覆盖。
 *
 * 键由「整数部分 + 小数部分」组成。整数部分首字符自编码总长度：'a'..'z' 表示正数
 * （总长 2..27），'Z'..'A' 表示负数。追加到末尾只需把整数部分加一，键长恒定；若只
 * 用小数部分，反复追加会让键长线性增长，而追加恰恰是最高频的操作。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const LAST_DIGIT = DIGITS[DIGITS.length - 1]!;
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
/** 超过此长度即认为该同级集合需要重排，否则键会随反复的中间插入无限变长。 */
export const ORDER_REBALANCE_THRESHOLD = 50;

export class InvalidOrderKeyError extends Error {
  override readonly name = 'InvalidOrderKeyError';

  constructor(key: string, reason: string) {
    super(`排序键无效（${reason}）：${key}`);
  }
}

/**
 * 按 ASCII 字典序比较排序键。
 *
 * 必须用 `<` / `>` 而不是 localeCompare：本字母表里数字 < 大写 < 小写，而 localeCompare
 * 在多数 locale 下会把 'a' 排在 'B' 之前，直接破坏键的序关系；且不同设备的 ICU 数据
 * 可能给出不同结果，导致各端显示顺序不一致。
 */
export function compareOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 生成严格位于 a、b 之间的键。`undefined` 表示该侧无边界（最前 / 最后）。
 *
 * 两个键完全相同的情况无法避免（两台设备同时追加到末尾会算出同一个键），所以调用方
 * 排序时必须再带一个稳定的次级键（记录 id）作为 tiebreaker。
 */
export function between(a: string | undefined, b: string | undefined): string {
  if (a !== undefined) validateOrderKey(a);
  if (b !== undefined) validateOrderKey(b);
  if (a !== undefined && b !== undefined && a >= b) throw new Error(`排序区间非法：${a} >= ${b}`);

  if (a === undefined) {
    if (b === undefined) return `a${ZERO}`;
    const integerB = integerPart(b);
    const fractionB = b.slice(integerB.length);
    if (integerB === SMALLEST_INTEGER) return integerB + midpoint('', fractionB);
    // b 带小数部分时，它的整数部分本身就已经严格小于 b，无需再借位。
    if (integerB < b) return integerB;
    const decremented = decrementInteger(integerB);
    if (decremented === undefined) throw new Error('排序键已达下界，无法继续前插');
    return decremented;
  }

  if (b === undefined) {
    const integerA = integerPart(a);
    const fractionA = a.slice(integerA.length);
    const incremented = incrementInteger(integerA);
    return incremented === undefined ? integerA + midpoint(fractionA, undefined) : incremented;
  }

  const integerA = integerPart(a);
  const fractionA = a.slice(integerA.length);
  const integerB = integerPart(b);
  if (integerA === integerB) return integerA + midpoint(fractionA, b.slice(integerB.length));
  const incremented = incrementInteger(integerA);
  if (incremented === undefined) throw new Error('排序键已达上界，无法继续插入');
  return incremented < b ? incremented : integerA + midpoint(fractionA, undefined);
}

/**
 * 生成 n 个严格位于 a、b 之间且递增的键，用于重排整组同级项。
 *
 * 二分展开而不是顺序调用 between：后者在有界区间内会让键长随 n 线性增长。
 */
export function betweenMany(a: string | undefined, b: string | undefined, count: number): string[] {
  if (count < 0) throw new Error(`排序键数量非法：${count}`);
  if (count === 0) return [];
  if (count === 1) return [between(a, b)];

  if (b === undefined) {
    let current = between(a, undefined);
    const result = [current];
    for (let index = 1; index < count; index += 1) {
      current = between(current, undefined);
      result.push(current);
    }
    return result;
  }

  if (a === undefined) {
    let current = between(undefined, b);
    const result = [current];
    for (let index = 1; index < count; index += 1) {
      current = between(undefined, current);
      result.push(current);
    }
    return result.reverse();
  }

  const half = Math.floor(count / 2);
  const middle = between(a, b);
  return [
    ...betweenMany(a, middle, half),
    middle,
    ...betweenMany(middle, b, count - half - 1),
  ];
}

/** 校验一个键是否可用作排序键；非法键必须在解析共享状态时就被拒绝，而不是等插入时才炸。 */
export function isValidOrderKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  try {
    validateOrderKey(key);
    return true;
  } catch {
    return false;
  }
}

function validateOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) throw new InvalidOrderKeyError(key, '已达下界');
  const integer = integerPart(key);
  // 首字符已由 integerPart 校验，其余各位必须都在字母表内，否则比较与中点计算都会失去意义。
  for (const character of key.slice(1)) digitIndex(character);
  // 末位为零的键无法在它与去掉该位的前缀之间再插入任何有限长的键。
  if (key.slice(integer.length).endsWith(ZERO)) throw new InvalidOrderKeyError(key, '小数部分以零结尾');
}

function integerPart(key: string): string {
  const head = key[0];
  if (head === undefined) throw new InvalidOrderKeyError(key, '为空');
  const length = integerLength(head);
  if (length > key.length) throw new InvalidOrderKeyError(key, '整数部分被截断');
  return key.slice(0, length);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new InvalidOrderKeyError(head, '整数部分首字符非法');
}

/** 返回 undefined 表示已达上界。 */
function incrementInteger(value: string): string | undefined {
  validateInteger(value);
  const head = value[0]!;
  const digits = value.slice(1).split('');
  let carry = true;
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const next = digitIndex(digits[index]!) + 1;
    if (next === DIGITS.length) digits[index] = ZERO;
    else {
      digits[index] = DIGITS[next]!;
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return `a${ZERO}`;
  if (head === 'z') return undefined;
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1);
  // 跨过负数/正数分界时整数部分的长度走向相反：负区越靠近 'A' 越长，正区越靠近 'z' 越长。
  if (nextHead > 'a') digits.push(ZERO);
  else digits.pop();
  return nextHead + digits.join('');
}

/** 返回 undefined 表示已达下界。 */
function decrementInteger(value: string): string | undefined {
  validateInteger(value);
  const head = value[0]!;
  const digits = value.slice(1).split('');
  let borrow = true;
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const next = digitIndex(digits[index]!) - 1;
    if (next === -1) digits[index] = LAST_DIGIT;
    else {
      digits[index] = DIGITS[next]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return `Z${LAST_DIGIT}`;
  if (head === 'A') return undefined;
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1);
  if (nextHead < 'Z') digits.push(LAST_DIGIT);
  else digits.pop();
  return nextHead + digits.join('');
}

function validateInteger(value: string): void {
  const head = value[0];
  if (head === undefined || value.length !== integerLength(head)) {
    throw new InvalidOrderKeyError(value, '整数部分长度与首字符不符');
  }
}

/**
 * 求小数部分 a、b 的中点；b 为 undefined 表示上界开区间。
 * 前置条件：a < b，且两者都不以零结尾。
 */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) throw new Error(`排序区间非法：${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== undefined && b.endsWith(ZERO))) {
    throw new InvalidOrderKeyError(b === undefined ? a : `${a}/${b}`, '小数部分以零结尾');
  }

  if (b !== undefined) {
    let common = 0;
    // a 越界的位视作零，这是算法的一部分：a 更短意味着它在该位上更小。
    while ((a[common] ?? ZERO) === b[common]) common += 1;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }

  const digitA = a.length > 0 ? digitIndex(a[0]!) : 0;
  const digitB = b !== undefined ? digitIndex(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), undefined);
}

function digitIndex(character: string): number {
  const index = DIGITS.indexOf(character);
  // 不能让 -1 静默参与算术：一条脏数据会污染之后所有的插入结果。
  if (index < 0) throw new InvalidOrderKeyError(character, '含非法字符');
  return index;
}
