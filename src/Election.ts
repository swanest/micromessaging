import { Messaging } from './Messaging';
import { Logger } from 'sw-logger';

export class Election {

    // Max time without a leader. Election will be launched after this
    // time
    static readonly DEFAULT_TIMEOUT: number = 15 * 1000;
    static TIMEOUT: number = Election.DEFAULT_TIMEOUT;
    private _messaging: Messaging;
    private _lastLeaderSync: Date;
    private _wasLeader = false;
    private _logger: Logger;
    public leaderId: string;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._logger = logger;
    }

    /**
     * Sets the last date the leader was seen on the PeerStat messages
     * and returns null. Otherwise (no param), returns the Date object
     * or undefined
     */
    public leaderSeen(date?: Date) {
        if (!date) {
            return this._lastLeaderSync;
        }
        this._lastLeaderSync = date;
    }

    /**
     * Starts an election process. This process will try to become the
     * leader before everyone else, when the exclusive queue (lock) is
     * free
     */
    public async start() {
        if (!this._messaging.isConnected()) {
            return;
        }
        await this._messaging.assertLeader();
    }

    /**
     * Returns true if there is a leader change.
     * @param prevLeader The previous leader
     */
    public leaderChange(prevLeader: string) {
        return this.leaderId !== prevLeader;
    }


    /**
     * Emits the leader.stepUp and leader.stepDown events if needed
     */
    public notifyLeader() {
        if (!this._messaging.isConnected()) {
            return;
        }
        this._messaging.getEventEmitter().emit('leader', {leaderId: this.leaderId});
        if (this.leaderId === this._messaging.getServiceId() && !this._wasLeader) {
            this._wasLeader = true;
            this._messaging.getEventEmitter().emit('leader.stepUp', {leaderId: this.leaderId});
        }
        if (this.leaderId !== this._messaging.getServiceId() && this._wasLeader) {
            this._wasLeader = false;
            this._messaging.getEventEmitter().emit('leader.stepDown', {leaderId: this.leaderId});
        }
    }
}
