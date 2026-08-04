const HTTP_REQUEST_TIMEOUT_STATUS = 408;
const HTTP_TOO_MANY_REQUESTS_STATUS = 429;
const HTTP_SERVER_ERROR_MINIMUM_STATUS = 500;
const HTTP_SERVER_ERROR_MAXIMUM_STATUS = 599;

function getMediaNetworkErrorMessage(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return 'The media request failed';
}

/** Identifies a transport failure while fetching media bytes. */
export class MediaNetworkError extends Error {
    public constructor(error: unknown) {
        super(getMediaNetworkErrorMessage(error));
        this.name = 'MediaNetworkError';
    }
}

/** Preserves HTTP status and retry policy without exposing the media URL. */
export class MediaHTTPError extends MediaNetworkError {
    public readonly retryable: boolean;
    public readonly status: number;

    public constructor(status: number) {
        super(`The media request failed with HTTP status ${status}`);
        this.name = 'MediaHTTPError';
        this.status = status;
        this.retryable = status === HTTP_REQUEST_TIMEOUT_STATUS
            || status === HTTP_TOO_MANY_REQUESTS_STATUS
            || (
                status >= HTTP_SERVER_ERROR_MINIMUM_STATUS
                && status <= HTTP_SERVER_ERROR_MAXIMUM_STATUS
            );
    }
}

/** Throws a status-aware error before Mediabunny converts it to a generic decode error. */
export function requireSuccessfulMediaHTTPResponse(
    response: Pick<Response, 'ok' | 'status'>
): void {
    if (!response.ok) {
        throw new MediaHTTPError(response.status);
    }
}

/** Retries transport errors and transient HTTP statuses, never permanent HTTP failures. */
export function isRetryableMediaFetchError(error: unknown): boolean {
    if (error instanceof MediaHTTPError) {
        return error.retryable;
    }
    return error instanceof MediaNetworkError;
}
