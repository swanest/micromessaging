Micromessaging
===================


This module has been written for Swanest back-end. It eases the use of messaging between microservices. It already uses a higher level of abstraction of RabbitMQ provided by the great [Rabbot module written by Alex Robson](https://github.com/arobson/rabbot)

----------


Installation
-------------

    npm install https://github.com/swanest/micromessaging


Client
-------------

```js
let logLib = require("logger"),
    tracer = new logLib.Logger({namespace: "micromessaging"}).context(null, "tests-client"),
    Service = require("../lib");

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

micromessaging.on("connected", ()=> {

    tracer.log(micromessaging.name + " is connected");

    //Emit message on ‘abc‘ service
    micromessaging.emit("abc", "stock.aapl.split", {ratio: "7:1"}, {headerAppInfo: "test"}).then(()=> {
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
    micromessaging.emit("xyz", "health.memory", {status: "bad"}, {
        additionalInfoA: 1,
        additionalInfoB: 3
    }).catch(console.error); //abc won't catch it

    //Emit on xyz in public mode
    micromessaging.emit("xyz", "health.memory", {status: "good"}, null, true).catch(console.error); //abc will catch it

    //Emit on all microservices
    micromessaging.emit("*", "health.memory", {status: "Hello folks"}, {headerInfo: 1}).catch(console.error); //abc will catch it

    //Send a request
    micromessaging.request("abc", "time-serie", {test: "ok"})
        .progress(function (msg) {
            console.log("progress", msg.body);
        })
        .then(function (msg) {
            console.log("finished", msg.body);
        })
        .catch(console.error);


});
```


Server
-------------

```js
let logLib = require("logger"),
    Service = require("../lib"),
    serviceName = process.argv[2],
    tracer = new logLib.Logger({namespace: "micromessaging"}).context(null, "tests-server-" + serviceName);

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
    }, "*");

    //Handling a request
    micromessaging.handle("time-serie", function (message) {
        tracer.log("time-serie request", message.body);
        for (var i = 0; i < 10000; i++) {
            message.reply({i: i}, {more: i != 9999}); //stream mode
        }
    });

    //As this service has consumers, it needs to subscribe to be able to start receiving messages !
    micromessaging.subscribe();
});
```


