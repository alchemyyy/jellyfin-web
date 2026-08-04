export type HLSRuntimeConstructor = abstract new (
    ...constructorArguments: never[]
) => unknown;

type HLSRuntimeModule = {
    default: HLSRuntimeConstructor
};

export type HLSRuntimeImporter = () => Promise<HLSRuntimeModule>;

export type HLSRuntimeSelection = {
    HLSRuntime: HLSRuntimeConstructor
    useWebGPUHLSRuntime: boolean
};

const importStableHLSRuntime: HLSRuntimeImporter = () => import('hls.js/dist/hls.js');
const importWebGPUHLSRuntime: HLSRuntimeImporter = () => import('hls.js-webgpu/dist/hls.js');

/** Loads the isolated modern runtime, falling back to the matching stable runtime. */
export async function loadHLSRuntime(
    useWebGPUHLSRuntime: boolean,
    stableRuntimeImporter: HLSRuntimeImporter = importStableHLSRuntime,
    webGPUHLSRuntimeImporter: HLSRuntimeImporter = importWebGPUHLSRuntime
): Promise<HLSRuntimeSelection> {
    if (useWebGPUHLSRuntime) {
        try {
            const { default: HLSRuntime } = await webGPUHLSRuntimeImporter();
            return { HLSRuntime, useWebGPUHLSRuntime: true };
        } catch (error) {
            console.warn(
                'Modern WebGPU HLS runtime failed to load; using the stable runtime',
                error
            );
        }
    }

    const { default: HLSRuntime } = await stableRuntimeImporter();
    return { HLSRuntime, useWebGPUHLSRuntime: false };
}
