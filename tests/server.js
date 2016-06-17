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