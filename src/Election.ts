import { Messaging } from './Messaging';
import { Message } from './Message';
import Timer = NodeJS.Timer;
import { isNullOrUndefined } from 'util';
import { Logger } from 'sw-logger';
import { PressureEvent } from './Qos';
import { AMQPLatency } from './AMQPLatency';
import { ReturnHandler } from './Interfaces';
import { PeerStatus } from './PeerStatus';
import { EventLoopStatus } from './HeavyEventLoop';

export class Election {

    // public TEMPO: number = Election.DEFAULT_TEMPO;
    static DEFAULT_TIMEOUT: number = 30 * 1000;
    public TIMEOUT: number = Election.DEFAULT_TIMEOUT;
    private _messaging: Messaging;

    // static DEFAULT_TEMPO: number = 2000;
    private _leaderId: string;
    private _lastLeaderSync: Date;
    private _selfElectionTimer: Timer;
    private _logger: Logger;
    private _amqpLatency: AMQPLatency;
    private _peers: PeerStatus;
    private _listenersBinding: Promise<ReturnHandler>[] = [];
    private _latency: number;

    private _candidates: Array<string> = [];
    private _playersVote: Map<string, string> = new Map<string, string>();
    private _stopped: boolean = false;

    constructor(messaging: Messaging, peerStatus: PeerStatus, logger: Logger) {
        this._messaging = messaging;
        this._peers = peerStatus;
        this._amqpLatency = new AMQPLatency(this._messaging);
        this._logger = logger.disable();

        this._listenersBinding.push(
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'leader.vote', this._electionListener.bind(this)),
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'leader.consensus', this._leaderConsensusHandler.bind(this))
        );

        if (this._peers.topologyReady) {
            this.start().catch(e => this._messaging.reportError(e));
        }

        let cancelledSelfElection = false,
            isUnderPressure = false;
        this._messaging.on('pressure', (pEvent: PressureEvent) => {
            if (pEvent.type === 'eventLoop') {
                isUnderPressure = true;
                this._latency += (pEvent.contents as EventLoopStatus).eventLoopDelayedByMS;
                if (this._selfElectionTimer) {
                    clearTimeout(this._selfElectionTimer);
                    this._selfElectionTimer = null;
                    cancelledSelfElection = true;
                }
            }
        });
        this._messaging.on('pressureReleased', (pEvent: PressureEvent) => {
            if (pEvent.type === 'eventLoop') {
                isUnderPressure = false;
                this._amqpLatency.benchmark(true).then(l => {
                    if (!isUnderPressure) {
                        this._latency = l;
                    }
                }).catch(e => this._messaging.reportError(e));
                if (cancelledSelfElection) {
                    if (this._leaderOpinion() === this._messaging.getServiceId()) {
                        this._waitAndMakeMeLeader();
                    }
                    cancelledSelfElection = false;
                }
            }
        });
    }

    public stop() {
        this._stopped = true;
        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer);
            this._selfElectionTimer = null;
        }
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
        await Promise.all(this._listenersBinding) // Wait for the listeners to be in place.
            .catch(e => this._messaging.reportError(e));
        this._latency = await this._amqpLatency.benchmark(true);
        this._logger.log('init a voting process');
        this._candidates = [];

        this._leaderId = null;
        this._lastLeaderSync = null;
        return this._voteFor(this._messaging.getServiceId());
    }

    private _leaderConsensusHandler(m: Message<ConsensusMessage>) {
        if (m.body.id === this._messaging.getServiceId()) {
            // If I'm receiving the message I just emitted it means I know who the leader is... Skipping the message.
            return;
        }
        if (!isNullOrUndefined(this._leaderId) && this._leaderId !== m.body.leaderId) {
            // throw new CustomError('leaderAlreadyDefined', `${this._messaging.getServiceId()} expected leader to be ${this._leaderId} but received ${(m.body as any).leaderId}`);
            this._logger.debug('Leader was already defined but someone pretends its someone else, lets vote again.');
            this._leaderId = null;
            this._lastLeaderSync = null;
            this.start().catch(e => this._messaging.reportError(e));

            return;
        }
        this._logger.debug('Received consensus for', m, this._leaderId);
        clearTimeout(this._selfElectionTimer);
        this._selfElectionTimer = null;
        const newLeader = m.body.leaderId !== this._leaderId;
        this._leaderId = m.body.leaderId;
        this._lastLeaderSync = new Date();
        this._candidates = [];
        if (newLeader) {
            this._notifyLeader();
        }
    }

    private _notifyLeader() {
        if (!this._messaging.isConnected() || isNullOrUndefined(this._leaderId)) {
            return;
        }
        this._messaging.getEventEmitter().emit('leader', {leaderId: this._leaderId});
    }

    private _electionListener(message: Message<ElectionMessage>) {
        // this._leaderByTimer();
        // clearTimeout(this._leaderNotification);

        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer); // Cancel auto proclamation as leader.
            this._selfElectionTimer = null;
        }

        this._logger.log(`${this._messaging.getServiceId()} received a vote message`, message.body, this._leaderId, this._lastLeaderSync, this.TIMEOUT, this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime());
        // Something arrives but vote is already done & lastLeaderSeen < 2/3 TIMEOUT, publish that the elected instance is the previously elected one
        if (message.body.id !== this._messaging.getServiceId() && !isNullOrUndefined(this._leaderId) && this._lastLeaderSync && new Date().getTime() - this._lastLeaderSync.getTime() < 2 / 3 * this.TIMEOUT) {
            this._logger.debug('%i Someone trying to make a new vote but we saw the leader %ims ago, announce the leader!', this._messaging.getServiceId(), new Date().getTime() - this._lastLeaderSync.getTime());
            this._emitKnownLeader().catch(e => this._messaging.reportError(e));
            return;
        }

        const leaderOpinion = this._leaderOpinion(message.body.voteFor);
        this._playersVote.set(message.body.id, message.body.voteFor);

        const foundUnanimity = this._unanimity();
        this._logger.log('Unanimity', foundUnanimity);
        if (foundUnanimity && leaderOpinion === this._messaging.getServiceId()) {
            this._waitAndMakeMeLeader();
        } else if (!foundUnanimity) { // Only vote if not everyone agrees
            this._voteFor(leaderOpinion).catch(e => this._messaging.reportError(e));
        }
    }

    private _unanimity(): boolean {
        if (isNullOrUndefined(this._peers.getPeers())) {
            return false;
        }
        const peers = this._peers.getPeers();
        // Delete players that don't exist as peers
        Array.from(this._playersVote.keys()).forEach(v => {
            if (!peers.has(v)) {
                this._playersVote.delete(v);
            }
        });
        // Add peers that were not in our local players list
        peers.forEach((value, key) => {
            if (!this._playersVote.has(key)) {
                this._playersVote.set(key, '-1');
            }
        });

        // determine if everyone agrees on the leader.
        let ret = true,
            opinion: string;
        this._playersVote.forEach(v => {
            if (isNullOrUndefined(opinion)) {
                opinion = v;
            }
            if (v === '-1' || v !== opinion) {
                ret = false;
            }
        });
        return ret;
    }

    private async _emitKnownLeader() {
        await this._messaging.emit(this._messaging.getInternalExchangeName(), 'leader.consensus', {
            id: this._messaging.getServiceId(),
            leaderId: this._leaderId
        }, undefined, {onlyIfConnected: true});
    }

    private _leaderOpinion(id?: string): string {
        if (!isNullOrUndefined(id) && this._candidates.indexOf(id) < 0) {
            this._candidates.push(id);
        }
        this._candidates.sort();
        this._logger.debug('Leader opinion %d', this._candidates[this._candidates.length - 1], this._candidates, this._playersVote);
        return this._candidates[this._candidates.length - 1];
    }

    private async _voteFor(id: string) {
        if (!this._messaging.isConnected()) {
            return;
        }

        this._logger.log(`${this._messaging.getServiceId()} proposing to vote for ${id}`, this._candidates, this._playersVote);

        await this._messaging.emit(this._messaging.getInternalExchangeName(), 'leader.vote', {
            id: this._messaging.getServiceId(),
            voteFor: id
        }, undefined, {onlyIfConnected: true});
    }

    private _waitAndMakeMeLeader() {
        if (isNullOrUndefined(this._peers.getPeers())) {
            return;
        }
        if (!isNullOrUndefined(this._selfElectionTimer)) {
            clearTimeout(this._selfElectionTimer);
            this._selfElectionTimer = null;
        }
        const latency = Math.ceil(this._latency);
        this._logger.log(`_waitAndMakeMeLeader in ${Math.max(latency * 3.5, 100)}ms.`);

        this._selfElectionTimer = setTimeout(() => {
            // If someone would have voted against this service, either the timer would have been cancelled
            // Or because of the benchmarkLatency the timer would not have been so we need to check one last time it follows what be believed
            // If still true then we notify everyone that this service will be the leader.
            if (this._leaderOpinion() !== this._messaging.getServiceId() || !this._messaging.isConnected()) {
                return;
            }
            this._leaderId = this._messaging.getServiceId();
            this._logger.debug('I become leader (' + this._messaging.getServiceId() + ') notifying others');
            this._lastLeaderSync = new Date();
            this._selfElectionTimer = null;
            this._notifyLeader();
            this._emitKnownLeader().catch(e => this._messaging.reportError(e));
        }, Math.max(latency * 6, 100));
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
