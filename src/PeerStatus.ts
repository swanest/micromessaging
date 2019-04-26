import { pull } from 'lodash';
import { CustomError, Logger } from 'sw-logger';
import { AMQPLatency } from './AMQPLatency';
import { Election } from './Election';
import { MessageHandler, ReturnHandler, Uptime } from './Interfaces';
import { Message } from './Message';
import { Messaging } from './Messaging';
import MemoryUsage = NodeJS.MemoryUsage;
import Timer = NodeJS.Timer;
import { Utils } from './Utils';

export class PeerStatus {
    static HEARTBEAT: number = 10 * 1000;
    public topologyReady: boolean = false;
    private _amqpLatency: AMQPLatency;
    private _election: Election;
    private _foreignBindings: Map<string, ReturnHandler> = new Map<string, ReturnHandler>();
    private _foreignListeners: Map<string, MessageHandler[]> = new Map<string, MessageHandler[]>();
    private _foreignOngoingAsync: Promise<any>;
    private _isActive: boolean = false;
    private _latency: number;
    private _listenersBinding: Promise<ReturnHandler | void>[] = [];
    private _logger: Logger;
    private _messaging: Messaging;
    private _ongoingPublish: boolean = false;
    private _ongoingLeaderDiscovery: boolean = false;
    private _peers: Map<string, PeerStat>;
    private _proxies: Array<(message: Message<PeerStat>) => void> = [];
    private _startedAt: [number, number]; // hrtime()
    private _timer: Timer;
    private _topologyTimer: Timer;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._amqpLatency = messaging.amqpLatency;
        this._election = messaging.election;
        this._logger = logger;
        this._peers = new Map();
        this._listenersBinding.push(
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'peer.alive', (m: Message<PeerStat>) => {
                this._peerStatusHandler(m);
            }).catch(e => this._messaging.reportError(e)),
            this._messaging.listen(this._messaging.getInternalExchangeName(), 'peer.alive.req', (m) => {
                this._logger.debug('Received peer.alive.req', m.originalMessage());
                this._publishAlive();
            }).catch(e => this._messaging.reportError(e)),
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
                this._logger.debug('peers.size', peers.size, message.body.knownPeers);
                if (peers.size > 1 && peers.size === message.body.knownPeers) {
                    cancelTimer = true;
                    if (localTimer != null) {
                        clearTimeout(localTimer);
                    }
                    this.stopListenOrProxy(targetService, messageHandler).catch(e => this._messaging.reportError(e));
                    resolve(Array.from(peers.values()));
                }
            };

            if (targetService !== this._messaging.getServiceName()) {
                await this.listenOrProxy(targetService, 'peer.alive', messageHandler);
            } else {
                this._proxies.push(messageHandler);
            }

            await this._messaging.emit(`${Messaging.internalExchangePrefix}.${targetService}`, 'peer.alive.req', undefined, undefined, {onlyIfConnected: true});

            this._amqpLatency.benchmark(true).then((latency) => {
                latency = Math.round(latency) * 6;
                if (cancelTimer) {
                    return;
                }
                localTimer = setTimeout(() => {
                    if (cancelTimer) {
                        return;
                    }
                    // This avoid having getStatus hanging forever...
                    this.stopListenOrProxy(targetService, messageHandler).catch(e => this._messaging.reportError(e));
                    peers.size > 0 ?
                        resolve(Array.from(peers.values())) :
                        reject(new CustomError('notFound', `No peers found for service ${targetService} within benchmarkLatency (hence at least ${latency}ms)`));
                }, Math.max(latency, 1000));
            });
        });
    }

    /**
     * Starts the process of knowing about peers and the system
     * topology.
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

    private async _keepAlive() {
        if (PeerStatus.HEARTBEAT < 10) {
            this._logger.warn('electionTimeoutTooSmall', 'Election timeout should be at least 10ms');
        }
        if (this._timer != null) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        // Mechanism to launch an election/leader discovery
        if ((this._election.leaderSeen() == null ||
             this._election.leaderSeen().valueOf() < (Date.now() - Election.TIMEOUT)) &&
            !this._ongoingLeaderDiscovery) {
            try {
                this._ongoingLeaderDiscovery = true;
                await this._election.start();
                this._ongoingLeaderDiscovery = false;
            } catch (e) {
                this._logger.warn('leaderDiscovery', 'PeerStatus leader discovery exception');
            } finally {
                this._ongoingLeaderDiscovery = false;
            }
        }

        this._publishAlive().catch(e => this._messaging.reportError(e));
        // Keep alive recurrent job
        this._timer = setTimeout(() => {
            this._keepAlive().catch(e => this._messaging.reportError(e));
        }, Math.max(PeerStatus.HEARTBEAT, 10));
    }

    private _peerStatusHandler(message: Message<PeerStat>) {
        this._proxies.forEach(fn => fn(message));
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.getServiceId()} received a peer alive message`, message.body);
        if (message.body.isMaster) {
            this._logger.log(`Leader seen ${message.body.id} at ${new Date().toISOString()}`);
            this._election.leaderSeen(new Date());
            const prevLeader = this._election.leaderId;
            this._election.leaderId = message.body.id;

            if (this._election.leaderChange(prevLeader)) {
                this._election.notifyLeader();
            }

            this._election.leaderId = message.body.id;
        }
        // Add a timestamp for this received PeerStat message
        message.body.lastSeen = new Date();
        this._peers.set(message.body.id, message.body);
        // Cleanup: check for dead peers
        this._peers.forEach((stat: PeerStat, peerId: string) => {
            this._removeDeadPeer(stat, peerId);
        });
        this._topologyNotify();
    }

    private _topologyNotify(timedOut: boolean = false) {
        if (this._topologyTimer != null) {
            clearTimeout(this._topologyTimer);
            this._topologyTimer = null;
        }
        if (!this.topologyReady && this._latency != null) {
            const timeSinceStart = Utils.hrtimeToMS(process.hrtime(this._startedAt));
            if (timedOut && timeSinceStart - (this._latency) * 2 > 300) { // 300ms to know the topology & there shouldn't be new peers.
                this.topologyReady = true;
                this._logger.debug(`Topology is now known within ${timeSinceStart}ms as the following`, this._peers);
                if (this._election != null) {
                    this._election.start().catch(e => this._messaging.reportError(e));
                }
                return;
            }
            this._topologyTimer = setTimeout(() => {
                this._topologyNotify(true);
            }, (this._latency) * 3);
        }
    }

    /**
     * Emits a PeerStat message if there is no ongoing publish already
     */
    private async _publishAlive() {
        if (this._ongoingPublish) {
            return;
        }
        this._ongoingPublish = true;
        await this._messaging.emit<PeerStat>(this._messaging.getInternalExchangeName(), 'peer.alive', {
            id: this._messaging.getServiceId(),
            name: this._messaging.getServiceName(),
            isReady: this._messaging.isReady(),
            isMaster: this._messaging.getServiceId() === this._election.leaderId,
            elapsedMs: this._messaging.getUptime().elapsedMs,
            startedAt: this._messaging.getUptime().startedAt,
            leaderId: this._election.leaderId,
            memoryUsage: process.memoryUsage(),
            knownPeers: this._peers.size + (this._peers.size === 0 ? 1 : 0),
        }, undefined, {onlyIfConnected: true});
        this._ongoingPublish = false;
        this._logger.log(`Published I'm still alive`);
    }

    /**
     * Cleans up the peers information if the peer has not sent any
     * info for 4 heartbeats
     *
     * @param stat PeerStat info sent by peer
     * @param peerId Its service ID
     */
    private _removeDeadPeer(stat: PeerStat, peerId: string) {
        const diff = new Date().getTime() - stat.lastSeen.getTime();
        if (diff < PeerStatus.HEARTBEAT * 4) {
            return;
        }
        this._peers.delete(peerId);
        this._logger.log(`Deleting peer ${peerId} because not seen since ${diff}ms (isLeader? ${stat.id} === ${this._election.leaderId})`);
    }

    private async listenOrProxy(targetService: string, route: string, handler: MessageHandler) {
        if (this._foreignListeners.has(targetService)) {
            this._foreignListeners.get(targetService).push(handler);
            return;
        }

        if (this._foreignOngoingAsync) {
            await this._foreignOngoingAsync;
        }

        this._foreignListeners.set(targetService, [handler]);
        const thisListener = this._foreignListeners.get(targetService);
        this._foreignBindings.set(targetService,
                                  await (this._foreignOngoingAsync = this._messaging.listen(
                                      `${Messaging.internalExchangePrefix}.${targetService}`,
                                      route,
                                      (m: Message) => thisListener.forEach(cb => cb(m)))
                                        ),
                                 );
        this._foreignOngoingAsync = undefined;
    }

    private async stopListenOrProxy(targetService: string, handler: MessageHandler) {
        // debounce
        await new Promise(resolve => setImmediate(async () => {
            // avoids that sync exploration of arrays stops
            if (targetService === this._messaging.getServiceName()) {
                pull(this._proxies, handler);
                resolve();
                return;
            }

            if (this._foreignOngoingAsync) {
                await this._foreignOngoingAsync;
            }

            const listeners = this._foreignListeners.get(targetService);
            if (listeners == null) {
                return;
            }
            pull(listeners, handler);
            if (listeners.length === 0) {
                this._foreignListeners.delete(targetService);
                await (this._foreignOngoingAsync = this._foreignBindings.get(targetService).stop());
                this._foreignOngoingAsync = undefined;
            }
            resolve();
        }));
    }
}

export interface PeerStat extends Uptime {
    id: string;
    isMaster: boolean;
    isReady: boolean;
    knownPeers: number;
    lastSeen?: Date;
    leaderId: string;
    memoryUsage: MemoryUsage;
    name: string;
}
