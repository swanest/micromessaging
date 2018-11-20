export class Bench {
    private ts: number = 0;

    constructor() {
        this.reset();
    }

    static now() {
        const ts = process.hrtime();
        return (ts[0] * 1e3) + (ts[1] / 1e6);
    }

    elapsed() {
        return Bench.now() - this.ts;
    }

    reset() {
        this.ts = Bench.now();
    }
}
