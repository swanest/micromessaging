import { Channel } from 'amqplib';
import { Deferred } from './Deferred';
import { Message } from './Message';
import { PeerStat } from './PeerStatus';
import Timer = NodeJS.Timer;

export type ExchangeType = 'topic' | 'direct' | 'fanout';

export interface Exchange {
    name: string;
    options?: ExchangeOptions;
    type: ExchangeType;
}

export interface ExchangeOptions {
    alternateExchange: string;
    autoDelete: boolean;
    durable: boolean;
    internal: boolean;
}

export interface Queue {
    name: string;
    options?: QueueOptions;
}

export interface QueueOptions {
    autoDelete?: boolean;
    deadLetterExchange?: string;
    durable?: boolean;
    exclusive?: boolean;
    expires?: number;
    maxLength?: number;
    maxPriority?: number;
    messageTtl?: number;
}

export interface MessageHandler {
    (message: Message): void;
}

export interface Route {
    _answerTimers?: Timer[];
    cancel?: () => Promise<void>;
    channel?: Channel;
    consume?: () => Promise<void>;
    consumerTag?: string;
    consumerWaiter?: any;
    handler: MessageHandler;
    isCancelling?: any;
    isClosed: boolean;
    isDeclaring: boolean;
    isReady: boolean;
    maxParallelism?: number;
    noAck: boolean;
    ongoingBytes: number;
    ongoingMessages?: number;
    options: ListenerOptions;
    queueName?: string;
    route: string;
    subjectToQuota?: boolean;
    target?: string;
    type: RouteType;
}

export type RouteType = 'rpc' | 'pubSub' | 'rpcReply';

export interface StatusOptions {
    hasMaster?: boolean; // Defaults to false. When true, won't resolve before target service has elected a master instance.
    timeout?: number; // Defaults is unlimited. Expressed in MS. If the target service isn't ready within that time promise is rejected.
    whenReady?: boolean; // Defaults to false on getStatus(..) and true on waitForServices(..)
}

export interface Status {
    hasMaster: boolean;
    hasReadyMembers: boolean;
    members: Array<PeerStat>;
}

export interface RequestOptions {
    /**
     * @param replyTimeout Defaults to 3000 (MS)
     * @param hasPriority Defaults to false
     */
    // timeout?: number; // expressed in milliseconds. Timeout to transmit the message to rabbit
    // expiresIn?: number; // expressed in milliseconds. Listeners to the event/message must read it within this interval
    timeout?: number; // express in milliseconds. Maximum time to receive an answer
    // maxParallel?: number; // defaults to unlimited. Limits the number of parallel requests for this route at the same time
    // onlyMaster?: boolean; // defaults to false. Request will only arrive on the master node.
    // hasPriority?: boolean; // defaults to false.
}

export interface TaskOptions {
    // replyTimeout?: number; // express in milliseconds. Maximum time to receive an answer
    noAck?: boolean; // defaults to false. Used to say we don't expect to get an ACK for the sent task.
    // expiresIn?: number; // expressed in milliseconds. Listeners to the event/message must read it within this interval
    timeout?: number; // expressed in milliseconds. Timeout to transmit the message to rabbit
    // maxParallel?: number; // defaults to unlimited. Limits the number of parallel requests for this route at the same time
    // onlyMaster?: boolean; // defaults to false. Task will only arrive on the master node.
    // hasPriority?: boolean; // defaults to false.
}

export interface EmitOptions {
    expiresAfter?: number; // deprecated, use expiresIn instead
    expiresIn?: number; // expressed in milliseconds. Listeners to the event/message must read it within this interval
    hasPriority?: boolean; // defaults to false.
    onlyIfConnected?: boolean;
    private?: boolean; // .privately.emit(..) and .privately.emit(.., {private: true}) are the same.
    timeout?: number; // expressed in milliseconds. Timeout to transmit the message to rabbit
}

export interface ServiceOptions {
    enableMemoryQos?: boolean; // Defaults: true. When activated, tries to keep memory < memorySoftLimit and enforces keeping memory < memoryHardLimit
    enableQos?: boolean; // Default: true. Quality of service will check event-loop delays to keep CPU usage under QosThreshold
    memoryHardLimit?: number; // Defaults to 3 fifth of heap_size_limit. Express in MB
    memorySoftLimit?: number; // Defaults to half heap_size_limit. Expressed in MB
    qosThreshold?: number; // Default: 0.7. [0.01; 1]
    readyOnConnected?: boolean;
    retryStrategy?: RetryStrategy;
    // parallelism?: ParallelismOptions;
}

export interface RetryStrategy {
    /**
     * The retry strategy to apply.
     * Returning a number will make the library wait for that amount of milliseconds before trying again.
     * Returning anything else than a number will make the process stop trying.
     * By default it will wait up to 30s where each attempt is: #attempt * 1s + 1ms
     * @param error why the connection attempt failed
     * @param attempts number of connection attempts
     * @param totalTime total time elapsed since last time connected or since initialization in the case it's the first connection
     */
    (error: Error, attempts: number, totalTime: number): number;
}

// export interface ParallelismOptions {
//     requestsLimit: number; // Default: -1 (unlimited). At any time how many max parallel requests.
//     tasksLimit: number; // Default: -1 (unlimited). At any time how many max parallel requests.
// }

export interface ListenerOptions {
    maxParallel?: number; // Max number of parallel messages. When set, will create a
    maxParallelBytes?: number; // Caps the amount of that received
}

export interface RequestReport {
    consumers: number;
    queueName: string;
    queueSize: number;
}

export interface ReturnHandler {
    stat: () => Promise<RequestReport>;
    /**
     * Make that the listener stops consuming messages.
     */
    stop: (options?: ReturnHandlerStopOpts) => Promise<void>;
}

/**
 * @param deletedQueue defaults to true
 */
export interface ReturnHandlerStopOpts {
    deleteQueue?: boolean;
}

export interface ReplyAwaiter {
    accumulator?: Array<Message>;
    deferred: Deferred<Message | Message[]>;
    sequence: number;
    streamHandler: (m: Message) => void;
    timer: Timer;
    timerMs: number;
}

export interface MessageHeaders {
    idRequest?: string;

    [name: string]: any;
}

export interface Uptime {
    elapsedMs: number;
    startedAt: Date;
}

export interface Leader {
    leaderId: string;
}
