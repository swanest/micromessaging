import {Messaging} from './Messaging';
import {Message} from './Message';
import Timer = NodeJS.Timer;
import {isNullOrUndefined} from 'util';
import {CustomError, Logger} from 'sw-logger';
import {PressureEvent} from './Qos';
import {AMQPLatency} from './AMQPLatency';
import {ReturnHandler} from './Interfaces';

export class Election {

    // public TEMPO: number = Election.DEFAULT_TEMPO;
    static DEFAULT_TIMEOUT: number = 30 * 1000;
    public TIMEOUT: number = Election.DEFAULT_TIMEOUT;
    private _messaging: Messaging;

    // static DEFAULT_TEMPO: number = 2000;
    private _leaderId: string;
    private _lastLeaderSync: Date;
    private _selfElectionTimer: Timer;
    private _leaderByNowTimer: Timer;
    private _logger: Logger;
    private _amqpLatency: AMQPLatency;
    private _listenersBinding: Promise<ReturnHandler>[] = [];
    private _leaderNotification: Timer;
    private _latency: number;

    private _candidates: Array<string> = [];
    private _players: Array<string> = [];
    private _stopped: boolean = false;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._amqpLatency = new AMQPLatency(this._messaging);
        this._logger = logger;

        // this.generateId();
        this._listenersBinding.push(
            this._messaging.listen(this._messaging.internalExchangeName(), 'leader.vote', this._electionListener.bind(this)),
            this._messaging.listen(this._messaging.internalExchangeName(), 'leader.consensus', this._leaderConsensusHandler.bind(this))
        );

        let cancelledLeaderNotification = false,
            cancelledVoteAnswer = false;
        this._messaging.on('pressure', (pEvent: PressureEvent) => {
            if (pEvent.type === 'eventLoop') {
                if (this._leaderByNowTimer) {
                    clearTimeout(this._leaderByNowTimer);
                    this._leaderByNowTimer = null;
                    cancelledLeaderNotification = true;
                }
                if (this._selfElectionTimer) {
                    clearTimeout(this._selfElectionTimer);
                    this._selfElectionTimer = null;
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
                        this.vote().catch(e => this._messaging.reportError(e));
                    }
                    cancelledVoteAnswer = false;
                }
            }
        });
    }

    private _leaderByTimer() {
        if (!isNullOrUndefined(this._leaderByNowTimer)) {
            clearTimeout(this._leaderByNowTimer);
            this._leaderByNowTimer = null;
        }
        const latency = Math.ceil(this._latency);
        if (!isNullOrUndefined(this._leaderByNowTimer)) {
            clearTimeout(this._leaderByNowTimer);
            this._leaderByNowTimer = null;
        }

        this._leaderByNowTimer = setTimeout(() => {
            // There should be a leader by now...
            if (isNullOrUndefined(this._leaderId) && this._messaging.isConnected()) {
                this._logger.log('There was no leader within 100ms, voting again.');
                this.vote().catch(e => this._messaging.reportError(e));
            }
        }, Math.max(latency * 3.5, 2000));
    }

    public shut() {
        this._stopped = true;
        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer);
        }
        if (!isNullOrUndefined(this._leaderByNowTimer)) {
            clearTimeout(this._leaderByNowTimer);
        }
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

    async vote() {
        if (!this._messaging.isConnected()) {
            return;
        }
        await Promise.all(this._listenersBinding) // Wait for the listeners to be in place.
            .catch(e => this._messaging.reportError(e));
        this._latency = await this._amqpLatency.benchmark();
        this._logger.log('init a voting process');
        this._candidates = [];
        this._players = [];
        this._leaderId = null;
        this._lastLeaderSync = null;
        return this._voteFor(this._messaging.serviceId());
    }

    private _leaderConsensusHandler(m: Message<ConsensusMessage>) {
        this._leaderByTimer();
        if (m.body.id === this._messaging.serviceId()) {
            // If I'm receiving the message I just emitted it means I know who the leader is... Skipping the message.
            return;
        }
        if (!isNullOrUndefined(this._leaderId) && this._leaderId !== m.body.leaderId) {
            // throw new CustomError('leaderAlreadyDefined', `${this._messaging.serviceId()} expected leader to be ${this._leaderId} but received ${(m.body as any).leaderId}`);
            this._logger.debug('Leader was already defined but someone pretends its someone else, lets vote again.');
            this._leaderId = null;
            this._lastLeaderSync = null;
            this.vote().catch(e => this._messaging.reportError(e));

            return;
        }
        this._leaderId = m.body.leaderId;
        this._lastLeaderSync = new Date();
        this._candidates = [];
        this._players = [];
        this._notifyLeader();
    }

    private _notifyLeader() {
        if (!isNullOrUndefined(this._leaderNotification)) {
            clearTimeout(this._leaderNotification);
            this._leaderNotification = null;
        }
        const latency = Math.ceil(this._latency);
        this._leaderNotification = setTimeout(() => {
            if (!this._messaging.isConnected() || isNullOrUndefined(this._leaderId)) {
                return;
            }
            this._messaging.ee().emit('leader', {leaderId: this._leaderId});
        }, Math.max(latency * 3.5, 100));
    }

    private _electionListener(message: Message<ElectionMessage>) {
        this._leaderByTimer();
        clearTimeout(this._leaderNotification);
        const howManyPlayers = this._players.length;
        if (this._players.indexOf(message.body.id) === -1) {
            this._players.push(message.body.id);
        }

        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer); // Cancel auto proclamation as leader.
        }

        this._logger.log(`${this._messaging.serviceId()} received a vote message`, message.body, this._leaderId, this._lastLeaderSync, this.TIMEOUT, this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime());
        // Something arrives but vote is already done & lastLeaderSeen < 2/3 TIMEOUT, publish that the elected instance is the previously elected one
        if (message.body.id !== this._messaging.serviceId() && !isNullOrUndefined(this._leaderId) && this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime() < 2 / 3 * this.TIMEOUT) {
            this._logger.debug('%i Someone trying to make a new vote but we saw the leader %ims ago, announce the leader!', this._messaging.serviceId(), new Date().getTime() - this._lastLeaderSync.getTime());
            this._emitKnownLeader().catch(e => this._messaging.reportError(e));
            // And vote for the known leader so that the service trying to vote get's he is wrong.
            // this._voteFor(this._leaderId).catch(e => this._messaging.reportError(e));
            return;
        }
        // if (!isNullOrUndefined(this._leaderId) && this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime() >= 2 / 3 * this.TIMEOUT) {
        //     // We haven't seen
        //     pull(this._candidates, this._leaderId);
        //     pull(this._players, this._leaderId);
        // }

        const leaderOpinion = this._leaderOpinion(message.body.voteFor);
        if (leaderOpinion === this._messaging.serviceId()) {
            this._waitAndMakeMeLeader();
        } else if (howManyPlayers !== this._players.length) { // Only vote if there are more voters.
            this._voteFor(leaderOpinion).catch(e => this._messaging.reportError(e));
        }
    }

    private async _emitKnownLeader() {
        await this._messaging.emit(this._messaging.internalExchangeName(), 'leader.consensus', {
            id: this._messaging.serviceId(),
            leaderId: this._leaderId
        });
    }

    private _leaderOpinion(id?: string): string {
        if (!isNullOrUndefined(id) && this._candidates.indexOf(id) < 0) {
            this._candidates.push(id);
        }
        this._candidates.sort();
        this._logger.debug('Leader opinion %d', this._candidates[this._candidates.length - 1], this._candidates, this._players);
        return this._candidates[this._candidates.length - 1];
    }

    private async _voteFor(id: string) {

        this._logger.log(`${this._messaging.serviceId()} proposing to vote for ${id}`, this._players, this._candidates);

        if (!isNullOrUndefined(this._leaderByNowTimer)) {
            clearTimeout(this._leaderByNowTimer);
            this._leaderByNowTimer = null;
        }

        await this._messaging.emit(this._messaging.internalExchangeName(), 'leader.vote', {
            id: this._messaging.serviceId(),
            voteFor: id
        });
    }

    private _waitAndMakeMeLeader() {
        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer);
        }
        const latency = Math.ceil(this._latency);
        this._logger.log(`_waitAndMakeMeLeader in ${Math.max(latency * 3.5, 100)}ms.`);

        this._selfElectionTimer = setTimeout(() => {
            // If someone would have voted against this service, either the timer would have been cancelled
            // Or because of the benchmarkLatency the timer would not have been so we need to check one last time it follows what be believed
            // If still true then we notify everyone that this service will be the leader.
            if (this._leaderOpinion() !== this._messaging.serviceId() || !this._messaging.isConnected()) {
                return;
            }
            this._leaderId = this._messaging.serviceId();
            this._logger.debug('I become leader (' + this._messaging.serviceId() + ') notifying others');
            this._lastLeaderSync = new Date();
            this._selfElectionTimer = null;
            this._notifyLeader();
            this._emitKnownLeader().catch(e => this._messaging.reportError(e));
        }, Math.max(latency * 3.5, 100));
    }
}

interface ElectionMessage {
    id: string;
    voteFor: string;
}

interface ConsensusMessage {
    id: string;
    leaderId: string;
}