import {Messaging} from './Messaging';
import {Message} from './Message';
import {CustomError, Logger} from 'sw-logger';
import Timer = NodeJS.Timer;
import {ReturnHandler, Uptime} from "./Interfaces";
import MemoryUsage = NodeJS.MemoryUsage;
import {isNullOrUndefined} from 'util';
import {pull} from 'lodash';
import {Election} from './Election';
import {AMQPLatency} from './AMQPLatency';
import {PressureEvent} from './Qos';
import {Status} from './HeavyEL';
import {Utils} from './Utils';

export class PeerStatus {

    public topologyReady: boolean = false;
    private _messaging: Messaging;
    private _election: Election;
    private _peers: Map<string, PeerStat>;
    private _isActive: boolean = false;
    private _logger: Logger;
    private _timer: Timer;
    private _proxies: Array<(message: Message<PeerStat>) => void> = [];
    private _listenersBinding: Promise<ReturnHandler | void>[] = [];
    private _amqpLatency: AMQPLatency;
    private _topologyTimer: Timer;
    private _ongoingPublish: boolean = false;
    private _latency: number;
    private _startedAt: [number, number]; // hrtime()

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._amqpLatency = new AMQPLatency(this._messaging);
        this._logger = logger;
        this._peers = new Map();
        this._listenersBinding.push(
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'peer.alive', (m: Message<PeerStat>) => {
                this._peerStatusHandler(m);
            }).catch(e => this._messaging.reportError(e)),
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'peer.alive.req', () => {
                this._request();
            }).catch(e => this._messaging.reportError(e))
        );
        this._messaging.on('pressure', (ev: PressureEvent) => {
            if (ev.type === 'eventLoop') {
                const cont = ev.contents as Status;
                cont.eventLoopDelayedByMS
            }
        });
    }

    public setElection(election: Election) {
        this._election = election;
    }

    public async getStatus(targetService: string): Promise<PeerStat[]> {
        return new Promise<PeerStat[]>(async (resolve, reject) => {
            const peers: Map<string, PeerStat> = new Map();
            let cancelTimer = false,
                localTimer: Timer;

            const messageHandler = (message: Message<PeerStat>) => {
                message.body.lastSeen = new Date();
                this._logger.debug('getStatus request got an answer', message.body);
                peers.set(message.body.id, message.body);
                if (peers.size > 1 && peers.size === message.body.knownPeers) {
                    cancelTimer = true;
                    if (!isNullOrUndefined(localTimer)) {
                        clearTimeout(localTimer);
                    }
                    pull(this._proxies, messageHandler);
                    resolve(Array.from(peers.values()));
                }
            };

            this._amqpLatency.benchmark(true).then((latency) => {
                if (cancelTimer) {
                    return;
                }
                localTimer = setTimeout(() => {
                    if (cancelTimer) {
                        return;
                    }
                    // This avoid having getStatus hanging forever...
                    pull(this._proxies, messageHandler);
                    peers.size > 0 ?
                        resolve(Array.from(peers.values())) :
                        reject(new CustomError('notFound', `No peers found for service ${targetService} within benchmarkLatency (hence at least ${latency}ms)`));
                }, Math.max(Math.ceil(latency * 2.5), 1000));
            });

            if (targetService !== this._messaging.getServiceName()) {
                await this._messaging.listen(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive', messageHandler);
            } else {
                this._proxies.push(messageHandler);
            }
            await this._messaging.emit(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive.req', undefined, undefined, {onlyIfConnected: true});
        });
    }

    /**
     * Starts the process of knowing about peers and the system topology.
     */
    public start() {
        if (this._isActive) {
            return;
        }
        this._startedAt = process.hrtime();
        this._logger.log(`${this._messaging.getServiceId()} start peer alive`);
        this._isActive = true;
        this._amqpLatency.benchmark(true)
            .then(l => {
                this._latency = l * 2;
                this._logger.debug('latency known as: ' + this._latency);
                if (!this.topologyReady) {
                    this._topologyNotify();
                }
            })
            .catch(e => this._messaging.reportError(e));

        Promise.all(this._listenersBinding).then(() => this._keepAlive());
    }

    /**
     * Stops the timers
     */
    public stop() {
        this._isActive = false;
        clearTimeout(this._timer);
        clearTimeout(this._topologyTimer);
    }

    /**
     * Get the actual peers list
     */
    public getPeers() {
        return this._peers;
    }

    private _request() {
        // Someone is asking for who is still there!
        this._logger.debug('Received a topology request, emitting presence');
        this._keepAlive().catch(e => this._messaging.reportError(e));
    }

    private _peerStatusHandler(message: Message<PeerStat>) {
        this._proxies.forEach(fn => fn(message));
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.getServiceId()} received a peer alive message`, message.body);
        if (message.body.id === this._election.leaderId()) {
            this._logger.log(`Leader seen ${message.body.id} at ${new Date().toISOString()}`);
            this._election.leaderSeen(new Date());
        }
        message.body.lastSeen = new Date();
        const peerSize = this._peers.size;
        this._peers.set(message.body.id, message.body);
        this._peers.forEach((stat: PeerStat, peerId: string) => {
            this._removeDeadPeerAndElect(stat, peerId);
        });
        if (this._peers.size > peerSize) {
            this._keepAlive().catch(e => this._messaging.reportError(e));
        }
        this._topologyNotify();
    }

    private _topologyNotify(timedOut: boolean = false) {
        if (!isNullOrUndefined(this._topologyTimer)) {
            clearTimeout(this._topologyTimer);
            this._topologyTimer = null;
        }
        if (!this.topologyReady && !isNullOrUndefined(this._latency)) {
            const timeSinceStart = Utils.hrtimeToMS(process.hrtime(this._startedAt));
            if (timedOut && timeSinceStart - (this._latency) * 2 > 300) { // 300ms to know the topology & there shouldn't be new peers.
                this.topologyReady = true;
                this._logger.debug(`Topology is now known within ${timeSinceStart}ms as the following`, this._peers);
                if (!isNullOrUndefined(this._election)) {
                    this._election.start().catch(e => this._messaging.reportError(e));
                }
                return;
            }
            this._topologyTimer = setTimeout(() => {
                this._topologyNotify(true);
            }, (this._latency) * 3);
        }
    }

    private _removeDeadPeerAndElect(stat: PeerStat, peerId: string) {
        const diff = new Date().getTime() - stat.lastSeen.getTime();
        if (diff < this._election.TIMEOUT) {
            return;
        }
        this._peers.delete(peerId);
        this._logger.log(`Deleting peer ${peerId} because not seen since ${diff}ms (isLeader? ${stat.id} === ${this._election.leaderId()})`);
        if (stat.id === this._election.leaderId()) {
            // Haven't seen leader for TIMEOUT so we proceed to a new election
            this._logger.log(`Leader not seen since ${diff}ms, vote again!`);
            this._election.start().catch(e => this._messaging.reportError(e));
        }
    }

    private async _publishAlive() {
        if (this._ongoingPublish) {
            return;
        }
        this._ongoingPublish = true;
        await this._messaging.emit<PeerStat>(this._messaging.getInternalExchangeName(), 'peer.alive', {
            id: this._messaging.getServiceId(),
            name: this._messaging.getServiceName(),
            leaderId: this._election.leaderId() || null,
            isReady: this._messaging.isReady(),
            isMaster: this._messaging.getServiceId() === this._election.leaderId(),
            elapsedMs: this._messaging.getUptime().elapsedMs,
            startedAt: this._messaging.getUptime().startedAt,
            memoryUsage: process.memoryUsage(),
            knownPeers: this._peers.size + (this._peers.size === 0 ? 1 : 0)
        }, undefined, {onlyIfConnected: true});
        this._ongoingPublish = false;
        this._logger.log(`Published I'm still alive`);
    }

    private async _keepAlive() {
        if (this._election.TIMEOUT / 3 < 10) {
            this._logger.warn('electionTimeoutTooSmall', 'Election timeout should be at least 10s');
        }
        if (!isNullOrUndefined(this._timer)) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._publishAlive().catch(e => this._messaging.reportError(e));
        this._timer = setTimeout(() => {
            this._keepAlive().catch(e => this._messaging.reportError(e));
        }, Math.max(~~(this._election.TIMEOUT / 3), 10))
    }
}

export interface PeerStat extends Uptime {
    id: string;
    name: string;
    leaderId: string; // Commonly agreed master
    lastSeen?: Date;
    isReady: boolean;
    isMaster: boolean;
    memoryUsage: MemoryUsage;
    knownPeers: number;
}
