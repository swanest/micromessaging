import Timer = NodeJS.Timer;
import { EventEmitter } from 'events';
import { Bench } from './tests/Bench';

export type Events = 'pressure' | 'released';

export class HeavyEventLoop extends EventEmitter {

    private _config: Config;
    private _consecutive: number = -1;
    private _eventLoopTimer: Timer;
    private _isStarted: boolean = false;
    private _load: Load;
    private _loadBench: Bench;

    constructor(config: Config) {
        super();
        this._config = config;
        this._loadBench = new Bench();
        this._load = {eventLoopDelay: 0};
    }

    public on(event: Events, listener: (status: EventLoopStatus) => void) {
        return super.on(event, listener);
    }

    start() {
        if (this._isStarted) {
            return;
        }
        this._isStarted = true;
        const loopSample = () => {

            (this._loadBench as any).reset();
            const measure = () => {
                this._load.eventLoopDelay = (this._loadBench.elapsed() - this._config.sampleInterval);
                if (this._load.eventLoopDelay > this._config.maxEventLoopDelay) {
                    this._consecutive++;
                    this._emit('pressure', {
                        consecutive: this._consecutive,
                        threshold: this._config.maxEventLoopDelay,
                        eventLoopDelayedByMS: this._load.eventLoopDelay,
                    });
                } else if (this._consecutive > -1) {
                    this._consecutive = -1;
                    this._emit('released', {
                        consecutive: this._consecutive,
                        threshold: this._config.maxEventLoopDelay,
                        eventLoopDelayedByMS: this._load.eventLoopDelay,
                    });
                } else {
                    this._consecutive = -1;
                }

                loopSample();
            };

            this._eventLoopTimer = setTimeout(measure, this._config.sampleInterval);
        };

        loopSample();
    }

    stop() {
        clearTimeout(this._eventLoopTimer);
        this._eventLoopTimer = null;
        this.removeAllListeners();
    }

    private _emit(event: Events, status: EventLoopStatus) {
        super.emit(event, status);
    }
}

export interface EventLoopStatus {
    consecutive: number;
    eventLoopDelayedByMS: number;
    threshold: number;
}

export interface Config {
    maxEventLoopDelay: number;
    sampleInterval: number;
}

export interface Load {
    eventLoopDelay: number;
}
