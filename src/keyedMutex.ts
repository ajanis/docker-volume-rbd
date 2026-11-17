/**
 * Serializes async work per key, so concurrent requests for the same volume
 * run one at a time while different volumes proceed in parallel.
 */
export default class KeyedMutex {
    private tails = new Map<string, Promise<void>>();

    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);

        await previous;
        try {
            return await fn();
        }
        finally {
            release();
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        }
    }
}
