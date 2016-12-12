declare namespace micromessaging {
    interface TwoPromises {
        removeSubscription: <T>() => When.Promise<T>;
        finalPromise: When.Promise<any>;
    }

    interface ListenHandleResult {
        onerror: (cb: Function) => TwoPromises;
        removeSubscription: <T>() => When.Promise<T>;
        finalPromise: When.Promise<any>;
    }

    interface BaseConfig {
        name: string;
        durable: boolean;
        limit: number;
    }

    interface TypeConfig {
        type: string;
    }

    interface PersistentConfig {
        persistent: boolean;
    }

    interface QueueLimitConfig {
        queueLimit: number;
    }

    interface ExclusiveConfig {
        exclusive: boolean;
    }

    interface AutoDeleteConfig {
        autoDelete: boolean;
    }

    interface NoAckConfig {
        noAck: boolean;
    }

    interface SubscribeConfig {
        subscribe: boolean;
    }

    interface ExpiresConfig {
        expires: number;
    }

    interface NoBatchConfig {
        noBatch: boolean;
    }

    interface ExchangeMessagesConfig extends BaseConfig, TypeConfig, PersistentConfig {
    }

    interface ExchangeRequestsConfig extends BaseConfig, TypeConfig, PersistentConfig {
    }

    interface ExchangeDeadRequestsConfig extends BaseConfig, TypeConfig, PersistentConfig {
    }

    interface QMessagesConfig extends BaseConfig, QueueLimitConfig, ExclusiveConfig, AutoDeleteConfig, NoAckConfig,
        SubscribeConfig, ExpiresConfig {
    }

    interface QSharedMessagesConfig extends BaseConfig, QueueLimitConfig, ExclusiveConfig, AutoDeleteConfig, NoAckConfig,
        SubscribeConfig, ExpiresConfig {
    }

    interface QResponsesConfig extends BaseConfig, QueueLimitConfig, NoAckConfig, SubscribeConfig, ExclusiveConfig,
        AutoDeleteConfig, ExpiresConfig {
    }

    interface QRequestsConfig extends BaseConfig, QueueLimitConfig, ExclusiveConfig, NoAckConfig, SubscribeConfig,
        NoBatchConfig, ExpiresConfig {
    }

    interface QDeadRequestsConfig extends BaseConfig, QueueLimitConfig, ExclusiveConfig, AutoDeleteConfig, NoAckConfig,
        SubscribeConfig, ExpiresConfig {
    }

    export interface SetupOptsConfig {
        EXCHANGE_MESSAGES?: ExchangeMessagesConfig;
        EXCHANGE_REQUESTS?: ExchangeRequestsConfig;
        EXCHANGE_DEAD_REQUESTS?: ExchangeDeadRequestsConfig;
        Q_MESSAGES?: QMessagesConfig;
        Q_SHARED_MESSAGES?: QSharedMessagesConfig;
        Q_RESPONSES?: QResponsesConfig;
        Q_REQUESTS?: QRequestsConfig;
        Q_DEAD_REQUESTS?: QDeadRequestsConfig;
    }

    export interface MessageProperties {
        isRedelivered: boolean;
        exchange: string;
        queue: string;
        routingKey: string;
        path: string;
    }

    export interface Message {
        body: any;
        properties: MessageProperties;
        status: string;
        type: string;

        write(message: any): When.Promise<any>;

        reply(message: any): When.Promise<any>;

        reject(message: any): When.Promise<any>;

        end(message: any): When.Promise<any>;

        ack(): void;

        nack(): void;
    }

    export interface SetupOpts {
        discoverable?: boolean,
        memoryPressureHandled?: boolean,
        config?: SetupOptsConfig;
    }

    export interface Service {
        name: string;
        uniqueID: string;
        replications: Array<any>;
        isElected: boolean;

        // Are these necessary ?
        // onlineSince: Date;
        // noCheck: boolean;
        // queueName: string;
        // exchange: string;

        new (name: string, setupOpts?: SetupOpts): Service;

        on(event: string | symbol, cb?: (message: any) => void): this;

        once(event: string | symbol, cb?: (message: any) => void): this;

        // Don't think this oen shall be exposed
        //__emit(event: string | symbol, ...args: any[]): boolean;

        close<T>(): When.Promise<T>;

        connect<T>(uri?: string): When.Promise<T>;

        subscribe<T>(): When.Promise<T>;

        // headers and opts could be an interface
        emit<T>(serviceName: string, route: string, data: any, headers?: any, opts?: any): When.Promise<T>;

        request<T>(serviceName: string, taskName: string, data: any, headers?: any, opts?: any): When.Promise<T>;

        task<T>(serviceName: string, taskName: string, data: any, headers?: any, opts?: any): When.Promise<T>;

        notify<T>(serviceName: string, taskName: string, data: any, headers?: any, opts?: any): When.Promise<T>;

        listen(route: string, cb: (mesage: Message) => void, serviceName?: string): ListenHandleResult;

        handle(taskName: string, cb: (mesage: Message) => void): ListenHandleResult;

        prefetch(count: number): any;

        getRequestReport(serviceName: string): any;

    }
}

declare var micromessaging: micromessaging.Service;
export = micromessaging;