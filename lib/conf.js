const _ = require("lodash");

module.exports = function (SERVICE_NAME, CONNECTION_NAME, setupOpts) {
    let conf = {
        simultaneousRequests: 500, // max Math.pow(2, 16) - 1, overlays Q_REQUESTS's consumer prefetch
        timeoutToSubscribe: 60 * 1000,
        discoverable: false,
        memoryPressureHandled: false,
        entities: {
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
            Q_INTERNAL_MESSAGES: {
                durable: false,
                name: "q.imessages-" + CONNECTION_NAME,
                limit: Math.pow(2, 16) - 1, //consumer prefetch limit
                queueLimit: Math.pow(2, 32) - 1, //max messages a queue can hold
                exclusive: true, //this queue is unique to this instance, only 1 consumer, is deleted when instance quits
                autoDelete: true, //deleted when the amount of consumers goes zero (messages left are deleted as they are supposed to be not important)
                noAck: true, //no need to ack,nack,reject...
                subscribe: true, //subscription is made automatically
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
                limit: Math.pow(2, 16) - 1, /*
                    This is the initial prefetch. As this is per new consumer, the first one (and unique) will prefetch this amount.
                    But, we cannot update it, only possible way is to cancel consumer and recreate one, which will lead to channel disruptions.
                    So the way to do it is to handle the global channel prefetch, which we can update in an ongoing manner. So put the consumer prefetch at its max. And handle global prefetch.
                    More info: http://www.rabbitmq.com/consumer-prefetch.html
                */
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

    if (setupOpts.entities.EXCHANGE_DEAD_REQUESTS != void 0)
        setupOpts.entities.Q_REQUESTS.deadLetter = setupOpts.entities.EXCHANGE_DEAD_REQUESTS.name;

    if (setupOpts.discoverable == true)
        setupOpts.discoverable = {};

    if (setupOpts.memoryPressureHandled == true)
        setupOpts.memoryPressureHandled = {};

    _.defaultsDeep(setupOpts, {
        discoverable: {
            intervalCheck: 3 * 60 * 1000, //each 3', we need to check whether there's still an elected instance online, otherwise we elect one
            electionTimeout: 3000 //time to wait (in ms) after the last online.res event to define the elected instance
        },
        memoryPressureHandled: {
            nackAfter: 5 * 60 * 1000, //if no 'PRESSURE_RELEASED' occured during that time (ms), nack all waiting requests
        }
    });

    return setupOpts;

};