let rabbot = require("rabbot"),
    _ = require("lodash"),
    logLib = require("logger"),
    uuid = require("node-uuid"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    Q = require("q"),
    CustomError = logLib.CustomError;

let processId = uuid.v4();

//Client-specific
rabbot.onReturned(function (message) {
    tracer.warn("unRoutableMessage", message);
});
rabbot.onUnhandled(function (message) {
    tracer.warn("unHandledMessage (no handler for this message)", message);
});

//Client and Server
rabbot.on("default.connection.connected", function () {
    tracer.info("rabbit connected");
});

rabbot.on("default.connection.closed", function () {
    tracer.info("rabbit closed");
});

rabbot.on("default.connection.failed", function (err) {
    tracer.fatal("rabbit failed to connect. going to reconnect:", err);
});

rabbot.on("default.connection.unreachable", function () {
    tracer.fatal("rabbit failed to connect. connection failures have reached the limit");
});

rabbot.nackOnError();
rabbot.nackUnhandled();


let SERVICE_NAME, EXCHANGE_MESSAGES, EXCHANGE_REQUESTS, Q_PUBLIC_MESSAGES, Q_PRIVATE_MESSAGES, Q_REQUESTS;


//Our rabbitMQ wrapper, based on ‘rabbot‘ library
let U = {};

//Make events available from the outside
U.on = rabbot.on;


U.service = (name)=> {
    SERVICE_NAME = name;
    EXCHANGE_MESSAGES = {
        name: "x-messages",
        type: "topic",
        durable: false,
        persistent: false,
        limit: Math.pow(2, 16) - 1,
        noBatch: false
    };
    EXCHANGE_REQUESTS = {
        name: "x-requests-" + SERVICE_NAME,
        type: "direct",
        durable: false,
        persistent: false,
        limit: Math.pow(2, 16) - 1,
        noBatch: false
    };
    Q_PUBLIC_MESSAGES = {
        name: "q-messages-" + processId,
        limit: Math.pow(2, 16) - 1,
        queueLimit: Math.pow(2, 32) - 1,
        exclusive: true,
        noAck: true,
        subscribe: true,
        noBatch: false
    };
    Q_PRIVATE_MESSAGES = {
        name: "q-messages-" + SERVICE_NAME + "-" + processId,
        limit: Math.pow(2, 16) - 1,
        queueLimit: Math.pow(2, 32) - 1,
        exclusive: true,
        noAck: true,
        subscribe: true,
        noBatch: false
    };
    Q_REQUESTS = {
        name: "q-req-" + SERVICE_NAME,
        limit: Math.pow(2, 16) - 1,
        queueLimit: Math.pow(2, 32) - 1,
        exclusive: false,
        noAck: false,
        subscribe: true,
        noBatch: false
    };
};


U.service(processId);

U.connect = (uri = process.env.RABBITMQ_URI || "amqp://localhost") => {
    let settings = {};
    settings.connection = {uri: uri};
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
    return rabbot.configure(settings).then(function () {
        rabbot.emit("ready");
    });
};

const genPromise = (r) => {
    //return new Promise((resolve, reject) => {
    //    setImmediate(()=> {
    //        resolve(r);
    //    });
    //});
    let d = Q.defer(); //because of ‘onProgress‘
    setImmediate(()=> {
        d.resolve(r);
    });
    return d.promise;
};

U.emit = (serviceName, route, data, headers = {}, isPublic = false) => {
    if(serviceName == "*")
        serviceName = "___ALL___", isPublic = true;
    let r = (isPublic ? "public." : "private.") + serviceName + "." + route, ex = genPromise();
    if (!rabbot.getExchange(EXCHANGE_MESSAGES.name))
        ex = rabbot.addExchange(EXCHANGE_MESSAGES, "default");
    return ex.then(function () {
        return rabbot.publish(EXCHANGE_MESSAGES.name,
            {
                type: r,
                body: data,
                expiresAfter: 60*1000, // TTL in ms
                mandatory: true, //Must be set to true for onReturned to receive unqueued message
                headers: headers,
                timeout: 10 * 60 * 1000 // ms to wait before cancelling the publish and rejecting the promise
            }
        );
    });
};

U.listen = (route, handler, serviceName = SERVICE_NAME) => {
    let q = serviceName == SERVICE_NAME ? Q_PRIVATE_MESSAGES.name : Q_PUBLIC_MESSAGES.name,
        r = "*." + serviceName + "." + route;
    rabbot.handle({
        queue: q,
        type: r, // handle messages with this type name or pattern
        autoNack: true, // automatically handle exceptions thrown in this handler
        context: null // control what `this` is when invoking the handler
    }, handler);
};

U.request = (serviceName, taskName, data, headers = {}) => {
    let TEMP_EXCHANGE_REQUESTS = _.omit(EXCHANGE_REQUESTS, "name"), ex = genPromise();
    TEMP_EXCHANGE_REQUESTS.name = "x-requests-" + serviceName;
    if (!rabbot.getExchange(TEMP_EXCHANGE_REQUESTS.name))
        ex = rabbot.addExchange(TEMP_EXCHANGE_REQUESTS, "default");
    return ex.then(function () {
        return rabbot.request(TEMP_EXCHANGE_REQUESTS.name,
            {
                type: taskName,
                routingKey: "task",
                body: data,
                expiresAfter: 60*1000, // TTL in ms
                mandatory: true, //Must be set to true for onReturned to receive unqueued message
                headers: headers,
                timeout: 10 * 60 * 1000, // publish timeout
                replyTimeout: 10 * 60 * 1000 //10 min
            }
        );
    });
};

U.handle = (taskName, handler) => {
    rabbot.handle({
        queue: Q_REQUESTS.name,
        type: taskName, // handle messages with this type name or pattern
        autoNack: true, // automatically handle exceptions thrown in this handler
        context: null // control what `this` is when invoking the handler
    }, handler);
};


module.exports = U;
