var expect = require("chai").expect;
var Service = require("../lib");
var Q = require("q");
var _ = require("lodash");

describe("When emitting", function () {

    it("private message", function (done) {
        var client = new Service("client");
        var abc_1 = new Service("abc");
        var abc_2 = new Service("abc");
        var xyz_1 = new Service("xyz");
        Q.all([client.connect(), abc_1.connect(), abc_2.connect(), xyz_1.connect()]).then(function () {

            abc_1.subscribe();
            abc_2.subscribe();
            xyz_1.subscribe();

            setTimeout(function () {
                client.emit("abc", "stock.aapl.split", {ratio: "7:1"}, {headerAppInfo: "test"}).catch(_.noop);
                client.emit("abc", "stock.aapl.cashDiv", {amount: 0.52}).catch(_.noop);
                client.emit("abc", "stock.msft.split", {ratio: "3:1"}).catch(_.noop);
                client.emit("abc", "stock.msft.cashDiv", {amount: 0.72}).catch(_.noop);
            }, 300);


            var abc_1_responses = {}, abc_2_responses = {}, xyz_1_responses = {};

            //Listening to private and public messages regarding service ‘abc‘ related to splits
            abc_1.listen("stock.aapl.split", function (message) {
                abc_1_responses["stock.aapl.split-" + message.fields.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
            abc_1.listen("stock.msft.*", function (message) {
                abc_1_responses["stock.msft.*-" + message.fields.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
            abc_1.listen("stock.#", function (message) {
                abc_1_responses["stock.#-" + message.fields.routingKey] = message.body;
            });

            //Listening to private and public messages regarding service ‘abc‘ related to splits
            abc_2.listen("stock.aapl.split", function (message) {
                abc_2_responses["stock.aapl.split-" + message.fields.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions of Microsoft
            abc_2.listen("stock.msft.*", function (message) {
                abc_2_responses["stock.msft.*-" + message.fields.routingKey] = message.body;
            });
            //Listening to private and public messages regarding service ‘abc‘ related to all corporate actions, whatever the stock
            abc_2.listen("stock.#", function (message) {
                abc_2_responses["stock.#-" + message.fields.routingKey] = message.body;
            });

            xyz_1.listen("stock.#", function (message) {
                xyz_1_responses["stock.#-" + message.fields.routingKey] = message.body;
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
                expect(xyz_1_responses).to.eql({});

                Q.all([abc_1.close(), abc_2.close(), xyz_1.close()]).then(function () {
                    done();
                });

            }, 1000);

        }).catch(function (e) {
            console.log("error", e);
        });

    });

    //it.only("test",function(done){
    //
    //    var a = new Service("a");
    //    var b = new Service("b");
    //
    //    a.connect(); b.connect();
    //
    //});


});