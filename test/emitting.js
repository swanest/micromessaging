var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var _ = require("lodash");

describe("When emitting", function () {


    function checkMessage(message) {
        return _.isPlainObject(message.headers) &&
            _.isString(message.headers.headerAppInfo) &&
            _.isPlainObject(message.body) &&
            _.isUndefined(message.properties.reply) &&
            _.isBoolean(message.properties.isRedelivered) &&
            _.isString(message.properties.exchange) &&
            _.isString(message.properties.routingKey) &&
            _.isString(message.properties.path) &&
            _.isString(message.properties.contentType) &&
            _.isString(message.properties.contentEncoding) &&
            _.isFinite(message.properties.expiresAfter) && message.properties.expiresAfter > 0 &&
            _.isFinite(message.properties.timestamp) &&
            _.isUndefined(message.reply) &&
            _.isUndefined(message.ack) &&
            _.isUndefined(message.nack) &&
            _.isUndefined(message.reject);
    };


    it("private message", function (done) {
        var client = new Service("client");
        var abc_1 = new Service("abc");
        var abc_2 = new Service("abc");
        var xyz_1 = new Service("xyz");
        when.all([client.connect(), abc_1.connect(), abc_2.connect(), xyz_1.connect()]).then(function () {
            client.subscribe();
            abc_1.subscribe();
            abc_2.subscribe();
            xyz_1.subscribe();
            setTimeout(function () {
                client.emit("abc", "stock.aapl.split", {ratio: "7:1"}, {headerAppInfo: "test"}).then(function (r) {
                    expect(r).to.equal(undefined);
                }).catch(done);
                client.emit("abc", "stock.aapl.cashDiv", {amount: 0.52}).catch(done);
                client.emit("abc", "stock.msft.split", {ratio: "3:1"}).catch(done);
                client.emit("abc", "stock.msft.cashDiv", {amount: 0.72}).catch(done);
                client.emit("xyz", "stock.msft.cashDiv", {amount: 0.72}).catch(done);
            }, 300);
            var abc_1_responses = {}, abc_2_responses = {}, xyz_1_responses = {};
            //Listening to private and public messages regarding service ‘abc‘ related to splits
            abc_1.listen("stock.aapl.split", function (message) {
                expect(message).to.satisfy(checkMessage);
                abc_1_responses["stock.aapl.split-" + message.properties.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
            abc_1.listen("stock.msft.*", function (message) {
                abc_1_responses["stock.msft.*-" + message.properties.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
            abc_1.listen("stock.#", function (message) {
                abc_1_responses["stock.#-" + message.properties.routingKey] = message.body;
            });

            //Listening to private and public messages regarding service ‘abc‘ related to splits
            abc_2.listen("stock.aapl.split", function (message) {
                abc_2_responses["stock.aapl.split-" + message.properties.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
            abc_2.listen("stock.msft.*", function (message) {
                abc_2_responses["stock.msft.*-" + message.properties.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
            abc_2.listen("stock.#", function (message) {
                abc_2_responses["stock.#-" + message.properties.routingKey] = message.body;
            });
            xyz_1.listen("stock.#", function (message) {
                xyz_1_responses["stock.#-" + message.properties.routingKey] = message.body;
            });
            setTimeout(function () {
                expect(abc_1_responses).to.eql({
                        'stock.aapl.split-private.abc.stock.aapl.split': {ratio: '7:1'},
                        'stock.#-private.abc.stock.aapl.split': {ratio: '7:1'},
                        'stock.#-private.abc.stock.aapl.cashDiv': {amount: 0.52},
                        'stock.msft.*-private.abc.stock.msft.split': {ratio: '3:1'},
                        'stock.#-private.abc.stock.msft.split': {ratio: '3:1'},
                        'stock.msft.*-private.abc.stock.msft.cashDiv': {amount: 0.72},
                        'stock.#-private.abc.stock.msft.cashDiv': {amount: 0.72}
                    }
                );
                expect(abc_1_responses).to.eql(abc_2_responses);
                expect(xyz_1_responses).to.eql({"stock.#-private.xyz.stock.msft.cashDiv": {amount: 0.72}});
                return when.all([client.close(), abc_1.close(), abc_2.close(), xyz_1.close()]).then(function () {
                    done();
                }, done);

            }, 600);

        }).catch(done);
    });


    it("public message", function (done) {
        var client = new Service("client");
        var abc_1 = new Service("abc");
        var abc_2 = new Service("abc");
        var xyz_1 = new Service("xyz");
        when.all([client.connect(), abc_1.connect(), abc_2.connect(), xyz_1.connect()]).then(function () {
            client.subscribe();
            abc_1.subscribe();
            abc_2.subscribe();
            xyz_1.subscribe();
            setTimeout(function () {
                //Emit on xyz in public mode
                client.emit("xyz", "health.memory", {status: "good"}, null, {isPublic:true}).then(function (r) {
                    expect(r).to.equal(undefined);
                }).catch(done); //abc will catch it
                //Emit on all microservices
                client.emit("*", "health.memory", {status: "Hello folks"}, {headerInfo: 1}).catch(done); //abc will catch it
            }, 300);
            var abc_1_responses = {}, abc_2_responses = {}, xyz_1_responses = {};
            abc_1.listen("#", function (message) {
                abc_1_responses["abc_1(*) #-" + message.properties.routingKey] = message.body;
            }, "*");
            abc_2.listen("#", function (message) {
                abc_2_responses["abc_2(xyz) #-" + message.properties.routingKey] = message.body;
            }, "xyz");
            xyz_1.listen("#", function (message) {
                xyz_1_responses["xyz #-" + message.properties.routingKey] = message.body;
            });
            setTimeout(function () {
                expect(abc_1_responses).to.eql({
                    'abc_1(*) #-public.xyz.health.memory': {status: 'good'},
                    'abc_1(*) #-public.___ALL___.health.memory': {status: 'Hello folks'}
                });
                expect(abc_2_responses).to.eql({'abc_2(xyz) #-public.xyz.health.memory': {status: 'good'}});
                expect(xyz_1_responses).to.eql({'xyz #-public.xyz.health.memory': {status: 'good'}});
                when.all([client.close(), abc_1.close(), abc_2.close(), xyz_1.close()]).then(function () {
                    done();
                }, done);
            }, 1000);
        }).catch(done);
    });

    //it("should be unhandled", function (done) {
    //    this.timeout(5000);
    //    var client = new Service("client");
    //    var aaa_1 = new Service("aaa");
    //    when.all([client.connect(), aaa_1.connect()]).then(function () {
    //        client.subscribe();
    //        aaa_1.subscribe();
    //        setTimeout(function () {
    //            client.task("aaa", "unhandled", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(done);
    //        }, 300);
    //        var gottenMessage;
    //        aaa_1.on("unhandledMessage", function (message) {
    //            gottenMessage = message;
    //            message.reject();
    //        });
    //        setTimeout(function () {
    //            when.all([client.close(), aaa_1.close()]).then(function () {
    //                expect(gottenMessage).to.satisfy(checkMessage);
    //                done();
    //            }, done);
    //
    //        }, 1000);
    //
    //    }).catch(done);
    //});


    it("should throw", function (done) {
        this.timeout(5000);
        var client = new Service("client");
        client.connect().then(function () {
            expect(client.emit("bbb", "unRoutable", {needsToBeRedelivered: true}, {response_forbidden: true}, {expiresAfter: 4000})).to.throw();
            //client.task("bbb", "unRoutable", {needsToBeRedelivered: true}, {testH: true}, {unAllowedOption: true});


            setTimeout(function () {
                client.close().then(function () {
                    done();
                }, done);
            }, 1000);

        }).catch(done);
    });

    //it("should be unhandled", function (done) {
    //    this.timeout(5000);
    //    var client = new Service("client");
    //    var aaa_1 = new Service("aaa");
    //    when.all([client.connect(), aaa_1.connect()]).then(function () {
    //        client.subscribe();
    //        aaa_1.subscribe();
    //        setTimeout(function () {
    //
    //            client.emit("aaa2", "unhandled", {needsToBeRedelivered: true}, {response_forbidden: true}, {expiresAfter: 4000}).catch(done);
    //
    //
    //        }, 300);
    //        var gottenMessage;
    //        aaa_1.on("unhandledMessage", function (message) {
    //            gottenMessage = message;
    //            message.reject();
    //        });
    //        setTimeout(function () {
    //            when.all([client.close(), aaa_1.close()]).then(function () {
    //                expect(gottenMessage).to.satisfy(checkMessage);
    //                done();
    //            }, done);
    //
    //        }, 1000);
    //
    //    }).catch(done);
    //});
    //
    //
    //it("should be unroutable", function (done) {
    //    this.timeout(5000);
    //    var client = new Service("client");
    //    var aaa_1 = new Service("aaa");
    //    when.all([client.connect(), aaa_1.connect()]).then(function () {
    //        client.subscribe();
    //        aaa_1.subscribe();
    //        setTimeout(function () {
    //            client.task("bbb", "unRoutable", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).then(function (r) {
    //                expect(r).to.equal(undefined);
    //            }).catch(done);
    //        }, 300);
    //        var gottenMessage;
    //        client.on("unroutableMessage", function (message) {
    //            gottenMessage = message;
    //        });
    //        setTimeout(function () {
    //            when.all([client.close(), aaa_1.close()]).then(function () {
    //                expect(gottenMessage).to.satisfy(checkMessageUnroutable);
    //                done();
    //            }, done);
    //
    //        }, 1000);
    //
    //    }).catch(done);
    //});


});