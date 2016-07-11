var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var _ = require("lodash");
var CustomError = require("logger").CustomError;

describe("When emitting", function () {


    function checkReceivedMessage(message, body, headers) {
        return message.type == "message" &&
            _.isEqual(message.body, body) &&
            message.properties.isRedelivered == false &&
            _.isString(message.properties.exchange) &&
            _.isString(message.properties.queue) &&
            _.isString(message.properties.routingKey) &&
            _.isString(message.properties.path) &&
            _.isUndefined(message.properties.id) &&
            _.isString(message.properties.contentType) &&
            _.isString(message.properties.contentEncoding) &&
            _.isFinite(message.properties.expiresAfter) &&
            _.isFinite(message.properties.timestamp) &&
            _.isUndefined(message.properties.replyTo) &&
            _.isUndefined(message.ack) &&
            _.isUndefined(message.nack) &&
            _.isUndefined(message.reject) &&
            _.isUndefined(message.write) &&
            _.isUndefined(message.end) &&
            _.isUndefined(message.reply) &&
            _.isEqual(message.headers, headers);
    };

    it("emits correctly", function (done) {

        this.timeout(500000);
        var client = new Service("client");
        var abc_1 = new Service("abc");
        var abc_2 = new Service("abc");
        var xyz_1 = new Service("xyz");
        var opq_1 = new Service("opq");
        var opq_2 = new Service("opq");


        when.all([client.connect(), abc_1.connect(), abc_2.connect(), xyz_1.connect(), opq_1.connect(), opq_2.connect()]).then(function () {

            client.subscribe();
            abc_1.subscribe();
            abc_2.subscribe();
            xyz_1.subscribe();
            opq_1.subscribe();
            opq_2.subscribe();


            var handled = [];

            //Gets only global messages and public messages of xyz
            abc_1.listen("initial.route", function (message) {
                handled.push({
                    listener: "abc_1(xyz):'initial.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            }, "xyz");

            xyz_1.listen("initial.route", function (message) {
                handled.push({
                    listener: "xyz:'initial.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            abc_1.listen("initial.*", function (message) {
                handled.push({
                    listener: "abc_1(xyz):'initial.*'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            }, "xyz");

            abc_2.listen("initial.route", function (message) {
                handled.push({
                    listener: "abc_2:'initial.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            abc_1.listen("second.route", function (message) { //removed
                handled.push({
                    listener: "abc_1:'second.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            }).remove();

            abc_1.listen("second.route", function (message) {
                handled.push({
                    listener: "abc_1:'second.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            abc_1.listen("third.route", function (message) {
                handled.push({
                    listener: "abc_1:'third.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            }).remove();


            opq_1.listen("fourth.route", function (message) {
                handled.push({
                    listener: "opq_1:'fourth.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });


            opq_2.listen("fourth.route", function (message) {
                handled.push({
                    listener: "opq_2:'fourth.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            opq_1.exclusively.listen("fifth.route", function (message) {
                handled.push({
                    listener: "opq_1.exl:'fifth.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            opq_2.exclusively.listen("fifth.route", function (message) {
                handled.push({
                    listener: "opq_2.exl:'fifth.route'",
                    routingKey: message.properties.routingKey,
                    c: message.body
                });
            });

            client.on("unroutableMessage", function (message) {
                handled.push({listener: "UNROUTABLE", unroutable: message.properties.routingKey, c: message.body});
            });


            setTimeout(function () {
                client.privately.emit("*", "initial.route", 1, null, {expiresAfter: 3000});
                client.publicly.emit("xyz", "initial.route", 2);
                client.privately.emit("xyz", "initial.route", 3); //private.xyz.initial.route

                client.privately.emit("*", "second.route", 4);
                client.emit("abc", "second.route", 5);
                client.privately.emit("abc", "second.route", 6);

                client.privately.emit("abc", "third.route", 7); //unroutable

                client.privately.emit("opq", "fourth.route", 8);
                client.privately.emit("opq", "fifth.route", 9);


            }, 100);

            setTimeout(function () {

                var res = _.groupBy(handled, "listener");


                var h = res["abc_1(xyz):'initial.route'"];
                expect(h).to.have.lengthOf(2);
                expect(_.findIndex(h, {routingKey: "public._G_.initial.route", c: 1})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "public.xyz.initial.route", c: 2})).to.not.equal(-1);

                h = res["abc_1(xyz):'initial.*'"];
                expect(h).to.have.lengthOf(2);
                expect(_.findIndex(h, {routingKey: "public._G_.initial.route", c: 1})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "public.xyz.initial.route", c: 2})).to.not.equal(-1);


                h = res["abc_2:'initial.route'"];
                expect(h).to.have.lengthOf(1);
                expect(_.findIndex(h, {routingKey: "public._G_.initial.route", c: 1})).to.not.equal(-1);


                h = res["abc_1:'second.route'"];
                expect(h).to.have.lengthOf(3);
                expect(_.findIndex(h, {routingKey: "public._G_.second.route", c: 4})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "public.abc.second.route", c: 5})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "private.abc.second.route", c: 6})).to.not.equal(-1);


                h = res["xyz:'initial.route'"];
                expect(h).to.have.lengthOf(3);
                expect(_.findIndex(h, {routingKey: "public._G_.initial.route", c: 1})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "public.xyz.initial.route", c: 2})).to.not.equal(-1);
                expect(_.findIndex(h, {routingKey: "private.xyz.initial.route", c: 3})).to.not.equal(-1);


                h = res["UNROUTABLE"];
                expect(h).to.have.lengthOf(1);
                expect(_.findIndex(h, {unroutable: "private.abc.third.route", c: 7})).to.not.equal(-1);


                h = res["opq_1:'fourth.route'"];
                expect(h).to.have.lengthOf(1);
                expect(_.findIndex(h, {routingKey: "private.opq.fourth.route", c: 8})).to.not.equal(-1);

                h = res["opq_2:'fourth.route'"];
                expect(h).to.have.lengthOf(1);
                expect(_.findIndex(h, {routingKey: "private.opq.fourth.route", c: 8})).to.not.equal(-1);

                h = res["opq_1.exl:'fifth.route'"] || res["opq_2.exl:'fifth.route'"];
                expect(h).to.have.lengthOf(1);
                expect(_.findIndex(h, {routingKey: "private.opq.fifth.route", c: 9})).to.not.equal(-1);

                expect(_.keys(res)).to.have.lengthOf(9);

                when.all([client.close(), abc_1.close(), abc_2.close(), xyz_1.close()]).then(function () {
                    done();
                }).catch(function (err) {
                    console.log(err);
                });


            }, 300);


        }).catch(done);


    });


});