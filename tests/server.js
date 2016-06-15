#!/usr/bin/env node
var logLib = require("logger"),
    micromessaging = require("../lib"),
    serviceName = process.argv[2],
    tracer = new logLib.Logger({namespace: "micromessaging"}).context(null, "tests-server-" + serviceName);

tracer.log("Welcome on %s process", serviceName); //launch at the same time ‘analysis‘ and ‘quotes' modules

micromessaging.service(serviceName);
micromessaging.connect();

micromessaging.on("unreachable", ()=> {
    tracer.warn("We should close this worker");
});

micromessaging.on("ready", ()=> {

    tracer.log("Connected");

    //LISTEN to public & private messages regarding the service ‘serviceName‘
    micromessaging.listen("stock.aapl.volatility", function (message) {
        tracer.log("message received for *.stock.aapl.volatility", message.body, message.fields.routingKey);
    });

    micromessaging.listen("stock.msft.*", function (message) {
        tracer.log("message received for *.stock.msft.*", message.body, message.fields.routingKey);
    });

    micromessaging.listen("stock.#", function (message) {
        tracer.log("message received for *.stock.#", message.body, message.fields.routingKey);
    });

    micromessaging.listen("other", function (message) {
        tracer.log("message received for *.other", message.body, message.fields.routingKey);
    });

    //LISTEN to public messages regarding ‘quotes‘ module
    micromessaging.listen("report", function (message) {
        tracer.log("GLOBAL message received for report, originated for module quotes", message.body, message.fields.routingKey);
    }, "quotes"); //replace ‘quotes‘ by ‘*‘ to get all public messages from all modules


    micromessaging.listen("report", function (message) {
        tracer.log("GLOBAL message received for report", message.body, message.fields.routingKey);
    }, "*");

    micromessaging.handle("test", function (message) {
        tracer.log("test/handle..." + message.body.i);
        for (var i = 0; i < 10000; i++) {
            message.reply({i: i}, {more: i != 9999});
        }
    });

    micromessaging.handle("test2", function (message) {
        tracer.log("test2/handle..." + message.body.i);
        for (var i = 0; i < 10000; i++) {
            message.reply({i: i}, {more: i != 9999});
        }
    });

});