let rabbot = require("rabbot"),
    util = require("util"),
    _ = require("lodash"),
    EventEmitter = require('events').EventEmitter,
    logLib = require("logger"),
    uuid = require("node-uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    when = require("when"),
    CustomError = logLib.CustomError;

//Rabbot configuration
rabbot.hasHandles = true; //mute warnings when we start subscribing to the queues without any handler already in place
rabbot.ignoreHandlerErrors(); //It is not micromessaging's job to handle processes' errors


//Helpers and constants
const isPositiveFinite = (n) => {
    return _.isFinite(n) && n >= 0;
};

const ALLOWED_OPTIONS = {
    timeout: isPositiveFinite,
    replyTimeout: isPositiveFinite,
    expiresAfter: isPositiveFinite,
    isPublic: _.isBoolean
};

const RESERVED_HEADERS = [
    "position",
    "sequence_end",
    "response_forbidden"
];

const cleanHeaders = (h) => {
    if (_.isPlainObject(h)) {
        RESERVED_HEADERS.forEach((k) => {
            _.unset(h, k);
        });
    }
    return h || {};
};

const checkHeaders = (h) => {
    if (h != void 0 && !_.isPlainObject(h))
        throw new CustomError("invalidArg", "Headers must be a plainObject", 500, "fatal");
    if (_.isPlainObject(h)) {
        for (let i = 0; i < RESERVED_HEADERS.length; i++) {
            if (h[RESERVED_HEADERS[i]] != void 0)
                throw new CustomError("unAllowedHeader", "h." + RESERVED_HEADERS[i] + " is reserved", 500, "fatal");
        }
    }
    return h || {};
};

const checkOpts = (opts, ...keys) => {
    if (opts != void 0 && !_.isPlainObject(opts))
        throw new CustomError("invalidArg", "Options must be a plainObject", 500, "fatal");
    if (!opts || !keys.length)
        return opts || {};
    let cloned = _.clone(opts);
    for (let i = 0; i < keys.length; i++) {
        let k = keys[i];
        if (opts[k] == void 0) continue;
        if (!ALLOWED_OPTIONS[k](opts[k]))
            throw new CustomError("unAllowedOptionValue", k + " with value " + opts[k] + " is not a valid", 500, "fatal");
        delete cloned[k];
    }
    if (_.keys(cloned).length)
        throw new CustomError("unAllowedOptions", "valid options are: " + keys.join(","), 500, "fatal");
    return opts;
};

//This wrapper needs to expose a filtered message object in order to limit rabbot's dependency from outside
const filter = (message, omitKeys) => {
    if (message == void 0)
        return;
    let msg = {
        headers: cleanHeaders(message.properties.headers),
        body: message.body,
        properties: {
            isRedelivered: message.fields.redelivered ? true : false,
            exchange: message.fields.exchange,
            routingKey: message.fields.routingKey,
            path: message.properties.type,
            contentType: message.properties.contentType,
            contentEncoding: message.properties.contentEncoding,
            expiresAfter: parseInt(message.properties.expiration),
            timestamp: parseInt(message.properties.timestamp)
        }
    };
    if (_.isString(message.properties.correlationId) && message.properties.correlationId != "")
        msg.properties.reply = {
            correlationId: message.properties.correlationId,
            queue: message.properties.replyTo
        };
    if (message.ack)
        msg.ack = message.ack;
    if (message.nack)
        msg.nack = message.nack;
    if (message.reject)
        msg.reject = message.reject;
    if (message.reply)
        msg.reply = message.reply;
    if (_.isArray(omitKeys))
        omitKeys.forEach(function (k) {
            _.unset(msg, k)
        });
    if (msg.reply != void 0) {
        let originalReplyFunc = msg.reply,
            replyFunc = (m, headers) => {
                originalReplyFunc(m, {more: false, headers: checkHeaders(headers)})
            },
            writeFunc = (m, headers) => {
                originalReplyFunc(m, {more: true, headers: checkHeaders(headers)})
            };
        msg.write = writeFunc;
        msg.reply = msg.end = replyFunc;
    }
    return msg;
};


let INSTANCES_ON_SAME_PROCESS = new Map(); //Map of connectionNames

rabbot.onReturned((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        console.log("@micromessaging-warning: a message has been unroutable but the sender service has been closed");
    return inst.__emit("unroutableMessage", filter(message, ["ack", "nack", "reject", "reply"]));
});

//It is up to the the user to nack(),ack(),reply() or reject() unhandled requests or to reject() them
rabbot.onUnhandled((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        console.log("@micromessaging-warning: a message has been unhandled but the consumer service has been closed");
    let omitKeys = [];
    //In case of an unhandled message which comes from an emit(), we need to ensure not being able to ack(),nack(),reject() or reply()
    if (message.fields.exchange == "x.messages")
        omitKeys.push("ack", "nack", "reject", "reply");
    else if (_.get(message.properties.headers, "response_forbidden") != void 0)
        omitKeys.push("reply");
    return inst.__emit("unhandledMessage", filter(message, omitKeys));
});


const Service = function Service(name = uuid.v1()) {
    this.name = name;
    let emitter = new EventEmitter(),
        settings,
        UNIQUE_ID = uuid.v4(),
        SERVICE_NAME = name,
        CONNECTION_NAME = SERVICE_NAME + "-" + UNIQUE_ID,
        EXCHANGE_MESSAGES = {
            name: "x.messages",
            type: "topic",
            durable: false,
            persistent: false,
            limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
        },
        EXCHANGE_REQUESTS = {
            name: "x.requests-" + SERVICE_NAME,
            type: "direct",
            durable: false,
            persistent: false,
            limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
        },
        Q_PUBLIC_MESSAGES = {
            name: "q.public.messages-" + CONNECTION_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
            exclusive: true,
            noAck: true,
            subscribe: false //subscription is made manually
        },
        Q_PRIVATE_MESSAGES = {
            name: "q.private.messages-" + CONNECTION_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
            exclusive: true, //deleted when the connection closes
            noAck: true,
            subscribe: false //subscription is made manually
        },
        Q_RESPONSES = {
            name: "q.responses-" + CONNECTION_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
            exclusive: true, //deleted when the connection closes
            autoDelete: true, //deleted when the amount of consumers goes zero
            noAck: true,
            subscribe: true //Automatically subscribing
        },
        Q_REQUESTS = {
            name: "q.requests-" + SERVICE_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1,
            exclusive: false, //deleted when the connection closes
            noAck: false, //acks are required
            subscribe: false, //subscription is made manually
            noBatch: false //ack,nack,reject do not take place immediately
        };

    rabbot.once(CONNECTION_NAME + ".connection.connected", () => {
        emitter.emit("connected");
    });
    rabbot.once(CONNECTION_NAME + ".connection.closed", () => {
        emitter.emit("closed");
    });
    rabbot.on(CONNECTION_NAME + ".connection.failed", (err) => {
        emitter.emit("failed", err);
    });
    rabbot.once(CONNECTION_NAME + ".connection.unreachable", () => {
        emitter.emit("unreachable");
    });

    this.on = emitter.on.bind(emitter);
    this.once = emitter.once.bind(emitter);
    this.__emit = emitter.emit.bind(emitter);

    this.close = ()=> {
        return when()
            .then(function () {
                if (rabbot.configurations[CONNECTION_NAME] == void 0 && rabbot.connections[CONNECTION_NAME] == void 0)
                    return;
                return rabbot.close(CONNECTION_NAME, true)
            }).
            then(function () {
                delete rabbot.configurations[CONNECTION_NAME], delete rabbot.connections[CONNECTION_NAME];
                for (let s in rabbot._subscriptions)
                    s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._subscriptions[s] : null;
                for (let s in rabbot._cache)
                    s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._cache[s] : null;
                INSTANCES_ON_SAME_PROCESS.delete(CONNECTION_NAME);
            }).timeout(1500, new CustomError(CONNECTION_NAME + " closing operation timed out"));
    };

    this.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {
        settings = {};
        settings.name = CONNECTION_NAME;
        settings.connection = {uri: uri, name: CONNECTION_NAME, replyQueue: Q_RESPONSES};
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
        });
    };


    this.subscribe = () => {
        return when.all([
            rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME),
            rabbot.startSubscription(Q_PUBLIC_MESSAGES.name, Q_PUBLIC_MESSAGES.exclusive, CONNECTION_NAME),
            rabbot.startSubscription(Q_PRIVATE_MESSAGES.name, Q_PRIVATE_MESSAGES.exclusive, CONNECTION_NAME)
        ]);
    };

    this.emit = (serviceName, route, data, headers = null, opts = null) => {
        if (!_.isString(serviceName))
            throw new CustomError("invalidArg", "`serviceName` must be a string", 500, "fatal");
        if (!_.isString(route))
            throw new CustomError("invalidArg", "`route` must be a string", 500, "fatal");

        headers = checkHeaders(headers);
        opts = checkOpts(opts, "timeout", "expiresAfter", "isPublic");

        if (serviceName == "*")
            serviceName = "___ALL___", opts.isPublic = true;

        let r = (opts.isPublic ? "public." : "private.") + serviceName + "." + route, ex = when();

        opts.type = r;
        opts.body = data;
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        _.defaults(opts, {
            timeout: 1000, // ms to wait before cancelling the publish and rejecting the promise
            expiresAfter: 5000 // TTL in ms
        });

        if (!rabbot.getExchange(EXCHANGE_MESSAGES.name, CONNECTION_NAME))
            ex = rabbot.addExchange(EXCHANGE_MESSAGES, CONNECTION_NAME);
        return ex.then(function () {
            return rabbot.publish(EXCHANGE_MESSAGES.name, opts);
        });
    };


    //ECMA5-style in order to control `this`
    this.request = function (serviceName, taskName, data, headers = null, opts = null) {
        if (!_.isString(serviceName))
            throw new CustomError("invalidArg", "`serviceName` must be a string", 500, "fatal");
        if (!_.isString(taskName))
            throw new CustomError("invalidArg", "`taskName` must be a string", 500, "fatal");

        if (!this.noCheck) //called from an auxiliary method that already handled the controls
            headers = checkHeaders(headers), opts = checkOpts(opts, "timeout", "replyTimeout", "expiresAfter");

        let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = when();
        TEMP_EXCHANGE_REQUESTS.name = "x.requests-" + serviceName;

        opts.type = taskName;
        opts.routingKey = "task";
        opts.body = data;
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        _.defaults(opts, {
            expiresAfter: 10 * 60 * 1000, // TTL in ms
            timeout: 1000, // publish timeout
            replyTimeout: 20 * 60 * 1000 //twice the expiresAfter timeout,
        });

        if (!rabbot.getExchange(TEMP_EXCHANGE_REQUESTS.name, CONNECTION_NAME))
            ex = rabbot.addExchange(TEMP_EXCHANGE_REQUESTS, CONNECTION_NAME);
        return ex.then(function () {
            return when.promise(function (resolve, reject, notify) {
                return rabbot.request(TEMP_EXCHANGE_REQUESTS.name, opts)
                    .progress((m)=> {
                        notify(filter(m));
                    }).then((m)=> {
                        resolve(filter(m));
                    }).catch((err)=> {
                        reject(err);
                    });
            });

        });
    };

    //todo: dead-letter exchange
//todo:check on puisse pas reply dans un then/progress de request, check les fields dans progress/then


    //Sugar-syntax (request with no expected response)
    this.task = (serviceName, taskName, data, headers = null, opts = null) => {
        headers = checkHeaders(headers);
        opts = checkOpts(opts, "timeout", "expiresAfter");
        headers.response_forbidden = true;
        opts.replyTimeout = -1;
        return this.request.call({noCheck: true}, serviceName, taskName, data, headers, opts);
    };

    this.notify = this.task;


    this.listen = (route, handler, serviceName = SERVICE_NAME) => {
        let q = serviceName == SERVICE_NAME ? Q_PRIVATE_MESSAGES.name : Q_PUBLIC_MESSAGES.name,
            r = "*." + serviceName + "." + route;

        function _handler(message) {
            return handler.call(this, filter(message, ["ack", "nack", "reply", "reject"]));
        };

        let opts = {};
        opts.connectionName = CONNECTION_NAME;
        opts.queue = q; //handle messages coming only from this specified queue
        opts.type = r; //handle messages with this type name or pattern
        opts.autoNack = false;
        opts.context = null // control what `this` is when invoking the handler

        rabbot.handle(opts, _handler);
    };

    this.handle = (taskName, handler) => {

        function _handler(message) {
            let omitKeys = [];
            if (message.properties.headers.response_forbidden)
                omitKeys.push("reply");
            return handler.call(this, filter(message, omitKeys));
        };

        let opts = {};
        opts.connectionName = CONNECTION_NAME;
        opts.queue = Q_REQUESTS.name; //handle messages coming only from this specified queue
        opts.type = taskName; //handle messages with this type name or pattern
        opts.autoNack = false;
        opts.context = null // control what `this` is when invoking the handler

        rabbot.handle(opts, _handler);
    };

    this.prefetch = (count) => {
        console.warn("@warning:using prefetch() method is unstable. use it with caution");
        return when.promise(function (resolve, reject, notify) {
            let queueChannel = rabbot.
                connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name]
                .queue.channel;
            queueChannel.prefetch(count);
            rabbot.stopSubscription(Q_REQUESTS.name, CONNECTION_NAME);
            setTimeout(function () {
                rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME);
                resolve();
            }, 30);
        });

    };

    this.getRequestsReport = (serviceName) => {
        let queueChannel = rabbot.
            connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name]
            .queue.channel;
        return queueChannel.checkQueue("q.requests-" + serviceName).then(function (r) {
            return {
                queueSize: r.messageCount
            };
        });
    };

    this.__connectionName = CONNECTION_NAME;

    INSTANCES_ON_SAME_PROCESS.set(this.__connectionName, this);
};


module.exports = Service;
