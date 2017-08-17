import {Channel, Message as AMessage} from 'amqplib';
import {isNullOrUndefined, isUndefined} from 'util';
import {defaults, cloneDeep} from 'lodash';
import {CustomError} from 'sw-logger';
import {MessageHeaders, Route} from './Interfaces';

export class Message<T = {}> {
    private _originalMessage: AMessage;
    private _isRequest: boolean = false;
    private _route: Route;
    private _isAcked: boolean;
    private _isAnswered: boolean;
    public body: T;

    constructor(route: Route, originalMessage: AMessage) {
        this._originalMessage = originalMessage;
        this._route = route;
        this._route.ongoingMessages++;
        switch (originalMessage.properties.contentEncoding) {
            case undefined:
                break;
            case 'gzip':
                throw new CustomError('notImplemented', 'contentEncoding: gzip not yet supported.'); // TODO: implement
            case 'deflate':
                throw new CustomError('notImplemented', 'contentEncoding: deflate not yet supported.'); // TODO: implement
            default:
                throw new CustomError('notImplemented', `contentEncoding: ${originalMessage.properties.contentEncoding} not yet supported.`);
        }
        switch (originalMessage.properties.contentType) {
            case undefined: // for backwards compatibility
                this.body = JSON.parse(originalMessage.content.toString()); // TODO: get rid of it.
            case 'application/json':
                this.body = JSON.parse(originalMessage.content.toString());
                break;
            default:
                throw new CustomError('notImplemented', `contentType: ${originalMessage.properties.contentType} not yet supported.`);
        }
        if (!isNullOrUndefined(this.correlationId())) {
            this._isRequest = true;
        }
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
        if (!this._isAcked) {
            this._route.channel.nack(this._originalMessage, false, false);
        }
    }

    public ack(): void {
        if (!this._isAcked) {
            this._route.ongoingMessages--;
            this._route.channel.ack(this._originalMessage);
            this._isAcked = true;
        }
    }

    public nack(): void {
        if (!this._isAcked) {
            this._route.ongoingMessages--;
            this._route.channel.nack(this._originalMessage);
            this._isAcked = true;
        }
    }

    private async _replyReject(bodyOrError?: any | CustomError,
                               headers: MessageHeaders = {idRequest: this._originalMessage.properties.headers.idRequest},
                               options?: InternalReplyOptions
    ) {

        if (isNullOrUndefined(options)) {
            options = {};
        }

        if (headers && (headers as any).__mms) {
            throw new CustomError('__mms header property is reserved. Please use another one.');
        }

        defaults(options, {isEnd: true, isRejection: false});``

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

        await this._route.channel.sendToQueue(
            this._originalMessage.properties.replyTo,
            Buffer.from(JSON.stringify(bodyOrError || '')),
            {
                contentType: 'application/json',
                correlationId: this._originalMessage.properties.correlationId,
                headers: _headers
            }
        );
        this.ack();
        if (options.isEnd) {
            this._isAnswered = true;
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

    public error() {
        const e = new CustomError(this.body as any);
        if (isNullOrUndefined(e.info)) {
            e.info = {};
        }
        e.info._receivedMessage = this;
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