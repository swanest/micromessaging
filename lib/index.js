let rabbot = require("rabbot"),
    util = require("util"),
    _ = require("lodash"),
    EventEmitter = require('events').EventEmitter,
    logLib = require("logger"),
    uuid = require("uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    when = require("when"),
    CustomError = logLib.CustomError;

//todo: send-to and receive-from a particular instance
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
    "_mms_no_reply",
    "_mms_no_ack",
    "_mms_type",
    "_rabbot_idm"
];

const RESERVED_ROUTES = [
    "_mms_online.req",
    "_mms_online.res",
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

const checkRoute = (r) => {
    if (r != void 0 && !_.isString(r))
        throw new CustomError("invalidArg", "Route must be a string", 500, "fatal");
    if (RESERVED_ROUTES.indexOf(r) > -1)
        throw new CustomError("unAllowedRoute", r + " is reserved", 500, "fatal");
    return r;
};

const checkOpts = (opts, ...keys) => {
    if (opts != void 0 && !_.isPlainObject(opts))
        throw new CustomError("invalidArg", "Options must be a plainObject", 500, "fatal");
    if (!opts || !keys.length) //Everything is permitted
        return opts || {};
    let cloned = _.clone(opts);
    for (let i = 0; i < keys.length; i++) {
        let k = keys[i];
        if (opts[k] != void 0 && !ALLOWED_OPTIONS[k](opts[k]))
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


    msg.status = "PENDING";

    if (!_.get(message.properties.headers, "_mms_no_ack")) {
        //Requests can only reply, nack and reject. They cannot ack
        if (message.ack && msg.type != "request")
            msg.ack = function () {
                if (msg.status != "PENDING")
                    return;
                msg.status = "ACKED";
                message.ack();
            };
        if (message.nack)
            msg.nack = function () {
                if (msg.status != "PENDING")
                    return;
                msg.status = "NACKED";
                message.nack();
            };
        if (message.reject) //Requests can reject, but be aware client will never get a response (that's why replyTimeout is required when publishing)
            msg.reject = function () {
                if (msg.status != "PENDING")
                    return;
                msg.status = "REJECTED";
                message.reject();
            };
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
            replyFunc = (m, headers) => {
                m = m || '';
                if (msg.status != "PENDING")
                    throw new CustomError("alreadyReplied", "This message has already been replied to", 500, "fatal");
                msg.status = "REPLIED"
                headers = checkHeaders(headers);
                headers._mms_type = "response";
                headers._mms_no_reply = true;
                headers._mms_no_ack = true;
                replied = true;
                return originalReplyFunc(m, {more: false, headers: headers, contentType: "application/json"})
            },
            writeFunc = (m, headers) => {
                m = m || '';
                if (msg.status != "PENDING")
                    throw new CustomError("alreadyReplied", "This message has already been replied to", 500, "fatal");
                headers = checkHeaders(headers);
                headers._mms_type = "response";
                headers._mms_no_reply = true;
                headers._mms_no_ack = true;
                return originalReplyFunc(m, {more: true, headers: headers, contentType: "application/json"})
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


const Service = function Service(name = uuid.v1(), setupOpts = {}) {

    if (!_.isString(name) || name == '')
        throw new CustomError("emptyServiceName", "The service name must be a non-empty string", 500, "fatal");
    if (name == "_G_" || name == "#" || name == "*")
        throw new CustomError("serviceNameReserved", "This service name is reserved", 500, "fatal");

    let _this = this,
        hasListeners = false,
        subscribing = false,
        emitter = new EventEmitter(),
        connection = null,
        UNIQUE_ID = uuid.v4(),
        SERVICE_NAME = name,
        CONNECTION_NAME = SERVICE_NAME + "-" + UNIQUE_ID;

    this.name = name;

    setupOpts = setupOpts || {};
    _.defaultsDeep(setupOpts, {
        discoverable: false,
        memoryPressureHandled: false,
        config: {
            EXCHANGE_MESSAGES: {
                name: "x.messages",
                type: "topic",
                durable: false,
                persistent: false,
                limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
            },
            EXCHANGE_REQUESTS: {
                name: "x.requests-" + SERVICE_NAME,
                type: "direct",
                durable: false,
                persistent: false,
                limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
            },
            EXCHANGE_DEAD_REQUESTS: {
                name: "x.dead-requests-" + SERVICE_NAME,
                type: "direct",
                durable: false,
                persistent: false,
                limit: Math.pow(2, 16) - 1 //unpublished messages to cache while waiting for connection
            },
            Q_MESSAGES: {
                durable: false,
                name: "q.messages-" + CONNECTION_NAME,
                limit: Math.pow(2, 16) - 1, //consumer prefetch limit
                queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
                exclusive: true, //this queue is unique to this instance, only 1 consumer, is deleted when instance quits
                autoDelete: true, //deleted when the amount of consumers goes zero (messages left are deleted as they are supposed to be not important)
                noAck: true, //no need to ack,nack,reject...
                subscribe: false, //subscription is made manually
                expires: 10 * 60 * 1000 //deleted if unused during 10min
            },
            Q_SHARED_MESSAGES: {
                durable: false,
                name: "q.messages-" + SERVICE_NAME,
                limit: Math.pow(2, 16) - 1,//consumer prefetch limit
                queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
                exclusive: false, //this queue is shared
                autoDelete: true, //deleted when the amount of consumers goes zero (messages left are deleted as they are supposed to be not important)
                noAck: true, //no need to ack,nack,reject...
                subscribe: false, //subscription is made manually
                expires: 10 * 60 * 1000 //deleted if unused during 10min
            },
            Q_RESPONSES: {
                durable: false,
                name: "q.responses-" + CONNECTION_NAME,
                limit: Math.pow(2, 16) - 1, //consumer prefetch limit
                queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
                noAck: true, //no need to ack,nack,reject...
                subscribe: true, //Automatically subscribing
                exclusive: true, //this queue is unique to this instance, only 1 consumer, is deleted when instance quits
                autoDelete: true, //deleted when the amount of consumers goes zero
                expires: 10 * 60 * 1000 //deleted if unused during 10min
            },
            Q_REQUESTS: {
                durable: false,
                name: "q.requests-" + SERVICE_NAME,
                limit: Math.pow(2, 16) - 1, //prefetch limit
                queueLimit: Math.pow(2, 32) - 1,
                exclusive: false, //this queue is shared
                noAck: false, //acks are required
                subscribe: false, //subscription is made manually
                noBatch: false, //ack,nack,reject do not take place immediately
                expires: 10 * 60 * 1000 //deleted if unused during 10min
                //autoDelete: true //deleted when the amount of consumers goes from 1 to zero
            },
            Q_DEAD_REQUESTS: {
                durable: false,
                name: "q.dead-requests-" + CONNECTION_NAME,
                limit: Math.pow(2, 16) - 1, //consumer prefetch limit
                queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
                exclusive: true, //this queue is unique to this instance, only 1 consumer, is deleted when instance quits
                autoDelete: true, //deleted when the amount of consumers goes zero (messages left are deleted as they are supposed to be not important)
                noAck: true, //no need to ack,nack,reject...
                subscribe: false, //subscription is made manually
                expires: 10 * 60 * 1000 //deleted if unused during 10min
            }
        }
    });

    if (setupOpts.config.EXCHANGE_DEAD_REQUESTS != void 0)
        setupOpts.config.Q_REQUESTS.deadLetter = setupOpts.config.EXCHANGE_DEAD_REQUESTS.name;

    if (setupOpts.discoverable == true)
        setupOpts.discoverable = {};

    _.defaultsDeep(setupOpts, {
        discoverable: {
            intervalCheck: 3 * 60 * 1000, //each 3', we need to check whether there's still an elected instance online, otherwise we elect one
            electionTimeout: 500 //time to wait (in ms) after the last online.res event to define the elected instance
        }
    });

    let EXCHANGE_MESSAGES = setupOpts.config.EXCHANGE_MESSAGES,
        EXCHANGE_REQUESTS = setupOpts.config.EXCHANGE_REQUESTS,
        EXCHANGE_DEAD_REQUESTS = setupOpts.config.EXCHANGE_DEAD_REQUESTS,
        Q_MESSAGES = setupOpts.config.Q_MESSAGES,
        Q_SHARED_MESSAGES = setupOpts.config.Q_SHARED_MESSAGES,
        Q_RESPONSES = setupOpts.config.Q_RESPONSES,
        Q_REQUESTS = setupOpts.config.Q_REQUESTS,
        Q_DEAD_REQUESTS = setupOpts.config.Q_DEAD_REQUESTS;

    rabbot.once(CONNECTION_NAME + ".connection.closed", () => {
        emitter.emit("closed");
    });
    rabbot.on(CONNECTION_NAME + ".connection.failed", (err) => {
        emitter.emit("failed", err);
    });
    rabbot.once(CONNECTION_NAME + ".connection.unreachable", () => {
        emitter.emit("unreachable");
    });

    this.uniqueID = UNIQUE_ID;

    //rabbot's `connected` event does not equal micromessaging's event, it's equivalent to `configured` event.
    this.on = emitter.on.bind(emitter);
    this.once = emitter.once.bind(emitter);
    this.__emit = emitter.emit.bind(emitter);

    this.close = ()=> {
        return when()
            .then(function () {
                rabbot.batchNack();
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
        let settings = {};
        settings.name = CONNECTION_NAME;
        settings.connection = {uri: uri, name: CONNECTION_NAME, replyQueue: Q_RESPONSES};
        settings.exchanges = [EXCHANGE_MESSAGES, EXCHANGE_REQUESTS, EXCHANGE_DEAD_REQUESTS];
        settings.queues = [Q_MESSAGES, Q_SHARED_MESSAGES, Q_REQUESTS, Q_DEAD_REQUESTS];
        settings.bindings = [
            //{
            //    exchange: EXCHANGE_MESSAGES.name,
            //    target: Q_MESSAGES.name,
            //    keys: [] //Bindings will be setup by the handlers later
            //},
            //{
            //    exchange: EXCHANGE_MESSAGES.name,
            //    target: Q_SHARED_MESSAGES.name,
            //    keys: [] //Bindings will be setup by the handlers later
            //},
            {
                exchange: EXCHANGE_REQUESTS.name,
                target: Q_REQUESTS.name,
                keys: ["task"] //unlike messages, all instances of same service need to be able to manage all type of requests
            }
        ];
        return rabbot.configure(settings).then(() => {
            emitter.emit("connected");
            connection = rabbot.connections[CONNECTION_NAME].connection;
            this.onlineSince = Date.now();
        });
    };


    let autoElection = () => {
        let autoElect = () => {
                this.replications = _.sortBy(this.replications, "onlineSince");
                if (!this.replications.length)
                    return;
                _.first(this.replications).isElected = true;
                if (_.first(this.replications).uniqueID == UNIQUE_ID && !this.isElected)
                    this.isElected = true, emitter.emit("elected");
            },
            autoElectTimeOut = null,
            recheckTimeout = null;
        when()
            .then(() => {
                return this.listen.call({noCheck: true}, "_mms_online.res", (msg) => { //Getting
                    if (_.find(this.replications, _.pick(msg.body, "uniqueID")) != void 0) //Already in there
                        return;
                    if (msg.body.uniqueID == UNIQUE_ID)
                        msg.body.isCurrent = true;
                    this.replications.push(msg.body);
                    clearTimeout(autoElectTimeOut);
                    autoElectTimeOut = setTimeout(autoElect, setupOpts.discoverable.electionTimeout);
                }).promise;
            }).then(()=> {
                return this.listen.call({noCheck: true}, "_mms_online.req", () => { //Asking to reveal myself
                    clearTimeout(recheckTimeout);
                    recheckTimeout = setTimeout(() => {
                        try {
                            this.privately.emit.call({noCheck: true}, this.name, "_mms_online.req");
                        } catch (e) {
                            clearTimeout(recheckTimeout); //maybe this instance has been closed in the meanwhile
                        }
                    }, setupOpts.discoverable.intervalCheck);
                    this.replications = [];
                    this.privately.emit.call({noCheck: true}, this.name, "_mms_online.res", {
                        onlineSince: this.onlineSince,
                        uniqueID: UNIQUE_ID
                    });
                }).promise;
            }).then(() => {
                this.privately.emit.call({noCheck: true}, this.name, "_mms_online.req");
            });
    };

    //Start consuming
    this.subscribe = () => {
        this.subscribe = () => {
            throw new CustomError("alreadySubscribed", "this instance for " + this.name + " has already subscribed");
        };
        return when().then(function () {
            return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME);
        }).then(function () {
            return rabbot.startSubscription(Q_DEAD_REQUESTS.name, Q_DEAD_REQUESTS.exclusive, CONNECTION_NAME);
        }).then(function () {
            return rabbot.startSubscription(Q_MESSAGES.name, Q_MESSAGES.exclusive, CONNECTION_NAME);
        }).then(function () {
            return rabbot.startSubscription(Q_SHARED_MESSAGES.name, Q_SHARED_MESSAGES.exclusive, CONNECTION_NAME);
        }).then(function () {
            subscribing = true;
            if (_.get(setupOpts, "discoverable"))
                autoElection();
        }).catch(function (err) {
            throw new CustomError("errorSubscription").use(err);
        });
    };

    /**
     --SENDER METHODS--
     */

    this.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");
        if (!_.isString(route) || route == '' || route == '*' || route == "#")
            throw new CustomError("invalidArg", "`route` must be a non-empty string and different from * and #", 500, "fatal");
        if (!this.noCheck) {
            route = checkRoute(route);
            headers = checkHeaders(headers);
            opts = checkOpts(opts, "timeout", "expiresAfter", "isPublic");
        }
        _.defaults(opts, {
            isPublic: true
        });

        if (serviceName == "*")
            serviceName = "_G_", opts.isPublic = true;
        let r = (opts.isPublic ? "public." : "private.") + serviceName + "." + route, ex = when();

        headers._mms_type = "message";
        headers._mms_no_reply = true;
        headers._mms_no_ack = true;

        opts.type = r;
        opts.body = data || ''; //data is not mandatory
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        delete opts.isPublic; //rabbot does not care about this option

        _.defaults(opts, {
            timeout: 1000, // 1 sec
            expiresAfter: 5000 //5 sec
        });

        var unRoutableError = new CustomError("unroutableMessage");
        if (!rabbot.getExchange(EXCHANGE_MESSAGES.name, CONNECTION_NAME))
            ex = rabbot.addExchange(EXCHANGE_MESSAGES, CONNECTION_NAME);
        return ex.then(function () {
            return rabbot.publish(EXCHANGE_MESSAGES.name, opts).catch(function (e) {
                if (e.message == "unroutable")
                    throw unRoutableError; //keep the original context
                else
                    throw e;
            });
        });
    };

    this.publicly = {};
    this.privately = {};

    this.publicly.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        if (!this.noCheck) {
            route = checkRoute(route);
            opts = checkOpts(opts, "timeout", "expiresAfter");
        }
        opts.isPublic = true;
        return _this.emit.call(this, serviceName, route, data, headers, opts);
    };

    this.privately.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        if (!this.noCheck) {
            route = checkRoute(route);
            opts = checkOpts(opts, "timeout", "expiresAfter");
        }
        opts.isPublic = false;
        return _this.emit.call(this, serviceName, route, data, headers, opts);
    };

    this.request = function (serviceName, taskName, data, headers = {}, opts = {}) {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");

        if (!this.noCheck) { //if not called from an auxiliary method that already handled the controls
            headers = _.clone(checkHeaders(headers));
            headers._mms_type = "request";
            opts = _.clone(checkOpts(opts, "timeout", "replyTimeout", "expiresAfter"));
        }

        let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = when();
        TEMP_EXCHANGE_REQUESTS.name = "x.requests-" + serviceName;

        opts.type = taskName; //internal routing (=type of request)
        opts.routingKey = "task";
        opts.body = data || ''; //data is not mandatory
        opts.headers = headers;
        opts.connectionName = CONNECTION_NAME;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        opts.contentType = "application/json";

        _.defaults(opts, {
            timeout: 1000, // 1 sec
            replyTimeout: 10 * 60 * 1000, //10 min
            expiresAfter: 10 * 60 * 1000 //10 min
        });

        var unRoutableError = new CustomError("unroutableMessage");
        if (!rabbot.getExchange(TEMP_EXCHANGE_REQUESTS.name, CONNECTION_NAME))
            ex = rabbot.addExchange(TEMP_EXCHANGE_REQUESTS, CONNECTION_NAME);
        return ex.then(function () {
            return when.promise(function (resolve, reject, notify) {
                return rabbot.request(TEMP_EXCHANGE_REQUESTS.name, opts)
                    .progress((m)=> {
                        notify(filter(m));
                    }).then((m)=> {
                        m = filter(m);
                        if (m && m.body.error != void 0)
                            return reject(new CustomError().use(m.body));
                        resolve(m);
                    }).catch((err)=> {
                        if (err.message == "unroutable")
                            reject(unRoutableError); //keep the original context
                        else
                            reject(err);
                    });
            });

        });
    };


    //Sugar-syntax (request with no expected response)
    this.task = (serviceName, taskName, data, headers = {}, opts = {}) => {
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");
        headers = _.clone(checkHeaders(headers));
        opts = _.clone(checkOpts(opts, "timeout", "expiresAfter"));
        headers._mms_type = "task";
        headers._mms_no_reply = true;
        opts.replyTimeout = -1;
        return this.request.call({noCheck: true}, serviceName, taskName, data, headers, opts);
    };
    this.notify = this.task;


    /**
     --RECEIVER METHODS--
     */

    let routesListeners = [];

    function addRoutingDef(def) {
        routesListeners.push(def);
        return rabbot.addQueueBinding(def.exchangeName, def.queueName, def.routingKey, CONNECTION_NAME);
    };

    function removeRoutingDef(def) {
        let f = _.findIndex(routesListeners, def);
        if (f == -1)
            throw new CustomError("routingKeyError", "failed to remove routingKey " + def.routingKey + " on " + def.queueName + " " + def.exchangeName + ": routesListeners array does not include it", 500, "fatal");
        _.pullAt(routesListeners, [f]);
        if (_.findIndex(routesListeners, def) == -1)
            return rabbot.removeQueueBinding(def.exchangeName, def.queueName, def.routingKey, CONNECTION_NAME);
        return when();
    };

    this.listen = function (route, handler, serviceName = SERVICE_NAME) {
        if (!_.isString(route) || route == '')
            throw new CustomError("invalidArg", "`route` must be a non-empty string", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");

        if (!this.noCheck)
            route = checkRoute(route);

        hasListeners = true;

        let queueName = this.queueName || Q_MESSAGES.name,
            exchangeName = this.exchangeName || EXCHANGE_MESSAGES.name,
            routes = [],
            promises = [];

        if (queueName == Q_DEAD_REQUESTS.name)
            routes.push(
                {exchangeName: exchangeName, routingKey: "task", queueName: queueName}
            );
        else if (serviceName == "*")
            routes.push(
                {exchangeName: exchangeName, routingKey: "public.*." + route, queueName: queueName},
                {
                    exchangeName: exchangeName,
                    routingKey: "private." + SERVICE_NAME + "." + route,
                    queueName: queueName
                });
        else if (serviceName != SERVICE_NAME)
            routes.push(
                {exchangeName: exchangeName, routingKey: "public._G_." + route, queueName: queueName},
                {exchangeName: exchangeName, routingKey: "public." + serviceName + "." + route, queueName: queueName});
        else
            routes.push(
                {exchangeName: exchangeName, routingKey: "public._G_." + route, queueName: queueName},
                {exchangeName: exchangeName, routingKey: "private." + SERVICE_NAME + "." + route, queueName: queueName},
                {exchangeName: exchangeName, routingKey: "public." + SERVICE_NAME + "." + route, queueName: queueName});

        routes.forEach(function (def) {
            promises.push(addRoutingDef({
                exchangeName: def.exchangeName,
                routingKey: def.routingKey,
                queueName: def.queueName
            }));
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
            if (def.routingKey == "task")
                opts.type = route;
            opts.autoNack = false;
            opts.context = null; // control what `this` is when invoking the handler
            def.subscription = rabbot.handle(opts, _handler);
        });

        let removeSubscription = function () {
            return when.promise(function (resolve, reject) {
                let proms = [];
                if (queueName == Q_SHARED_MESSAGES.name)
                    return reject(CustomError("subscriptionDeletionUnauthorized", "exclusive listeners cannot be removed", 500, "fatal"));
                routes.forEach(function (def) {
                    def.subscription.remove();
                    delete def.subscription;
                    proms.push(removeRoutingDef(def));
                });
                routes = [];
                return when.all(proms).then(function () {
                    resolve();
                }).catch(reject);
            });
        }.bind(this);

        let finalPromise = when.all(promises);
        return {
            onError: function (cb) {
                _handlerError = cb;
                return {
                    remove: removeSubscription,
                    promise: finalPromise
                }
            },
            remove: removeSubscription,
            promise: finalPromise
        }
    };

    this.exclusively = {};
    this.exclusively.listen = function (route, handler, serviceName = SERVICE_NAME) {
        return _this.listen.call({queueName: Q_SHARED_MESSAGES.name}, route, handler, serviceName);
    };

    this.death = {};
    this.death.listen = function (route, handler, serviceName = SERVICE_NAME) { //todo: remove subscription
        return _this.listen.call({
            queueName: Q_DEAD_REQUESTS.name,
            exchangeName: "x.dead-requests-" + serviceName
        }, route, handler, serviceName);
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

        let removeSubscription = function () {
            return when(subscription.remove())
        }.bind(this);

        let finalPromise = when();

        return {
            onError: function (cb) {
                _handlerError = cb;
                return {
                    remove: removeSubscription,
                    promise: finalPromise
                }
            },
            remove: removeSubscription,
            promise: finalPromise
        }
    };


    function retry(fn, intervalMS, max, i, g) {
        //fn(max,i,insistFn,giveUpFn)
        i = i == void 0 ? 0 : i, g = g == void 0 ? 0 : g;
        function insistFn() {
            g++;
        };
        function giveUpFn() {
            i = null;
        };
        return fn(max, i, insistFn, giveUpFn).catch(function (err) {
            if (typeof i === 'number')
                i++;
            if (i == void 0 || (typeof i === 'number' && typeof max === 'number' && i - g > max))
                throw err;
            else
                return when().delay(intervalMS).then(function () {
                    return retry(fn, intervalMS, max, i, g);
                });
        });
    };


    /**
     --EXTRA METHODS--
     */

    let lastPrefetchCount = null;
    this.prefetch = (count) => {
        lastPrefetchCount = count != 0 ? count : lastPrefetchCount;
        if (!subscribing)
            return when();
        return connection.getChannel("ctrl:prefetch:" + UNIQUE_ID).then(function (channel) {
            //Check queue
            return channel.checkQueue(Q_REQUESTS.name).then(function () {
                //Queue exists & prefetchCount == 0 ? stop subscription
                if (count == 0) {
                    return retry(function (max, i, insistFn, giveUpFn) {
                        if (i > 0)
                            tracer.warn("prefetch " + count + " stopSubscription reattempt");
                        return rabbot.stopSubscription(Q_REQUESTS.name, CONNECTION_NAME);
                    }, 2000, 5).catch(function (err) {
                        tracer.warn("ignored-error", err);
                    });
                }
                return when().then(function () {
                    let consumersCount = _.keys(_.get(rabbot.connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name], "lastQueue.channel").item.consumers).length;
                    if (!consumersCount) //Recreate a channel for that queue
                        return retry(function (max, i, insistFn, giveUpFn) {
                            if (i > 0)
                                tracer.warn("prefetch " + count + " addQueue reattempt");
                            return rabbot.addQueue(Q_REQUESTS.name, Q_REQUESTS, CONNECTION_NAME);
                        }, 2000, 5);
                }).then(function () {
                    return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME);
                }).then(function () {
                    let queueChannel = _.get(rabbot.connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name], "lastQueue.channel");
                    return queueChannel.prefetch(count, true);
                });
            }, function () {
                //Does not exist ?
                if (count == 0) throw new CustomError("queueNotFound", "tried to unsubscribe from a missing queue " + Q_REQUESTS.name, 500, "fatal");
                //count > 0 ? createQueue & bind, start subscription, prefetch
                return retry(function (max, i, insistFn, giveUpFn) {
                    if (i > 0)
                        tracer.warn("prefetch " + count + " addQueue reattempt - bis");
                    return rabbot.addQueue(Q_REQUESTS.name, Q_REQUESTS, CONNECTION_NAME);
                }, 2000, 5).then(function (q) {
                    return rabbot.bindQueue(EXCHANGE_REQUESTS.name, Q_REQUESTS.name, ["task"], CONNECTION_NAME);
                }).then(function () {
                    return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME);
                }).then(function () {
                    let queueChannel = _.get(rabbot.connections[CONNECTION_NAME].channels["queue:" + Q_REQUESTS.name], "lastQueue.channel");
                    return queueChannel.prefetch(count, true);
                });
            });
        });
    };

    this.getRequestsReport = (serviceName) => {
        return connection.getChannel("ctrl:report:" + UNIQUE_ID).then(function (channel) {
            return channel.checkQueue("q.requests-" + serviceName).then(function (r) {
                return {
                    queueSize: r.messageCount
                };
            }, function () {
                throw new CustomError("requestsReportUnavailable", 500, "fatal");
            });
        });
    };


    this.__connectionName = CONNECTION_NAME;
    INSTANCES_ON_SAME_PROCESS.set(this.__connectionName, this);

    setTimeout(function () {
        if (hasListeners && !subscribing)
            throw new CustomError(SERVICE_NAME + " - some handlers are set up without calling subscribe()", "subscriptionMissingError", 500, "notice");
    }, 30000);

    if (setupOpts.memoryPressureHandled) {
        let memory = require("memory-pressure").new(this.__connectionName, setupOpts.memoryPressureHandled);
        memory.on("underPressure", (mem) => {
            tracer.info("memory-pressure: under pressure, calling prefetch(0)", mem);
            return this.prefetch(0).then(function () {
                tracer.debug("prefetching 0 due to memory succeeded");
            }, function (err) {
                tracer.error("prefetching 0 due to memory failed", err);
            }).finally(function () {
                memory.ack();
            });
        });
        memory.on("pressureReleased", (mem) => {
            tracer.info("memory-pressure: pressure released, calling prefetch(" + lastPrefetchCount + ")", mem);
            return this.prefetch(lastPrefetchCount).then(function () {
                tracer.debug("prefetching " + lastPrefetchCount + " succeeded");
            }, function (err) {
                tracer.error("prefetching " + lastPrefetchCount + " failed", err);
            }).finally(function () {
                memory.ack();
            });
        });
    }

};


module.exports = Service;
