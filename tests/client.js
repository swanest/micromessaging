#!/usr/bin/env node
var rabbit = require("../lib");


rabbit.connect()
    .then((channel)=> {

        //rabbit.on("analysis", function (msg) {
        //    console.log(msg);
        //});

        rabbit.emit({myData:"hello babe"}, "analysis.blabla");


        rabbit.request("aRequest", {symbol: "AAPL"}, function (response) {
            console.log("response", response.data);
        });


    })
    .catch((errConn)=> {
        console.log("errConnect", errConn);
    });