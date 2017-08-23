export class Utils {
    public static defer<T>() {
        let resolve, reject;
        const promise = new Promise<T>(function (_resolve, _reject) {
            resolve = _resolve;
            reject = _reject;
        });

        return {
            promise,
            resolve,
            reject
        } as Deferred<T>;
    }

    public static hrtimeToMS(time: [number, number]): number {
        return (time[0] * 1e9 + time[1]) / 1e6;
    }
}

export interface Deferred<T = {}> {
    promise: Promise<T>;
    resolve: (value?: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
}