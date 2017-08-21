import {Messaging} from './Messaging';
import {Message} from './Message';
import {CustomError, Logger} from 'sw-logger';
import Timer = NodeJS.Timer;
import {Uptime} from "./Interfaces";
import MemoryUsage = NodeJS.MemoryUsage;
import {isNullOrUndefined} from 'util';
import {pull} from 'lodash';

export class PeerStatus {

    private _messaging: Messaging;
    private _peers: Map<string, PeerStat>;
    private _isActive: boolean = false;
    private _logger: Logger;
    private _timer: Timer;
    private _proxies: Array<(message: Message<PeerStat>) => void> = [];

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._logger = logger;
        this._peers = new Map();
    }

    public async getStatus(targetService: string): Promise<PeerStat[]> {
        return new Promise<PeerStat[]>(async (resolve, reject) => {
            const peers: Map<string, PeerStat> = new Map(),
                maxDuration = this._messaging.election().TEMPO * 2;

            const messageHandler = (message: Message<PeerStat>) => {
                message.body.lastSeen = new Date();
                this._logger.debug('getStatus request got an answer', message.body);
                peers.set(message.body.id, message.body);
                if (peers.size > 1 && peers.size === message.body.knownPeers) {
                    clearTimeout(timer);
                    pull(this._proxies, messageHandler);
                    resolve(Array.from(peers.values()));
                }
            };

            const timer = setTimeout(() => {
                // This avoid having getStatus hanging forever...
                pull(this._proxies, messageHandler);
                peers.size > 0 ?
                    resolve(Array.from(peers.values())) :
                    reject(new CustomError('notFound', `No peers found for service ${targetService} within ${maxDuration}ms`));
            }, maxDuration);

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
        this._logger.log(`${this._messaging.election().id()} start peer alive`);
        this._isActive = true;
        const al = this._messaging.listen(this._messaging.internalExchangeName(), 'peer.alive', this._peerStatusHandler.bind(this));
        const alR = this._messaging.listen(this._messaging.internalExchangeName(), 'peer.alive.req', this._request.bind(this));
        Promise.all([al, alR]).then(() => this._keepAlive());
    }

    public stopBroadcast() {
        this._isActive = false;
        clearTimeout(this._timer);
    }

    private _request(message: Message) {
        // Someone is asking for who is still there!
        this._keepAlive();
    }

    private _peerStatusHandler(message: Message<PeerStat>) {
        this._proxies.forEach(fn => fn(message));
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.election().id()} received a peer alive message`, message.body);
        if (message.body.electionId === this._messaging.election().leaderId()) {
            this._logger.log(`Leader seen ${message.body.electionId} at ${new Date().toISOString()}`);
            this._messaging.election().leaderSeen(new Date());
        }
        message.body.lastSeen = new Date();
        this._peers.set(message.body.id, message.body);
        this._peers.forEach((stat: PeerStat, peerId: string) => {
            this._removeDeadPeerAndElect(peerId, stat);
        });
    }

    private _removeDeadPeerAndElect(peerId: string, stat: PeerStat) {
        const diff = new Date().getTime() - stat.lastSeen.getTime();
        if (diff < this._messaging.election().TIMEOUT) {
            return;
        }
        if (stat.electionId === this._messaging.election().leaderId()) {
            // Haven't seen leader for TIMEOUT so we proceed to a new election
            this._messaging.election().vote();
        }
    }

    private async _keepAlive() {
        if (this._messaging.election().TIMEOUT / 10 < 1000) {
            this._logger.warn('electionTimeoutTooSmall', 'Election timeout should be at least 10s');
        }
        if (!isNullOrUndefined(this._timer)) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        await this._messaging.emit<PeerStat>(this._messaging.internalExchangeName(), 'peer.alive', {
            id: this._messaging.serviceId(),
            name: this._messaging.serviceName(),
            electionId: this._messaging.election().id(),
            leaderId: this._messaging.election().leaderId() || null,
            isReady: this._messaging.isReady(),
            isMaster: this._messaging.election().id() === this._messaging.election().leaderId(),
            elapsedMs: this._messaging.uptime().elapsedMs,
            startedAt: this._messaging.uptime().startedAt,
            memoryUsage: process.memoryUsage(),
            knownPeers: this._peers.size + (this._peers.size === 0 ? 1 : 0)
        }, undefined, {onlyIfConnected: true});
        this._logger.log(`Publish I'm still alive`);
        this._timer = setTimeout(() => {
            this._keepAlive();
        }, ~~(this._messaging.election().TIMEOUT / 10))
    }
}

export interface PeerStat extends Uptime {
    id: string;
    name: string;
    electionId: number; // Service ID for election
    leaderId: number; // Commonly agreed master
    lastSeen?: Date;
    isReady: boolean;
    isMaster: boolean;
    memoryUsage: MemoryUsage;
    knownPeers: number;
}