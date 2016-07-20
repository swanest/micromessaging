var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var _ = require("lodash");

process.on("unhandledRejection", function(e){
    console.log(e.stack, e.options,e.channel);
});

describe("When requesting something", function () {

    function checkReceivedMessage(message, body, headers) {
        return message.type == "request" &&
            _.isEqual(message.body, body) &&
            _.isBoolean(message.properties.isRedelivered) &&
            _.isString(message.properties.exchange) &&
            _.isString(message.properties.queue) &&
            _.isString(message.properties.routingKey) && message.properties.routingKey == "task" &&
            _.isString(message.properties.path) && message.properties.path != "task" &&
            _.isString(message.properties.id) &&
            _.isString(message.properties.contentType) &&
            _.isString(message.properties.contentEncoding) &&
            _.isFinite(message.properties.expiresAfter) &&
            _.isFinite(message.properties.timestamp) &&
            _.isString(message.properties.replyTo.exchange) &&
            _.isString(message.properties.replyTo.queue) &&
            _.isString(message.properties.replyTo.routingKey) &&
            _.isString(message.properties.replyTo.path) &&
            _.isUndefined(message.ack) && //requests cannot ack, they need to reply
            _.isFunction(message.nack) &&
            _.isFunction(message.reject) &&
            _.isFunction(message.write) &&
            _.isFunction(message.end) &&
            _.isFunction(message.reply) &&
            _.isEqual(message.headers, headers);
    };

    function checkUnroutableMessage(message, body, headers) {
        return message.type == "request" &&
            _.isEqual(message.body, body) &&
            _.isBoolean(message.properties.isRedelivered) &&
            _.isString(message.properties.exchange) &&
            _.isUndefined(message.properties.queue) &&
            _.isString(message.properties.routingKey) &&
            _.isString(message.properties.path) &&
            _.isString(message.properties.id) &&
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


    function checkRespondedMessage(message, body, headers) {
        return message.type == "response" &&
            _.isEqual(message.body, body) &&
            _.isBoolean(message.properties.isRedelivered) &&
            _.isString(message.properties.exchange) &&
            _.isString(message.properties.queue) &&
            _.isString(message.properties.routingKey) &&
            _.isString(message.properties.path) &&
            _.isString(message.properties.correlatedTo) &&
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

    it("should be correctly handled", function (done) {

        this.timeout(30000);
        var client = new Service("client");
        var aaa_1 = new Service("aaap");
        var aaa_2 = new Service("aaap");

        when.all([client.connect(), aaa_1.connect(), aaa_2.connect()]).then(function () {

            client.subscribe();
            aaa_1.subscribe();
            aaa_2.subscribe();

            var progressions = 0, end = 0;

            setTimeout(function () {

                expect(client.request.bind(client, "aaap", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {
                    expiresAfter: 4000,
                    replyTimeout: -1
                })).to.throw(/replyTimeout/);

                expect(client.request.bind(client, "aaap", "redelivering", {needsToBeRedelivered: true}, {_mms_no_ack: true}, {
                    expiresAfter: 4000
                })).to.throw("h._mms_no_ack is reserved");

                client.request("aaap", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {
                    expiresAfter: 4000
                    //replyTimeout: 3000
                }).progress(function (m) {
                    progressions++;
                    expect(checkRespondedMessage(m, m.body, m.headers)).to.be.ok;
                }).then(function (m) {
                    end++;
                    expect(checkRespondedMessage(m, m.body, m.headers)).to.be.ok;
                });


            }, 300);

            var handled = 0, gottenMessage;

            var handler = function (message) {
                message.write({starting: "1"}, {moreee: "maybe?"});
                message.write({starting: "2"}, {moreee: "maybe?"});
                message.end({finished: "1"}, {more: true});
                expect(message.reply.bind(message, {noOp: "1"}, {noOp: "no!"})).to.throw(/already/); //end() already called!
            };

            expect(aaa_1.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    throw new Error("not feelin it today")
                else {
                    handled++;
                    gottenMessage = message;
                    handler(message);
                }
            }).onError(function (err, message) {
                expect(err.message).to.equal("not feelin it today");
                message.nack();
            })).to.have.property("remove");


            expect(aaa_2.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    throw new Error("not feelin it today")
                else {
                    handled++;
                    gottenMessage = message;
                    handler(message);
                }
            }).onError(function (err, message) {
                expect(err.message).to.equal("not feelin it today");
                message.nack();
            })).to.have.property("remove");

            setTimeout(function () {
                expect(handled).to.be.equal(1);
                expect(progressions).to.equal(2);
                expect(end).to.equal(1);
                expect(checkReceivedMessage(gottenMessage, {needsToBeRedelivered: true}, {myH: true})).to.be.ok;
                return when.all([client.close(), aaa_1.close(), aaa_2.close()]).then(function () {
                    done();
                }, done);

            }, 1000);


        }).catch(done);
    });


    it("should be unhandled", function (done) {
        this.timeout(5000);
        var client = new Service("client");
        var aaa_1 = new Service("aaa");
        when.all([client.connect(), aaa_1.connect()]).then(function () {
            client.subscribe();
            aaa_1.subscribe();
            setTimeout(function () {
                client.request("aaa", "unhandled", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(done);
            }, 300);
            var gottenMessage;
            aaa_1.on("unhandledMessage", function (message) {
                gottenMessage = message;
                message.reject();
            });
            setTimeout(function () {
                when.all([client.close(), aaa_1.close()]).then(function () {
                    expect(checkReceivedMessage(gottenMessage, {needsToBeRedelivered: true}, {myH: true})).to.be.ok;
                    done();
                }, done);

            }, 1000);

        }).catch(done);
    });


    it("should be unroutable", function (done) {
        this.timeout(5000);
        var client = new Service("client");
        var aaa_1 = new Service("aaa");
        when.all([client.connect(), aaa_1.connect()]).then(function () {
            client.subscribe();
            aaa_1.subscribe();
            setTimeout(function () {
                client.request("bbb", "unRoutable", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(function(e){
                    expect(e.codeString).to.equal("unroutableMessage");
                });
            }, 300);
            var gottenMessage;
            client.on("unroutableMessage", function (message) {
                gottenMessage = message;
            });
            setTimeout(function () {
                when.all([client.close(), aaa_1.close()]).then(function () {
                    expect(checkUnroutableMessage(gottenMessage, {needsToBeRedelivered: true}, {myH: true})).to.be.ok;
                    done();
                }, done);

            }, 1000);

        }).catch(done);
    });


});