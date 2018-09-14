export class Deferred<T> {
    public promise: Promise<T>;
    public reject: (reason?: any) => void;
    public resolve: (value?: T | PromiseLike<T>) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
