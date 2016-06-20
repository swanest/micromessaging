let logLib = require("logger"),
    Service = require("../lib"),
    serviceName = process.argv[2],
    tracer = new logLib.Logger({namespace: "micromessaging"}).context(null, "tests-server-" + serviceName);

tracer.log("Welcome on %s process", serviceName); //launch at the same time ‘abc‘ and ‘zxy' modules

let micromessaging = new Service(serviceName);

function toBuffer(ab) {
    var buffer = new Buffer(ab.byteLength);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buffer.length; ++i) {
        buffer[i] = view[i];
    }
    return buffer;
}

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


        if (message.body instanceof Buffer)
            tracer.log("time-serie request buffer", toBuffer(message.body).toString());
        else
            tracer.log("time-serie request", message.body);


        //return setTimeout(function () {
        //    message.reply({i: message.body});
        //}, 1000)

        message.ack();

        //return
        //for (var i = 0; i < 10000; i++) {
        //    message.reply({i: i}, {more: i != 9999}); //stream mode
        //}
    });

    let t = 5;
    micromessaging.prefetch(t);
    micromessaging.subscribe(); //not necessary as prefetch() calls subscribe()

    //setInterval(function () {
    //    if (t == 1)
    //        t = 5;
    //    else
    //        t = 1;
    //    micromessaging.prefetch(t); //dynamically adjust prefetch limit
    //    console.log("=========================================================prefetch", t);
    //}, 30000);


});