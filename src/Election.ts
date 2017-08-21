import {Messaging} from './Messaging';
import {random} from 'lodash';
import {Message} from './Message';
import Timer = NodeJS.Timer;
import {isNullOrUndefined} from 'util';
import {CustomError, Logger} from 'sw-logger';
import {PressureEvent} from './Qos';

let COUNT = 0;

export class Election {

    private _messaging: Messaging;
    private _id: number;
    private _leaderId: number;
    private _lastLeaderSync: Date;

    static DEFAULT_TEMPO: number = 2000;
    public TEMPO: number = Election.DEFAULT_TEMPO;
    static DEFAULT_TIMEOUT: number = 30 * 1000;
    public TIMEOUT: number = Election.DEFAULT_TIMEOUT;

    private _voteAnswerTimeout: Timer;
    private _leaderNotificationTimer: Timer;
    private _logger: Logger;
    private _ping: Date;
    private _pong: Date;
    private _firstMessageISent: boolean = false;

    private _candidates: Array<number> = [];

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this.generateId();
        this._messaging.listen(this._messaging.internalExchangeName(), 'leader.vote', this._electionListener.bind(this));
        this._messaging.listen(this._messaging.internalExchangeName(), 'leader.consensus', m => {
            if (this._voteAnswerTimeout) {
                clearTimeout(this._voteAnswerTimeout);
                this._voteAnswerTimeout = null;
            }
            if ((m as any).id === this._id) {
                // If I'm receiving the message I just emitted it means I know who is the leader...
                return;
            }
            if (!isNullOrUndefined(this._leaderId) && this._leaderId !== (m.body as any).leaderId) {
                // throw new CustomError('leaderAlreadyDefined', `${this._id} expected leader to be ${this._leaderId} but received ${(m.body as any).leaderId}`);
                this._logger.debug('Leader was already defined but someone pretends its someone else, lets vote again.');
                clearTimeout(this._leaderNotificationTimer);
                this._leaderNotificationTimer = null;
                this.TEMPO *= 2;
                this.TIMEOUT *= 2;
                this._leaderId = null;
                this._lastLeaderSync = null;
                this.vote();
                return;
            }
            this.TEMPO = Election.DEFAULT_TEMPO;
            this.TIMEOUT = Election.DEFAULT_TIMEOUT;
            this._leaderId = (m.body as any).leaderId;
            this._notifyLeader();
        });

        let cancelledLeaderNotification = false,
            cancelledVoteAnswer = false;
        this._messaging.on('pressure', (pEvent: PressureEvent) => {
            if (pEvent.type === 'eventLoop') {
                if (this._leaderNotificationTimer) {
                    clearTimeout(this._leaderNotificationTimer);
                    cancelledLeaderNotification = true;
                }
                if (this._voteAnswerTimeout) {
                    clearTimeout(this._voteAnswerTimeout);
                    cancelledVoteAnswer = true;
                }
            }
        });
        this._messaging.on('pressureReleased', (pEvent: PressureEvent) => {
            if (pEvent.type === 'eventLoop') {
                if (cancelledLeaderNotification) {
                    this._notifyLeader();
                    cancelledLeaderNotification = false;
                }
                if (cancelledVoteAnswer) {
                    if (isNullOrUndefined(this._leaderId)) {
                        this.vote();
                    }
                    cancelledVoteAnswer = false;
                }
            }
        });
        this._logger = logger;
    }

    private _notifyLeader() {
        if (!isNullOrUndefined(this._leaderNotificationTimer)) {
            clearTimeout(this._leaderNotificationTimer);
        }
        this._logger.log(`Will notify leader in ${this.TEMPO}ms.`);
        this._leaderNotificationTimer = setTimeout(() => {
            if (this._leaderId === null) {
                return;
            }
            this._messaging.ee().emit('leader', {leaderId: this._leaderId});
            this._leaderNotificationTimer = null;
        }, this.TEMPO);
    }

    public shut() {
        if (!isNullOrUndefined(this._voteAnswerTimeout)) {
            clearTimeout(this._voteAnswerTimeout);
        }
        if (!isNullOrUndefined(this._leaderNotificationTimer)) {
            clearTimeout(this._leaderNotificationTimer);
        }
    }

    generateId() {
        // this._id = random(1, Number.MAX_SAFE_INTEGER, false);
        this._id = ++COUNT;
    }

    public id() {
        return this._id;
    }

    public leaderId() {
        return this._leaderId;
    }

    public leaderSeen(date?: Date) {
        if (!date) {
            return this._lastLeaderSync;
        }
        this._lastLeaderSync = date;
    }

    private async _electionListener(message: Message<ElectionMessage>) {
        if (message.body.id === this._id) {
            if (this._firstMessageISent) {
                this._waitAndMakeMeLeader();
                this._firstMessageISent = false;
            }
            this._pong = new Date();
            const pingPong = this._pong.getTime() - this._ping.getTime();
            if (this.TEMPO < pingPong) {
                this.TEMPO = Math.ceil(pingPong * 1.5);
            } else if (this.TEMPO > pingPong * 2) {
                this.TEMPO = ~~(pingPong * 2); // Put TEMPO at 2 times lantency.
                if (this.TEMPO < 500) {
                    this.TEMPO = 500;
                }
            }
            if (this.TIMEOUT < this.TEMPO) {
                throw new CustomError('latencyTooHigh', 'Latency is too high and wont help in the election process...');
            }
            this._logger.debug('Received a message I sent myself. Ignoring it.');
            return; // Ignore rest of handle for messages that I sent myself.
        }
        this._logger.log(`${this._id} received a vote message`, message.body, this._lastLeaderSync);
        // Something arrives but vote is already done & lastLeaderSeen < 2/3 TIMEOUT, publish that the elected instance is the previously elected one
        if (!isNullOrUndefined(this._leaderId) && this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime() < 2 / 3 * this.TIMEOUT) {
            this._logger.debug('%i Someone trying to make a new vote but we saw the leader %ims ago, announce the leader!', this._id, new Date().getTime() - this._lastLeaderSync.getTime());
            await this._emitKnownLeader();
            return;
        }
        if (!isNullOrUndefined(message.body.voteFor)) {
            clearTimeout(this._voteAnswerTimeout);
            this._voteAnswerTimeout = null;
            // Something arrives with vote _id > me, publish that I vote for him
            if (message.body.voteFor > this._id) {
                await this._voteFor(message.body.voteFor);
            }
            // Something arrives with vote _id < me, publish that I still vote for myself
            if (message.body.voteFor < this._id) {
                await this._voteFor(this._id);
            }
            if (message.body.voteFor === this._id) {
                this._logger.debug('Shall %i be leader? %b', this._id, this._shallIBeLeader());
            }
            if (message.body.voteFor === this._id && this._shallIBeLeader()) {
                // Wait that no one else NACKs that result.
                this._waitAndMakeMeLeader();
            }
            return;
        }
        throw new CustomError('inconsistency', 'Case shouldnt happen');
    }

    private async _emitKnownLeader() {
        await this._messaging.emit(this._messaging.internalExchangeName(), 'leader.consensus', {
            id: this._id,
            leaderId: this._leaderId
        }, undefined, {onlyIfConnected: true});
    }

    private _shallIBeLeader(): boolean {
        this._candidates.sort((a, b) => a - b);
        return this._id === this._candidates[this._candidates.length - 1];
    }

    private async _voteFor(id: number, initialVote: boolean = false) {
        if (this._candidates.indexOf(id) === -1) {
            this._candidates.push(id);
        }
        this._candidates.sort((a, b) => a - b);

        const winnerIMO = this._candidates[this._candidates.length - 1];
        this._logger.debug('winner IMO %d', winnerIMO, this._candidates);
        if (winnerIMO !== this._id && !initialVote) { // Shut the fuck up.
            return;
        } else if (!initialVote && winnerIMO === this._id) {
            this._waitAndMakeMeLeader();
        }

        this._logger.log(`${this._id} proposing to vote for ${winnerIMO}`);
        this._ping = new Date();
        await this._messaging.emit(this._messaging.internalExchangeName(), 'leader.vote', {
            id: this._id,
            voteFor: winnerIMO
        }, undefined, {onlyIfConnected: true});
    }

    private _waitAndMakeMeLeader(initialFactor: number = 1) {
        if (!isNullOrUndefined(this._voteAnswerTimeout)) {
            clearTimeout(this._voteAnswerTimeout);
        }
        this._voteAnswerTimeout = setTimeout(async () => {
            // Nothing? => I become master
            this._leaderId = this._id;
            this._logger.debug('I become leader (' + this._id + ') notifying others');
            this._lastLeaderSync = new Date();
            this._notifyLeader();
            this._voteAnswerTimeout = null;
            await this._emitKnownLeader();
        }, this.TEMPO * initialFactor);
    }

    async vote() {
        this._firstMessageISent = true;
        return this._voteFor(this._id, true);
        // Wait a proposition from someone within TEMPO
    }
}

interface ElectionMessage {
    id: number;
    leaderId?: number;
    voteFor?: number;
}