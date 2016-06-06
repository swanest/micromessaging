let amqp = require("amqplib/callback_api"),
    _ = require("lodash"),
    logLib = require("logger"),
    uuid = require("node-uuid");

let rabbit = {},
    connection = null,
    channel = null; //1 channel per thread. because of NodeJs which is mono-thread, we just use one common channel

let env = process.env.NODE_ENV || "development",
    tracer = new logLib.Logger({
        namespace: "rabbit", //define a namespace if you want to be able to activate, deactivate the logging module by passing DEBUG=name as environment variable
        environment: env,
        context: null,//{id:"a name that represents the context, like a sessionId", contents:{bigObject:{foo:bar}}}
        streams: {
            stdOut: {
                formatter: logLib.formatters.beautiful({
                    linesBetweenLogs: 2,
                    environment: true,
                    namespace: true,
                    context: false, //can also be a mapping function that takes as argument context.contents and retransforms it, or true to show the complete context.contents object
                    idContext: true, //Show the idContext if any
                    level: true,
                    pid: true,
                    date: "DD/MM/YY HH:mm UTC",
                    inBetweenDuration: true
                }),
                levels: {
                    DEBUG: true,
                    INFO: true,
                    WARNING: true,
                    ERROR: true,
                    FATAL: true
                }
            }
        }
    });

const connect = (url, options) => {
    return new Promise((resolve, reject) => {
        amqp.connect(url, options, (err, conn)=> {
            if (err)
                tracer.error("Connection error", err, url, options), reject(err);
            else
                tracer.debug("Connected to rabbit server", url, options), resolve(conn);
        });
    });
};

const createChannel = (conn) => {
    return new Promise((resolve, reject) => {
        conn.createChannel((err, channel)=> {
            if (err)
                tracer.error("A channel could not be created", err), reject(err);
            else
                tracer.debug("A channel has been created", channel), resolve(channel);
        });
    });
};

const genPromise = (r) => {
    return new Promise((resolve, reject) => {
        setImmediate(()=> {
            resolve(r);
        });
    });
};


rabbit.connect = (url = "amqp://localhost", options = null) => {
    return connect(url, options).then((c) => {
        connection = c;
        return createChannel(c);
    }).then((c)=> {
        channel = c;
        return;
    });
};

rabbit.emit = (data = null, route = "*", exchange = "main") => {
    let opts = {
        exchange: {durable: false}
    };
    channel.assertExchange(exchange, 'topic', opts.exchange);
    channel.publish(exchange, route, new Buffer(JSON.stringify(data)));
    tracer.debug("Emitted message: %m on %e/%r", data, exchange, route);
};

rabbit.on = (route = "*", exchange = "main", callback = null) => {
    let opts = {
        exchange: {durable: false},
        queue: {exclusive: true},
        consume: {noAck: true}
    };
    if (_.isFunction(arguments[1]))
        callback = exchange, exchange = "main";
    channel.assertExchange(exchange, 'topic', opts.exchange);
    channel.assertQueue('', opts.queue, function (err, q) {
        tracer.debug("Waiting for emitted messages on %e/%r", exchange, route);
        channel.bindQueue(q.queue, exchange, route);
        channel.consume(q.queue, (msg)=> {
            msg.data = JSON.parse(msg.content.toString());
            tracer.log("Received emitted message %m on %e/%r | criteria:%c", msg.data, msg.fields.exchange, msg.fields.routingKey, route);
            callback(msg);
        }, opts.consume);
    });
};

rabbit.request = (myQueue = "task", data = null, callback = null) => {

    let opts = {
        queue: {durable: true},
        msg: {persistent: true, contentType: "application/json"}
    };

    channel.assertQueue(myQueue, opts.queue);

    if (_.isFunction(callback)) {
        let corr = uuid.v4();
        //Waiting for response to our request
        channel.assertQueue('', {exclusive: true}, function (err, q) {
            tracer.debug("Sending request/callback with data %d on %q", data, myQueue);
            channel.consume(q.queue, function (msg) {
                console.log("bizzzzzzarreeeee")
                if (msg.properties.correlationId == corr) {
                    msg.data = JSON.parse(msg.content.toString());
                    callback(msg);
                }
            }, {noAck: true});

            var ooo = _.extend({
                correlationId: corr,
                replyTo: q.queue
            }, opts.msg);

            console.log(ooo);

            channel.sendToQueue(myQueue, new Buffer(JSON.stringify(data)), ooo);
        });
    }
    else {
        tracer.debug("Sending request with data %d on %q", data, myQueue);
        channel.sendToQueue(myQueue, new Buffer(JSON.stringify(data)), opts.msg);
    }
};

rabbit.handle = (myQueue = "task", callback = null) => {
    let opts = {
            queue: {durable: true},
            prefetch: null
        },
        open = null;

    if (opts.prefetch)
        open = createChannel();
    else
        open = genPromise(channel);

    open.then((channel)=> {
        channel.assertQueue(myQueue, opts.queue);
        opts.prefetch && channel.prefetch(opts.prefetch);
        tracer.debug("Waiting for requests on %q", myQueue);

        channel.consume(myQueue, function (msg) {
            msg.data = JSON.parse(msg.content.toString());
            tracer.debug("Request received with data %d on %q Ack required ; Response asked:%r", msg.data, myQueue, msg.properties.replyTo != null);
            let ackFunc = (response) => {
                channel.ack(msg);
                if (msg.properties.replyTo)
                    channel.sendToQueue(msg.properties.replyTo,
                        new Buffer(JSON.stringify(response)),
                        {correlationId: msg.properties.correlationId});

            };
            callback(msg, ackFunc);
        }, {noAck: false});

    })
};


module.exports = rabbit;

