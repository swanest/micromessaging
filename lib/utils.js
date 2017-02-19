// rabbit.publish( "exchange.name",
//     {
//         routingKey: "hi",
//         type: "company.project.messages.textMessage",
//         correlationId: "one",
//         contentType: "application/json",
//         body: { text: "hello!" },
//         messageId: "100",
//         expiresAfter: 1000 // TTL in ms, in this example 1 second
//         timestamp: // posix timestamp (long)
//         mandatory: true, //Must be set to true for onReturned to receive unqueued message
//     headers: {
//     random: "application specific value"
// },
// timeout: // ms to wait before cancelling the publish and rejecting the promise
//     },
// connectionName: "" // another optional way to provide connection name if needed
// );

// {
//     // metadata specific to routing & delivery
//     fields: {
//         consumerTag: "", // identifies the consumer to rabbit
//             connectionName: "", // identifies the connection name
//             deliveryTag: #, // identifies the message delivered for rabbit
//         redelivered: true|false, // indicates if the message was previously nacked or returned to the queue
//             exchange: "" // name of exchange the message was published to,
//         routingKey: "" // the routing key (if any) used when published
//     },
//     properties:{
//         contentType: "application/json", // see serialization for how defaults are determined
//             contentEncoding: "utf8", // rabbot's default
//             headers: {}, // any user provided headers
//         correlationId: "", // the correlation id if provided
//             replyTo: "", // the reply queue would go here
//             messageId: "", // message id if provided
//             type: "", // the type of the message published
//             appId: "" // not used by rabbot
//     },
//     content: { "type": "Buffer", "data": [ ... ] }, // raw buffer of message body
//     body: , // this could be an object, string, etc - whatever was published
//     type: "" // this also contains the type of the message published
// }

const _ = require("lodash"),
    logLib = require("sw-logger"),
    tracer = new logLib.Logger({namespace: "micromessaging"}),
    when = require("when"),
    CustomError = logLib.CustomError;

//Helpers and constants
const isPositiveFinite = (n) => {
    return _.isFinite(n) && n >= 0;
};

const ALLOWED_OPTIONS = {
    timeout: isPositiveFinite,
    replyTimeout: isPositiveFinite,
    expiresAfter: isPositiveFinite,
    isPublic: _.isBoolean,
    isElected: _.isBoolean,
    mandatory: _.isBoolean
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
    "_mms_status.req",
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

const retry = function (fn, intervalMS, max, i = 0, g = 0) {
    //fn = function(max,i,insistFn,giveUpFn)
    function insistFn() {
        g++;
    };
    function giveUpFn() {
        i = null;
    };
    return fn(max, i, insistFn, giveUpFn).catch(function (err) {
        if (typeof i === 'number')
            i++;
        if (i == null || (typeof i === 'number' && typeof max === 'number' && i - g > max))
            throw err;
        else
            return when().delay(intervalMS).then(function () {
                return retry(fn, intervalMS, max, i, g);
            });
    });
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


module.exports.checkHeaders = checkHeaders;
module.exports.cleanHeaders = cleanHeaders;
module.exports.checkRoute = checkRoute;
module.exports.checkOpts = checkOpts;
module.exports.retry = retry;
module.exports.filter = filter;

