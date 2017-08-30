import { Messaging } from './Messaging';
import { Logger } from 'sw-logger';
import { setTimeout } from 'timers';
import Timer = NodeJS.Timer;
import { isNullOrUndefined } from 'util';
import { Route } from './Interfaces';
import { HeavyMemory, MemoryStatus } from './HeavyMemory';
import { EventLoopStatus, HeavyEventLoop } from './HeavyEventLoop';

export class Qos {
    private _client: Messaging;
    private _mMonitor: HeavyMemory;
    private _elMonitor: HeavyEventLoop;
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
    private _shouldStopReceiving: boolean = false;
    private _maxParallelism: number = 1;
    private _lastDecreaseApplied: boolean = true;
    private _handledMessagesSinceLastMonitor: number = 0;
    private _mRoutes: Map<string, Route>;

    constructor(instance: Messaging, routes: Map<string, Route>, logger: Logger) {
        this._client = instance;
        this._logger = logger;
        this._mRoutes = routes;
    }

    public enable() {
        if (this._isEnabled || this._disabled) {
            return;
        }
        this._logger.debug('QOS has been enabled. Managing memory and event-loop.');
        this._isEnabled = true;
        const serviceOptions = this._client.getServiceOptions();
        this._config = {
            memorySoftLimit: serviceOptions.memorySoftLimit * Math.pow(2, 20),
            memoryHardLimit: serviceOptions.memoryHardLimit * Math.pow(2, 20),
            eventLoopThreshold: serviceOptions.qosThreshold * 100
        };
        this._mMonitor = new HeavyMemory({
            softLimit: this._config.memorySoftLimit,
            hardLimit: this._config.memoryHardLimit,
            sampleInterval: this._sampleInterval
        })
        this._mMonitor.on('pressure', this._memoryPressure.bind(this));
        this._mMonitor.on('released', this._memoryPressureReleased.bind(this));
        this._mMonitor.start();

        this._elMonitor = new HeavyEventLoop({
            maxEventLoopDelay: this._config.eventLoopThreshold,
            sampleInterval: this._sampleInterval
        });
        this._elMonitor.on('pressure', this._elPressure.bind(this));
        this._elMonitor.on('released', this._elReleased.bind(this));
        this._elMonitor.start();
        this._client.setQosMaxParallelism(1);
        this._looper();
    }

    public handledMessage() {
        this._handledMessagesSinceLastMonitor++;
    }

    public disable() {
        this._disabled = true;
        if (!this._isEnabled) {
            return;
        }
        clearTimeout(this._monitor);
        this._mMonitor.stop();
        this._mMonitor = null; // Allows GC
        this._elMonitor.stop();
        this._elMonitor = null; // Allows GC
    }

    private isHandlingMessages() {
        if (!this._lastLoop || isNullOrUndefined(this._client.getLastMessageDate())) {
            return false;
        }
        return this._client.getLastMessageDate().getTime() > this._lastLoop.getTime();
    }

    private isLimited() {
        let max = 0, ongoing = 0, isOneLimited = false;
        this._mRoutes.forEach(route => {
            if (!route.subjectToQuota) {
                return;
            }
            if (route.maxParallelism <= route.ongoingMessages) {
                isOneLimited = true;
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
        this._logger.debug(`Limits are: ${ongoing}/${max} isLimited? ${max < ongoing || isOneLimited}`);
        return max <= ongoing || isOneLimited;
    }

    private async _looper() {
        if (!this._lastLoopFinished) {
            return;
        }
        if (this._shouldStopReceiving) {
            if (this._client.getMaxParallelism() > 0) {
                this._client.setQosMaxParallelism(0);
            }
            this._lastLoop = new Date();
            this._lastLoopFinished = true;
            this._monitor = setTimeout(() => this._looper(), this._sampleInterval);
            return;
        }
        this._lastLoopFinished = false;
        if (this.isHandlingMessages()) {
            if (!this._isUnderPressure) {
                if (new Date().getTime() - this._lastUnderPressure.getTime() > this._sampleInterval * 3) {
                    if (this.isLimited()) {
                        this._maxParallelism += 10;
                        this._logger.debug('Assert new parallelism', this._maxParallelism);
                        await this._client.setQosMaxParallelism(this._maxParallelism);
                        this._lastDecreaseApplied = true;
                    }
                } else {
                    await this._client.setQosMaxParallelism(this._maxParallelism);
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
            await this._client.setQosMaxParallelism(this._maxParallelism);
        }
        this._lastLoop = new Date();
        this._lastLoopFinished = true;
        this._monitor = setTimeout(() => this._looper(), this._sampleInterval);
    }

    private _elPressure(status: EventLoopStatus) {
        this._logger.log(`Event loop is under pressure. Threshold set to ${this._config.eventLoopThreshold} but got ${status.eventLoopDelayedByMS}. Status attached`, status);
        this._lastUnderPressure = new Date();
        this._isUnderPressure = true;
        this._client.setQosMaxParallelism(0);
        this._client.getEventEmitter().emit('pressure', {
            type: 'eventLoop',
            contents: status
        });
    }

    private _elReleased(status: EventLoopStatus) {
        this._logger.log(`Event loop is now ok. Threshold set to ${this._config.eventLoopThreshold} > ${status.eventLoopDelayedByMS}. Status attached`, status);
        this._isUnderPressure = false;
        this._client.getEventEmitter().emit('pressureReleased', {
            type: 'eventLoop',
            contents: status
        });
    }

    private _memoryPressure(status: MemoryStatus) {
        this._logger.log(`Memory is exceeding softLimit of ${this._config.memorySoftLimit / Math.pow(2, 20)}MB. History attached.`, status);
        if (status.heapUsed > this._config.memoryHardLimit) {
            this._shouldStopReceiving = true;
            this._client.setQosMaxParallelism(0);
        } else {
            this._isUnderPressure = true;
        }
        this._client.getEventEmitter().emit('pressure', {
            type: 'memory',
            contents: status
        });
    }

    private _memoryPressureReleased(status: MemoryStatus) {
        this._logger.log(`Memory went below softLimit of ${this._config.memorySoftLimit / Math.pow(2, 20)}MB. History attached.`, status);
        this._shouldStopReceiving = false;
        this._isUnderPressure = false;
        this._client.getEventEmitter().emit('pressureReleased', {
            type: 'memory',
            contents: status
        });
    }
}

export type PressureEventType = 'eventLoop' | 'memory';

export interface PressureEvent {
    type: PressureEventType,
    contents: EventLoopStatus | MemoryStatus
}

interface QosOptions {
    memorySoftLimit: number;
    memoryHardLimit: number;
    eventLoopThreshold: number;
}
