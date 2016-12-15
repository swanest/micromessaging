/*
 Data-structures
 */

import * as When from 'when';

declare namespace Types {
    type event = "unroutableMessage" | "unhandledMessage" | "closed" | "failed" | "unreachable" | "connected" | "elected";
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
    }

    interface MemoryPressure {
        memoryThreshold: number;
        interval: number;
        stillUnderPressure: number;
        consecutiveGrowths: number;
    }

    interface Setup {
        discoverable?: boolean;
        memoryPressureHandled?: boolean | MemoryPressure
        config?: {
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
    }

    interface ScopeEmit {
        timeout?: number;
        expiresAfter: number;
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

}

/*
 Interfaces
 */

interface ListenHandleResult {
    onError: (cb: Function) => {
        remove: () => When.Promise<any>,
        promise: When.Promise<any>
    };
    remove: () => When.Promise<any>;
    promise: When.Promise<any>;
}

interface SimpleMessage {
    type: string;
    body: any;
    properties: {
        isRedelivered: boolean;
        exchange: string;
        queue: undefined | string;
        routingKey: string;
        path: string;
        id?: string;
        correlatedTo?: string
        contentType: string;
        contentEncoding: string;
        expiresAfter: number;
        timestamp: number;
        replyTo?: {
            exchange: '';
            queue: string;
            routingKey: string;
            path: string;
        }
    };
    status: "PENDING" | "ACKED" | "NACKED" | "REJECTED";
}

interface Message extends SimpleMessage {
    //Requests
    write(body: any, headers?: any): void;
    end(body: any, headers?: any): void;
    reply(body: any, headers?: any): void;
    reject(): void; //if it is a request, then client won't receive any response
    ack(): void; //only for tasks
    nack(): void;
}

interface ScopeEmit{
    emit(serviceName: string, route: string, body: any, headers?: any, opts?: Config.ScopeEmit): When.Promise<void>;
}

interface ScopeListen{
    listen(route: string, cb: (mesage: Message) => void, serviceName?: string): ListenHandleResult;
}

export declare class Service {
    name: string;
    uniqueID: string;
    replications: Array<any>;
    isElected: boolean;

    // Are these necessary ?
    // noCheck: boolean;
    // queueName: string;
    // exchange: string;

    constructor(name: string, setupOpts?: Config.Setup);

    on(event: 'unroutableMessage', cb: (message: SimpleMessage) => void): void;
    on(event: 'unhandledMessage', cb: (message: Message) => void): void;
    on(event: 'failed', cb: (error: Error) => void): void;
    on(event: 'closed', cb: () => void): void;
    on(event: 'unreachable', cb: () => void): void;
    on(event: 'connected', cb: () => void): void;
    on(event: 'elected', cb: () => void): void;

    once(event: Types.event, cb?: (message: Message | Error) => void): void;

    close(): When.Promise<void>;

    connect(uri?: string): When.Promise<void>;

    subscribe(): When.Promise<void>;

    emit(serviceName: string, route: string, body: any, headers?: any, opts?: Config.Emit): When.Promise<void>;

    publicly: ScopeEmit;
    privately: ScopeEmit;

    request(serviceName: string, taskName: string, body: any, headers?: any, opts?: Config.Request): When.Promise<Message>;

    task(serviceName: string, taskName: string, body: any, headers?: any, opts?: Config.Task): When.Promise<void>;

    notify(serviceName: string, taskName: string, body: any, headers?: any, opts?: Config.Task): When.Promise<void>;

    listen(route: string, cb: (message: Message) => void, serviceName?: string): ListenHandleResult;

    exclusively: ScopeListen;
    death: ScopeListen;

    handle(taskName: string, cb: (message: Message) => void): ListenHandleResult;

    prefetch(count: number): When.Promise<void>;

    getRequestReport(serviceName: string): When.Promise<{queueSize: number;}>;

}