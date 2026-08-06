export type FFmpegEAC3Module = {
    HEAPF32: Float32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

declare const createFFmpegEAC3Module: () => Promise<FFmpegEAC3Module>;

export default createFFmpegEAC3Module;
