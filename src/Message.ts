import { Message as AMessage } from 'amqplib';
import { isNullOrUndefined, isUndefined } from 'util';
import { cloneDeep, defaults, omit } from 'lodash';
import { CustomError } from 'sw-logger';
import { MessageHeaders, Route } from './Interfaces';
import { Messaging } from './Messaging';
import * as stream from 'stream';
import { PassThrough } from 'stream';
import { Utils } from './Utils';

export class Message<T = {}> {
    public body: T;
    public headers: any;
    private _originalMessage: AMessage;
    private _isRequest: boolean = false;
    private _route: Route;
    private _isAcked: boolean = false;
    private _isAnswered: boolean = false;
    private _messaging: Messaging;

    constructor(messaging: Messaging, route: Route, originalMessage: AMessage) {
        this._messaging = messaging;
        this._originalMessage = originalMessage;
        this._route = route;
        this._route.ongoingMessages++;

        let body = originalMessage.content.toString();
        switch (originalMessage.properties.contentEncoding) {
            case undefined:
                break;
            case 'gzip':
                body = Utils.uncompress(originalMessage.content).toString();
                break;
            case 'deflate':
                throw new CustomError('notImplemented', 'contentEncoding: deflate not yet supported.'); // TODO: implement
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
        if (!isNullOrUndefined(this.correlationId())) {
            this._isRequest = true;
        }
    }

    public static async toBuffer(ref: any = ''): Promise<ToBuffer> {
        let buf: Buffer,
            compression: string = undefined;
        if (ref instanceof stream.Readable) {
            buf = await Utils.compress(ref);
            compression = 'gzip';
        } else {
            const str = JSON.stringify(ref);
            if (str.length > 1000) {
                compression = 'gzip';
                let stream = new PassThrough();
                stream.push(str);
                stream.push(null);
                buf = await Utils.compress(stream);
            } else {
                buf = Buffer.from(str);
            }
        }
        return {buffer: buf, compression};
    }

    public static toJSON(message: AMessage) {
        return {
            fields: message.fields,
            properties: message.properties,
            content: JSON.parse(message.content.toString())
        }
    }

    public originalMessage() {
        return cloneDeep(this._originalMessage);
    }

    public destinationRoute() {
        if (!this.isRequest() && !this.isTask()) {
            return this._originalMessage.fields.routingKey;
        }
        return this._originalMessage.properties.headers.__mms.route;
    }

    public isChannelClosed() {
        return this._route.isClosed;
    }

    public async reply(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers);
    }

    public async write(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers, {isEnd: false});
    }

    public async end(body?: any, headers?: MessageHeaders): Promise<void> {
        return this._replyReject(body, headers);
    }

    public async reject(error: CustomError | object, headers?: MessageHeaders) {
        return this._replyReject(error, headers, {isRejection: true});
    }

    public nativeReject() {
        if (!this._isAcked && this._route.noAck === false) {
            this._route.channel.nack(this._originalMessage, false, false);
        }
    }

    public ack(): void {
        this._assertOpen();
        if (!this._isAcked && this._route.noAck === false) {
            this._route.ongoingMessages--;
            this._route.channel.ack(this._originalMessage);
            this._isAcked = true;
        }
    }

    public nack(): void {
        this._assertOpen();
        if (!this._isAcked && this._route.noAck === false) {
            this._route.ongoingMessages--;
            this._route.channel.nack(this._originalMessage);
            this._isAcked = true;
        }
    }

    public isStream() {
        return this._originalMessage.properties.headers.__mms.isEnd === false;
    }

    public isAnswer() {
        return this._originalMessage.properties.correlationId && isUndefined(this._originalMessage.properties.replyTo);
    }

    public isError() {
        return this._originalMessage.properties.headers.__mms.isError;
    }

    public correlationId() {
        return this._originalMessage.properties.correlationId;
    }

    public isRequest() {
        return this._isRequest;
    }

    public isEvent() {
        return this._originalMessage.fields.exchange !== '';
    }

    /**
     * Converts the message to an Error
     */
    public error() {
        const e = new CustomError(this.body as any);
        return e;
    }

    /**
     * Return true is the message a task.
     * Tasks do not expect answer, if it is expecting an answer then it's a request.
     * @return {boolean}
     */
    public isTask() {
        return this._originalMessage.properties.headers.__mms.isTask === true;
    }

    public toJSON() {
        return {
            properties: this._originalMessage.properties,
            fields: this._originalMessage.fields,
            body: this.body
        };
    }

    private _assertOpen() {
        if (!this._messaging.isConnected()) {
            throw new CustomError('closed', 'Connection has been cleanly closed, hence you cannot reply to this message. If it is a task or a request, it will be redelivered.');
        }
        if (this._route.isClosed) {
            throw new CustomError('closed', 'Channel has been cleanly closed, hence you cannot reply to this message. If it is a task or a request, it will be redelivered.');
        }
    }

    private async _replyReject(bodyOrError?: any | CustomError,
                               headers: MessageHeaders = {idRequest: this._originalMessage.properties.headers.idRequest},
                               options?: InternalReplyOptions) {
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
                headers: _headers
            }
        );
        this.ack();
        if (options.isEnd) {
            this._isAnswered = true;
        }
    }
}

export interface IncomingMessage {

}

export interface IncomingHeaders {
    correlationId?: string;
}

interface InternalReplyOptions {
    isRejection?: boolean;
    isEnd?: boolean;
}

export interface ToBuffer {
    buffer: Buffer;
    compression: string;
}
