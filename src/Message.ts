import { Message as AMessage } from 'amqplib';
import { cloneDeep, defaults, omit, pull } from 'lodash';
import * as stream from 'stream';
import { PassThrough } from 'stream';
import { CustomError } from 'sw-logger';
import { isNullOrUndefined, isUndefined } from 'util';
import { MessageHeaders, Route } from './Interfaces';
import { Messaging } from './Messaging';
import { Utils } from './Utils';
import Timer = NodeJS.Timer;

export class Message<T = {}> {
    public body: T;
    public headers: any;
    private _byteLength: number; // in bytes
    private _expireTimer: Timer = null;
    private _expiresAt: Date;
    private _isAcked: boolean = false;
    private _isAnswered: boolean = false;
    private _isExpired: boolean = false;
    private _isRequest: boolean = false;
    private _isStreaming: boolean = false;
    private _issuedAt: Date;
    private _messaging: Messaging;
    private _originalMessage: AMessage;
    private _route: Route;
    private _sequence: number = 0;

    /**
     * Gets the size of the message in bytes
     */
    public get size(): number {
        return this._byteLength;
    }

    constructor(messaging: Messaging, route: Route, originalMessage: AMessage) {
        this._messaging = messaging;
        this._route = route;
        this._route.ongoingMessages++;
        this.parseMessage(originalMessage);
    }

    public static async toBuffer(ref: any = ''): Promise<ToBuffer> {
        let buf: Buffer,
            compression: string = undefined;
        if (ref instanceof stream.Readable) {
            buf = await Utils.compress(ref);
            compression = 'gzip';
        } else {
            const data = ref instanceof Buffer ? ref : JSON.stringify(ref);
            const type = ref instanceof Buffer ? 'buffer' : 'string';
            if ( // compress only data above 1MB
                (type === 'string' && Buffer.byteLength(data as string, 'utf8') > 1000 ** 2) ||
                data.length > 1000 ** 2
            ) {
                compression = 'gzip';
                const stream = new PassThrough();
                stream.push(data);
                stream.push(null);
                buf = await Utils.compress(stream);
            } else if (type === 'string') {
                buf = Buffer.from(data as string, 'utf8');
            } else if (type === 'buffer') {
                buf = data as Buffer;
            } else {
                throw new CustomError('unsupportedDataType', `Data type unsupported`, {data});
            }
        }
        return {buffer: buf, compression};
    }

    public static toJSON(message: AMessage) {
        return {
            fields: message.fields,
            properties: message.properties,
            content: JSON.parse(message.content.toString()),
        };
    }

    public ack(): void {
        this._assertOpen();
        if (!this._isAcked && this._route.noAck === false) {
            this._route.ongoingMessages--;
            this._route.channel.ack(this._originalMessage);
            this._isAcked = true;
            this.releaseBytes();
        }
    }

    public correlationId() {
        return this._originalMessage.properties.correlationId;
    }

    public destinationRoute() {
        if (!this.isRequest() && !this.isTask()) {
            return this._originalMessage.fields.routingKey;
        }
        return this._originalMessage.properties.headers.__mms.route;
    }

    public async end(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers, {isStream: true, isEnd: true});
    }

    /**
     * Converts the message to an Error
     */
    public error() {
        const e = new CustomError(this.body as any);
        return e;
    }

    public getSequence() {
        return this._originalMessage.properties.headers.__mms.sequence;
    }

    public isAnswer() {
        return this._originalMessage.properties.correlationId && isUndefined(this._originalMessage.properties.replyTo);
    }

    public isChannelClosed() {
        return this._route.isClosed;
    }

    public isError() {
        return this._originalMessage.properties.headers.__mms.isError;
    }

    public isEvent() {
        return this._originalMessage.fields.exchange !== '';
    }

    public isRequest() {
        return this._isRequest;
    }

    public isStream() {
        return this._originalMessage.properties.headers.__mms.isStream === true;
    }

    public isStreamEnd() {
        return this._originalMessage.properties.headers.__mms.isEnd === true;
    }

    /**
     * Return true is the message a task.
     * Tasks do not expect answer, if it is expecting an answer then it's a request.
     * @return {boolean}
     */
    public isTask() {
        return this._originalMessage.properties.headers.__mms.isTask === true;
    }

    public nack(): void {
        this._assertOpen();
        if (!this._isAcked && this._route.noAck === false) {
            this._route.ongoingMessages--;
            this._route.channel.nack(this._originalMessage);
            this._isAcked = true;
            this.releaseBytes();
        }
    }

    public nativeReject() {
        if (!this._isAcked && this._route.noAck === false) {
            this._route.channel.nack(this._originalMessage, false, false);
        }
    }

    public originalMessage() {
        return cloneDeep(this._originalMessage);
    }

    public async reject(error: CustomError | object, headers?: MessageHeaders) {
        return this._replyReject(error, headers, {isRejection: true});
    }

    public async reply(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers);
    }

    public toJSON() {
        return {
            properties: this._originalMessage.properties,
            fields: this._originalMessage.fields,
            body: this.body,
        };
    }

    public async write(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers, {isStream: true, isEnd: false});
    }

    private _assertOpen() {
        if (!this._messaging.isConnected()) {
            throw new CustomError('closed', 'Connection has been cleanly closed, hence you cannot reply to this message. If it is a task or a request, it will be redelivered.');
        }
        if (this._route.isClosed) {
            throw new CustomError('closed', 'Channel has been cleanly closed, hence you cannot reply to this message. If it is a task or a request, it will be redelivered.');
        }
    }

    private _autoExpire() {
        const ttl = this._expiresAt.getTime() - this._issuedAt.getTime();
        this._expireTimer = setTimeout(() => {
            this._assertOpen();
            this.ack();
            this._isExpired = true;
            if (!isNullOrUndefined(this._route._answerTimers)) {
                pull(this._route._answerTimers, this._expireTimer);
            }
            this._messaging.getEventEmitter().emit('message.timeout', new CustomError(`Expected an answer within ${ttl}ms`), this);
        }, ttl);
        if (!isNullOrUndefined(this._route._answerTimers)) {
            this._route._answerTimers.push(this._expireTimer);
        }
    }

    private async _replyReject(bodyOrError?: any | CustomError,
                               headers: MessageHeaders = {idRequest: this._originalMessage.properties.headers.idRequest},
                               options?: InternalReplyOptions) {
        if (this._isStreaming && options.isStream !== true) {
            throw new CustomError('You were previously streaming, to finish the message please use .end()');
        }
        if (this._isExpired) { // Silently ignore.
            return;
        }
        if (this.isTask()) { // Tasks do not need to be replied just acked.
            this.ack();
            return;
        }
        this._assertOpen();

        if (isNullOrUndefined(options)) {
            options = {};
        }

        if (bodyOrError instanceof Error) {
            options.isRejection = true;
        }

        if (headers && (headers as any).__mms) {
            throw new CustomError('__mms header property is reserved. Please use another one.');
        }

        defaults(options, {isEnd: true, isRejection: false});

        if (this._isAnswered) {
            throw new CustomError('forbidden', 'Message was already replied (you might want to have used .write(..) and .end(..)?).');
        }
        if (!this.isRequest()) {
            throw new CustomError('forbidden', 'You cannot reply/reject a message that is not a request nor a acked task');
        }

        const _headers = cloneDeep(headers);
        (_headers as any).__mms = {
            isError: options.isRejection,
            isEnd: options.isEnd,
            isStream: options.isStream,
            sequence: this._sequence++,
        };
        if (isNullOrUndefined(_headers.idRequest) && !isNullOrUndefined(this._originalMessage.properties.headers.idRequest)) {
            _headers.idRequest = this._originalMessage.properties.headers.idRequest;
        }

        const content = await Message.toBuffer(bodyOrError);

        await this._route.channel.sendToQueue(
            this._originalMessage.properties.replyTo,
            content.buffer,
            {
                contentType: 'application/json',
                contentEncoding: content.compression,
                correlationId: this._originalMessage.properties.correlationId,
                headers: _headers,
            },
        );
        if (this._expireTimer !== null) {
            clearTimeout(this._expireTimer);
            this._expireTimer = null;
        }
        this.ack();
        if (options.isEnd) {
            this._isAnswered = true;
        }
    }

    private parseMessage(originalMessage: AMessage) {
        this._originalMessage = originalMessage;
        this._byteLength = originalMessage.content.byteLength;
        let body = originalMessage.content.toString();
        switch (originalMessage.properties.contentEncoding) {
            case undefined:
                break;
            case 'gzip':
                const buf = Utils.uncompress(originalMessage.content);
                body = buf.toString();
                this._byteLength = buf.byteLength;
                break;
            case 'deflate':
                throw new CustomError('notImplemented', 'contentEncoding: deflate not yet supported.');
            default:
                throw new CustomError('notImplemented', `contentEncoding: ${originalMessage.properties.contentEncoding} not yet supported.`);
        }
        switch (originalMessage.properties.contentType) {
            case 'application/json':
                this.body = JSON.parse(body);
                break;
            default:
                throw new CustomError('notImplemented', `contentType: ${originalMessage.properties.contentType} not yet supported.`);
        }
        this.headers = omit(originalMessage.properties.headers, '__mms');
        if (originalMessage.properties.headers.__mms) {
            if (originalMessage.properties.headers.__mms.iat > 0) {
                this._issuedAt = new Date(originalMessage.properties.headers.__mms.iat);
            }
            if (originalMessage.properties.headers.__mms.eat > 0 &&
                originalMessage.properties.headers.__mms.eat > originalMessage.properties.headers.__mms.iat
            ) {
                this._expiresAt = new Date(originalMessage.properties.headers.__mms.eat);
            }
            if (this._issuedAt && this._expiresAt) {
                this._autoExpire();
            }
        }
        if (!isNullOrUndefined(this.correlationId())) {
            this._isRequest = true;
        }
    }

    private releaseBytes() {
        if (this._route.ongoingBytes > 0) {
            this._route.ongoingBytes -= this.size;
            if (this._messaging.getMaxParallelism() === 0 && this._route.ongoingBytes > 0 && this._route.ongoingBytes < this._route.options.maxParallelBytes * 0.7) {
                if (this._messaging.getServiceOptions().enableQos) {
                    this._messaging.setQosMaxParallelism(-1);
                } else {
                    this._messaging.setMaxParallelism(-1);
                }
            }
        }
    }
}

export interface IncomingMessage {

}

export interface IncomingHeaders {
    correlationId?: string;
}

interface InternalReplyOptions {
    isEnd?: boolean;
    isRejection?: boolean;
    isStream?: boolean;
}

export interface ToBuffer {
    buffer: Buffer;
    compression: string;
}
