Micromessaging
===================

This module has been written for Swanest back-end. It eases the use of messaging between microservices. It already uses a higher level of abstraction of RabbitMQ provided by the great [Rabbot module written by Alex Robson](https://github.com/arobson/rabbot)

----------


Installation
-------------

    npm install micromessaging --save


Client
-------------

```js
let logLib = require("sw-logger"),
    tracer = new logLib.Logger({namespace: "micromessaging"}).context("tests-client"),
    Service = require("micromessaging").Service;

let micromessaging = new Service("client"); //name your service

//Connect, by default to localhost. You may specify a string URI or ‘RABBITMQ_URI‘ env variable
micromessaging.connect();

micromessaging.on("unreachable", ()=> {
    tracer.warn(micromessaging.name + " failed to reach rabbit server");
});
micromessaging.on("unroutableMessage", (message)=> {
    tracer.warn(micromessaging.name + " encountered an unroutable message", message);
});
micromessaging.on("unhandledMessage", (message)=> {
    tracer.warn(micromessaging.name + " encountered an unhandled message", message);
});
micromessaging.on("closed", () => {
    tracer.warn(micromessaging.name + " closed its connection");
    process.exit(0);
});
micromessaging.on("failed", () => {
    tracer.warn(micromessaging.name + " failed to connect. going to reconnect");
});

//We could have called micromessaging.connect().then(...).catch(...)

micromessaging.on("connected", ()=> {

    tracer.log(micromessaging.name + " is connected");

    //Publicly emit message on ‘abc‘ service
    micromessaging.emit("abc", "stock.aapl.split", {ratio: "7:1"}, {headerAppInfo: "test"}, {timeout:300, expiresAfter:4000}).then(()=> {
        console.log("ok");
    }).catch(console.error);
    micromessaging.emit("abc", "stock.aapl.cashDiv", {amount: 0.52}).then(()=> {
        console.log("ok");
    }).catch(console.error);
    micromessaging.emit("abc", "stock.msft.split", {ratio: "3:1"}).then(()=> {
        console.log("ok");
    }).catch(console.error);
    micromessaging.emit("abc", "stock.msft.cashDiv", {amount: 0.72}).then(()=> {
        console.log("ok");
    }).catch(console.error);

    //Emit on xyz
    micromessaging.privately.emit("xyz", "health.memory", {status: "bad"}, {
        additionalInfoA: 1,
        additionalInfoB: 3
    }).catch(console.error); //abc won't receive it

    //Emit on xyz in public mode (publicly is optional, by default it's public)
    micromessaging.publicly.emit("xyz", "health.memory", {status: "good"}, null).catch(console.error); //abc will receive it

    //Emit on all microservices
    micromessaging.emit("*", "health.memory", {status: "Hello folks"}, {headerInfo: 1}).catch(console.error); //abc will receive it

    //Send a request
    micromessaging.request("abc", "time-serie", {test: "ok"}, {replyTimeout:5000})
        .progress(function (msg) {
            console.log("progress", msg.body);
        })
        .then(function (msg) {
            console.log("finished", msg.body);
        })
        .catch(console.error);

    //Send a task (meaning a request without expected answer, and without any `expiresAfter` constraint)
    micromessaging.task("abc", "time-serie", {test: "ok"}).then(console.log, console.error);

    //Notify() is a synonyme for task()
    micromessaging.notify("abc", "time-serie", {test: "ok"}).then(console.log, console.error)

});
```


Server
-------------

```js
let logLib = require("sw-logger"),
    Service = require("micromessaging").Service,
    serviceName = process.argv[2],
    tracer = new logLib.Logger({namespace: "micromessaging"}).context("tests-server-" + serviceName);

tracer.log("Welcome on %s process", serviceName); //launch at the same time ‘abc‘ and ‘zxy' modules

let micromessaging = new Service(serviceName);

micromessaging.connect();

micromessaging.on("unreachable", ()=> {
    tracer.warn(micromessaging.name + " failed to reach rabbit server");
});
micromessaging.on("unroutableMessage", (message)=> {
    tracer.warn(micromessaging.name + " encountered an unroutable message", message);
});
micromessaging.on("unhandledHandled", (message)=> {
    tracer.warn(micromessaging.name + " encountered an unhandled message", message);
});
micromessaging.on("closed", () => {
    tracer.warn(micromessaging.name + " closed its connection");
    process.exit(0);
});
micromessaging.on("failed", () => {
    tracer.warn(micromessaging.name + " failed to connect. going to reconnect");
});

//We could have called micromessaging.connect().then(...).catch(...)
micromessaging.on("connected", ()=> {

    //We are connected
    tracer.log(micromessaging.name + " is connected");

    //Listening to private and public messages regarding service ‘abc‘ related to splits
    micromessaging.listen("stock.aapl.split", function (message) {
        tracer.log("stock.aapl.split", message.fields.routingKey, message.body);
    });

    //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
    micromessaging.listen("stock.msft.*", function (message) {
        tracer.log("stock.msft.*", message.fields.routingKey, message.body);
    });

    //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
    micromessaging.listen("stock.#", function (message) {
        tracer.log("stock.#", message.fields.routingKey, message.body);
    });

    //Listening to public messages regarding service ‘xyz‘ module
    micromessaging.listen("health.memory", function (message) {
        tracer.log("health.memory /xyz", message.fields.routingKey, message.body);
    }, "xyz");

    //Listening to global public messages
    micromessaging.listen("health.memory", function (message) {
        tracer.log("health.memory /*", message.fields.routingKey, message.body);
    }, "*").onError((error, message)=>console.log);

    //Handling a request
    var handler = micromessaging.handle("time-serie", function (message) {
        tracer.log("time-serie request", message.body);
        message.write({m:1},{h:"foo"});
        message.reply({m:1},{h:"foo"});
    }).onError(function(error,message){
        console.log(error);
        message.nack();
    });

    //we could remove the subscription by doing handler.remove();

    //As this service has consumers, it needs to subscribe to be able to start receiving messages !
    micromessaging.subscribe();
});
```


Options
-------------

`new Service(name, opts)`

__Memory pressure handling__

This is by default set to `false`. But you can enable it by passing `true` as it will stop entering requests when memory is under pressure.
You can also specify the configuration.

```js
let opts = {
    memoryPressureHandled: {
            memoryThreshold: 300000000, //in bytes (300mb)
            interval: 1000, //interval check in ms (1 sec)
            consecutiveGrowths: 5
    }
}
```


__Discoverable__

Sometimes you need a leader among instances of the same service. This is possible by setting `discoverable:true` or a more specific config. 

```js
let opts = {
    discoverable: {
            intervalCheck: 3 * 60 * 1000, //in ms (3 min) - every 3min we check whether an elected instance exists
            electionTimeout: 500 //in ms, time to wait after the last signal to elect an instance
    }
}
```

You can then use as events such as "elected", "electedAndSubscribing", "electedAndReady" to perform some actions.

Exclusively
-------------

By `exclusively.listen()`, only one instance will get the message reserved to its service.


Ready / Unready
-------------

By default, calling `subscribe()` makes the instance as ready. 
But you can distinguish by calling `subscribing(false)` and then later call `ready()` or `unready()`.
This status will be used by and in both methods `getStatus(serviceName)` and `waitForService(serviceName)` 

Get status
-------------

You can ask for a partner status.

`getStatus(serviceName, [{isElected:boolean}])`


Wait for service
-------------

You can wait for one or more services to be ready

`waitForService(serviceName, [{isElected:boolean}])` or `waitForServices(serviceNames, [{isElected:boolean}])` 


Tests
-------------

    npm test
