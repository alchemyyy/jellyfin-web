export type LibDCADECModule = {
    HEAP32: Int32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

declare const createLibDCADECModule: () => Promise<LibDCADECModule>;

export default createLibDCADECModule;
