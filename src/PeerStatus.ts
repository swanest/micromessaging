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

export class PeerStatus {

    private _messaging: Messaging;
    private _election: Election;
    private _peers: Map<string, PeerStat>;
    private _isActive: boolean = false;
    private _logger: Logger;
    private _timer: Timer;
    private _proxies: Array<(message: Message<PeerStat>) => void> = [];
    private _listenersBinding: Promise<ReturnHandler | void>[] = [];
    private _amqpLatency: AMQPLatency;

    constructor(messaging: Messaging, election: Election, logger: Logger) {
        this._messaging = messaging;
        this._amqpLatency = new AMQPLatency(this._messaging);
        this._election = election;
        this._logger = logger;
        this._peers = new Map();
        this._listenersBinding.push(
            this._messaging.listen(this._messaging.internalExchangeName(), 'peer.alive', (m: Message<PeerStat>) => {
                this._peerStatusHandler(m);
            }).catch(e => this._messaging.reportError(e)),
            this._messaging.listen(this._messaging.internalExchangeName(), 'peer.alive.req', () => {
                this._request();
            }).catch(e => this._messaging.reportError(e))
        );
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

            this._amqpLatency.benchmark().then((latency) => {
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

            if (targetService !== this._messaging.serviceName()) {
                await this._messaging.listen(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive', messageHandler);
            } else {
                this._proxies.push(messageHandler);
            }
            await this._messaging.emit(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive.req');
        });
    }

    public startBroadcast() {
        if (this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.serviceId()} start peer alive`);
        this._isActive = true;

        Promise.all(this._listenersBinding).then(() => this._keepAlive());
    }

    public stopBroadcast() {
        this._isActive = false;
        clearTimeout(this._timer);
    }

    private _request() {
        // Someone is asking for who is still there!
        this._keepAlive().catch(e => this._messaging.reportError(e));
    }

    private _peerStatusHandler(message: Message<PeerStat>) {
        this._proxies.forEach(fn => fn(message));
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.serviceId()} received a peer alive message`, message.body);
        if (message.body.id === this._election.leaderId()) {
            this._logger.log(`Leader seen ${message.body.id} at ${new Date().toISOString()}`);
            this._election.leaderSeen(new Date());
        }
        message.body.lastSeen = new Date();
        this._peers.set(message.body.id, message.body);
        this._peers.forEach((stat: PeerStat, peerId: string) => {
            this._removeDeadPeerAndElect(stat, peerId);
        });
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
            this._election.vote().catch(e => this._messaging.reportError(e));
        }
    }

    private async _keepAlive() {
        if (this._election.TIMEOUT / 10 < 10) {
            this._logger.warn('electionTimeoutTooSmall', 'Election timeout should be at least 10s');
        }
        if (!isNullOrUndefined(this._timer)) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        await this._messaging.emit<PeerStat>(this._messaging.internalExchangeName(), 'peer.alive', {
            id: this._messaging.serviceId(),
            name: this._messaging.serviceName(),
            leaderId: this._election.leaderId() || null,
            isReady: this._messaging.isReady(),
            isMaster: this._messaging.serviceId() === this._election.leaderId(),
            elapsedMs: this._messaging.uptime().elapsedMs,
            startedAt: this._messaging.uptime().startedAt,
            memoryUsage: process.memoryUsage(),
            knownPeers: this._peers.size + (this._peers.size === 0 ? 1 : 0)
        }, undefined, {onlyIfConnected: true});
        this._logger.log(`Publish I'm still alive`);
        this._timer = setTimeout(() => {
            this._keepAlive().catch(e => this._messaging.reportError(e));
        }, Math.max(~~(this._election.TIMEOUT / 10), 10))
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