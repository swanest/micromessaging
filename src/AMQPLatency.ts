import { CustomError } from 'sw-logger';
import * as v4 from 'uuid/v4';
import { ReturnHandler } from './Interfaces';
import { Message } from './Message';
import { Messaging } from './Messaging';
import { isNullOrUndefined, Utils } from './Utils';

export class AMQPLatency {
    public lastLatencyMS: number;
    private _id: string;
    private _listener: Promise<ReturnHandler>;
    private _messaging: Messaging;
    private _ongoingBenchmark: Promise<number>;
    private _sampleCount: number;

    constructor(messaging: Messaging) {
        this._messaging = messaging;
    }

    /**
     * Benchmarks the current messaging broker latency.
     * @returns The average time it took to exchange 100 messages.
     */
    public async benchmark(silent: boolean = false): Promise<number> {
        if (!this._messaging.isConnected()) {
            if (silent) {
                return 10000;
            } else {
                throw new CustomError('forbidden', 'Messaging instance is not ready. Try again later.');
            }
        }
        if (this._listener) {
            return this._ongoingBenchmark;
        }
        return this._ongoingBenchmark = this._benchmark();
    }

    private async _benchmark() {
        const latencyMS = await new Promise<number>((resolve, reject) => {
            this._id = v4();
            const samples: number[] = [];
            this._sampleCount = 0;
            this._listener = this._messaging.listen(this._messaging.getInternalExchangeName(), `latency.${this._id}`, (m: Message<SampleMessage>) => {
                samples.push(Utils.hrtimeToMS(process.hrtime(m.body.sentAt)));
                if (this._sampleCount < 10) {
                    this._sendSample().catch(reject);
                } else {
                    resolve(samples.reduce((previousValue, currentValue) => {
                        return previousValue + currentValue;
                    }, 0) / samples.length);
                }
            });
            this._listener
                .then(() => this._sendSample())
                .catch(reject);
        });
        await this._clean();
        this.lastLatencyMS = latencyMS;
        return latencyMS;
    }

    private async _clean() {
        if (this._listener) {
            const handler = await this._listener;
            await handler.stop();
            this._listener = null;
            this._ongoingBenchmark = null;
        }
    }

    private async _sendSample() {
        if (isNullOrUndefined(this._sampleCount) || isNullOrUndefined(this._id)) {
            throw new CustomError('forbidden', 'sendSample cannot be called before benchmark.');
        }
        await this._messaging.emit<SampleMessage>(this._messaging.getInternalExchangeName(), `latency.${this._id}`, {
            sample: this._sampleCount++,
            sentAt: process.hrtime(),
        });
    }
}

interface SampleMessage {
    sample: number;
    sentAt: [number, number];
}
