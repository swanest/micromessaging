Micromessaging
===================


This module has been written for Swanest back-end. It eases the use of messaging between microservices. It already uses a higher level of abstraction of RabbitMQ provided by the great [Rabbot module written by Alex Robson](https://github.com/arobson/rabbot)

----------


Installation
-------------

    npm install https://github.com/swanest/micromessaging

Server
-------------

    micromessaging = require("micromessaging");

    //Define your microservice
    micromessaging.service("abc");

    //Connect to RabbitMQ server
    micromessaging.connect(uri = process.env.RABBITMQ_URI || "amqp://localhost");
    
    micromessaging.on("unreachable", ()=> {
	    console.error("We should close this worker");
	    process.exit(1);
    });
    
    micromessaging.on("ready", ()=> {
	    //We are connected
	    
	    //Listening to private and public messages regarding service ‘abc‘ related to splits
	    micromessaging.listen("stock.aapl.split", function (message) {
	        console.log(message.body);
	    });
	
		//Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
	    micromessaging.listen("stock.msft.*", function (message) {
	        console.log(message.body, message.fields.routingKey);
	    });
	
		//Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
	    micromessaging.listen("stock.#", function (message) {
	        console.log(message.body, message.fields.routingKey);
	    });
	
	    //Listening to public messages regarding service ‘xyz‘ module
	    micromessaging.listen("health.memory", function (message) {
	        console.log(message.body, message.fields.routingKey);
	    }, "xyz");
	
	    //Listening to global public messages
	    micromessaging.listen("health.memory", function (message) {
	        console.log(message.body, message.fields.routingKey);
	    }, "*");
	
		//Handling a request
	    micromessaging.handle("time-serie", function (message) {
	        tracer.log("time-serie request", message.body);
	        for (var i = 0; i < 10000; i++) {
	            message.reply({i: i}, {more: i != 9999}); //stream mode
	        }
	    });

    });



Client
-------------

    micromessaging.connect();

    micromessaging.on("unreachable", ()=> {
        console.error("We should close this worker");
        process.exit(1);
    });

    micromessaging.on("ready", ()=> {
        console.log("Connected");

        //Emit message on ‘abc‘ service
        micromessaging.emit("abc", "stock.aapl.split", {ratio: "7:1"}, {headerAppInfo:"test"}).then(()=>{console.log("ok"); }).catch(console.error);
        micromessaging.emit("abc", "stock.aapl.cashDiv", {amount: 0.52}).then(()=>{console.log("ok"); }).catch(console.error);
        micromessaging.emit("abc", "stock.msft.split", {ratio: "3:1"}).then(()=>{console.log("ok"); }).catch(console.error);
        micromessaging.emit("abc", "stock.msft.cashDiv", {amount: 0.72}).then(()=>{console.log("ok"); }).catch(console.error);

        //Emit on xyz in private mode
        micromessaging.emit("xyz", "health.memory", {status: "bad"}, {additionalInfoA:1,additionalInfoB:3}).catch(console.error); //abc won't catch it

        //Emit on xyz in public mode
        micromessaging.emit("xyz", "health.memory", {status: "good"}, null,true).catch(console.error); //abc will catch it

        //Emit on all available microservices
        micromessaging.emit("*", "health.memory", {status: "Hello folks"}, {headerInfo:"blabla"}).catch(console.error); //abc will catch it

        //Make a request on abc
        micromessaging.request("abc", "time-serie", {test: "ok"}).progress(function (msg) {
                console.log("progress", msg.body);
            }).then(function (msg) {
                console.log("finished", msg.body);
            }).catch(console.error));
    });

API references
-------------

@todo