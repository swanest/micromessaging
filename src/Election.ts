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

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._logger = logger;
    }

    public stop() {
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
        this._leaderId = await this._messaging.assertLeader();
        this._notifyLeader();
    }

    private _notifyLeader() {
        if (!this._messaging.isConnected() || isNullOrUndefined(this._leaderId)) {
            return;
        }
        this._messaging.getEventEmitter().emit('leader', {leaderId: this._leaderId});
    }
}
