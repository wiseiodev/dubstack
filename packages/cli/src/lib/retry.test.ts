import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry';

const noSleep = () => Promise.resolve();
const noJitter = () => 0;

describe('retry', () => {
  it('returns the value when fn succeeds on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retry(fn, { sleep: noSleep, random: noJitter });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValue('done');
    const onRetry = vi.fn();

    const result = await retry(fn, {
      sleep: noSleep,
      random: noJitter,
      onRetry,
    });

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 2, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, 3, expect.any(Error));
  });

  it('does not fire onRetry on the first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('first');
    const onRetry = vi.fn();

    await retry(fn, { sleep: noSleep, random: noJitter, onRetry });

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('short-circuits when isPermanent returns true', async () => {
    const permanent = new Error('nope');
    const fn = vi.fn().mockRejectedValue(permanent);
    const isPermanent = vi.fn().mockReturnValue(true);
    const onRetry = vi.fn();

    await expect(
      retry(fn, {
        sleep: noSleep,
        random: noJitter,
        isPermanent,
        onRetry,
      }),
    ).rejects.toBe(permanent);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(isPermanent).toHaveBeenCalledWith(permanent);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('throws a wrapped error with attempt count after exhaustion', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('flaky'));

    await expect(
      retry(fn, {
        maxAttempts: 3,
        sleep: noSleep,
        random: noJitter,
      }),
    ).rejects.toThrow(/giving up after 3 attempts.*flaky/);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('preserves the last error as the wrapped error cause', async () => {
    const last = new Error('last one');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(last);

    let caught: unknown;
    try {
      await retry(fn, { maxAttempts: 2, sleep: noSleep, random: noJitter });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { cause: unknown }).cause).toBe(last);
  });

  it('uses exponential backoff capped at maxMs', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retry(fn, {
        maxAttempts: 5,
        baseMs: 100,
        maxMs: 500,
        sleep,
        random: noJitter,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400, 500]);
  });

  it('applies jitter on top of the exponential delay, never exceeding maxMs', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retry(fn, {
        maxAttempts: 4,
        baseMs: 100,
        maxMs: 2000,
        sleep,
        random: () => 0.5,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([112.5, 225, 450]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects %s maxAttempts before calling fn', async (_label, maxAttempts) => {
    const fn = vi.fn();

    await expect(
      retry(fn, { maxAttempts, sleep: noSleep, random: noJitter }),
    ).rejects.toThrow(/maxAttempts must be a positive integer/);

    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['baseMs', { baseMs: Number.NaN }, /baseMs must be a finite/],
    ['baseMs', { baseMs: -1 }, /baseMs must be a finite/],
    ['baseMs', { baseMs: Number.POSITIVE_INFINITY }, /baseMs must be a finite/],
    ['maxMs', { maxMs: Number.NaN }, /maxMs must be a finite/],
    ['maxMs', { maxMs: -1 }, /maxMs must be a finite/],
    ['maxMs', { maxMs: Number.POSITIVE_INFINITY }, /maxMs must be a finite/],
  ])('rejects invalid %s before calling fn', async (_label, opts, pattern) => {
    const fn = vi.fn();

    await expect(
      retry(fn, { ...opts, sleep: noSleep, random: noJitter }),
    ).rejects.toThrow(pattern);

    expect(fn).not.toHaveBeenCalled();
  });

  it('clamps an out-of-range random() to 0 so delay never exceeds maxMs', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retry(fn, {
        maxAttempts: 3,
        baseMs: 100,
        maxMs: 2000,
        sleep,
        random: () => Number.NaN,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200]);
  });

  it('runs fn exactly once when maxAttempts is 1', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('only try'));
    const onRetry = vi.fn();

    await expect(
      retry(fn, {
        maxAttempts: 1,
        sleep: noSleep,
        random: noJitter,
        onRetry,
      }),
    ).rejects.toThrow(/giving up after 1 attempts.*only try/);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
