import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME,
    getCustomAudioWorkletSource
} from './AudioWorkletProcessorSource';

type WorkletMessageEvent = { data: unknown };

class MockProcessorPort {
    public onmessage: ((event: WorkletMessageEvent) => void) | null = null;
    public readonly postedMessages: unknown[] = [];

    public postMessage(message: unknown): void {
        this.postedMessages.push(message);
    }

    public deliver(message: unknown): void {
        this.onmessage?.({ data: message });
    }
}

class MockAudioWorkletProcessor {
    public readonly port = new MockProcessorPort();
}

type ProcessorHarness = MockAudioWorkletProcessor & {
    process: (inputs: readonly unknown[], outputs: readonly Float32Array[][]) => boolean
};

type ProcessorConstructor = new (options: {
    processorOptions: {
        channelCount: number
        maxBufferedFrames: number
        maxChunks: number
        telemetryIntervalFrames: number
    }
}) => ProcessorHarness;

type WorkletModuleEvaluator = (
    processorBase: typeof MockAudioWorkletProcessor,
    registerProcessor: (name: string, constructor: ProcessorConstructor) => void,
    sampleRate: number
) => void;

function requireProcessorConstructor(
    constructor: ProcessorConstructor | null
): ProcessorConstructor {
    if (!constructor) {
        throw new Error('Worklet processor was not registered');
    }
    return constructor;
}

describe('AudioWorkletProcessorSource', () => {
    it('executes bounded enqueue, render, overflow, flush, and underflow paths', () => {
        let registeredName = '';
        let Processor: ProcessorConstructor | null = null;
        const registerProcessor = (name: string, constructor: ProcessorConstructor): void => {
            registeredName = name;
            Processor = constructor;
        };
        // eslint-disable-next-line sonarjs/code-eval -- Validates the generated standalone module
        const evaluateModule = Function(
            'AudioWorkletProcessor',
            'registerProcessor',
            'sampleRate',
            getCustomAudioWorkletSource()
        ) as WorkletModuleEvaluator;
        evaluateModule(MockAudioWorkletProcessor, registerProcessor, 1_000);

        expect(registeredName).toBe(CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME);
        const ProcessorConstructor = requireProcessorConstructor(Processor);
        const processor = Reflect.construct(ProcessorConstructor, [ {
            processorOptions: {
                channelCount: 2,
                maxBufferedFrames: 4,
                maxChunks: 2,
                telemetryIntervalFrames: 4
            }
        } ]) as ProcessorHarness;
        processor.port.deliver({
            channelData: [ new Float32Array([ 1, 2, 3, 4 ]), new Float32Array([ 5, 6, 7, 8 ]) ],
            generation: 1,
            sequence: 1,
            timestampMicroseconds: -1_000_000,
            type: 'enqueue'
        });
        processor.port.deliver({
            channelData: [ new Float32Array([ 9 ]), new Float32Array([ 10 ]) ],
            generation: 1,
            sequence: 2,
            timestampMicroseconds: 0,
            type: 'enqueue'
        });
        processor.port.deliver({ playing: true, type: 'playback' });

        const firstOutput = [ new Float32Array(4), new Float32Array(4) ];
        expect(processor.process([], [ firstOutput ])).toBe(true);
        expect(Array.from(firstOutput[0])).toEqual([ 1, 2, 3, 4 ]);
        expect(Array.from(firstOutput[1])).toEqual([ 5, 6, 7, 8 ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            overflowEvents: 1,
            overflowFrames: 1,
            reason: 'overflow',
            sequence: 2
        }));

        const underflowOutput = [ new Float32Array(4).fill(12), new Float32Array(4).fill(12) ];
        processor.process([], [ underflowOutput ]);
        expect(Array.from(underflowOutput[0])).toEqual([ 0, 0, 0, 0 ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            mediaTimeMicroseconds: -996_000,
            reason: 'underflow',
            underflowEvents: 1,
            underflowFrames: 4
        }));

        processor.port.deliver({
            channelData: [ new Float32Array([ 9, 10, 11, 12 ]), new Float32Array([ 13, 14, 15, 16 ]) ],
            generation: 1,
            sequence: 3,
            timestampMicroseconds: 2_000_000,
            type: 'enqueue'
        });
        const recoveredOutput = [ new Float32Array(4), new Float32Array(4) ];
        processor.process([], [ recoveredOutput ]);
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            mediaTimeMicroseconds: 2_004_000,
            queuedFrames: 0,
            reason: 'underflow-recovered'
        }));

        processor.port.deliver({
            generation: 2,
            mediaTimeMicroseconds: -5_000_000,
            type: 'flush'
        });
        expect(processor.port.postedMessages).toContainEqual(expect.objectContaining({
            generation: 2,
            mediaTimeMicroseconds: -5_000_000,
            queuedFrames: 0,
            reason: 'flush'
        }));
    });
});
