import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer 固定容量环形缓冲（要求 13：长时间运行内存不增长）', () => {
  it('容量上限：写满后覆盖最旧元素，length 永不超过 capacity', () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 8; i++) buf.push(i);
    expect(buf.length).toBe(5);
    expect(buf.capacity).toBe(5);
    // 保留最新 5 个，且按最旧→最新排序
    expect(buf.toArray()).toEqual([4, 5, 6, 7, 8]);
  });

  it('未写满时按写入顺序返回', () => {
    const buf = new RingBuffer<string>(10);
    buf.push('a');
    buf.push('b');
    buf.push('c');
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual(['a', 'b', 'c']);
  });

  it('多轮覆盖后顺序仍然正确', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 100; i++) buf.push(i);
    expect(buf.length).toBe(3);
    expect(buf.toArray()).toEqual([97, 98, 99]);
  });

  it('clear 清空后可继续写入', () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push(9);
    expect(buf.toArray()).toEqual([9]);
  });

  it('非法容量直接抛错', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
    expect(() => new RingBuffer(1.5)).toThrow();
  });

  it('toArray 返回副本：外部修改不影响缓冲', () => {
    const buf = new RingBuffer<{ v: number }>(2);
    buf.push({ v: 1 });
    const arr = buf.toArray();
    arr.pop();
    expect(buf.length).toBe(1);
    expect(buf.toArray()).toHaveLength(1);
  });
});
