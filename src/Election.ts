import { Messaging } from './Messaging';
import { isNullOrUndefined } from 'util';
import { Logger } from 'sw-logger';

export class Election {

    // public TEMPO: number = Election.DEFAULT_TEMPO;
    static DEFAULT_TIMEOUT: number = 30 * 1000;
    public TIMEOUT: number = Election.DEFAULT_TIMEOUT;
    private _messaging: Messaging;

    private _leaderId: string;
    private _lastLeaderSync: Date;
    private _logger: Logger;
    private _wasLeader = false;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._logger = logger;
    }

    /**
     * Get the leader ID
     */
    public leaderId() {
        return this._leaderId;
    }

    /**
     * Sets the last date the leader was seen
     */
    public leaderSeen(date?: Date) {
        if (!date) {
            return this._lastLeaderSync;
        }
        this._lastLeaderSync = date;
    }

    /**
     * Starts an election process.
     */
    public async start() {
        if (!this._messaging.isConnected()) {
            return;
        }
        const newLeader = await this._messaging.assertLeader();
        const prevLeader = this._leaderId;
        this._leaderId = newLeader;
        this._notifyLeader(prevLeader);
    }

    private _notifyLeader(prevLeader: string) {
        if (!this._messaging.isConnected() || isNullOrUndefined(this._leaderId) || this._leaderId === prevLeader) {
            return;
        }
        this._messaging.getEventEmitter().emit('leader', {leaderId: this._leaderId});
        if (this._leaderId === this._messaging.getServiceId() && !this._wasLeader) {
            this._wasLeader = true;
            this._messaging.getEventEmitter().emit('leader.stepUp', {leaderId: this._leaderId});
        }
        if (this._leaderId !== this._messaging.getServiceId() && this._wasLeader) {
            this._wasLeader = false;
            this._messaging.getEventEmitter().emit('leader.stepDown', {leaderId: this._leaderId});
        }
    }
}
