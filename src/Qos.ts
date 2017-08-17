import {Messaging} from './Messaging';
import * as memoryPressure from 'memory-pressure';
import MemoryUsage = NodeJS.MemoryUsage;
import {HeavyEL, Status} from './HeavyEL';
import {Logger} from 'sw-logger';
import {setInterval, setTimeout} from 'timers';
import Timer = NodeJS.Timer;
import {isNullOrUndefined} from 'util';

export class Qos {
    private _client: Messaging;
    private _mPressure: memoryPressure.MemoryPressure;
    private _elMonitor: HeavyEL;
    private _isEnabled: boolean = false;
    private _disabled: boolean = false;
    private _config: QosOptions;
    private _logger: Logger;
    private _monitor: Timer;
    private _sampleInterval: number = 500;
    private _lastLoop: Date;
    private _lastLoopFinished: boolean = true;
    private _lastUnderPressure: Date = new Date('2017-01-01T00:00:00.000Z');
    private _isUnderPressure: boolean = false;
    private _maxParallelism: number = 1;
    private _lastDecreaseApplied: boolean = true;
    private _handledMessagesSinceLastMonitor: number = 0;

    constructor(instance: Messaging, logger: Logger) {
        this._client = instance;
        this._logger = logger;
    }

    public enable() {
        if (this._isEnabled || this._disabled) {
            return;
        }
        this._logger.debug('QOS has been enabled. Managing memory and event-loop.');
        this._isEnabled = true;
        const serviceOptions = this._client.serviceOptions();
        this._config = {
            memorySoftLimit: serviceOptions.memorySoftLimit * Math.pow(2, 20),
            memoryHardLimit: serviceOptions.memoryHardLimit * Math.pow(2, 20),
            eventLoopThreshold: serviceOptions.qosThreshold * 100
        };
        this._mPressure = memoryPressure.new(this._client.serviceName(), {
            memoryThreshold: this._config.memorySoftLimit,
            interval: this._sampleInterval,
            consecutiveGrowths: 3
        });
        this._mPressure.on(memoryPressure.EVENTS.UNDER_PRESSURE, this._memoryPressure.bind(this));
        this._mPressure.on(memoryPressure.EVENTS.PRESSURE_RELEASED, this._memoryPressureReleased.bind(this));

        this._elMonitor = new HeavyEL({
            maxEventLoopDelay: this._config.eventLoopThreshold,
            sampleInterval: this._sampleInterval
        });
        this._elMonitor.on('pressure', this._elPressure.bind(this));
        this._elMonitor.on('released', this._elReleased.bind(this));
        this._elMonitor.start();
        this._client.qosMaxParallelism(1);
        this._looper();
    }

    private isHandlingMessages() {
        if (!this._lastLoop || isNullOrUndefined(this._client.lastMessageDate())) {
            return false;
        }
        return this._client.lastMessageDate().getTime() > this._lastLoop.getTime();
    }

    public handledMessage() {
        this._handledMessagesSinceLastMonitor++;
    }

    private isLimited() {
        let max = 0, ongoing = 0;
        this._client.routes().forEach(route => {
            if (!route.subjectToQuota) {
                return;
            }
            max += route.maxParallelism;
            ongoing += route.ongoingMessages;
        });
        if (ongoing < max && this._handledMessagesSinceLastMonitor > max) {
            this._logger.debug(`Limits are: ${ongoing}/${max} but received ${this._handledMessagesSinceLastMonitor} messages. So yes it's limited`);
            this._handledMessagesSinceLastMonitor = 0;
            return true;
        }
        this._handledMessagesSinceLastMonitor = 0;
        this._logger.debug(`Limits are: ${ongoing}/${max} isLimited? ${max - 10 < ongoing}`);
        return max === ongoing;
    }

    private async _looper() {
        if (!this._lastLoopFinished) {
            return;
        }
        this._lastLoopFinished = false;
        if (this.isHandlingMessages()) {
            if (!this._isUnderPressure) {
                if (new Date().getTime() - this._lastUnderPressure.getTime() > this._sampleInterval * 3) {
                    if (this.isLimited()) {
                        this._maxParallelism += 10;
                        this._logger.debug('Assert new parallelism', this._maxParallelism);
                        await this._client.qosMaxParallelism(this._maxParallelism);
                        this._lastDecreaseApplied = true;
                    }
                } else {
                    await this._client.qosMaxParallelism(this._maxParallelism);
                    this._lastDecreaseApplied = true;
                }
            } else if (this._lastDecreaseApplied) {
                this._logger.log(`Decreasing quota from ${this._maxParallelism} to ${~~(this._maxParallelism / 2)}`);
                this._maxParallelism = ~~(this._maxParallelism / 2);
                if (this._maxParallelism === 0) {
                    this._maxParallelism = 1;
                }
                this._lastDecreaseApplied = false;
            }
        } else if (!this._isUnderPressure && this._client.getMaxParallelism() === 0) {
            await this._client.qosMaxParallelism(this._maxParallelism);
        }
        this._lastLoop = new Date();
        this._lastLoopFinished = true;
        this._monitor = setTimeout(() => this._looper(), this._sampleInterval);
    }

    private _elPressure(status: Status) {
        this._logger.log(`Event loop is under pressure. Threshold set to ${this._config.eventLoopThreshold} but got ${status.eventLoopDelayedByMS}. Status attached`, status);
        this._lastUnderPressure = new Date();
        this._isUnderPressure = true;
        this._client.qosMaxParallelism(0);
        this._client.ee().emit('pressure', {
            type: 'eventLoop',
            contents: status
        });
    }

    private _elReleased(status: Status) {
        this._logger.log(`Event loop is now ok. Threshold set to ${this._config.eventLoopThreshold} > ${status.eventLoopDelayedByMS}. Status attached`, status);
        this._isUnderPressure = false;
        this._client.ee().emit('pressureReleased', {
            type: 'eventLoop',
            contents: status
        });
    }

    private _memoryPressure(args: MemoryPressureArgs) {
        this._logger.log(`Memory is exceeding softLimit of ${this._config.memorySoftLimit / Math.pow(2, 20)}MB. History attached.`, args.memoryUsageHistory);
        args.ack();
        this._client.ee().emit('pressure', {
            type: 'memory',
            contents: args
        });
    }

    private _memoryPressureReleased(args: MemoryPressureArgs) {
        this._logger.log(`Memory went below softLimit of ${this._config.memorySoftLimit / Math.pow(2, 20)}MB. History attached.`, args.memoryUsageHistory);
        args.ack();
        this._client.ee().emit('pressureReleased', {
            type: 'memory',
            contents: args
        });
    }

    public disable() {
        this._disabled = true;
        if (!this._isEnabled) {
            return;
        }
        clearTimeout(this._monitor);
        this._mPressure.clear();
        this._mPressure = null; // Allows GC
        this._elMonitor.stop();
        this._elMonitor = null; // Allows GC
    }
}

export type PressureEventType = 'eventLoop' | 'memory';

export interface PressureEvent {
    type: PressureEventType,
    contents: MemoryPressureArgs | Status
}

interface QosOptions {
    memorySoftLimit: number;
    memoryHardLimit: number;
    eventLoopThreshold: number;
}

export interface MemoryPressureArgs {
    memoryUsageHistory: MemoryUsage[];

    ack(): void;
}