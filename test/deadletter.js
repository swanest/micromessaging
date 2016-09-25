var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("logger").CustomError;
var tracer = new (require("logger").Logger)();

process.on("unhandledRejection", function (e) {
    console.log(e.stack, e.options, e.channel);
});

describe("When dead-lettering", function () {


    it("dead-letters", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var abc_1 = new Service("server-dl");
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


    //it.only("dead-letters bis", function (done) {
    //    this.timeout(40000);
    //    var client = new Service("client");
    //    var abc_1 = new Service("server-dl2",{config:{Q_REQUESTS:{expires:1000}}});
    //    when.all([client.connect(), abc_1.connect()]).then(function () {
    //        return when.all([abc_1.subscribe(), client.subscribe()]);
    //    }).then(function () {
    //        let mess;
    //        client.death.listen("foo", function (message) {
    //            mess = message
    //        }, "server-dl2").promise.then(function () {
    //                client.task("server-dl2", "foo", {test: 1}, {blabla: 2}, {
    //                    expiresAfter: 5000
    //                }).then(function(){
    //                    return abc_1.prefetch(0);
    //                }).catch(done);
    //            });
    //        setTimeout(function () {
    //            expect(mess).to.have.deep.property("headers.x-death");
    //            done();
    //        }, 3000);
    //    }).catch(done);
    //});


});