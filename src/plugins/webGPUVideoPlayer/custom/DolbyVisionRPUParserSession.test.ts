import { describe, expect, it, vi } from 'vitest';

import type { DolbyVisionRPUSnapshot } from './DolbyVisionRPUParser';
import DolbyVisionRPUParserSession, {
    type DolbyVisionRPUParserPort
} from './DolbyVisionRPUParserSession';

function createDeferred<Value>(): {
    promise: Promise<Value>
    resolve: (value: Value) => void
} {
    let promiseResolver: ((value: Value) => void) | null = null;
    const promise = new Promise<Value>(resolve => {
        promiseResolver = resolve;
    });
    return {
        promise,
        resolve: (value: Value): void => {
            if (!promiseResolver) {
                throw new Error('Deferred promise was not initialized');
            }
            promiseResolver(value);
        }
    };
}

function createParserPort(packedData = new ArrayBuffer(32)): DolbyVisionRPUParserPort & {
    close: ReturnType<typeof vi.fn>
    parse: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
} {
    return {
        close: vi.fn(),
        parse: vi.fn((): DolbyVisionRPUSnapshot => ({
            packedData
        } as DolbyVisionRPUSnapshot)),
        reset: vi.fn()
    };
}

describe('DolbyVisionRPUParserSession', () => {
    it('waits for lazy initialization and returns owned packed data', async () => {
        const deferredParser = createDeferred<DolbyVisionRPUParserPort>();
        const packedData = new ArrayBuffer(32);
        const parser = createParserPort(packedData);
        const createParser = vi.fn(() => deferredParser.promise);
        const session = DolbyVisionRPUParserSession.create('parser.wasm', { createParser });
        const rpuNALUnit = new Uint8Array([ 124, 1, 25, 8, 9 ]);
        const parsePromise = session.parse(rpuNALUnit);

        deferredParser.resolve(parser);

        await expect(parsePromise).resolves.toBe(packedData);
        expect(createParser).toHaveBeenCalledWith('parser.wasm');
        expect(parser.parse).toHaveBeenCalledWith(rpuNALUnit);
        session.close();
        expect(parser.reset).toHaveBeenCalledTimes(1);
        expect(parser.close).toHaveBeenCalledTimes(1);
    });

    it('retires a parser that resolves after its generation closes', async () => {
        const deferredParser = createDeferred<DolbyVisionRPUParserPort>();
        const parser = createParserPort();
        const session = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: (): Promise<DolbyVisionRPUParserPort> => deferredParser.promise
        });

        session.close();
        session.close();
        deferredParser.resolve(parser);
        await Promise.resolve();
        await Promise.resolve();

        expect(parser.reset).toHaveBeenCalledTimes(1);
        expect(parser.close).toHaveBeenCalledTimes(1);
        expect(() => session.close()).not.toThrow();
        await expect(session.parse(new Uint8Array([ 1 ]))).rejects.toThrow(
            'parser session is closed'
        );
    });

    it('propagates initialization and parse failures without an unhandled rejection', async () => {
        const initializationFailure = new Error('parser initialization failed');
        const failedInitialization = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: (): Promise<DolbyVisionRPUParserPort> => (
                Promise.reject(initializationFailure)
            )
        });
        await expect(failedInitialization.parse(new Uint8Array([ 1 ]))).rejects.toBe(
            initializationFailure
        );
        failedInitialization.close();

        const parseFailure = new Error('RPU parse failed');
        const parser = createParserPort();
        parser.parse.mockImplementation((): never => {
            throw parseFailure;
        });
        const failedParse = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: async (): Promise<DolbyVisionRPUParserPort> => parser
        });
        await expect(failedParse.parse(new Uint8Array([ 2 ]))).rejects.toBe(parseFailure);
        failedParse.close();
    });
});
