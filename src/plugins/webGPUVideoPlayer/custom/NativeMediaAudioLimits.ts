import { millisecondsToMicroseconds } from '../MediaTime';

export const MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS =
    millisecondsToMicroseconds(2_000);
export const MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH = 2 * 1_024 * 1_024;
export const MAXIMUM_NATIVE_AUDIO_PENDING_BYTE_LENGTH = 4 * 1_024 * 1_024;
export const MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT = 16;
