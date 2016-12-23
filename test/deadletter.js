var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;
var tracer = new (require("sw-logger").Logger)();


describe("When dead-lettering", function () {


    it("dead-letters", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var abc_1 = new Service("server-dl", {entities:{
            Q_REQUESTS:{
                autoDelete:false
            }
        }});
        when.all([client.connect(), abc_1.connect()]).then(function () {
            return when.all([abc_1.subscribe(), client.subscribe()]);
        }).then(function () {
            return abc_1.prefetch(0);
        }).then(function () {
            let mess;
            client.death.listen("foo", function (message) {
                mess = message
            }, "server-dl").promise.then(function () {
                client.task("server-dl", "foo", {test: 1}, {blabla: 2}, {
                    expiresAfter: 500
                }).catch(done);
            });
            setTimeout(function () {
                expect(mess).to.have.deep.property("headers.x-death");
                done();
            }, 1000);
        }).catch(done);
    });




    // it("channel errors", function (done) { //to make it buggy, rabbot/src/amqp/queue.js put if (noAck = false) line 108
    //     this.timeout(6000000);
    //     var client = new Service("client");
    //     var abc_1 = new Service("test6", {
    //         entities: {
    //             Q_REQUESTS: {
    //                 noBatch: true,
    //                 noAck: true,
    //                 autoDelete:true
    //             }
    //         }
    //     });
    //     when.all([client.connect(), abc_1.connect()]).then(function () {
    //         return when.all([abc_1.subscribe(), client.subscribe()]);
    //     }).then(function () {
    //
    //         setInterval(function () {
    //             client.task(abc_1.name, "ok", "test");
    //         }, 5000);
    //
    //         abc_1.handle("ok", function (msg) {
    //             console.log("Got message...");
    //             return abc_1.prefetch(0).then(function () {
    //                 return abc_1.prefetch(1);
    //             }).then(function () {
    //                 //msg.nack(); //todo: should use the latest current channel !!!
    //                 msg.ack();
    //             })
    //         });
    //
    //
    //     }).catch(done);
    // });


});