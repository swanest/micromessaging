import {OwnEvents} from './Events';
import {EventEmitter} from 'events';
import * as logger from 'sw-logger';
import {CustomError, Logger} from 'sw-logger';
import * as amqp from 'amqplib';
import {Channel, Connection, Message as AMessage} from 'amqplib';
import {isNull, isNullOrUndefined, isUndefined} from 'util';
import {cloneDeep, omit, pull} from 'lodash';
import {
    EmitOptions,
    Exchange,
    ListenerOptions,
    MessageHandler,
    MessageHeaders,
    Queue,
    QueueOptions,
    ReplyAwaiter,
    RequestOptions,
    RequestReport,
    ReturnHandler,
    Route,
    ServiceOptions,
    Status,
    StatusOptions,
    TaskOptions,
    Uptime,
} from "./Interfaces";
import {getHeapStatistics} from 'v8';
import {Message} from './Message';
import {PressureEvent, Qos} from './Qos';
import {Election} from './Election';
import {PeerStatus} from './PeerStatus';
import * as when from 'when';
import {URL} from 'url';
import uuid = require('uuid');
import Deferred = When.Deferred;
import Timer = NodeJS.Timer;
import {AMQPLatency} from './AMQPLatency';

const tracer = new logger.Logger({namespace: 'micromessaging'});
let ID = 0;

export class Messaging {

    public static internalExchangePrefix = 'internal';
    public static instances: Messaging[] = [];
    public latencyMS: number;
    private _queues: Map<string, Queue> = new Map();
    private _channels: Map<string, Channel> = new Map();
    private _awaitingReply: Map<string, ReplyAwaiter> = new Map();
    private _exchanges: Map<string, Exchange> = new Map();
    private _routes: Map<string, Route> = new Map();
    private _outgoingChannel: Channel;
    private _serviceOptions: ServiceOptions;
    private _eventEmitter: EventEmitter;
    private _uri: string;
    private _connection: Connection;
    private _qos: Qos;
    // private _serviceId: string = uuid.v4();
    private _serviceId: string = '' + (++ID);
    private _election: Election;
    private _peerStatus: PeerStatus;
    private _lastMessageDate: Date;
    private _isReady: boolean = false;
    private _startedAt: Date = new Date();
    private _waitParallelismAsserted: Deferred<void>;
    private _maxParallelism: number = -1;
    private _lastAppliedParallelism = {
        value: -1,
        qSubjectToQuota: 0
    };
    private _ongoingQAssertion: Deferred<void>[] = [];
    private _replyQueueAssertionPromise: Promise<any> = null;
    private _isConnected: boolean = false;
    private _isConnecting: boolean = false;
    private _isClosing: boolean = false;
    private _isClosed: boolean = false;
    private _logger: Logger;
    private _amqpLatency: AMQPLatency;

    /**
     * @param {string} _serviceName
     * @param options memorySoftLimit and memoryHardLimit respectively defaults to half and 3/5 of heap_size_limit. Expressed in MB.
     */
    constructor(private _serviceName: string, options: ServiceOptions = {}) {

        this._logger = tracer.context(`${this._serviceName}:${this._serviceId.substr(0, 10)}`);
        this._qos = new Qos(this, this._routes, this._logger.context(`${this._serviceName}:${this._serviceId.substr(0, 10)}:qos`));

        this._serviceOptions = Object.assign({}, {
            readyOnConnected: true,
            enableQos: true, // Default: true. Quality of service will check event-loop delays to keep CPU usage under QosThreshold
            qosThreshold: 0.7, // Default: 0.7. [0.01; 1]
            enableMemoryQos: true, // Defaults: true. When activated, tries to keep memory < memorySoftLimit and enforces keeping memory < memoryHardLimit
            memorySoftLimit: Messaging.defaultMemoryLimit().soft, // Defaults to half heap_size_limit. Expressed in MB
            memoryHardLimit: Messaging.defaultMemoryLimit().hard // Defaults to 3 fifth of heap_size_limit. Express in MB
        }, options);

        this._eventEmitter = new EventEmitter();
        if (this._serviceOptions.enableQos) {
            this._logger.log('Enable QOS');
            this._qos.enable();
        }

        this._peerStatus = new PeerStatus(this, tracer.context(`${this._serviceName}:${this._serviceId.substr(0, 10)}:peer-status`));
        this._election = new Election(this, this._peerStatus, tracer.context(`${this._serviceName}:${this._serviceId.substr(0, 10)}:election`));
        this._peerStatus.setElection(this._election);
        this._amqpLatency = new AMQPLatency(this);

        Messaging.instances.push(this);
    }

    private get _replyQueue() {
        return `q.replyQueue.${this._serviceName}.${this._serviceId}`;
    }

    private get _internalExchangeName() {
        return `${Messaging.internalExchangePrefix}.${this._serviceName}`;
    }

    static defaultMemoryLimit() {
        const {heap_size_limit} = getHeapStatistics();
        return {
            soft: ~~(heap_size_limit / Math.pow(2, 20) / 2),
            hard: ~~(heap_size_limit / Math.pow(2, 20) / 5 * 3)
        };
    }

    /**
     * Get the last Date object where a message was received. Does not account for internal messages.
     */
    public getLastMessageDate(): Date {
        return this._lastMessageDate;
    }

    /**
     * Returns the name of the service (name supplied while instantiating the service).
     */
    public getServiceName() {
        this._assertNotClosed();
        return this._serviceName;
    }

    /**
     * Getter: options sat while instantiating the service with the corresponding default values.
     */
    public getServiceOptions() {
        this._assertNotClosed();
        return this._serviceOptions;
    }

    /**
     * Access to the eventEmitter.
     */
    public getEventEmitter() {
        return this._eventEmitter;
    }

    /**
     * Get the default name used for declaring internal listen queues.
     */
    public getInternalExchangeName() {
        this._assertNotClosed();
        return this._internalExchangeName;
    }

    /**
     * Get the UUID generated for this instance.
     */
    public getServiceId() {
        return this._serviceId;
    }

    public async setQosMaxParallelism(value?: number) {
        this._assertNotClosed();

        this._maxParallelism = value;
        this._logger.debug(`Desires to set parallelism to ${value}`);

        if (!this._channels || this._channels.size === 0) {
            return;
        }
        this._logger.debug(`Should wait? ${!isNullOrUndefined(this._waitParallelismAsserted)}`);
        if (isNullOrUndefined(this._waitParallelismAsserted)) {
            await this._assertParallelBoundaries();
        } else {
            await this._waitParallelismAsserted;
        }
    }

    public getMaxParallelism() {
        return this._maxParallelism;
    }

    public setMaxParallelism(value: number) {
        this._assertNotClosed();

        if (this._serviceOptions.enableQos) {
            throw new CustomError('QOS is in charge you cant change the parallelism settings.');
        }

        if (isNullOrUndefined(value)) {
            throw new CustomError('Please supply a value.');
        }

        this._maxParallelism = value;

        if (!this._channels || this._channels.size === 0) {
            return;
        }
        if (isNullOrUndefined(this._waitParallelismAsserted)) {
            this._assertParallelBoundaries().catch(e => this.reportError(e));
        }
    }

    public isReady(): boolean {
        return this._isReady;
    }

    public isConnected(): boolean {
        return this._isConnected;
    }

    public getUptime(): Uptime {
        return {
            startedAt: this._startedAt,
            elapsedMs: new Date().getTime() - this._startedAt.getTime(),
        };
    }

    /**
     * Connects to a rabbit instance. Idempotent.
     * @param rabbitURI format: amqp://localhost?heartbeat=30 — If heartbeat is not supplied, will default to 30s
     * @returns Returns once the connection is properly initialized and that all listeners and handlers have been fully declared.
     */
    public async connect(rabbitURI?: string): Promise<void> {
        this._assertNotClosed();
        if (this._isConnected || this._isConnecting) {
            return;
        }
        this._isConnecting = true;
        this._uri = rabbitURI || process.env.RABBIT_URI || 'amqp://localhost';
        const parsed = new URL(this._uri);
        parsed.searchParams.set('heartbeat', parsed.searchParams.get('heartbeat') || '30');
        this._uri = parsed.toString();
        this._logger.debug(`Establishing connection to ${this._uri}`);
        try {
            this._connection = await amqp.connect(this._uri);
            this._isConnected = true;
        } catch (e) {
            const customError = new CustomError('unableToConnect', 'Service was unable to connect to RabbitMQ', e);
            this._eventEmitter.emit('error', customError);
            throw customError;
        }
        this._logger.debug('Connection to RabbitMQ established.');
        this._outgoingChannel = await this._createChannel();

        // Should be the last assertion so that every declared bit gets opened properly and that we avoid race conditions.
        await this._assertRoutes();
        this._logger.debug('Routes asserted.');
        this._isConnecting = false;
        this._isReady = true;

        // Instance is now ready, process to vote
        this._peerStatus.start();
        this._benchmarkLatency();
    }

    private _benchmarkLatency() {
        this._amqpLatency.benchmark(true).then(ms => this.latencyMS = ms).catch(e => this.reportError(e));
    }

    /**
     * Listen to a specific event. See {{OwnEvents}} to know what events exist.
     * @param {OwnEvents} event
     * @param {(error: CustomError, message: Message) => void} listener
     * @returns
     */
    public on(event: OwnEvents, listener: (errorOrEvent: CustomError | PressureEvent, message?: Message) => void): this {
        this._assertNotClosed();
        this._eventEmitter.on(event, listener.bind(this));
        return this;
    }

    /**
     * Sets a callback for an event. Will be triggered at max 1 time.
     * @param {OwnEvents} event
     * @param {(errorOrEvent: (CustomError | PressureEvent), message?: Message) => void} listener
     */
    public once(event: OwnEvents, listener: (errorOrEvent: CustomError | PressureEvent, message?: Message) => void): this {
        this._assertNotClosed();
        this._eventEmitter.once(event, listener.bind(this));
        return this;
    }

    /**
     * Emit an event to a target. Target can be a service or just a commonly agreed namespace.
     * @param {string} target
     * @param {string} route
     * @param messageBody
     * @param messageHeaders
     * @param {EmitOptions} options
     * @returns {Promise<void>}
     */
    public async emit<T = {}>(target: string,
                              route: string,
                              messageBody?: T,
                              messageHeaders: MessageHeaders = {},
                              {onlyIfConnected = false}: EmitOptions = {}): Promise<void> {

        this._assertNotClosed();
        if (!this._isConnected && onlyIfConnected === true) {
            return;
        }

        if (!this._isConnected) {
            throw new CustomError('notConnected', 'No active connection to send the request.');
        }

        if (!isNullOrUndefined(messageHeaders.__mms)) {
            throw new CustomError('__mms header property is reserved. Please use something else.');
        }

        const _headers = cloneDeep(messageHeaders);
        (_headers as any).__mms = {};

        await this._outgoingChannel.publish(
            `x.pubSub`,
            `${target}.${route}`,
            Buffer.from(JSON.stringify(messageBody || '')),
            {
                contentType: 'application/json',
                headers: _headers
            }
        );
    }

    /**
     * RPC implementation. Request a service identified by the name targetService.
     * The promise will resolve when the target replies or that there is an error (timeout, unroutable, etc.)
     * If there are multiple instances of the targetService, only one will handle it.
     * Use timeout: -1 if you don't want the request to timeout.
     * @param targetService The name of the service that will have to handle the request
     * @param route A routing key to the handler in the targetService
     * @param messageBody The message to send
     * @param messageHeaders Additional headers. If idRequest is not provided, will auto-generate one.
     * @param streamHandler callback that will be called when the reply is a stream
     * @returns The final response message to the request
     */
    public async request<T = {}>(targetService: string,
                                 route: string,
                                 messageBody: any = '',
                                 {idRequest = uuid.v4(), ...remainingHeaders}: MessageHeaders = {},
                                 {timeout = 3000}: RequestOptions = {},
                                 streamHandler: (message: Message) => void = null): Promise<Message<T>> {

        this._assertNotClosed();
        if (!this._isConnected) {
            throw new CustomError('notConnected', 'No active connection to send the request.');
        }
        if (isNullOrUndefined(targetService)) {
            throw new CustomError('notConnected', 'You must specify a target.');
        }
        if (isNullOrUndefined(route)) {
            throw new CustomError('notConnected', 'You must specify a target route.');
        }
        const preparedScopedError = new CustomError('timeout', `Request on ${targetService}.${route} timed out. Expecting response within ${timeout}ms`);

        await this._assertReplyQueue();
        const correlationId = uuid.v4();
        const def = when.defer<Message<T>>();
        const awaitingReplyObj: ReplyAwaiter = {
            deferred: def,
            streamHandler: streamHandler,
            timer: null
        };

        if (timeout > -1) {
            awaitingReplyObj.timer = setTimeout(() => {
                def.reject(preparedScopedError);
                this._awaitingReply.delete(correlationId);
            }, timeout);
        }

        this._awaitingReply.set(correlationId, awaitingReplyObj);

        if (timeout === 0) {
            def.reject(preparedScopedError);
            this._awaitingReply.delete(correlationId);
        }

        await this._outgoingChannel.sendToQueue(
            `q.requests.${targetService}.${route}`,
            Buffer.from(JSON.stringify(messageBody)),
            {
                correlationId,
                mandatory: true,
                replyTo: this._replyQueue,
                contentType: 'application/json',
                headers: {
                    __mms: {route},
                    idRequest,
                    ...remainingHeaders
                }
            }
        );
        return def.promise;
    }

    /**
     * Worker queue implementation. By default we always want an acknowledgment to a sent task (for backwards compatibility).
     * @param {string} targetService The name of the service that will have to handle the request
     * @param {string} route A routing key to the handler in the targetService
     * @param messageBody The message to send.
     * @param messageHeaders Additional headers. If idRequest is not provided, will auto-generate one.
     * @returns A promise that resolves once the message has been sent or a proxied request
     */
    public async task(targetService: string,
                      route: string,
                      messageBody: any = '',
                      {idRequest = uuid.v4(), ...remainingHeaders}: MessageHeaders = {},
                      {timeout = 3000, noAck = true}: TaskOptions = {}): Promise<void | Message> {

        this._assertNotClosed();
        if (!this._isConnected) {
            throw new CustomError('notConnected', 'No active connection to send the task to.');
        }

        if (noAck === false) {
            console.warn('Using task(..) to dispatch requests is deprecated. Use request(..) instead.');
            return this.request(targetService,
                route,
                messageBody,
                {idRequest, ...remainingHeaders},
                {timeout});
        }

        await this._outgoingChannel.sendToQueue(
            `q.requests.${targetService}.${route}`,
            Buffer.from(JSON.stringify(messageBody)),
            {
                contentType: 'application/json',
                mandatory: true,
                headers: {
                    __mms: {
                        route,
                        isTask: true
                    },
                    idRequest,
                    ...remainingHeaders
                }
            }
        );
        this._logger.log('Task sent.');
        return;
    }

    /**
     * PUB/SUB creates an event listener
     * @param target The target on which you want to listen by default it's the serviceName but it can be the name of a commonly agreed exchange
     * @param route The route on which to listen
     * @param listener The callback function that will be called each time a message arrives on that route
     * @return resolves when listeners are fully asserted and returns an object which has a "stop" function.
     */
    public async listen(target: string, route: string, listener: MessageHandler): Promise<ReturnHandler>;

    /**
     * PUB/SUB creates an event listener
     * @param route The route on which to listen
     * @param listener The callback function that will be called each time a message arrives on that route
     * @return resolves when listeners are fully asserted and returns an object which has a "stop" function.
     */
    public async listen(route: string, listener: MessageHandler): Promise<ReturnHandler>;

    /**
     * See the docs of the two other overloaded methods. This is the implementation of them.
     */
    public async listen(routeOrTarget: string, routeOrListener: any, listener?: MessageHandler): Promise<ReturnHandler> {
        this._assertNotClosed();
        let target = routeOrTarget,
            route = routeOrListener;
        if (typeof routeOrListener === 'function') {
            listener = routeOrListener;
            target = this._serviceName;
            route = routeOrTarget;
        }

        const routeAlias = `listen.${target}.${route}`;

        if (!isUndefined(this._routes.get(routeAlias))) {
            throw new CustomError(`A listener for ${isNull(target) ? '' : target + ':'}${route} is already defined.`);
        }
        this._routes.set(routeAlias, {
            options: null, // Not implemented yet.
            route,
            target,
            isClosed: false,
            isReady: false,
            isDeclaring: false,
            type: 'pubSub',
            handler: listener,
            subjectToQuota: !(target === this._internalExchangeName)
        });
        this._logger.debug('Asserting route', routeAlias);
        await this._assertRoute(routeAlias);
        return {
            stop: this._stopListen(routeAlias),
            stat: () => {
                return this._queueReport({routeAlias: routeAlias});
            }
        };
    }

    /**
     * Returns a report about the request queue of a target service
     * @param {string} serviceName name of the service to get the report about
     * @returns {Promise<void>}
     */
    public getRequestsReport(serviceName: string, route: string) {
        // Create a dedicated channel so that it can fail alone without annoying other channels
        return this._queueReport({queueName: `q.requests.${serviceName}.${route}`});
    }

    private async _queueReport({queueName = null, routeAlias = null}: { queueName?: string, routeAlias?: string }): Promise<RequestReport> {
        if (isNullOrUndefined(queueName)) {
            queueName = this._routes.get(routeAlias).queueName;
        }
        // Create a dedicated channel so that it can fail alone without annoying other channels
        const channel = await this._assertChannel('__requestReport', true);
        try {
            const report = await channel.checkQueue(queueName);
            return {
                queueSize: report.messageCount,
                queueName: report.queue,
                consumers: report.consumerCount
            };
        } catch (e) {
            if (/NOT_FOUND/.test(e.message)) {
                throw new CustomError('notFound', `Queue named ${queueName} doesnt exist.`);
            }
        }
    }

    /**
     *
     * @param {string} route
     * @param {MessageHandler} listener
     * @param {ListenerOptions} options
     */
    public async handle(route: string, listener: MessageHandler, options?: ListenerOptions): Promise<ReturnHandler> {
        this._assertNotClosed();
        const routeAlias = 'handle.' + route;
        if (!isUndefined(this._routes.get(routeAlias))) {
            throw new CustomError(`A handler for ${route} is already defined.`);
        }
        this._routes.set(routeAlias, {
            options,
            route,
            isClosed: false,
            isReady: false,
            isDeclaring: false,
            type: 'rpc',
            handler: listener
        });
        await this._assertRoute(routeAlias);
        return {
            stop: this._stopListen(routeAlias),
            stat: () => {
                return this._queueReport({routeAlias: routeAlias});
            }
        };
    }

    /**
     * Ask for the status of a service
     * @param {string} targetService
     * @param {StatusOptions} options
     */
    public async getStatus(targetService: string = this._serviceName, options?: StatusOptions): Promise<Status> {
        this._assertConnected();
        const members = await this._peerStatus.getStatus(targetService);
        const hasMaster = members.some(m => !isNullOrUndefined(m.leaderId));
        const hasReadyMembers = members.some(m => !isNullOrUndefined(m.isReady));
        return {
            hasMaster,
            hasReadyMembers,
            members: members,
        }
    }

    /**
     * Like task without ack
     */
    public async notify(...args: any[]): Promise<void> {
        this._assertNotClosed();
        return this.emit.call(this, args);
    }

    /**
     * Cleanly closes the connection to Rabbit and removes all handlers. Request queue is not deleted.
     * @param deleteAllQueues Delete queues only if empty and not used.
     * @param force Forces deletion (no check on ifEmpty & ifUnused).
     * @returns Promise that resolves once the connection has been fully closed.
     */
    public async close(deleteAllQueues: boolean = false, force: boolean = false) {
        if (this._isClosed || this._isClosing) {
            // Close is idempotent
            return;
        }
        this._logger.debug('Closing connection');

        this._isClosing = true;
        await Promise.all<any>(this._ongoingQAssertion.map(p => p.promise)); // Wait that assertions still ongoing are finished before closing.

        if (this._qos) {
            this._qos.disable();
        }
        if (this._peerStatus) {
            this._peerStatus.stop();
        }
        if (this._election) {
            this._election.stop();
        }

        // Stop consuming
        const cancelConsuming: any = [];
        this._routes.forEach(route => {
            if (route.cancel) {
                cancelConsuming.push(route.cancel());
            }
        });
        await Promise.all(cancelConsuming); // Until we get acks for each, we can still receive messages.

        if (deleteAllQueues) {
            const proms: Array<string> = [];
            this._queues.forEach(q => !q.options.autoDelete && !q.options.exclusive && proms.push(q.name)); // Only delete queue that won't auto-delete.
            const opts = {
                ifUnused: true,
                ifEmpty: true
            };
            if (force) {
                opts.ifEmpty = false;
            }
            await Promise.all(proms.map(name => this._outgoingChannel.deleteQueue(name, opts)));
        }

        if (this._isConnected) {
            this._routes.forEach(r => r.isClosed = true);
            await Promise.all([...this._channels].map(c => c[1].close()));
            await this._connection.close();
            this._isConnected = false;
        }
        this._isClosed = true;
        this._logger.debug('Closing fully closed');
        this._logger = null;
        pull(Messaging.instances, this);
    }

    public reportError(e: Error | CustomError, m?: Message) {
        if (this._isClosing || this._isClosed) {
            // Swallow errors while closing.
            return;
        }
        this._eventEmitter.emit('error', e, m);
    }

    private async _assertParallelBoundaries() {
        if (!this._isConnected || this._isClosing) {
            return;
        }

        const prefetchProms: any[] = [];
        let maxParallelismPerConsumer = -1;

        let countQSubjectToQuota = 0;
        this._routes.forEach((route, name) => {
            if (route.subjectToQuota === false || !route.isReady) {
                return;
            }
            this._logger.debug(`Route corresponding to: ${name} is subject to quota.`);
            countQSubjectToQuota++;
        });

        this._logger.log('Current parallelism compared to past', this._maxParallelism, countQSubjectToQuota, this._lastAppliedParallelism);
        if (this._maxParallelism === this._lastAppliedParallelism.value && countQSubjectToQuota === this._lastAppliedParallelism.qSubjectToQuota) {
            return;
        }

        this._logger.debug(`Applying maxParallelism of ${this._maxParallelism} on ${countQSubjectToQuota} consumers.`);

        if (this._maxParallelism > 0) {
            maxParallelismPerConsumer = ~~(this._maxParallelism / countQSubjectToQuota);
            if (this._maxParallelism > 0 && maxParallelismPerConsumer < 1) { // To avoid prefetch(0) on all channel and block everything.
                maxParallelismPerConsumer = 1;
            }
        } else if (this._maxParallelism === 0) {
            maxParallelismPerConsumer = 0; // This doesn't work we need to stop consuming...
        }

        // Apply quotas to each consumer
        this._routes.forEach((route, name) => {
            if (route.subjectToQuota === false || !route.isReady) {
                return;
            }
            this._logger.debug(`Applying maxParallelism of ${maxParallelismPerConsumer} on queue: ${name}.`);
            route.maxParallelism = maxParallelismPerConsumer;
            if (maxParallelismPerConsumer === 0) {
                if (!isNullOrUndefined(route.consumerTag)) {
                    prefetchProms.push(route.cancel());
                }
            } else if (maxParallelismPerConsumer > 0) {
                prefetchProms.push(route.channel.prefetch(maxParallelismPerConsumer, true));
                if (isNullOrUndefined(route.consumerTag)) {
                    prefetchProms.push(route.consume());
                }
            } else if (maxParallelismPerConsumer === -1) {
                prefetchProms.push(route.consume());
            } else {
                const e = new CustomError('inconsistency', `Negative prefetch (${maxParallelismPerConsumer}) are forbidden.`);
                if (this._eventEmitter.listenerCount('error') < 1) {
                    throw e;
                } else {
                    this._eventEmitter.emit('error', e);
                }
            }
            route.maxParallelism = maxParallelismPerConsumer;
        });
        this._waitParallelismAsserted = when.defer<void>();
        const cacheAppliedParams = {
            value: this._maxParallelism,
            qSubjectToQuota: countQSubjectToQuota
        };

        await Promise.all(prefetchProms);
        this._logger.log('Finished asserting parallelism on consumers');
        // Saving the last applied params
        this._lastAppliedParallelism.value = cacheAppliedParams.value;
        this._lastAppliedParallelism.qSubjectToQuota = cacheAppliedParams.qSubjectToQuota;

        // Check that the parallelism quota hasn't changed while applying the last params
        if (this._maxParallelism !== this._lastAppliedParallelism.value) {
            this._assertParallelBoundaries().catch(e => this.reportError(e));
        } else if (!isNullOrUndefined(this._waitParallelismAsserted)) {
            this._waitParallelismAsserted.resolve();
            this._waitParallelismAsserted = null;
        }
    }

    private async _createChannel(): Promise<Channel> {
        this._assertConnected();
        const chan = await this._connection.createChannel();
        chan.on('error', this.reportError);
        chan.on('drain', () => this._logger.debug('Got a drain event on a channel.'));
        chan.on('return', msg => {
            const e = new CustomError('unroutable', `No route to "${msg.fields.routingKey}". Originally sent message attached.`);
            e.info = isNullOrUndefined(e.info) ? {} : e.info;
            e.info.sentMessage = msg;
            if (this._awaitingReply.has(msg.properties.correlationId)) {
                this._awaitingReply.get(msg.properties.correlationId).deferred.reject(e);
                this._awaitingReply.delete(msg.properties.correlationId);
            } else {
                if (this._eventEmitter.listenerCount('unroutableMessage') > 0) {
                    this._eventEmitter.emit('unroutableMessage', e);
                } else {
                    throw e;
                }
            }
        });
        chan.on('close', () => {
            // this._logger.log('Channel closed');
        });
        return chan;
    }

    private _assertNotClosed() {
        if (this._isClosed === true) {
            throw new CustomError('This instance is not usable anymore as it has been closed. Please create a new one.');
        }
    }

    private _assertConnected() {
        if (this._isConnected !== true) {
            throw new CustomError('This action requires to be connected.');
        }
    }

    private _stopListen(routeName: string): () => Promise<void> {
        return async () => {
            if (!this._routes.has(routeName)) {
                throw new CustomError('notFound', 'This route does not exist.');
            }
            this._logger.log(`Stop handling ${routeName}`);
            const route = this._routes.get(routeName);
            route.isClosed = true;
            route.isReady = false;
            this._channels.delete(routeName);
            this._routes.delete(routeName);
            this._queues.delete(route.queueName);

            if (route.isReady) {
                await route.cancel();
            }
            if (route.type === 'pubSub') {
                await route.channel.unbindQueue(route.queueName, 'x.pubSub', `${route.target}.${route.route}`);
            }
            await route.channel.close();

            if (!this._isConnected) {
                return;
            }
            // We do this separately because we could get PRECONDITION errors that we want to ignore.
            const channelThatCanError = await this._connection.createChannel();
            channelThatCanError.on('error', () => {
            });
            try {
                await channelThatCanError.deleteQueue(route.queueName, {
                    ifEmpty: true,
                    ifUnused: true
                });
                await channelThatCanError.close();
            } catch (e) {
                if (!this._isConnected) {
                    return;
                }
                if (!/PRECONDITION/.test(e.message)) {
                    this.reportError(new CustomError('Error while stop listening', e)); // Let's not swallow too much, just what we are sure we need to.
                }
                // At this stage the channel is closed so no need to close it again.
            }
        };
    }

    private async _assertChannel(name: string, swallowErrors: boolean = false): Promise<Channel> {
        const newChan = await this._createChannel();
        newChan.on('close', () => {
            this._channels.delete(name);
        });
        if (swallowErrors) {
            newChan.removeAllListeners('error');
            newChan.on('error', () => {
            });
        }
        this._channels.set(name, newChan);
        return newChan;
    }

    /**
     * Asserts a route identified by a name into existence. Called after declaration of a route. Idempotent.
     * @param routeAlias The name of the route
     */
    private async _assertRoute(routeAlias: string) {
        this._logger.log('_assertRoute ' + routeAlias + ' only if isConnected?: ' + this._isConnected + ' and not Closing: ' + !this._isClosing);
        if (this._isConnected && !this._isClosing && !this._isClosed) {

            const route = this._routes.get(routeAlias);
            if (route.isDeclaring) {
                return;
            }
            route.isDeclaring = true;

            const currentQAssertion = when.defer<void>();
            this._ongoingQAssertion.push(currentQAssertion);
            const cleanReturn = () => {
                currentQAssertion.resolve();
                pull(this._ongoingQAssertion, currentQAssertion);
            };

            this._logger.log(`Declaring ${routeAlias} with properties:`, omit(route, 'channel'));
            if (isNullOrUndefined(route)) {
                throw new CustomError('inconsistency', `Trying to assert a route ${routeAlias} that doesn't exist.`);
            }
            if (this._channels.has(routeAlias)) {
                // Meaning the route already exists and is defined on the broker.
                cleanReturn();
                return;
            }

            route.maxParallelism = -1; // Unlimited by default.
            route.ongoingMessages = 0;
            const channel = await this._createChannel();
            route.channel = channel;
            route.cancel = async () => {
                if (!route.isReady) {
                    throw new CustomError('Cannot cancel while not being ready for consumption');
                }
                if (route.consumerTag === 'pending') {
                    await route.consumerWaiter;
                }
                if (!isNullOrUndefined(route.consumerTag) && route.isReady) {
                    const consumerTag = route.consumerTag;
                    route.consumerTag = null;
                    await route.channel.cancel(consumerTag);
                }
            };
            route.consume = async () => {
                if (this._isClosing) {
                    return;
                }
                if (!route.isReady) {
                    throw new CustomError('Cant consume if the queue is not asserted yet.')
                }
                if (!route.queueName) {
                    throw new CustomError('inconsistency', 'No queue name to consume on.');
                }
                if (isNullOrUndefined(route.consumerTag)) {
                    route.consumerTag = 'pending';
                    route.consumerWaiter = channel.consume(route.queueName, (message: AMessage) => {
                        this._messageHandler(message, route);
                    }, {exclusive: route.type !== 'rpc'});
                    route.consumerWaiter;
                    route.consumerTag = (await route.consumerWaiter).consumerTag;
                    this._logger.debug(`Consuming queue: ${route.queueName} (${route.route})`);
                    if (route.subjectToQuota && route.maxParallelism > 0) {
                        this._logger.debug(`Setting // to ${route.maxParallelism} on ${route.queueName} (${route.route})`);
                        if (this._isClosing) { // Because of the await just above this line might try to execute on a closing connection.
                            return;
                        }
                        await channel.prefetch(route.maxParallelism, true);
                    }
                }
            };
            if (isNullOrUndefined(route.subjectToQuota)) {
                route.subjectToQuota = true;
            }
            this._channels.set(routeAlias, channel);
            const queueOptions: QueueOptions = {};
            switch (route.type) {
                case 'rpc':
                    route.queueName = `q.requests.${this._serviceName}.${route.route}`;
                    queueOptions.expires = 24 * 60 * 60 * 1000; // After 24h the queue gets deleted if not used.
                    await channel.assertQueue(route.queueName, {
                        expires: queueOptions.expires,
                        exclusive: false
                    });
                    this._logger.log(`Asserted queue: ${route.queueName}. Asserting prefetch now.`);
                    route.isReady = true;
                    route.isDeclaring = false;
                    await this._assertParallelBoundaries();
                    if (route.subjectToQuota && (route.maxParallelism === -1 || route.maxParallelism > 0)) {
                        await route.consume();
                    }
                    break;
                case 'pubSub':
                    await channel.assertExchange('x.pubSub', 'topic');
                    queueOptions.exclusive = true;
                    queueOptions.autoDelete = true;
                    route.queueName = `q.pubSub.${this._serviceName}.${uuid.v4()}`;
                    this._logger.log(`Asserting ${route.queueName} into existence.`);
                    await channel.assertQueue(route.queueName, {
                        exclusive: queueOptions.exclusive,
                        autoDelete: queueOptions.autoDelete
                    });
                    this._logger.log(`Trying to bind ${route.queueName} on x.pubSub with routingKey: ${route.target}.${route.route}`);
                    await channel.bindQueue(route.queueName, 'x.pubSub', `${route.target}.${route.route}`);
                    this._logger.log(`Bound ${route.queueName} on x.pubSub with routingKey: ${route.target}.${route.route}`);

                    route.isReady = true;
                    route.isDeclaring = false;
                    await this._assertParallelBoundaries();
                    if (route.subjectToQuota && (route.maxParallelism === -1 || route.maxParallelism > 0)) {
                        await route.consume();
                    } else if (!route.subjectToQuota) {
                        await route.consume();
                    }
                    break;
                case 'rpcReply':
                    this._logger.log('Asserting reply queue, should be waiting');
                    queueOptions.exclusive = true;
                    queueOptions.autoDelete = true;
                    await channel.assertQueue(
                        this._replyQueue,
                        {
                            exclusive: queueOptions.exclusive,
                            autoDelete: queueOptions.autoDelete,
                        }
                    );
                    route.subjectToQuota = false;
                    route.queueName = this._replyQueue;
                    route.isReady = true;
                    route.isDeclaring = false;
                    await this._assertParallelBoundaries();
                    await route.consume();
                    break;
                default:
                    throw new CustomError('inconsistency', `Trying to handle an unknown route type: ${route.type}`);
            }
            if (route.queueName) {
                this._queues.set(route.queueName, {name: route.queueName, options: queueOptions});
            }
            this._logger.log(`Route ${route.type}:${routeAlias} initialized.`);
            cleanReturn();
        }
    }

    /**
     * Asserts the replyQueue into existence. Idempotent.
     */
    private async _assertReplyQueue() {
        if (!this._routes.has('replyQueue')) {
            this._routes.set('replyQueue', {
                route: 'replyQueue',
                type: 'rpcReply',
                handler: null,
                options: null,
                isClosed: false,
                isReady: false,
                isDeclaring: false,
                subjectToQuota: false,
            });
            await (this._replyQueueAssertionPromise = this._assertRoute('replyQueue'));
            this._replyQueueAssertionPromise = null;
        }
        if (!isNullOrUndefined(this._replyQueueAssertionPromise)) {
            await this._replyQueueAssertionPromise;
        }
    }

    /**
     * Main message handler; Every incoming message goes through this handler.
     * @param originalMessage The raw AMQP message received.
     * @param route The destination route key in _routes Map.
     */
    private _messageHandler(originalMessage: AMessage, route: Route) {
        // this._logger.debug(`Received a message in _messageHandler isClosed? ${this._isClosed}, isConnected: ${this._isConnected}, isClosing: ${this._isClosing}`, Message.toJSON(originalMessage));
        if (this._isClosed || !this._isConnected || this._isClosing) {
            // We dont handle messages in those cases. They will auto-nack because the channels and connection will die soon so there is no need to nack them all first.
            return;
        }
        if (this._serviceOptions.enableQos && route.subjectToQuota) {
            this._qos.handledMessage(); // This enables to keep track of synchronous messages that pass by and that wouldn't be counted between two monitors of the E.L.
        }
        const m = new Message(route, originalMessage);
        const routeAlias = `${m.isRequest() || m.isTask() ? 'handle' : 'listen'}.${m.destinationRoute()}`;

        // this._logger.log(`Message arriving on queue ${route.queueName} with ${route.ongoingMessages}/${route.maxParallelism}`);
        if (route.subjectToQuota && route.maxParallelism !== -1 && route.ongoingMessages > route.maxParallelism) {
            // We don't want this message...
            this._logger.log(`Nacking because exceeds limit for a message arriving on queue ${route.queueName} with ${route.ongoingMessages}/${route.maxParallelism} (cTag: ${route.consumerTag})`);
            m.nack();
            return;
        }
        if (route.subjectToQuota) {
            this._lastMessageDate = new Date();
        }
        if (m.isAnswer()) {
            m.ack();
            if (!this._awaitingReply.has(m.correlationId())) {
                // throw new CustomError('inconsistency', `No handler found for response with correlationId: ${m.correlationId()}`, m);
                this._logger.debug('A response to a request arrived but we do not have it locally. Most probably it was rejected earlier due to a timeout.');
                this._eventEmitter.emit('unhandledMessage', new CustomError(`A response to a request arrived but we do not have it locally. Most probably it was rejected earlier due to a timeout.`), m);
                return; // Means it probably timed out or there is a big issue...
            }
            const defMess = this._awaitingReply.get(m.correlationId());
            if (m.isError()) {
                this._logger.log('Found a rejection...');
                defMess.deferred.reject(m.error());
                this._awaitingReply.delete(m.correlationId());
                return;
            }
            if (m.isStream()) {
                if (typeof defMess.streamHandler !== 'function') {
                    if (isNullOrUndefined(defMess.accumulator)) {
                        defMess.accumulator = [];
                    }
                    defMess.accumulator.push(m);
                } else {
                    defMess.streamHandler(m);
                }
            } else {
                if (!isNullOrUndefined(defMess.accumulator)) {
                    defMess.deferred.resolve(defMess.accumulator);
                } else {
                    defMess.deferred.resolve(m);
                }
                this._awaitingReply.delete(m.correlationId());
            }
            return;
        }
        if (!this._routes.has(routeAlias)) {
            m.nativeReject();
            if (this._eventEmitter.listenerCount('unhandledMessage') > 0) {
                this._eventEmitter.emit('unhandledMessage', new CustomError(`Handler for ${m.destinationRoute()} missing.`), m);
            }
            return;
        }
        route.handler.call(this, m);
    }

    /**
     * Asserts all routes into existence. Idempotent.
     */
    private async _assertRoutes() {
        const proms: Promise<void>[] = [];
        this._routes.forEach((value, routeAlias) => {
            proms.push(this._assertRoute(routeAlias));
        });
        return await Promise.all(proms);
    }
}
