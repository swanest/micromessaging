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

    micromessaging.emit("abc", "no-listener", {noListener: "that's it"}).then(()=> {
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


    //Get the amount of pending requests for a specific service
    micromessaging.getRequestsReport("abc").then(function (report) {
        tracer.log(report);
    }).catch(function (err) {
        //Unable to get the report
        tracer.error(err);
    });

    //Send a request
    //for (let i = 0; i < 1000; i++)
    //    micromessaging.task("abc", "time-serie", {test: i})
    //        .progress(function (msg) {
    //            tracer.log("progress", msg);
    //        })
    //        .then(function (msg) {
    //            tracer.log("finished", msg);
    //        })
    //        .catch(function (err) {
    //            tracer.error("error", err);
    //        });

    micromessaging.task("abc", "test", {test: "ok"});


});


