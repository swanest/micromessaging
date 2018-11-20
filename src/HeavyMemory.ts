import Timer = NodeJS.Timer;
import { EventEmitter } from 'events';
import { Bench } from './tests/Bench';

export type Events = 'pressure' | 'released';

export class HeavyMemory extends EventEmitter {

    private _config: Config;
    private _consecutive: number = -1;
    private _isStarted: boolean = false;
    private _load: Load;
    private _loadBench: Bench;
    private _timer: Timer;

    constructor(config: Config) {
        super();
        this._config = config;
        this._loadBench = new Bench();
        this._load = {heapUsed: 0};
    }

    public on(event: Events, listener: (status: MemoryStatus) => void) {
        return super.on(event, listener);
    }

    start() {
        if (this._isStarted) {
            return;
        }
        this._isStarted = true;
        let notifiedPressure = false,
            notifiedHardPressure = false;
        const loopSample = () => {

            (this._loadBench as any).reset();
            const measure = () => {
                this._load.heapUsed = process.memoryUsage().heapUsed;
                if (this._load.heapUsed > this._config.softLimit) {
                    this._consecutive++;
                }
                if (this._load.heapUsed > this._config.softLimit && this._load.heapUsed < this._config.hardLimit && !notifiedPressure) {
                    this._emit('pressure', {
                        consecutive: this._consecutive,
                        threshold: this._config.softLimit,
                        heapUsed: this._load.heapUsed,
                    });
                    notifiedPressure = true;
                }
                if (this._load.heapUsed > this._config.hardLimit && !notifiedHardPressure) {
                    this._emit('pressure', {
                        consecutive: this._consecutive,
                        threshold: this._config.hardLimit,
                        heapUsed: this._load.heapUsed,
                    });
                    notifiedHardPressure = true;
                }
                if (this._load.heapUsed < this._config.softLimit && (notifiedPressure || notifiedHardPressure)) {
                    this._consecutive = -1;
                    this._emit('released', {
                        consecutive: this._consecutive,
                        threshold: this._config.softLimit,
                        heapUsed: this._load.heapUsed,
                    });
                    notifiedPressure = false;
                    notifiedHardPressure = false;
                }

                loopSample();
            };

            this._timer = setTimeout(measure, this._config.sampleInterval);
        };

        loopSample();
    }

    stop() {
        clearTimeout(this._timer);
        this._timer = null;
        this.removeAllListeners();
    }

    private _emit(event: Events, status: MemoryStatus) {
        super.emit(event, status);
    }
}

export interface MemoryStatus {
    consecutive: number;
    heapUsed: number;
    threshold: number;
}

export interface Config {
    hardLimit: number;
    sampleInterval: number;
    softLimit: number;
}

export interface Load {
    heapUsed: number;
}
