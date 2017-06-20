let rabbot = require("rabbot"),
    sizeof = require('object-sizeof'),
    _ = require("lodash"),
    EventEmitter = require('events').EventEmitter,
    logLib = require("sw-logger"),
    uuid = require("uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    memoryPressure = require("memory-pressure"),
    when = require("when"),
    CustomError = logLib.CustomError,
    defaultConf = require("./conf"),
    {filter, retry, checkRoute, checkHeaders, checkOpts} = require("./utils");

if (process.env.NODE_ENV == 'production' || process.env.NODE_ENV == 'staging')
    tracer.addStream('stdOut', {formatter: require("sw-logger").formatters.json()});

let INSTANCES_ON_SAME_PROCESS = new Map(); //Map of connectionNames

//Rabbot configuration
rabbot.hasHandlers = true; //mute warnings when we start subscribing to the queues without any handler already in place
rabbot.ignoreHandlerErrors(); //It is not rabbot neither micromessaging's job to handle automatic nack() on errors

rabbot.onReturned((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        return tracer.warn("a message is unroutable but the sender service has been closed");
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
        return tracer.warn("a message has been unhandled but the consumer service has been closed");
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

    const _THIS = this,
        EMITTER = new EventEmitter(),
        UNIQUE_ID = uuid.v4(),
        SERVICE_NAME = name,
        CONNECTION_NAME = SERVICE_NAME + "-" + UNIQUE_ID;

    INSTANCES_ON_SAME_PROCESS.set(CONNECTION_NAME, this);

    let ONLINE_SINCE = null,
        HAS_LISTENERS = false,
        IS_CLOSED = null,
        SUBSCRIBING = false,
        IS_READY = false;

    //Fill in default configuration
    setupOpts = defaultConf(SERVICE_NAME, CONNECTION_NAME, setupOpts);

    const EXCHANGE_MESSAGES = setupOpts.entities.EXCHANGE_MESSAGES,
        EXCHANGE_REQUESTS = setupOpts.entities.EXCHANGE_REQUESTS,
        EXCHANGE_DEAD_REQUESTS = setupOpts.entities.EXCHANGE_DEAD_REQUESTS,
        Q_MESSAGES = setupOpts.entities.Q_MESSAGES,
        Q_INTERNAL_MESSAGES = setupOpts.entities.Q_INTERNAL_MESSAGES,
        Q_SHARED_MESSAGES = setupOpts.entities.Q_SHARED_MESSAGES,
        Q_RESPONSES = setupOpts.entities.Q_RESPONSES,
        Q_REQUESTS = setupOpts.entities.Q_REQUESTS,
        Q_DEAD_REQUESTS = setupOpts.entities.Q_DEAD_REQUESTS;

    rabbot.once(CONNECTION_NAME + ".connection.closed", () => {
        IS_CLOSED = true;
        _THIS.__emit("closed");
    });

    rabbot.on(CONNECTION_NAME + ".connection.failed", (err) => {
        _THIS.__emit("failed", err);
    });

    rabbot.once(CONNECTION_NAME + ".connection.unreachable", () => {
        IS_CLOSED = true;
        _THIS.__emit("unreachable");
    });

    this.on = EMITTER.on.bind(EMITTER);
    this.once = EMITTER.once.bind(EMITTER);
    this.__emit = EMITTER.emit.bind(EMITTER);
    this.name = name;
    this.isElected = false;
    this.uniqueID = UNIQUE_ID;

    this.close = () => {
        IS_CLOSED = true;
        _THIS.setMemoryHandling(false); // stop memory handling !
        if (ONLINE_SINCE == void 0)
            return when();
        return when().then(function () {
            return _THIS.prefetch.call({priority: true}, 0); // stop receiving !
        }).delay(500).then(function () {
            handleWaitingRequests('reject'); // nack all waiting requests !
            rabbot.batchNack();
            if (rabbot.configurations[CONNECTION_NAME] == void 0 && rabbot.connections[CONNECTION_NAME] == void 0)
                return;
            return when().delay(500).then(function () {
                return rabbot.close(CONNECTION_NAME, true).timeout(1500, new CustomError(CONNECTION_NAME + " closing operation timed out (maybe due to unhandled items)"));
            })
        }).then(function () { // clean
            delete rabbot.configurations[CONNECTION_NAME], delete rabbot.connections[CONNECTION_NAME];
            for (let s in rabbot._subscriptions)
                s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._subscriptions[s] : null;
            for (let s in rabbot._cache)
                s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._cache[s] : null;
            INSTANCES_ON_SAME_PROCESS.delete(CONNECTION_NAME);
        })
    };


    this.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {

        this.connect = () => {
            if (IS_CLOSED)
                throw new CustomError("isClosed", "Service cannot reconnect because it has been closed", 500, "fatal");
            return when();
        };

        let settings = {};
        settings.name = CONNECTION_NAME;
        settings.connection = {uri: uri, name: CONNECTION_NAME, replyQueue: Q_RESPONSES};
        settings.exchanges = [EXCHANGE_MESSAGES, EXCHANGE_REQUESTS, EXCHANGE_DEAD_REQUESTS];
        settings.queues = [Q_INTERNAL_MESSAGES, Q_MESSAGES, Q_SHARED_MESSAGES, Q_REQUESTS, Q_DEAD_REQUESTS];
        settings.bindings = [ //Q_INTERNAL_MESSAGES & Q_MESSAGES & Q_SHARED_MESSAGES bindings will be set later
            {
                exchange: EXCHANGE_REQUESTS.name,
                target: Q_REQUESTS.name,
                keys: ["task"] //unlike messages, all instances of same service need to be able to manage all type of requests
            }
        ];

        return rabbot.configure(settings).then(() => {

            ONLINE_SINCE = Date.now();

            if (IS_CLOSED)
                return this.close();

            if (!_.get(setupOpts, "discoverable"))
                return _THIS.__emit("connected");

            // Listen to reply my status (getStatus())
            let listenerStatus = _THIS.listen.call({
                noCheck: true,
                queueName: Q_INTERNAL_MESSAGES.name
            }, "_mms_status.req", (msg) => {
                _THIS.privately.emit.call({noCheck: true}, msg.body.replyTo.serviceName, msg.body.replyTo.route, {
                    timestamp: Date.now(),
                    serviceName: SERVICE_NAME,
                    uniqueID: UNIQUE_ID,
                    onlineSince: ONLINE_SINCE,
                    isReady: IS_READY,
                    isElected: _THIS.isElected,
                    memoryUsage: process.memoryUsage()
                }, null, {mandatory: false}).catch(_.noop);
            });

            let awareOf = null;

            // Listen to elect myself
            let listenerElect = _THIS.listen.call({
                noCheck: true,
                queueName: Q_INTERNAL_MESSAGES.name
            }, `_mms_elect.${UNIQUE_ID}.req`, (msg) => {
                let prom = when();
                // If awareOf == null, getStatus()
                if (awareOf == void 0)
                    prom = _THIS.getStatus(_THIS.name, {expiresAfter: setupOpts.discoverable.electionTimeout}).then(function (st) {
                        if (awareOf == void 0)
                            awareOf = st.instances;
                    }).catch(_.noop);
                prom.then(function () {
                    let find = _.find(awareOf, {uniqueID: msg.body.senderID});
                    if (!find)
                        awareOf = null;
                    else {
                        find.vote = true;
                        if (_.filter(awareOf, {vote: true}).length / awareOf.length >= 0.9) {
                            if (!_THIS.isElected) {
                                _THIS.isElected = true;
                                _THIS.__emit("elected");
                                if (SUBSCRIBING)
                                    _THIS.__emit("electedAndSubscribing");
                                if (IS_READY)
                                    _THIS.__emit("electedAndReady");
                            }
                        }
                    }
                });
            });

            return when.all([listenerStatus.promise, listenerElect.promise]).then(function () {
                autoElection();
                _THIS.__emit("connected");
            });

        });
    };

    let autoElection = () => {
        return _THIS.getStatus(_THIS.name, {expiresAfter: setupOpts.discoverable.electionTimeout}).then((lao) => {
            if (!lao.instances.length)
                return autoElection();
            let oldestInstance = _.minBy(lao.instances, (inst) => {
                return inst.onlineSince;
            });
            return _THIS.privately.emit.call({noCheck: true}, _THIS.name, `_mms_elect.${oldestInstance.uniqueID}.req`, {senderID: UNIQUE_ID}, null, {mandatory: false}).catch(_.noop);
        }).delay(setupOpts.discoverable.intervalCheck).then(function () {
            return autoElection();
        });
    };

    //Start consuming
    let subscriptionMissingTimeout = setTimeout(function () {
        if (!IS_CLOSED && HAS_LISTENERS && !SUBSCRIBING)
            throw new CustomError(SERVICE_NAME + " - some handlers are set up without calling subscribe()", "subscriptionMissing", 500, "notice");
    }, setupOpts.timeoutToSubscribe);

    this.subscribe = (setAsReady = true) => {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        clearTimeout(subscriptionMissingTimeout);
        this.subscribe = () => {
            return when();
        };
        return when().then(function () {
            return rabbot.startSubscription(Q_DEAD_REQUESTS.name, Q_DEAD_REQUESTS.exclusive, CONNECTION_NAME)
                .timeout(15000, new CustomError('subscriptionTimeout', 'subscription timed out for queue %n', Q_DEAD_REQUESTS.name));
        }).then(function () {
            return rabbot.startSubscription(Q_MESSAGES.name, Q_MESSAGES.exclusive, CONNECTION_NAME)
                .timeout(15000, new CustomError('subscriptionTimeout', 'subscription timed out for queue %n', Q_MESSAGES.name));
        }).then(function () {
            return rabbot.startSubscription(Q_SHARED_MESSAGES.name, Q_SHARED_MESSAGES.exclusive, CONNECTION_NAME)
                .timeout(15000, new CustomError('subscriptionTimeout', 'subscription timed out for queue %n', Q_SHARED_MESSAGES.name));
        }).then(function () {
            return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME)
                .timeout(15000, new CustomError('subscriptionTimeout', 'subscription timed out for queue %n', Q_REQUESTS.name));
        }).then(function () {
            SUBSCRIBING = true;
            if (setAsReady)
                _THIS.setAsReady();
            _THIS.__emit("subscribing");
            if (_THIS.isElected)
                _THIS.__emit("electedAndSubscribing");
        }).then(function () {
            return _THIS.prefetch(setupOpts.simultaneousRequests);
        }).catch(function (err) {
            throw new CustomError("subscriptionError").use(err);
        });
    };

    /**
     --SENDER METHODS--
     */

    function publish(exchange, opts) {
        if (IS_CLOSED)
            return when();
        _.defaults(opts, {
            connectionName: CONNECTION_NAME,
            contentType: "application/json",
        });
        let ex = when(), _stack = new CustomError({});
        if (!rabbot.getExchange(exchange.name, CONNECTION_NAME))
            ex = rabbot.addExchange(exchange, CONNECTION_NAME);
        return ex.then(function () {
            return rabbot[opts.routingKey == 'task' ? 'request' : 'publish'](exchange.name, opts).catch(function (e) {
                let cE = new CustomError(e.message == 'unroutable' ? 'unroutableMessage' : 'publishError', {
                    publishInputs: {                 // keep in mind routing info
                        exchange,
                        opts,
                    },
                    rabbotError: e, // keep in mind the original error
                });
                cE.stack = _stack.stack;
                throw cE;
            });
        });
    };

    this.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        data = data || {};
        headers = headers || {};
        opts = opts || {};
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");
        if (!_.isString(route) || route == '' || route == '*' || route == "#")
            throw new CustomError("invalidArg", "`route` must be a non-empty string and different from * and #", 500, "fatal");
        if (!this.noCheck) {
            route = checkRoute(route);
            headers = checkHeaders(headers);
            opts = checkOpts(opts, "timeout", "expiresAfter", "isPublic", "mandatory");
        }
        _.defaults(opts, {
            isPublic: true
        });
        if (serviceName == "*")
            serviceName = "_G_", opts.isPublic = true;
        let r = (opts.isPublic ? "public." : "private.") + serviceName + "." + route;
        headers._mms_type = "message";
        headers._mms_no_reply = true;
        headers._mms_no_ack = true;
        opts.type = r;
        opts.body = data; //data is not mandatory
        opts.headers = headers;
        delete opts.isPublic; //rabbot does not care about this option
        _.defaults(opts, {
            timeout: 1000, // 1 sec
            expiresAfter: 5000, //5 sec
            mandatory: true
        });
        return publish(EXCHANGE_MESSAGES, opts);
    };

    this.publicly = {};
    this.privately = {};

    this.publicly.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        data = data || {};
        headers = headers || {};
        opts = opts || {};
        if (!this.noCheck) {
            route = checkRoute(route);
            headers = checkHeaders(headers);
            opts = checkOpts(opts, "timeout", "expiresAfter", "mandatory");
        }
        opts.isPublic = true;
        return _THIS.emit.call(this, serviceName, route, data, headers, opts);
    };

    this.privately.emit = function (serviceName, route, data, headers = {}, opts = {}) {
        data = data || {};
        headers = headers || {};
        opts = opts || {};
        if (!this.noCheck) {
            route = checkRoute(route);
            headers = checkHeaders(headers);
            opts = checkOpts(opts, "timeout", "expiresAfter", "mandatory");
        }
        opts.isPublic = false;
        return _THIS.emit.call(this, serviceName, route, data, headers, opts);
    };

    this.request = function (serviceName, taskName, data, headers = {}, opts = {}) {
        data = data || {};
        headers = headers || {};
        opts = opts || {};
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");
        if (!this.noCheck) { //if not called from an auxiliary method that already handled the controls
            headers = _.clone(checkHeaders(headers));
            headers._mms_type = "request";
            opts = _.clone(checkOpts(opts, "timeout", "replyTimeout", "expiresAfter"));
            _.defaults(opts, {
                timeout: 1000, // 1 sec
                replyTimeout: 10 * 60 * 1000, //10 min
            });
            _.defaults(opts, {
                expiresAfter: Math.round(opts.replyTimeout * 1.05)
            });
        }
        let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = when();
        TEMP_EXCHANGE_REQUESTS.name = "x.requests-" + serviceName;
        opts.routingKey = "task";
        opts.type = taskName; //internal routing (=type of request)
        opts.body = data; //data is not mandatory
        opts.headers = headers;
        opts.mandatory = true; //Must be set to true for onReturned to receive unroutable messages
        return when.promise(function (resolve, reject, notify) {
            return publish(TEMP_EXCHANGE_REQUESTS, opts)
                .progress((m) => {
                    notify(filter(m));
                }).then((m) => {
                    m = filter(m);
                    if (m && m.body.error != void 0)
                        return reject(new CustomError().use(m.body));
                    resolve(m);
                }).catch((err) => {
                    reject(err);
                });
        });
    };


    //Sugar-syntax (request with no expected response)
    this.task = (serviceName, taskName, data, headers = {}, opts = {}) => {
        data = data || {};
        headers = headers || {};
        opts = opts || {};
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "*")
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and *", 500, "fatal");
        if (!_.isString(taskName) || taskName == '' || taskName == '*' || taskName == "#")
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string and different from * and #", 500, "fatal");
        headers = _.clone(checkHeaders(headers));
        opts = _.clone(checkOpts(opts, "timeout", "expiresAfter"));
        headers._mms_type = "task";
        headers._mms_no_reply = true;
        opts.replyTimeout = -1;
        _.defaults(opts, {
            timeout: 1000, // 1 sec
        });
        return this.request.call({noCheck: true}, serviceName, taskName, data, headers, opts);
    };
    this.notify = this.task;


    /**
     --RECEIVER METHODS--
     */

    let routesListeners = [];

    function addRoutingDef(def) {
        if (IS_CLOSED)
            return when();
        routesListeners.push(def);
        return rabbot.addQueueBinding(def.exchangeName, def.queueName, def.routingKey, CONNECTION_NAME);
    };

    function removeRoutingDef(def) {
        if (IS_CLOSED)
            return when();
        let f = _.findIndex(routesListeners, def);
        if (f == -1)
            throw new CustomError("routingKeyError", "failed to remove routingKey " + def.routingKey + " on " + def.queueName + " " + def.exchangeName + ": routesListeners array does not include it", 500, "fatal");
        _.pullAt(routesListeners, [f]);
        if (_.findIndex(routesListeners, def) == -1)
            return rabbot.removeQueueBinding(def.exchangeName, def.queueName, def.routingKey, CONNECTION_NAME);
        return when();
    };

    this.listen = function (route, handler, serviceName = SERVICE_NAME) {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!_.isString(route) || route == '')
            throw new CustomError("invalidArg", "`route` must be a non-empty string", 500, "fatal");
        if (!_.isString(serviceName) || serviceName == '' || serviceName == "#" || serviceName == "_G_") //* is authorized
            throw new CustomError("invalidArg", "`serviceName` must be a non-empty string and different from # and _G_", 500, "fatal");

        if (!this.noCheck)
            route = checkRoute(route);

        let queueName = this.queueName || Q_MESSAGES.name,
            exchangeName = this.exchangeName || EXCHANGE_MESSAGES.name,
            routes = [],
            promises = [];

        if (queueName !== Q_INTERNAL_MESSAGES.name)
            HAS_LISTENERS = true;

        if (queueName == Q_DEAD_REQUESTS.name)
            routes.push(
                {exchangeName: exchangeName, routingKey: "task", queueName: queueName}
            );
        else if (serviceName == "*")
            routes.push(
                {
                    exchangeName: exchangeName,
                    routingKey: "public.*." + route,
                    queueName: queueName
                },
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
            if (def.routingKey == "task") // Q_DEAD_REQUESTS
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
        return _THIS.listen.call({queueName: Q_SHARED_MESSAGES.name}, route, handler, serviceName);
    };

    this.death = {};
    this.death.listen = function (route, handler, serviceName = SERVICE_NAME) { //todo: remove subscription
        return _THIS.listen.call({
            queueName: Q_DEAD_REQUESTS.name,
            exchangeName: "x.dead-requests-" + serviceName
        }, route, handler, serviceName);
    };


    let // variables touched by memory handling process and used in .handle()
        memoryPressureHandler = null,
        memoryPressureTracer = tracer.context('memory-handling'),
        requestsNeedToWait = {status: false, nackTimeout: null, bulk: []},
        // variables touched by prefetch handling
        isPrefetchRunning = false,
        prefetchCounts = [],
        lastPrefetchCount = setupOpts.simultaneousRequests;


    function handleWaitingRequests(status = 'resolve', nFirst) {

        let bulkSize = requestsNeedToWait.bulk.length;

        if (nFirst == void 0)
            nFirst = bulkSize;

        // preferred check
        nFirst = _.min([nFirst, bulkSize]);

        if (nFirst > 0)
            memoryPressureTracer.debug('handling waiting requests ( %n / %t ): %s', nFirst, bulkSize, status);

        for (let i = 0; i < nFirst; i++) {
            let req = requestsNeedToWait.bulk[i];
            if (status == 'reject')
                req.message.nack();
            req.defer[status]();
        }

        if (nFirst > 0)
            requestsNeedToWait.bulk = _.drop(requestsNeedToWait.bulk, nFirst);

        if (status == 'resolve')
            requestsNeedToWait.status = false;
        else
            requestsNeedToWait.status = true;

    };

    this.handle = (taskName, handler) => {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!_.isString(taskName) || taskName == '')
            throw new CustomError("invalidArg", "`taskName` must be a non-empty string", 500, "fatal");

        HAS_LISTENERS = true;

        let _handlerError = function (err, message) {
            throw err;
        };

        function _handler(message) {
            message = filter(message);
            let s = when();
            if (requestsNeedToWait.status) {
                let d = when.defer();
                requestsNeedToWait.bulk.push({defer: d, message: message});
                s = d.promise;
            }
            return s.then(function () {
                return handler.call(this, message);
            }.bind(this), _.noop).catch(function (err) {
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

    /**
     --EXTRA METHODS--
     */

    const acquireConnection = function () {
        return when(_.get(rabbot.connections, CONNECTION_NAME + ".connection"));
    };

    const acquireChannel = function (channelName) {
        return acquireConnection().then(function (connection) {
            if (connection == void 0)
                throw new CustomError("connectionMissing", "Cannot acquire channel %s", channelName, 500, "fatal");
            return connection.getChannel(channelName);
        })
    };

    const prefetch = (count) => {
        return acquireConnection().then(function (connection) {
            if (connection == void 0)
                return when.reject(new CustomError("connectionMissing", "connection is missing. prefetch() has maybe been called on a closed service.", 500, "fatal"));
            return acquireChannel(["queue", Q_REQUESTS.name].join(":"))
        }).then(function (queueChannel) {
            tracer.log("prefetching: %c, current consumers: %c, current tag: %t", count, _.keys(queueChannel.item.consumers), queueChannel.tag);
            if (_.keys(queueChannel.item.consumers).length == 0 && queueChannel.tag == void 0 && count == 0) {
                tracer.log("prefetch(0) ignored because there are no consumers");
                return when();
            }
            if (!SUBSCRIBING)
                return when();
            return acquireChannel("ctrl:prefetch:" + UNIQUE_ID).then(function (controlChannel) {
                //Check queue
                return controlChannel.checkQueue(Q_REQUESTS.name).then(_.noop, function () {
                    //Queue does not exist anymore, clean properly
                    return rabbot.deleteQueue(Q_REQUESTS.name, CONNECTION_NAME).then(function () {
                        return acquireConnection().then(function (connection) {
                            return connection.removeChannel(["queue", Q_REQUESTS.name].join(":"));
                        }).then(function () {
                            //Recreate a channel, a queue and add binding...
                            return acquireChannel(["queue", Q_REQUESTS.name].join(":")).then(function () {
                                //This is actually a restore-procedure (queue->no queue->queue) and so bindings are rebuilt
                                return rabbot.addQueue(Q_REQUESTS.name, Q_REQUESTS, CONNECTION_NAME);
                                //return rabbot.bindQueue(EXCHANGE_REQUESTS.name, Q_REQUESTS.name, ["task"], CONNECTION_NAME);
                            })
                        });
                    })
                })
            }).then(function () {
                //Here we can be sure the binded queue exists ...So we can either stop flowing messages or change prefetch()
                if (count == 0)
                    return rabbot.stopSubscription(Q_REQUESTS.name, CONNECTION_NAME);
                else
                    return rabbot.startSubscription(Q_REQUESTS.name, Q_REQUESTS.exclusive, CONNECTION_NAME).then(function () {
                        return acquireChannel(["queue", Q_REQUESTS.name].join(":")).then(function (queueChannel) {
                            return when.all([queueChannel.prefetch(count, false), queueChannel.prefetch(count, true)]);
                        });
                    });
            }).then(function () {
                return acquireChannel(["queue", Q_REQUESTS.name].join(":")).then(function (queueChannel) {
                    tracer.log("prefetched: %c, current consumers: %c, current tag: %t", count, _.keys(queueChannel.item.consumers), queueChannel.tag);
                    if (count == 0 && (_.keys(queueChannel.item.consumers).length != 0 || queueChannel.tag != void 0))
                        throw new CustomError("badResult", "Channel should have no consumers at this time", 500, "fatal");
                    if (count != 0 && (_.keys(queueChannel.item.consumers).length == 0 || queueChannel.tag == void 0))
                        throw new CustomError("badResult", "Channel should have a consumer at this time", 500, "fatal");
                });
            });
        });
    };

    function runPrefetch() {
        if (!prefetchCounts.length)
            return (isPrefetchRunning = false); //stop
        let countDef = prefetchCounts.shift();
        prefetch(countDef.count).then(countDef.defer.resolve, countDef.defer.reject).then(runPrefetch);
    };

    this.prefetch = function (count) {
        if (IS_CLOSED && !this.priority)
            return when();
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        if (!this.doNotRemember)
            lastPrefetchCount = count;
        let defer = when.defer();
        prefetchCounts[this.priority ? 'unshift' : 'push']({defer: defer, count: count});
        if (!isPrefetchRunning)
            isPrefetchRunning = true, runPrefetch();
        return defer.promise;
    };

    this.getWaitingRequests = function () {
        return requestsNeedToWait;
    };

    this.setMemoryHandling = function (memoryHandleParams) {

        memoryPressureTracer.debug('Setting up a memory handling process...');

        handleWaitingRequests('resolve');

        if (memoryPressureHandler) { // cancel previous memory handler if any
            memoryPressureHandler.clear();
            memoryPressureHandler = null;
            _THIS.memoryPressureHandler = memoryPressureHandler;
        }

        if (!memoryHandleParams)
            return true;

        _THIS.memoryPressureHandler = memoryPressureHandler = memoryPressure.new(CONNECTION_NAME, memoryHandleParams);

        let events = [
            memoryPressure.EVENTS.UNDER_PRESSURE,
            memoryPressure.EVENTS.PRESSURE_RELEASED
        ];

        events.forEach(function (ev, evIndex) {

            memoryPressureHandler.on(ev, function (mem) {

                memoryPressureTracer.info("event received: %e", ev);

                let prefetchCount = ev == memoryPressure.EVENTS.PRESSURE_RELEASED ? lastPrefetchCount : 1;

                if (ev == memoryPressure.EVENTS.UNDER_PRESSURE)
                    handleWaitingRequests('reject', 0); // upcoming requests will be on hold!
                else {

                    clearTimeout(requestsNeedToWait.nackTimeout);
                    requestsNeedToWait.nackTimeout = null;

                    handleWaitingRequests('resolve');
                }

                return retry(function (max, i, insistFn, giveUpFn) {
                    memoryPressureTracer.info("calling prefetch(%c), attempt:%i", prefetchCount, i);
                    return _THIS.prefetch.call({doNotRemember: true}, prefetchCount).catch(function (err) {
                        tracer.error("prefetch(%c) failed", prefetchCount, err);
                        throw err;
                    });
                }, 2000, 3).then(function () {
                    memoryPressureTracer.info("Finally, prefetch(%c) succeeded", prefetchCount);
                }).catch(function (err) {
                    memoryPressureTracer.error("Finally, prefetch(%c) failed", prefetchCount);
                }).finally(function () {

                    // If requests entered between the moment where flag=waiting and the effective prefetch(1), empty all but 1
                    if (ev == memoryPressure.EVENTS.UNDER_PRESSURE && requestsNeedToWait.bulk.length > 1) {
                        handleWaitingRequests('reject', requestsNeedToWait.bulk.length - 1);
                    }

                    // In rare case where the last pending item takes actually the whole memory, empty the bulk and let's see
                    if (ev == memoryPressure.EVENTS.UNDER_PRESSURE && requestsNeedToWait.nackTimeout == void 0) {
                        memoryPressureTracer.info('sets a reminder after %t ms to nack all waiting requests if memory is not released on time...', setupOpts.memoryPressureHandled.nackAfter);
                        requestsNeedToWait.nackTimeout = setTimeout(() => {

                            clearTimeout(requestsNeedToWait.nackTimeout);
                            requestsNeedToWait.nackTimeout = null;

                            memoryPressureTracer.info('calling handleWaitingRequests(status=reject) due to the reminder: going to approximately release %s mb', sizeof(requestsNeedToWait.bulk) / 1e6);

                            handleWaitingRequests('reject');

                        }, setupOpts.memoryPressureHandled.nackAfter);
                    }

                    memoryPressureTracer.info('inform memory-pressure that we took care of the event %e, waiting now for next event ( logically: %e )', ev, events[(((evIndex + 1) % 2))]);

                    mem.ack();
                });
            });
        });
        return true;
    };

    if (setupOpts.memoryPressureHandled)
        this.setMemoryHandling(setupOpts.memoryPressureHandled);

    this.getRequestsReport = (serviceName) => {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        return acquireChannel("ctrl:report:" + UNIQUE_ID).then(function (channel) {
            return channel.checkQueue("q.requests-" + serviceName).then(function (r) {
                return {
                    queueSize: r.messageCount
                };
            }, function () {
                throw new CustomError("requestsReportUnavailable", 500, "fatal");
            });
        });
    };

    this.setAsReady = () => {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        IS_READY = true;
        _THIS.__emit("ready");
        if (_THIS.isElected)
            _THIS.__emit("electedAndReady");
        return this;
    };

    this.setAsUnready = () => {
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        IS_READY = false;
        _THIS.__emit("unready");
        return this;
    };

    this.getStatus = (serviceName, opts = {}) => { //if isElected == null, we do not care, if isElected=bool, we specify
        if (!ONLINE_SINCE)
            throw new CustomError("connectionMissing", "This instance is not connected and therefore cannot perform this action", 500, "fatal");
        opts = _.clone(checkOpts(opts, "isElected", "expiresAfter"));
        _.defaults(opts, {
            expiresAfter: 300
        });
        let replyRoute = "_mms_status.res." + uuid.v4(),
            instances = [],
            listener = _THIS.listen.call({
                queueName: Q_INTERNAL_MESSAGES.name,
                noCheck: true
            }, replyRoute, (msg) => {
                instances.push(msg.body);
            });
        return listener.promise.then(function () {
            return _THIS.privately.emit.call({noCheck: true}, serviceName, "_mms_status.req", {
                replyTo: {
                    serviceName: SERVICE_NAME,
                    route: replyRoute
                }
            }, null, {mandatory: false}).catch(_.noop);
        }).delay(opts.expiresAfter).then(function () {
            let find = {
                isReady: true
            };
            if (opts.isElected !== void 0)
                find.isElected = opts.isElected;
            let inst = _.find(instances, find);
            return {
                isReady: _.get(inst, "isReady") || false,
                instances: instances
            }
        }).finally(function () {
            return listener.remove().catch(_.noop);
        });
    };


    let poll = require('when/poll');
    this.waitForService = (serviceName, opts = {}) => {
        opts = _.clone(checkOpts(opts, "timeout", "isElected"));
        _.defaults(opts, {
            timeout: 3 * 60 * 1000 //3min
        });
        let endTime = Date.now() + opts.timeout, attempts = 0;
        delete opts.timeout;
        return poll(function () {
            return _THIS.getStatus(serviceName, opts);
        }, 300, function stopCondition(status) {
            attempts++;
            return status.isReady || Date.now() > endTime;
        }).then(function (status) {
            if (!status.isReady)
                throw new CustomError("unready", "Waiting for service %s to be ready timed out", serviceName, 500, "fatal", {status: _.extend(status, {attempts: attempts})});
            return _.extend(status, {attempts: attempts});
        });
    };

    this.waitForServices = (serviceNames, opts = {}) => {
        if (!_.isArray(serviceNames))
            throw new CustomError("`serviceNames` must be an array of strings", "badArgument", 500, "fatal");
        return when.all(_.map(serviceNames, (serviceName) => {
            return this.waitForService(serviceName, opts);
        }))
    };

};


module.exports = {Service: Service};
