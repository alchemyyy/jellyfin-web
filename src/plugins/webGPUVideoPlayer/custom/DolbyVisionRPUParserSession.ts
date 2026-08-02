import DolbyVisionRPUParser, {
    type DolbyVisionRPUSnapshot
} from './DolbyVisionRPUParser';

export type DolbyVisionRPUParserPort = {
    close: () => void
    parse: (rpuNALUnit: Uint8Array) => DolbyVisionRPUSnapshot
    reset: () => void
};

export type DolbyVisionRPUParserSessionDependencies = {
    createParser: (wasmURL: string) => Promise<DolbyVisionRPUParserPort>
};

type ParserInitializationResult = {
    error: unknown
    parser: DolbyVisionRPUParserPort | null
};

const DEFAULT_DEPENDENCIES: DolbyVisionRPUParserSessionDependencies = {
    createParser: (wasmURL: string): Promise<DolbyVisionRPUParserPort> => (
        DolbyVisionRPUParser.create(wasmURL)
    )
};

function releaseParser(parser: DolbyVisionRPUParserPort): void {
    try {
        parser.reset();
    } catch {
        // Closing remains authoritative when reset fails during retirement
    }
    try {
        parser.close();
    } catch {
        // Ownership still ends when an implementation throws during close
    }
}

/** Lazily owns one stateful parser without delaying ordinary HEVC packets. */
export default class DolbyVisionRPUParserSession {
    private closed = false;
    private initialization!: Promise<ParserInitializationResult>;
    private parser: DolbyVisionRPUParserPort | null = null;

    private constructor() {
        // Use create() so asynchronous initialization starts outside construction
    }

    /** Starts non-blocking parser initialization for one decode generation. */
    public static create(
        wasmURL: string,
        dependencies: DolbyVisionRPUParserSessionDependencies = DEFAULT_DEPENDENCIES
    ): DolbyVisionRPUParserSession {
        const session = new DolbyVisionRPUParserSession();
        session.initialization = session.initializeParser(wasmURL, dependencies);
        return session;
    }

    private initializeParser(
        wasmURL: string,
        dependencies: DolbyVisionRPUParserSessionDependencies
    ): Promise<ParserInitializationResult> {
        return dependencies.createParser(wasmURL).then(
            (parser: DolbyVisionRPUParserPort): ParserInitializationResult => {
                if (this.closed) {
                    releaseParser(parser);
                    return {
                        error: new Error('Dolby Vision parser session is closed'),
                        parser: null
                    };
                }
                this.parser = parser;
                return { error: null, parser };
            },
            (error: unknown): ParserInitializationResult => ({ error, parser: null })
        );
    }

    /** Parses one owned RPU in decode order into transferable packed data. */
    public async parse(rpuNALUnit: Uint8Array): Promise<ArrayBuffer> {
        this.requireOpen();
        const initialization = await this.initialization;
        this.requireOpen();
        if (!initialization.parser) {
            throw initialization.error;
        }
        return initialization.parser.parse(rpuNALUnit).packedData;
    }

    /** Invalidates the generation and retires the parser exactly once. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const parser = this.parser;
        this.parser = null;
        if (parser) {
            releaseParser(parser);
        }
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Dolby Vision parser session is closed');
        }
    }
}
