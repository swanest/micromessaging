#!/usr/bin/env node
var rabbit = require("../lib");


rabbit.connect()
    .then((channel)=> {


        rabbit.handle("aRequest", function (msg, ack) {

            console.log("req", msg.data);

            var resp = {
                symbol: "AAAAAAAAAA"
            };

            ack(resp);

        });

        rabbit.on("analysis.blabla", function (msg) {
            //console.log("blabla", msg.data);
        });

        rabbit.on("analysis.*", function (msg) {
            //console.log("*", msg);
        });

        //setTimeout(function () {
        //    rabbit.emit("analysis.blabla", {monMessage: "blabla"});
        //    rabbit.emit("analysis.hello", {monMessage: "hello"});
        //}, 300);


    })
    .catch((errConn)=> {
        console.log("errConnect", errConn);
    });