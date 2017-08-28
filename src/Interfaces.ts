import { Channel } from 'amqplib';
import { Message } from './Message';
import { Message as AMessage } from 'amqplib';
import Deferred = When.Deferred;
import Timer = NodeJS.Timer;
import { PeerStat } from './PeerStatus';

export type ExchangeType = 'topic' | 'direct' | 'fanout';

export interface Exchange {
    name: string;
    type: ExchangeType;
    options?: ExchangeOptions;
}

export interface ExchangeOptions {
    durable: boolean;
    internal: boolean;
    autoDelete: boolean;
    alternateExchange: string;
}

export interface Queue {
    name: string;
    options?: QueueOptions;
}

export interface QueueOptions {
    exclusive?: boolean;
    durable?: boolean;
    autoDelete?: boolean;
    messageTtl?: number;
    expires?: number;
    deadLetterExchange?: string;
    maxLength?: number;
    maxPriority?: number;
}

export interface MessageHandler {
    (message: Message): void;
}

export interface Route {
    route: string;
    type: RouteType;
    handler: MessageHandler;
    options: ListenerOptions;
    consumerTag?: string;
    target?: string;
    channel?: Channel;

    subjectToQuota?: boolean;
    ongoingMessages?: number;
    maxParallelism?: number;

    cancel?: () => Promise<void>;
    consume?: () => Promise<void>;
    consumerWaiter?: any;

    isDeclaring: boolean;
    isReady: boolean;
    isClosed: boolean;

    queueName?: string;
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
    timeout?: number; // expressed in milliseconds. Timeout to transmit the message to rabbit
    // expiresIn?: number; // expressed in milliseconds. Listeners to the event/message must read it within this interval
    // replyTimeout?: number; // express in milliseconds. Maximum time to receive an answer
    noAck?: boolean; // defaults to false. Used to say we don't expect to get an ACK for the sent task.
    // maxParallel?: number; // defaults to unlimited. Limits the number of parallel requests for this route at the same time
    // onlyMaster?: boolean; // defaults to false. Task will only arrive on the master node.
    // hasPriority?: boolean; // defaults to false.
}

export interface EmitOptions {
    timeout?: number; // expressed in milliseconds. Timeout to transmit the message to rabbit
    expiresIn?: number; // expressed in milliseconds. Listeners to the event/message must read it within this interval
    private?: boolean; // .privately.emit(..) and .privately.emit(.., {private: true}) are the same.
    hasPriority?: boolean; // defaults to false.
    onlyIfConnected?: boolean;

    expiresAfter?: number; // deprecated, use expiresIn instead
}

export interface ServiceOptions {
    enableQos?: boolean; // Default: true. Quality of service will check event-loop delays to keep CPU usage under QosThreshold
    qosThreshold?: number; // Default: 0.7. [0.01; 1]
    enableMemoryQos?: boolean; // Defaults: true. When activated, tries to keep memory < memorySoftLimit and enforces keeping memory < memoryHardLimit
    memorySoftLimit?: number; // Defaults to half heap_size_limit. Expressed in MB
    memoryHardLimit?: number; // Defaults to 3 fifth of heap_size_limit. Express in MB
    readyOnConnected?: boolean;
    // parallelism?: ParallelismOptions;
}

// export interface ParallelismOptions {
//     requestsLimit: number; // Default: -1 (unlimited). At any time how many max parallel requests.
//     tasksLimit: number; // Default: -1 (unlimited). At any time how many max parallel requests.
// }

export interface ListenerOptions {
    maxParallel?: number; // Max number of parallel messages. When set, will create a
}

export interface RequestReport {
    queueSize: number;
    queueName: string;
    consumers: number;
}

export interface ReturnHandler {
    /**
     * Make that the listener stops consuming messages.
     */
    stop: () => Promise<void>;
    stat: () => Promise<RequestReport>;
}

export interface ReplyAwaiter {
    streamHandler: (m: Message) => void;
    deferred: Deferred<Message | Message[]>;
    accumulator?: Array<Message>;
    timer: Timer;
}

export interface MessageHeaders {
    idRequest?: string;

    [name: string]: any;
}

export interface Uptime {
    startedAt: Date;
    elapsedMs: number;
}
