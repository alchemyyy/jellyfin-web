/** Leaves bundled AC-3 registration unavailable in ordinary builds. */
export function registerBundledAC3SoftwareAudioDecoder(): Promise<void> {
    return Promise.resolve();
}
