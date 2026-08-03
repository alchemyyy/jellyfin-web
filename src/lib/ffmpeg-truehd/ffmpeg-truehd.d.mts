export type FFmpegTrueHDModule = {
    HEAP16: Int16Array
    HEAP32: Int32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

declare const createFFmpegTrueHDModule: () => Promise<FFmpegTrueHDModule>;

export default createFFmpegTrueHDModule;
