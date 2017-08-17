import {Bench} from 'hoek';

import Timer = NodeJS.Timer;
import {EventEmitter} from 'events';

export type Events = 'pressure' | 'released';

export class HeavyEL extends EventEmitter {

    private _config: Config;
    private _isStarted: boolean = false;
    private _eventLoopTimer: Timer;
    private _load: Load;
    private _loadBench: Bench;
    private _consecutive: number = -1;

    constructor(config: Config) {
        super();
        this._config = config;
        this._loadBench = new Bench();
        this._load = {eventLoopDelay: 0};
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
                        eventLoopDelayedByMS: this._load.eventLoopDelay
                    });
                } else if (this._consecutive > -1) {
                    this._consecutive = -1;
                    this._emit('released', {
                        consecutive: this._consecutive,
                        threshold: this._config.maxEventLoopDelay,
                        eventLoopDelayedByMS: this._load.eventLoopDelay
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

    public on(event: Events, listener: (status: Status) => void) {
        return super.on(event, listener);
    }

    private _emit(event: Events, status: Status) {
        super.emit(event, status);
    }

    stop() {
        clearTimeout(this._eventLoopTimer);
        this._eventLoopTimer = null;
        this.removeAllListeners();
    }
}

export interface Status {
    consecutive: number;
    threshold: number;
    eventLoopDelayedByMS: number;
}

export interface Config {
    sampleInterval: number;
    maxEventLoopDelay: number;
}

export interface Load {
    eventLoopDelay: number;
}