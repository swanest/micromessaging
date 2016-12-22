let rabbot = require("rabbot"),
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

let INSTANCES_ON_SAME_PROCESS = new Map(); //Map of connectionNames

//Rabbot configuration
rabbot.hasHandlers = true; //mute warnings when we start subscribing to the queues without any handler already in place
rabbot.ignoreHandlerErrors(); //It is not micromessaging's job to handle processes' errors

rabbot.onReturned((message) => {
    let inst = INSTANCES_ON_SAME_PROCESS.get(message.fields.connectionName);
    if (inst == void 0)
        return console.log("@micromessaging-warning: a message is unroutable but the sender service has been closed");
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
        emitter = new EventEmitter(),

        HAS_LISTENERS = false,
        ONLINE_SINCE = null,
        IS_CLOSED = null,
        SUBSCRIBING = false,
        UNIQUE_ID = uuid.v4(),
        SERVICE_NAME = name,
        CONNECTION_NAME = SERVICE_NAME + "-" + UNIQUE_ID,
        IS_READY = false;

    INSTANCES_ON_SAME_PROCESS.set(CONNECTION_NAME, this);

    //Fill in default configuration
    setupOpts = defaultConf(SERVICE_NAME, CONNECTION_NAME, setupOpts);

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

    //rabbot's `connected` event does not equal micromessaging's event, it's equivalent to `configured` event.
    this.on = emitter.on.bind(emitter);
    this.once = emitter.once.bind(emitter);
    this.__emit = emitter.emit.bind(emitter);
    this.name = name;

    let memoryPressureHandler = null;
    if (setupOpts.memoryPressureHandled) {
        memoryPressureHandler = memoryPressure.new(CONNECTION_NAME, setupOpts.memoryPressureHandled);
        [
            {
                event: memoryPressure.EVENTS.UNDER_PRESSURE,
                count: 0
            },
            {
                event: memoryPressure.EVENTS.PRESSURE_RELEASED,
                count: null
            }
        ].forEach(function (ev) {
            memoryPressureHandler.on(ev.event, function (mem) {
                let prefetchCount = ev.count == null ? lastPrefetchCount : ev.count;
                return retry(function (max, i, insistFn, giveUpFn) {
                    tracer.info("memory: %e, calling prefetch(%c), attempt:%i", ev.event, prefetchCount, i);
                    return _this.prefetch(prefetchCount).catch(function (err) {
                        tracer.info("prefetch(%c) failed", prefetchCount);
                        throw err;
                    });
                }, 2000, 3).then(function () {
                    tracer.info("Finally, prefetch(%c) succeeded", prefetchCount);
                }).catch(function (err) {
                    tracer.info("Finally, prefetch(%c) failed", prefetchCount);
                    throw err; //let it fail
                }).finally(function () {
                    mem.ack();
                });
            });
        });
    }

    this.close = () => {
        if (ONLINE_SINCE == void 0)
            return when().then(function () {
                IS_CLOSED = true;
            });
        return when()
            .then(function () {
                rabbot.batchNack();
                if (rabbot.configurations[CONNECTION_NAME] == void 0 && rabbot.connections[CONNECTION_NAME] == void 0)
                    return;
                return rabbot.close(CONNECTION_NAME, true)
            }).then(function () {
                delete rabbot.configurations[CONNECTION_NAME], delete rabbot.connections[CONNECTION_NAME];
                for (let s in rabbot._subscriptions)
                    s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._subscriptions[s] : null;
                for (let s in rabbot._cache)
                    s.indexOf(CONNECTION_NAME) == 0 ? delete rabbot._cache[s] : null;
                INSTANCES_ON_SAME_PROCESS.delete(CONNECTION_NAME);
                memoryPressureHandler && memoryPressureHandler.clear();
                IS_CLOSED = true;
            }).timeout(1500, new CustomError(CONNECTION_NAME + " closing operation timed out (maybe due to unhandled items)"));
    };

    this.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {
        if (IS_CLOSED)
            throw new CustomError("isClosed", "Service cannot reconnect because it has been closed", 500, "fatal");
        let settings = {};
        settings.name = CONNECTION_NAME;
        settings.connection = {uri: uri, name: CONNECTION_NAME, replyQueue: Q_RESPONSES};
        settings.exchanges = [EXCHANGE_MESSAGES, EXCHANGE_REQUESTS, EXCHANGE_DEAD_REQUESTS];
        settings.queues = [Q_MESSAGES, Q_SHARED_MESSAGES, Q_REQUESTS, Q_DEAD_REQUESTS];
        settings.bindings = [ //Q_MESSAGES & Q_SHARED_MESSAGES bindings will be set later
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
            else
                emitter.emit("connected");
        });
    };

    let autoElection = () => {
        let autoElect = () => {
                this.replications = _.sortBy(this.replications, "onlineSince");
                if (!this.replications.length)
                    return;
                _.first(this.replications).isElected = true;
                if (_.first(this.replications).uniqueID == UNIQUE_ID && !this.isElected)
                    this.isElected = true, this.__emit("elected");
            },
            autoElectTimeOut = null,
            recheckTimeout = null;
        when()
            .then(() => {
                return this.listen.call({noCheck: true}, "_mms_online.res", (msg) => { //Getting all my neighbours presences
                    if (_.find(this.replications, _.pick(msg.body, "uniqueID")) != void 0) //Already in there
                        return;
                    if (msg.body.uniqueID == UNIQUE_ID)
                        msg.body.isCurrent = true;
                    this.replications.push(msg.body);
                    clearTimeout(autoElectTimeOut);
                    autoElectTimeOut = setTimeout(autoElect, setupOpts.discoverable.electionTimeout);
                }).promise;
            }).then(() => {
            return this.listen.call({noCheck: true}, "_mms_online.req", () => { //Listening on request to reveal myself
                clearTimeout(recheckTimeout);
                recheckTimeout = setTimeout(() => {
                    try {
                        this.privately.emit.call({noCheck: true}, this.name, "_mms_online.req"); //Ask all instances of service to reveal
                    } catch (e) {
                        clearTimeout(recheckTimeout); //maybe this instance has been closed in the meanwhile
                    }
                }, setupOpts.discoverable.intervalCheck);
                this.replications = [];
                this.privately.emit.call({noCheck: true}, this.name, "_mms_online.res", {
                    onlineSince: ONLINE_SINCE,
                    uniqueID: UNIQUE_ID
                });
            }).promise;
        }).then(() => {
            this.privately.emit.call({noCheck: true}, this.name, "_mms_online.req"); //Ask all instances of service (including myself) to reveal
        });
    };

    //Start consuming
    this.subscribe = (setAsReady = true) => {
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
            SUBSCRIBING = true;
            if (_.get(setupOpts, "discoverable"))
                autoElection();
            // if (setAsReady)
            //     return _this.setAsReady();
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

        let unRoutableError = new CustomError("unroutableMessage");
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
            _.defaults(opts, {
                timeout: 1000, // 1 sec
                replyTimeout: 10 * 60 * 1000, //10 min
                expiresAfter: 10 * 60 * 1000 //10 min
            });
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

        let unRoutableError = new CustomError("unroutableMessage");
        if (!rabbot.getExchange(TEMP_EXCHANGE_REQUESTS.name, CONNECTION_NAME))
            ex = rabbot.addExchange(TEMP_EXCHANGE_REQUESTS, CONNECTION_NAME);
        return ex.then(function () {
            return when.promise(function (resolve, reject, notify) {
                return rabbot.request(TEMP_EXCHANGE_REQUESTS.name, opts)
                    .progress((m) => {
                        notify(filter(m));
                    }).then((m) => {
                        m = filter(m);
                        if (m && m.body.error != void 0)
                            return reject(new CustomError().use(m.body));
                        resolve(m);
                    }).catch((err) => {
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

        HAS_LISTENERS = true;

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

        HAS_LISTENERS = true;

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
            // let connectionObj = _.get(rabbot.connections, CONNECTION_NAME),
            //     //connection = connectionObj.connection,
            //     connectionChannels = _.get(connectionObj, "channels"),
            //     queueChannel = _.get(connectionChannels, channelName),
            //     lastQueueChannel = _.get(queueChannel, "lastQueue.channel");
            return connection.getChannel(channelName);
        })
    };


    let isPrefetchRunning = false, prefetchCounts = [], lastPrefetchCount = null;
    const prefetch = (count) => {
        return acquireConnection().then(function (connection) {
            if (connection == void 0)
                return when.reject(new CustomError("connectionMissing", "connection is missing. prefetch() has maybe been called on a closed service.", 500, "fatal"));
            return acquireChannel(["queue", Q_REQUESTS.name].join(":"))
        }).then(function (queueChannel) {
            tracer.log("prefetching: %c, current consumers: %c, current tag: %t", count, _.keys(queueChannel.item.consumers), queueChannel.tag);
            if (_.keys(queueChannel.item.consumers).length == 0 && count == 0) {
                tracer.log("prefetch(0) ignored because there are no consumers");
                return when();
            }
            lastPrefetchCount = count != 0 ? count : lastPrefetchCount;
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
                            return queueChannel.prefetch(count, true);
                        });
                    });
            }).then(function () {
                return acquireChannel(["queue", Q_REQUESTS.name].join(":")).then(function (queueChannel) {
                    tracer.log("prefetched: %c, current consumers: %c, current tag: %t", count, _.keys(queueChannel.item.consumers), queueChannel.tag);
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
        let defer = when.defer();
        prefetchCounts.push({defer: defer, count: count});
        if (!isPrefetchRunning)
            isPrefetchRunning = true, runPrefetch();
        return defer.promise;
    };

    this.getRequestsReport = (serviceName) => {
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

    // this.setAsReady = () => {
    //     IS_READY = true;
    //     return this;
    // };
    //
    // this.setAsUnready = () => {
    //     IS_READY = false;
    //     return this;
    // };
    //
    // this.getStatus = (serviceName, isElected) => {
    //     let reqUUID = uuid.v4();
    //     //Listen for request-responses
    //     this.listen("status-res-")
    //
    // };
    //
    // this.waitForService = (serviceName, isElected) => {
    //
    // };

    setTimeout(function () {
        if (HAS_LISTENERS && !SUBSCRIBING)
            throw new CustomError(SERVICE_NAME + " - some handlers are set up without calling subscribe()", "subscriptionMissingError", 500, "notice");
    }, 15000);

};


module.exports = {Service: Service};
