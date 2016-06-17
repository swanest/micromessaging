let rabbot = require("rabbot"),
    util = require("util"),
    _ = require("lodash"),
    EventEmitter = require('events').EventEmitter,
    logLib = require("logger"),
    uuid = require("node-uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    Q = require("q"),
    CustomError = logLib.CustomError;

rabbot.nackOnError();
rabbot.nackUnhandled();
rabbot.hasHandles = true; //mute warnings when we subscribe to the queues without any handler

const genPromise = (r) => {
    let d = Q.defer(); //because of ‘onProgress‘
    setImmediate(()=> {
        d.resolve(r);
    });
    return d.promise;
};

const Service = function Service(name = uuid.v1()) {
    this.name = name;
    let emitter = new EventEmitter(),
        settings = {},

        UNIQUE_ID = uuid.v4(),
        SERVICE_NAME = name,
        EXCHANGE_MESSAGES = {
            name: "x-messages",
            type: "topic",
            durable: false,
            persistent: false,
            limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
        },
        EXCHANGE_REQUESTS = {
            name: "x-requests-" + SERVICE_NAME,
            type: "direct",
            durable: false,
            persistent: false,
            limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
        },
        Q_PUBLIC_MESSAGES = {
            name: "q-public-messages-" + SERVICE_NAME + "-" + UNIQUE_ID,
            limit: Math.pow(2, 16) - 1,
            queueLimit: Math.pow(2, 32) - 1,
            exclusive: true,
            noAck: true,
            subscribe: false, //subscription is made manually
            noBatch: false
        },
        Q_PRIVATE_MESSAGES = {
            name: "q-private-messages-" + SERVICE_NAME + "-" + UNIQUE_ID,
            limit: Math.pow(2, 16) - 1,
            queueLimit: Math.pow(2, 32) - 1,
            exclusive: true,
            noAck: true,
            subscribe: false, //subscription is made manually
            noBatch: false
        },
        Q_REQUESTS = {
            name: "q-req-" + SERVICE_NAME,
            limit: Math.pow(2, 16) - 1,
            queueLimit: Math.pow(2, 32) - 1,
            exclusive: false,
            noAck: false,
            subscribe: false, //subscription is made manually
            noBatch: false
        },
        REPLY_QUEUE = {
            name: "q-responses-" + SERVICE_NAME + "-" + UNIQUE_ID,
            limit: Math.pow(2, 16) - 1,
            queueLimit: Math.pow(2, 32) - 1,
            exclusive: true,
            autoDelete: true,
            noAck: true,
            subscribe: true,
            noBatch: false
        }

    rabbot.once(SERVICE_NAME + ".connection.connected", () => {
        emitter.emit("connected");
    });
    rabbot.once(SERVICE_NAME + ".connection.closed", () => {
        emitter.emit("closed");
    });
    rabbot.on(SERVICE_NAME + ".connection.failed", (err) => {
        emitter.emit("failed", err);
    });
    rabbot.once(SERVICE_NAME + ".connection.unreachable", () => {
        emitter.emit("unreachable");
    });
    rabbot.onReturned((message) => {
        emitter.emit("unroutableMessage", message);
    });
    rabbot.onUnhandled((message) => {
        emitter.emit("unhandledMessage", message);
    });

    this.on = emitter.on.bind(emitter);
    this.once = emitter.once.bind(emitter);

    this.close = ()=> {
        return rabbot.close(SERVICE_NAME, true);
    };

    this.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {
        settings.name = SERVICE_NAME;
        settings.connection = {uri: uri, name: SERVICE_NAME, replyQueue: REPLY_QUEUE};
        settings.exchanges = [EXCHANGE_MESSAGES, EXCHANGE_REQUESTS];
        settings.queues = [Q_PUBLIC_MESSAGES, Q_PRIVATE_MESSAGES, Q_REQUESTS];
        settings.bindings = [
            {
                exchange: EXCHANGE_MESSAGES.name,
                target: Q_PRIVATE_MESSAGES.name,
                keys: ["*." + SERVICE_NAME + ".#"]
            },
            {
                exchange: EXCHANGE_MESSAGES.name,
                target: Q_PUBLIC_MESSAGES.name,
                keys: ["public.#"]
            },
            {
                exchange: EXCHANGE_REQUESTS.name,
                target: Q_REQUESTS.name,
                keys: ["task"]
            }
        ];
        return rabbot.configure(settings).then(() => {
            emitter.emit("connected");
        }).catch(function () {
        });
    };


    this.subscribe = () => {
        rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, SERVICE_NAME);
        rabbot.startSubscription(Q_PUBLIC_MESSAGES.name, Q_PUBLIC_MESSAGES.exclusive, SERVICE_NAME);
        rabbot.startSubscription(Q_PRIVATE_MESSAGES.name, Q_PRIVATE_MESSAGES.exclusive, SERVICE_NAME);
    };

    //this.pause = () => {
    //    rabbot.stopSubscription(Q_REQUESTS.name, SERVICE_NAME);
    //    rabbot.stopSubscription(Q_PUBLIC_MESSAGES.name, SERVICE_NAME);
    //    rabbot.stopSubscription(Q_PRIVATE_MESSAGES.name, SERVICE_NAME);
    //};

    this.emit = (serviceName, route, data, headers = {}, isPublic = false) => {
        if (serviceName == "*")
            serviceName = "___ALL___", isPublic = true;
        let r = (isPublic ? "public." : "private.") + serviceName + "." + route, ex = genPromise();
        if (!rabbot.getExchange(EXCHANGE_MESSAGES.name, SERVICE_NAME))
            ex = rabbot.addExchange(EXCHANGE_MESSAGES, SERVICE_NAME);
        return ex.then(function () {
            return rabbot.publish(EXCHANGE_MESSAGES.name,
                {
                    type: r,
                    body: data,
                    expiresAfter: 60 * 1000, // TTL in ms
                    mandatory: true, //Must be set to true for onReturned to receive unqueued message
                    headers: headers,
                    timeout: 10 * 60 * 1000, // ms to wait before cancelling the publish and rejecting the promise
                    connectionName: SERVICE_NAME
                }
            );
        });
    };


    this.listen = (route, handler, serviceName = SERVICE_NAME) => {
        let q = serviceName == SERVICE_NAME ? Q_PRIVATE_MESSAGES.name : Q_PUBLIC_MESSAGES.name,
            r = "*." + serviceName + "." + route;
        rabbot.handle({
            queue: q,
            type: r, // handle messages with this type name or pattern
            autoNack: true, // automatically handle exceptions thrown in this handler
            context: null // control what `this` is when invoking the handler
        }, handler);
    };


    this.request = (serviceName, taskName, data, headers = {}) => {
        let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = genPromise();
        TEMP_EXCHANGE_REQUESTS.name = "x-requests-" + serviceName;
        if (!rabbot.getExchange(TEMP_EXCHANGE_REQUESTS.name, SERVICE_NAME))
            ex = rabbot.addExchange(TEMP_EXCHANGE_REQUESTS, SERVICE_NAME);
        return ex.then(function () {
            return rabbot.request(TEMP_EXCHANGE_REQUESTS.name,
                {
                    type: taskName,
                    routingKey: "task",
                    body: data,
                    expiresAfter: 60 * 1000, // TTL in ms
                    mandatory: true, //Must be set to true for onReturned to receive unqueued message
                    headers: headers,
                    timeout: 10 * 60 * 1000, // publish timeout
                    replyTimeout: 10 * 60 * 1000, //10 min
                    connectionName: SERVICE_NAME
                }
            );
        });
    };


    this.pendingRequests = (serviceName) => {
        throw "unimplemented";
    };

    this.handle = (taskName, handler) => {
        rabbot.handle({
            queue: Q_REQUESTS.name,
            type: taskName, // handle messages with this type name or pattern
            autoNack: true, // automatically handle exceptions thrown in this handler
            context: null // control what `this` is when invoking the handler
        }, handler);
    };


    this.prefetch = (count) => {

        throw "unimplemented";
        //return this.close().then(()=> {
        //    Q_REQUESTS.limit = count;
        //    return rabbot.configure(settings).then(() => {
        //        return this.subscribe();
        //    }).catch(function () {
        //    });
        //});


        //return rabbot.addQueue(Q_REQUESTS.name, Q_REQUESTS, SERVICE_NAME).then(function () {
        //    return;
        //});


        let queueChannel = rabbot.
            connections[SERVICE_NAME].channels["queue:" + Q_REQUESTS.name]
            .queue.channel;

        //let exchangeChannel = rabbot.
        //    connections[SERVICE_NAME].channels["exchange:" + EXCHANGE_REQUESTS.name]
        //    .exchange.channel;

        //exchangeChannel.prefetch(count);
        //queueChannel.prefetch(count);

        //console.log(rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, SERVICE_NAME));

        //return rabbot.stopSubscription(Q_REQUESTS.name, SERVICE_NAME).then(function () {
        //    console.log("stopped");
        //    return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, SERVICE_NAME)
        //});


        //
        //console.log(this.pause());
        //
        //console.log("next");
        //
        //setTimeout(()=> {
        //    this.ready();
        //    console.log("acceeee");
        //}, 300);


        //exchangeChannel.close();
        //queueChannel.close();

    };

};


module.exports = Service;
