let rabbot = require("rabbot"),
    util = require("util"),
    _ = require("lodash"),
    EventEmitter = require('events').EventEmitter,
    logLib = require("logger"),
    uuid = require("node-uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    when = require("when"),
    CustomError = logLib.CustomError;

//todo: dead-letter exchange

//Rabbot configuration
rabbot.hasHandles = true; //mute warnings when we start subscribing to the queues without any handler already in place
rabbot.ignoreHandlerErrors(); //It is not micromessaging's job to handle processes' errors

//todo:force close connection (even if there are unhandled messages)

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
    "_mms_no_reply",
    "_mms_no_ack",
    "_mms_type"
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
            throw new CustomError("unAllowedOptionValue", "Option " + k + " with value " + opts[k] + " is not valid", 500, "fatal");
        delete cloned[k];
    }
    if (_.keys(cloned).length)
        throw new CustomError("unAllowedOption", "Valid options are: " + keys.join(","), 500, "fatal");
    return opts;
};

//This wrapper needs to expose a filtered message object in order to limit rabbot's dependency from outside
const filter = (message) => {
    if (message == void 0)
        return;

    let msg = {
        type: message.properties.headers._mms_type,
        body: message.body,
        properties: {
            isRedelivered: message.fields.redelivered ? true : false,
            exchange: message.fields.exchange,
            queue: message.queue,
            routingKey: message.fields.routingKey,
            path: message.properties.type
        }
    };

    if (_.isString(message.properties.correlationId) && message.properties.correlationId != '')
        msg.properties.correlatedTo = message.properties.correlationId;
    else if (_.isString(message.properties.messageId) && message.properties.messageId != '')
        msg.properties.id = message.properties.messageId;

    msg.properties.contentType = message.properties.contentType;
    msg.properties.contentEncoding = message.properties.contentEncoding;
    msg.properties.expiresAfter = message.properties.expiration ? parseInt(message.properties.expiration) : -1;
    msg.properties.timestamp = parseInt(message.properties.timestamp);

    if (!_.get(message.properties.headers, "_mms_no_ack")) {
        //Requests can only reply and nack. They cannot reject nor ack
        if (message.ack && msg.type != "request")
            msg.ack = message.ack.bind(message);
        if (message.nack)
            msg.nack = message.nack.bind(message);
        if (message.reject) //Requests can reject, but be aware client will never get a response (that's why replyTimeout is required when publishing)
            msg.reject = message.reject.bind(message);
    }

    if (!_.get(message.properties.headers, "_mms_no_reply") && message.reply) {
        //Requests can reply
        msg.properties.replyTo = {
            exchange: '',
            queue: message.properties.replyTo,
            routingKey: message.properties.replyTo,
            path: message.properties.messageId
        };
        let originalReplyFunc = message.reply.bind(message),
            replied = false,
            replyFunc = (m, headers) => {
                m = m || '';
                if (replied)
                    throw new CustomError("alreadyReplied", "This message has already been replied to", 500, "fatal");
                headers = checkHeaders(headers);
                headers._mms_type = "response";
                headers._mms_no_reply = true;
                headers._mms_no_ack = true;
                replied = true;
                originalReplyFunc(m, {more: false, headers: headers})
            },
            writeFunc = (m, headers) => {
                m = m || '';
                if (replied)
                    throw new CustomError("alreadyReplied", "This message has already been replied to", 500, "fatal");
                headers = checkHeaders(headers);
                headers._mms_type = "response";
                headers._mms_no_reply = true;
                headers._mms_no_ack = true;
                originalReplyFunc(m, {more: true, headers: headers})
            };
        msg.write = writeFunc;
        msg.reply = msg.end = replyFunc;
    }
    msg.headers = cleanHeaders(message.properties.headers);
    return msg;
};


let INSTANCES_ON_SAME_PROCESS = new Map(); //Map of connectionNames

rabbot.onReturned((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        return console.log("@micromessaging-warning: a message has been unroutable but the sender service has been closed");
    when().then(function () {
        inst.__emit("unroutableMessage", filter(message));
    }).catch(function (e) {
        throw e;
    });
});

//It is up to the the user to nack(),ack(),reply() or reject() unhandled requests or to reject() them
rabbot.onUnhandled((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        return console.log("@micromessaging-warning: a message has been unhandled but the consumer service has been closed");
    when().then(function () {
        inst.__emit("unhandledMessage", filter(message));
    }).catch(function (e) {
        throw e;
    });
});


const Service = function Service(name = uuid.v1()) {

    if (!_.isString(name) || name == '')
        throw new CustomError("emptyServiceName", "The service name must be a non-empty string", 500, "fatal");
    if (name == "_G_" || name == "#" || name == "*")
        throw new CustomError("serviceNameReserved", "This service name is reserved", 500, "fatal");

    this.name = name;

    let hasListeners = false,
        subscribing = false,
        emitter = new EventEmitter(),
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
        Q_MESSAGES = {
            name: "q.messages-" + CONNECTION_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
            exclusive: true,
            noAck: true,
            subscribe: false //subscription is made manually
        },
        Q_SHARED_MESSAGES = {
            name: "q.messages-" + SERVICE_NAME,
            limit: Math.pow(2, 16) - 1, //prefetch limit
            queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
            exclusive: false, //this queue is shared
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


    rabbot.once(CONNECTION_NAME + ".connection.closed", () => {
        emitter.emit("closed");
    });
    rabbot.on(CONNECTION_NAME + ".connection.failed", (err) => {
        emitter.emit("failed", err);
    });
    rabbot.once(CONNECTION_NAME + ".connection.unreachable", () => {
        emitter.emit("unreachable");
    });

    //rabbot's `connected` event does not equal micromessaging's event, it's equivalent to `configured` event.


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
            }).timeout(1500, new CustomError(CONNECTION_NAME + " closing operation timed out (maybe due to unhandled items)"));
    };

    this.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {
        settings = {};
        settings.name = CONNECTION_NAME;
        settings.connection = {uri: uri, name: CONNECTION_NAME, replyQueue: Q_RESPONSES};
        settings.exchanges = [EXCHANGE_MESSAGES, EXCHANGE_REQUESTS];
        settings.queues = [Q_MESSAGES, Q_SHARED_MESSAGES, Q_REQUESTS];
        settings.bindings = [
            {
                exchange: EXCHANGE_MESSAGES.name,
                target: Q_MESSAGES.name,
                keys: [] //Bindings will be setup by the handlers later
            },
            {
                exchange: EXCHANGE_MESSAGES.name,
                target: Q_SHARED_MESSAGES.name,
                keys: [] //Bindings will be setup by the handlers later
            },
            {
                exchange: EXCHANGE_REQUESTS.name,
                target: Q_REQUESTS.name,
                keys: ["task"] //unlike messages, all instances of same service need to be able to manage all type of requests
            }
        ];
        return rabbot.configure(settings).then(() => {
            emitter.emit("connected");
        });
    };

    //Start consuming
    this.subscribe = () => {
        subscribing = true;
        return when.all([
            rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME),
            rabbot.startSubscription(Q_MESSAGES.name, Q_MESSAGES.exclusive, CONNECTION_NAME),
            rabbot.startSubscription(Q_SHARED_MESSAGES.name, Q_SHARED_MESSAGES.exclusive, CONNECTION_NAME)
        ]);
    };

    this.emit = (serviceName, route, data, headers = null, opts = null) => {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");
        if (!_.isString(route) || route == '' || route == '*' || route == "#")
            throw new CustomError("invalidArg", "`route` must be a non-empty string and different from * and #", 500, "fatal");

        headers = checkHeaders(headers);
        opts = checkOpts(opts, "timeout", "expiresAfter", "isPublic");

        if (serviceName == "*")
            serviceName = "_G_", opts.isPublic = true;

        let r = (opts.isPublic ? "public." : "private.") + serviceName + "." + route, ex = when();

        headers._mms_type = "message";
        headers._mms_no_reply = true;
        headers._mms_no_ack = true;

        opts.type = r;
        opts.body = data;
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        delete opts.isPublic; //rabbot does not care about this option

        _.defaults(opts, {
            timeout: 1000, // 1 sec
            expiresAfter: 5000 //5 sec
        });

        if (!rabbot.getExchange(EXCHANGE_MESSAGES.name, CONNECTION_NAME))
            ex = rabbot.addExchange(EXCHANGE_MESSAGES, CONNECTION_NAME);
        return ex.then(function () {
            return rabbot.publish(EXCHANGE_MESSAGES.name, opts);
        });
    };

    this.publicly = {};
    this.publicly.emit = (serviceName, route, data, headers = null, opts = null) => {
        opts = checkOpts(opts, "timeout", "expiresAfter");
        opts.isPublic = true;
        return this.emit(serviceName, route, data, headers, opts);
    };


    //ECMA5-style in order to control `this`
    this.request = function (serviceName, taskName, data, headers = null, opts = null) {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");

        if (!this.noCheck) { //if not called from an auxiliary method that already handled the controls
            headers = checkHeaders(headers);
            headers._mms_type = "request";
            opts = checkOpts(opts, "timeout", "replyTimeout", "expiresAfter");
        }

        let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = when();
        TEMP_EXCHANGE_REQUESTS.name = "x.requests-" + serviceName;

        opts.type = taskName; //internal routing (=type of request)
        opts.routingKey = "task";
        opts.body = data;
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        _.defaults(opts, {
            timeout: 1000, // 1 sec
            replyTimeout: 10 * 60 * 1000, //10 min
            expiresAfter: 10 * 60 * 1000 //10 min
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


    //Sugar-syntax (request with no expected response)
    this.task = (serviceName, taskName, data, headers = null, opts = null) => {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");
        headers = checkHeaders(headers);
        opts = checkOpts(opts, "timeout", "expiresAfter");
        headers._mms_type = "task";
        headers._mms_no_reply = true;
        opts.replyTimeout = -1;
        return this.request.call({noCheck: true}, serviceName, taskName, data, headers, opts);
    };
    this.notify = this.task;


    let routesListeners = [];

    function addRoutingDef(def) {
        routesListeners.push(def);
        rabbot.addQueueBinding(EXCHANGE_MESSAGES.name, def.queueName, def.routingKey, CONNECTION_NAME);
    };

    function removeRoutingDef(def) {
        let f = _.findIndex(routesListeners, def);
        if (f == -1)
            throw new CustomError("routingKeyError", "failed to remove routingKey " + def.routingKey + " on " + def.queueName + ": routesListeners array does not include it", 500, "fatal");
        _.pullAt(routesListeners, [f]);
        if (_.findIndex(routesListeners, def) == -1) {
            if (def.queueName == Q_MESSAGES.name) //not shared queue, unique to the service instance, so we can remove the binding-key
                rabbot.removeQueueBinding(EXCHANGE_MESSAGES.name, def.queueName, def.routingKey, CONNECTION_NAME);
        }
    };

    this.listen = function (route, handler, serviceName = SERVICE_NAME) {
        if (!_.isString(route) || route == '')
            throw new CustomError("invalidArg", "`route` must be a non-empty string", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");

        this.queueName = this.queueName || Q_MESSAGES.name;

        hasListeners = true;

        let routes = [];

        if (serviceName == "*")
            routes.push(
                {routingKey: "public.*." + route, queueName: this.queueName},
                {routingKey: "private." + SERVICE_NAME + "." + route, queueName: this.queueName});
        else if (serviceName != SERVICE_NAME)
            routes.push(
                {routingKey: "public._G_." + route, queueName: this.queueName},
                {routingKey: "public." + serviceName + "." + route, queueName: this.queueName});
        else
            routes.push(
                {routingKey: "public._G_." + route, queueName: this.queueName},
                {routingKey: "private." + SERVICE_NAME + "." + route, queueName: this.queueName},
                {routingKey: "public." + SERVICE_NAME + "." + route, queueName: this.queueName});

        routes.forEach(function (def) {
            addRoutingDef({routingKey: def.routingKey, queueName: def.queueName});
        });

        let _handlerError = function (err, message) {
            throw err;
        };

        function _handler(message) {
            message = filter(message);
            return when().then(function () {
                return handler.call(this, message);
            }.bind(this)).catch(function (err) {
                _handlerError.call(this, err, message);
            }.bind(this));
        };

        routes.forEach(function (def) {
            let opts = {};
            opts.connectionName = CONNECTION_NAME;
            opts.queue = def.queueName; //handle messages coming only from this specified queue
            opts.type = def.routingKey; //handle messages with this type name or pattern
            opts.autoNack = false;
            opts.context = null; // control what `this` is when invoking the handler
            def.subscription = rabbot.handle(opts, _handler);
        });

        let removeSubscription = function () {
            if (this.queueName == Q_SHARED_MESSAGES.name)
                throw new CustomError("subscriptionDeletionUnauthorized", "exclusive listeners cannot be removed", 500, "fatal");
            routes.forEach(function (def) {
                def.subscription.remove();
                delete def.subscription;
                removeRoutingDef(def);
            });
            routes = [];
        }.bind(this);

        return {
            onError: function (cb) {
                _handlerError = cb;
                return {
                    remove: removeSubscription
                }
            },
            remove: removeSubscription
        }
    };

    this.exclusively = {};
    this.exclusively.listen = (route, handler, serviceName = SERVICE_NAME) => {
        return this.listen.call({queueName: Q_SHARED_MESSAGES.name}, route, handler, serviceName);
    };


    this.handle = (taskName, handler) => {

        if (!_.isString(taskName) || taskName == '')
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string", 500, "fatal");

        hasListeners = true;
        let _handlerError = function (err, message) {
            throw err;
        };

        function _handler(message) {
            message = filter(message);
            return when().then(function () {
                return handler.call(this, message);
            }.bind(this)).catch(function (err) {
                _handlerError.call(this, err, message);
            }.bind(this));
        };

        let opts = {};
        opts.connectionName = CONNECTION_NAME;
        opts.queue = Q_REQUESTS.name; //handle messages coming only from this specified queue
        opts.type = taskName; //handle messages with this type name or pattern
        opts.autoNack = false;
        opts.context = null; // control what `this` is when invoking the handler
        let subscription = rabbot.handle(opts, _handler);
        return {
            onError: function (cb) {
                _handlerError = cb;
                return {
                    remove: subscription.remove.bind(subscription)
                }
            },
            remove: subscription.remove.bind(subscription)
        }
    };

    this.prefetch = (count) => {
        let queueChannel = rabbot.
            connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name]
            .queue.channel;
        return queueChannel.prefetch(count, true).then(function () {
            return rabbot.stopSubscription(Q_REQUESTS.name, CONNECTION_NAME).then(function () {
                return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME);
            });
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

    setTimeout(function () {
        if (hasListeners && !subscribing)
            throw new CustomError(SERVICE_NAME + " - some handlers are set up without calling subscribe()", "subscriptionMissingError", 500, "notice");
    }, 300);

    this.__connectionName = CONNECTION_NAME;

    INSTANCES_ON_SAME_PROCESS.set(this.__connectionName, this);
};


module.exports = Service;
