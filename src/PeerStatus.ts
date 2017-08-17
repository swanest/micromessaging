import {Messaging} from './Messaging';
import {Message} from './Message';
import {CustomError, Logger} from 'sw-logger';
import {Election} from './Election';
import Timer = NodeJS.Timer;

export class PeerStatus {

    private _messaging: Messaging;
    private _peers: Map<string, Stat>;
    private _isActive: boolean = false;
    private _logger: Logger;
    private _timer: Timer;

    constructor(messaging: Messaging, logger: Logger) {
        this._messaging = messaging;
        this._logger = logger.disable();
        this._peers = new Map();
    }

    public startBroadcast() {
        if (this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.election().id()} start peer alive`);
        this._isActive = true;
        this._messaging.listen(this._messaging.internalExchangeName(), 'peer.alive', this._peerStatusHandler.bind(this));
        this._keepAlive();
    }

    public stopBroadcast() {
        this._isActive = false;
        clearTimeout(this._timer);
    }

    private _peerStatusHandler(message: Message<Stat>) {
        if (!this._isActive) {
            return;
        }
        this._logger.log(`${this._messaging.election().id()} received a peer alive message`, message.body);
        if (message.body.electionId === this._messaging.election().leaderId()) {
            this._logger.log(`Leader seen ${message.body.electionId} at ${new Date().toISOString()}`);
            this._messaging.election().leaderSeen(new Date());
        }
        this._peers.set(message.body.id, {
            id: message.body.id,
            electionId: message.body.electionId,
            lastSeen: new Date()
        });
        this._peers.forEach((stat: Stat, peerId: string) => {
            this._removeDeadPeerAndElect(peerId, stat);
        });
    }

    private _removeDeadPeerAndElect(peerId: string, stat: Stat) {
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
        await this._messaging.emit(this._messaging.internalExchangeName(), 'peer.alive', {
            id: this._messaging.serviceId(),
            electionId: this._messaging.election().id()
        }, undefined, {onlyIfConnected: true});
        this._logger.log(`Publish I'm still alive`);
        this._timer = setTimeout(() => {
            this._keepAlive();
        }, ~~(this._messaging.election().TIMEOUT / 10))
    }
}

interface Stat {
    id: string,
    electionId: number,
    lastSeen?: Date
}