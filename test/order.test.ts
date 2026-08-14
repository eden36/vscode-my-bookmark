import { describe, expect, it } from 'vitest';
import {
  between,
  betweenMany,
  compareOrder,
  InvalidOrderKeyError,
  isValidOrderKey,
} from '../src/core/order';

describe('排序键生成', () => {
  it('两端为空时返回最小正整数键', () => {
    expect(between(undefined, undefined)).toBe('a0');
  });

  it('追加到末尾只递增整数部分，键长保持恒定', () => {
    let key = between(undefined, undefined);
    for (let index = 0; index < 200; index += 1) {
      const next = between(key, undefined);
      expect(compareOrder(key, next)).toBe(-1);
      key = next;
    }
    expect(key.length).toBeLessThanOrEqual(4);
  });

  it('反复前插不会越过下界', () => {
    let key = between(undefined, undefined);
    for (let index = 0; index < 200; index += 1) {
      const next = between(undefined, key);
      expect(compareOrder(next, key)).toBe(-1);
      key = next;
    }
  });

  it('在相邻的两个键之间插入时向小数部分延伸', () => {
    const first = between(undefined, undefined);
    const second = between(first, undefined);
    const middle = between(first, second);

    expect(compareOrder(first, middle)).toBe(-1);
    expect(compareOrder(middle, second)).toBe(-1);
  });

  it('反复在同一位置插入仍严格有序，键长缓慢增长', () => {
    const left = between(undefined, undefined);
    let right = between(left, undefined);
    for (let index = 0; index < 60; index += 1) {
      const middle = between(left, right);
      expect(compareOrder(left, middle)).toBe(-1);
      expect(compareOrder(middle, right)).toBe(-1);
      right = middle;
    }
    expect(right.length).toBeLessThan(80);
  });

  it('生成的键末位不会是零，否则其左侧将无法再插入', () => {
    let key = between(undefined, undefined);
    const keys = [key];
    for (let index = 0; index < 100; index += 1) {
      key = between(key, undefined);
      keys.push(key);
    }
    for (let index = 1; index < keys.length; index += 1) {
      const middle = between(keys[index - 1], keys[index]);
      expect(middle.endsWith('0')).toBe(false);
    }
  });

  it('区间非法时抛错', () => {
    const first = between(undefined, undefined);
    const second = between(first, undefined);

    expect(() => between(second, first)).toThrow('排序区间非法');
    expect(() => between(first, first)).toThrow('排序区间非法');
  });

  it('拒绝含非法字符或末位为零的键', () => {
    expect(() => between('a0V#', undefined)).toThrow(InvalidOrderKeyError);
    expect(() => between('a0V0', undefined)).toThrow(InvalidOrderKeyError);
    expect(isValidOrderKey('a0V#')).toBe(false);
    expect(isValidOrderKey('a$')).toBe(false);
    expect(isValidOrderKey('a0V0')).toBe(false);
    expect(isValidOrderKey('0a')).toBe(false);
    expect(isValidOrderKey('a0')).toBe(true);
    expect(isValidOrderKey('a0V')).toBe(true);
    expect(isValidOrderKey(42)).toBe(false);
    expect(isValidOrderKey('')).toBe(false);
  });
});

describe('批量排序键', () => {
  it('数量为 0 时返回空数组', () => {
    expect(betweenMany(undefined, undefined, 0)).toEqual([]);
  });

  it('在有界区间内生成的键严格递增且长度可控', () => {
    const left = between(undefined, undefined);
    const right = between(left, undefined);
    const keys = betweenMany(left, right, 50);

    expect(keys).toHaveLength(50);
    for (const key of keys) {
      expect(compareOrder(left, key)).toBe(-1);
      expect(compareOrder(key, right)).toBe(-1);
    }
    expectStrictlyIncreasing(keys);
    // 二分展开的意义：顺序调用 between 会让键长随数量线性增长。
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(20);
  });

  it('两端开区间时同样严格递增', () => {
    expectStrictlyIncreasing(betweenMany(undefined, undefined, 20));
    const anchor = between(undefined, undefined);
    expectStrictlyIncreasing(betweenMany(anchor, undefined, 20));
    expectStrictlyIncreasing(betweenMany(undefined, anchor, 20));
  });
});

describe('排序键比较', () => {
  it('按 ASCII 字典序比较，不受 locale 影响', () => {
    // localeCompare 在多数 locale 下会把 'a' 判为小于 'B'，与本字母表的序相反。
    expect(compareOrder('a0B', 'a0a')).toBe(-1);
    expect('a0B'.localeCompare('a0a')).toBeGreaterThan(0);
  });
});

describe('随机插入的属性', () => {
  it('随机位置插入 1000 次后序列仍严格递增且键长有界', () => {
    let seed = 20260814;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const keys = [between(undefined, undefined)];
    for (let index = 0; index < 1000; index += 1) {
      const at = Math.floor(random() * (keys.length + 1));
      const key = between(keys[at - 1], keys[at]);
      keys.splice(at, 0, key);
    }

    expect(keys).toHaveLength(1001);
    expectStrictlyIncreasing(keys);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThan(30);
  });
});

function expectStrictlyIncreasing(keys: readonly string[]): void {
  for (let index = 1; index < keys.length; index += 1) {
    expect(compareOrder(keys[index - 1]!, keys[index]!)).toBe(-1);
  }
}
