/**
 * 固定容量环形缓冲区：长时间运行内存不增长（要求 13）。
 * 先进先出，写满后覆盖最旧元素。
 */
export class RingBuffer<T> {
  private buf: Array<T | undefined>;
  private readonly cap: number;
  private head = 0; // 下一次写入位置
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('RingBuffer capacity must be a positive integer');
    }
    this.cap = capacity;
    this.buf = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size += 1;
  }

  /** 返回按时间顺序（最旧→最新）的副本。 */
  toArray(): T[] {
    const out: T[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buf[(this.head - this.size + i + this.cap * 2) % this.cap] as T;
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }

  get capacity(): number {
    return this.cap;
  }
}