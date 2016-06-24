var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var _ = require("lodash");

describe("When requesting something", function () {

    function checkReceivedMessage(message, body, headers) {
        return message.type == "request" &&
            _.isEqual(message.body, body) &&
            _.isBoolean(message.properties.isRedelivered) &&
            _.isString(message.properties.exchange) &&
            _.isString(message.properties.queue) &&
            _.isString(message.properties.routingKey) &&
            _.isString(message.properties.path) &&
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
            _.isUndefined(message.reject) && //requests cannot reject, they need to nack
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
            _.isString(message.properties.id) &&
            _.isString(message.properties.contentType) &&
            _.isString(message.properties.contentEncoding) &&
            _.isFinite(message.properties.expiresAfter) &&
            _.isFinite(message.properties.timestamp) &&
            _.isString(message.properties.replyTo.exchange) &&
            _.isString(message.properties.replyTo.queue) &&
            _.isString(message.properties.replyTo.routingKey) &&
            _.isString(message.properties.replyTo.path) &&
            _.isUndefined(message.ack) &&
            _.isUndefined(message.nack) &&
            _.isUndefined(message.reject) &&
            _.isUndefined(message.write) &&
            _.isUndefined(message.end) &&
            _.isUndefined(message.reply) &&
            _.isEqual(message.headers, headers);
    };

    it.only("should be correctly handled", function (done) {
        this.timeout(30000);
        var client = new Service("client");
        var aaa_1 = new Service("aaa");
        var aaa_2 = new Service("aaa");
        when.all([client.connect(), aaa_1.connect(), aaa_2.connect()]).then(function () {
            client.subscribe();
            aaa_1.subscribe();
            aaa_2.subscribe();
            setTimeout(function () {

                //client.request("aaa", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {
                //    expiresAfter: 4000,
                //    replyTimeout: 3000
                //}).catch(done);
                //client.request("aaa", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {
                //    expiresAfter: 4000,
                //    replyTimeout: 3000
                //}).catch(done);

                client.request("aaa", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {
                    expiresAfter: 4000,
                    replyTimeout: 3000
                }).progress(function (m) {
                    console.log(m);
                }).then(function (m) {
                    console.log(m);
                }).catch(done);


            }, 300);
            var aaa_1_responses = {}, aaa_2_responses = {}, gottenMessage;
            aaa_1.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    message.nack();
                else {
                    gottenMessage = message;
                    aaa_1_responses.aaa1Handled = true;
                    message.write({starting: "1"}, {moreee: true});
                    message.write({starting: "2"}, {moreee: "maybe?"});
                    message.end({finished: "1"}, {moreee: "no!"});
                    try {
                        message.reply({noOp: "1"}, {noOp: "no!"});
                    } catch (e) {
                        expect(e).to.match(/already replied to/);
                    }

                }
            });
            aaa_2.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    message.nack();
                else {
                    gottenMessage = message;
                    aaa_2_responses.aaa2Handled = true;
                    message.write({starting: "1"}, {moreee: true});
                    message.write({starting: "2"}, {moreee: "maybe?"});
                    message.end({finished: "1"}, {moreee: "no!"});
                    try {
                        message.reply({noOp: "1"}, {noOp: "no!"});
                    } catch (e) {
                        expect(e).to.match(/already replied to/);
                    }
                }
            });
            setTimeout(function () {
                _.extend(aaa_1_responses, aaa_2_responses);
                console.log(aaa_1_responses);
                expect(aaa_1_responses).to.satisfy(function (obj) {
                    return _.keys(obj).length == 1;
                });
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
                client.request("bbb", "unRoutable", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).then(function (r) {
                    expect(r).to.equal(undefined);
                }).catch(done);
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