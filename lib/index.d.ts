/*
 Data-structures
 */

import * as When from 'when';

declare namespace Types {
    type event = "unroutableMessage" | "unhandledMessage" | "closed" | "failed" | "unreachable" | "connected" | "elected" | "electedAndSubscribing" | "electedAndReady" | "subscribing" | "ready" | "unready";
    type exchange = "direct" | "fanout" | "topic";
    type queue = "direct" | "fanout" | "topic";
}

declare namespace Config {

    interface Exchange {
        autoDelete: boolean;
        durable: boolean;
        persistent: boolean;
        alternate?: string;
        limit?: number;
    }

    interface Queue {
        autoDelete: boolean;
        queueLimit?: number;
        expires?: number;
        maxPriority?: number;
        noBatch?: boolean
    }

    interface MemoryPressure {
        memoryThreshold: number;
        interval: number;
        consecutiveGrowths: number;
        nackAfter?: number;
    }

    interface Discoverable {
        intervalCheck: number;
        electionTimeout: number;
    }

    interface Setup {
        simultaneousRequests?: number;
        timeoutToSubscribe?: number;
        discoverable?: boolean | Discoverable;
        memoryPressureHandled?: boolean | MemoryPressure;
        entities?: {
            EXCHANGE_MESSAGES?: Exchange;
            EXCHANGE_REQUESTS?: Exchange;
            EXCHANGE_DEAD_REQUESTS?: Exchange;
            Q_MESSAGES?: Queue;
            Q_SHARED_MESSAGES?: Queue;
            Q_RESPONSES?: Queue;
            Q_REQUESTS?: Queue;
            Q_DEAD_REQUESTS?: Queue;
        }
    }

    interface Emit {
        timeout?: number;
        expiresAfter: number;
        isPublic?: boolean;
        mandatory?: boolean;
    }

    interface ScopeEmit {
        timeout?: number;
        expiresAfter: number;
        mandatory?: boolean;
    }

    interface Request {
        timeout?: number;
        expiresAfter?: number;
        replyTimeout: number;
    }

    interface Task {
        timeout?: number;
        expiresAfter: number;
    }

    interface GetStatus {
        isElected?: boolean;
        expiresAfter?: number;
    }

    interface WaitForService {
        isElected?: boolean;
        timeout?: number;
    }
}

/*
 Interfaces
 */

interface ListenResult {
    onError: (cb: (err: Error, message: SimpleMessage) => void) => {
        remove: () => When.Promise<any>;
        promise: When.Promise<any>;
    };
    remove: () => When.Promise<any>;
    promise: When.Promise<any>;
}

interface HandleResult {
    onError: (cb: (err: Error, message: Message) => void) => {
        remove: () => When.Promise<any>;
        promise: When.Promise<any>;
    };
    remove: () => When.Promise<any>;
    promise: When.Promise<any>;
}


interface MemoryUsage {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external?: number;
}

interface ServiceInstanceSummary {
    serviceName: string;
    uniqueID: string;
    onlineSince: number;
    isReady: boolean;
    isElected: boolean;
    memoryUsage: MemoryUsage;
}

interface Status {
    isReady: boolean;
    instances: Array<ServiceInstanceSummary>;
}

interface SimpleMessage {
    type: string;
    body: any;
    headers: Object;
    properties: {
        isRedelivered: boolean;
        exchange: string;
        queue: undefined | string;
        routingKey: string;
        path: string;
        id?: string;
        correlatedTo?: string;
        contentType: string;
        contentEncoding: string;
        expiresAfter: number;
        timestamp: number;
        replyTo?: {
            exchange: '';
            queue: string;
            routingKey: string;
            path: string;
        };
    };
    status: "PENDING" | "ACKED" | "NACKED" | "REJECTED";
}

interface Message extends SimpleMessage {
    //Requests
    write(body?: any, headers?: any): void;
    end(body?: any, headers?: any): void;
    reply(body?: any, headers?: any): void;
    reject(): void; //if it is a request, then client won't receive any response
    ack(): void; //only for tasks
    nack(): void;
}

interface ScopeEmit {
    emit(serviceName: string, route: string, body: any, headers?: any, opts?: Config.ScopeEmit): When.Promise<void>;
}

interface ScopeListen {
    listen(route: string, cb: (mesage: Message) => void, serviceName?: string): ListenResult;
}

declare interface ProgressivePromise<T> extends When.Promise<T> {
    progress(onProgress?: (progress: T) => void): When.Promise<T>;
}

interface MemoryListen {
    on(event: 'underPressure'| 'pressureReleased', cb: (mem: {ack: ()=>void; memoryUsageHistory: Array<MemoryUsage>; }) => void): void;
}

export declare class Service {
    name: string;
    uniqueID: string;
    isElected: boolean;
    memoryPressureHandler?: MemoryListen;

    // Are these necessary ?
    // noCheck: boolean;
    // queueName: string;
    // exchange: string;

    constructor(name: string, setupOpts?: Config.Setup);

    on(event: 'unroutableMessage', cb: (message: SimpleMessage) => void): void;
    on(event: 'unhandledMessage', cb: (message: Message) => void): void;
    on(event: 'failed', cb: (error: Error) => void): void;
    on(event: Types.event, cb?: (message: Message | Error) => void): void;

    once(event: Types.event, cb?: (message: Message | Error) => void): void;

    close(): When.Promise<void>;

    connect(uri?: string): When.Promise<void>;

    subscribe(setAsReady?: boolean): When.Promise<void>;

    emit(serviceName: string, route: string, body?: any, headers?: any, opts?: Config.Emit): When.Promise<void>;

    publicly: ScopeEmit;
    privately: ScopeEmit;

    request(serviceName: string, taskName: string, body?: any, headers?: any, opts?: Config.Request): ProgressivePromise<SimpleMessage>;

    task(serviceName: string, taskName: string, body?: any, headers?: any, opts?: Config.Task): When.Promise<void>;

    notify(serviceName: string, taskName: string, body?: any, headers?: any, opts?: Config.Task): When.Promise<void>;

    listen(route: string, cb: (message: Message) => void, serviceName?: string): ListenResult;

    exclusively: ScopeListen;
    death: ScopeListen;

    handle(taskName: string, cb: (message: Message) => void): HandleResult;

    prefetch(count?: number): When.Promise<void>;

    getWaitingRequests(): {status: boolean; nackTimeout: any; bulk: Array<{defer: When.Deferred<any>;message: any}>};

    setMemoryHandling(params?: boolean | Config.MemoryPressure): boolean;

    getRequestReport(serviceName: string): When.Promise<{queueSize: number;}>;

    setAsReady(): this;

    setAsUnready(): this;

    getStatus(serviceName: string, opts?: Config.GetStatus): When.Promise<Status>

    waitForService(serviceName: string, opts?: Config.WaitForService): When.Promise<Status>

    waitForServices(serviceNames: Array<string>, opts?: Config.WaitForService): When.Promise<Array<Status>>


}