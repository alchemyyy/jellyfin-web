import { describe, expect, it } from 'vitest';

import {
    isRetryableMediaFetchError,
    MediaHTTPError,
    MediaNetworkError,
    requireSuccessfulMediaHTTPResponse
} from './MediaFetchPolicy';

describe('media fetch policy', () => {
    it('accepts successful partial responses', () => {
        expect(() => requireSuccessfulMediaHTTPResponse({
            ok: true,
            status: 206
        })).not.toThrow();
    });

    it.each([ 408, 429, 500, 503, 599 ])(
        'classifies transient HTTP status %i as retryable',
        (status: number) => {
            let thrownError: unknown;
            try {
                requireSuccessfulMediaHTTPResponse({ ok: false, status });
            } catch (error) {
                thrownError = error;
            }

            expect(thrownError).toBeInstanceOf(MediaHTTPError);
            expect(thrownError).toMatchObject({ retryable: true, status });
            expect(isRetryableMediaFetchError(thrownError)).toBe(true);
        }
    );

    it.each([ 0, 400, 401, 404, 409, 499 ])(
        'classifies permanent HTTP status %i as non-retryable',
        (status: number) => {
            const error = new MediaHTTPError(status);

            expect(error.retryable).toBe(false);
            expect(isRetryableMediaFetchError(error)).toBe(false);
        }
    );

    it('retries rejected fetches as transport failures', () => {
        const error = new MediaNetworkError(new TypeError('Failed to fetch'));

        expect(error.message).toBe('Failed to fetch');
        expect(isRetryableMediaFetchError(error)).toBe(true);
    });

    it('does not retry unrelated decode errors', () => {
        expect(isRetryableMediaFetchError(new Error('Decoder failed'))).toBe(false);
    });
});
