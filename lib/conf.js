const _ = require("lodash");

module.exports = function (SERVICE_NAME, CONNECTION_NAME, setupOpts) {
    let conf = {
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
                expires: 10 * 60 * 1000, //deleted if unused during 10min
                autoDelete: false
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
    };

    setupOpts = setupOpts || {};

    _.defaultsDeep(setupOpts, conf);

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

    return setupOpts;

};