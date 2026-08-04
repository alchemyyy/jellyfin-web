import { describe, expect, it } from 'vitest';

import { MAX_DECODED_RAW_FRAME_CREDITS } from './DecodeWorkerProtocol';
import RawFrameBufferPool from './RawFrameBufferPool';

describe('RawFrameBufferPool', () => {
    it('allows only the fixed initial allocation count', () => {
        const pool = new RawFrameBufferPool(MAX_DECODED_RAW_FRAME_CREDITS);

        expect(pool.recycle(new ArrayBuffer(16))).toBe(false);
        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.acquire()).toBeNull();
    });

    it('reuses delayed returns in deterministic FIFO order without new allocations', () => {
        const pool = new RawFrameBufferPool(MAX_DECODED_RAW_FRAME_CREDITS);
        const firstBuffer = new ArrayBuffer(16);
        const secondBuffer = new ArrayBuffer(16);

        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.acquire()).toBeNull();

        expect(pool.recycle(secondBuffer)).toBe(true);
        expect(pool.recycle(firstBuffer)).toBe(true);
        expect(pool.recycle(new ArrayBuffer(16))).toBe(false);
        expect(pool.acquire()).toEqual({ buffer: secondBuffer, kind: 'reuse' });
        expect(pool.acquire()).toEqual({ buffer: firstBuffer, kind: 'reuse' });
        expect(pool.acquire()).toBeNull();
    });

    it('rejects empty and excess recycled buffers', () => {
        const pool = new RawFrameBufferPool(MAX_DECODED_RAW_FRAME_CREDITS);
        const firstBuffer = new ArrayBuffer(16);
        const secondBuffer = new ArrayBuffer(16);

        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.acquire()).toEqual({ kind: 'allocate' });
        expect(pool.recycle(new ArrayBuffer(0))).toBe(false);
        expect(pool.recycle(firstBuffer)).toBe(true);
        expect(pool.recycle(secondBuffer)).toBe(true);
        expect(pool.recycle(new ArrayBuffer(16))).toBe(false);
    });
});
