export type RawFrameBufferLease =
    | { kind: 'allocate' }
    | { buffer: ArrayBuffer, kind: 'reuse' };

/** Owns the bounded FIFO of worker-side raw frame copy buffers. */
export default class RawFrameBufferPool {
    private readonly maximumBufferCount: number;
    private readonly recycledBuffers: ArrayBuffer[] = [];
    private checkedOutBufferCount = 0;
    private remainingAllocationCount: number;

    public constructor(maximumBufferCount: number) {
        if (!Number.isSafeInteger(maximumBufferCount) || maximumBufferCount <= 0) {
            throw new RangeError('Raw frame buffer pool size must be a positive safe integer');
        }

        this.maximumBufferCount = maximumBufferCount;
        this.remainingAllocationCount = maximumBufferCount;
    }

    /** Acquires the oldest recycled buffer or one of the fixed allocation slots. */
    public acquire(): RawFrameBufferLease | null {
        const recycledBuffer = this.recycledBuffers.shift();
        if (recycledBuffer) {
            this.checkedOutBufferCount += 1;
            return { buffer: recycledBuffer, kind: 'reuse' };
        }
        if (this.remainingAllocationCount === 0) {
            return null;
        }

        this.remainingAllocationCount -= 1;
        this.checkedOutBufferCount += 1;
        return { kind: 'allocate' };
    }

    /** Adds a returned buffer without allowing the worker-side pool to grow. */
    public recycle(buffer: ArrayBuffer): boolean {
        if (
            buffer.byteLength === 0
            || this.checkedOutBufferCount === 0
            || this.recycledBuffers.length >= this.maximumBufferCount
        ) {
            return false;
        }

        this.checkedOutBufferCount -= 1;
        this.recycledBuffers.push(buffer);
        return true;
    }
}
