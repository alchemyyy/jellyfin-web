const AC3_IMPLEMENTATION_ARTIFACT_SENTINEL = 'jellyfin-webgpu-bundled-ac3-v1';

/** Loads and registers the non-redistributable AC-3 decoder in enabled local builds. */
export async function registerBundledAC3SoftwareAudioDecoder(): Promise<void> {
    try {
        const { registerAC3SoftwareAudioDecoder } = await import('./AC3SoftwareAudioDecoder');
        registerAC3SoftwareAudioDecoder();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${AC3_IMPLEMENTATION_ARTIFACT_SENTINEL}: ${detail}`);
    }
}
