#!/usr/bin/env node
var logLib = require("logger"),
    tracer = new logLib.Logger({namespace: "micromessaging"}).context(null, "tests-client"),
    micromessaging = require("../lib"),
    Q = require("q"),
    moment = require("moment");


micromessaging.connect();

micromessaging.on("unreachable", ()=> {
    tracer.warn("We should close this worker");
});

micromessaging.on("ready", ()=> {

    tracer.log("Connected");

    //EMIT MESSAGES on ‘analysis‘ module
    micromessaging.emit("analysis", "stock.aapl.volatility", {analysisSymbol: "aapl"}).catch(console.error);
    micromessaging.emit("analysis", "stock.msft.volatility", {analysisSymbol: "msft"}).catch(console.error);


    //EMIT MESSAGES on ‘quotes‘ module in a private and public mode
    //setInterval(function () {
        micromessaging.emit("quotes", "other", {priv: "bar"}).catch(console.error);
        micromessaging.emit("quotes", "report", {public: "hi"}, null, true).catch(console.error);
    //}, 2000);


    //EMIT MESSAGES on all modules in a public mode
    micromessaging.emit("*", "report", {allPublic: "hi"}).catch(console.error);


    var start = moment.utc();
    var proms = [];
    for (let i = 0; i < 5; i++) {
        let sp = 0;
        proms.push(micromessaging.request("analysis", "test", {i: i}).progress(function (msg) {
            if (msg.body.i < sp)
                throw "not ordered";
            sp = msg.body.i;
            //tracer.log("progress" + msg.body.i);
        }).then(function (msg) {
            tracer.log("finished" + i, msg.body);
        }).catch(console.error));
    }


    Q.all(proms).then(function () {
        tracer.warn("Time needed", moment.utc().diff(start, "second"));

        //
        //for (let i = 0; i < 1000; i++) {
        //    let sp = 0;
        //    proms.push(micromessaging.request("analysis", "test2", {i: i}).progress(function (msg) {
        //        if (msg.body.i < sp)
        //            throw "not ordered";
        //        sp = msg.body.i;
        //        //tracer.log("progress" + msg.body.i);
        //    }).then(function (msg) {
        //        tracer.log("finished" + i, msg.body);
        //    }).catch(console.error));
        //}

    });


    //var prom2 = micromessaging.request("analysis", "test", {i: 1});
    //console.log(prom2.progress);

});