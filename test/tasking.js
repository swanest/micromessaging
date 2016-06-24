var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var _ = require("lodash");

describe("When tasking something", function () {

    function checkMessage(message) {
        return _.isPlainObject(message.headers) &&
            message.headers.myH &&
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
            _.isFunction(message.ack) &&
            _.isFunction(message.nack) &&
            _.isFunction(message.reject);
    };

    function checkMessageUnroutable(message) {
        return _.isPlainObject(message.headers) &&
            message.headers.myH &&
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

    it("should be redelivered", function (done) {
        this.timeout(30000);
        var client = new Service("client");
        var aaa_1 = new Service("aaa");
        var aaa_2 = new Service("aaa");
        when.all([client.connect(), aaa_1.connect(), aaa_2.connect()]).then(function () {
            client.subscribe();
            aaa_1.subscribe();
            aaa_2.subscribe();
            setTimeout(function () {
                client.task("aaa", "redelivering", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(done);
            }, 300);
            var aaa_1_responses = {}, aaa_2_responses = {}, gottenMessage;
            aaa_1.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    message.nack();
                else
                    gottenMessage = message, message.ack(), aaa_1_responses.aaa1Handled = true;
            });
            aaa_2.handle("redelivering", function (message) {
                if (!message.properties.isRedelivered)
                    message.nack();
                else
                    gottenMessage = message, message.ack(), aaa_2_responses.aaa2Handled = true;
            });
            setTimeout(function () {
                _.extend(aaa_1_responses, aaa_2_responses);
                expect(aaa_1_responses).to.satisfy(function (obj) {
                    return _.keys(obj).length == 1;
                });
                expect(gottenMessage).to.satisfy(checkMessage);
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
                client.task("aaa", "unhandled", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(done);
            }, 300);
            var gottenMessage;
            aaa_1.on("unhandledMessage", function (message) {
                gottenMessage = message;
                message.reject();
            });
            setTimeout(function () {
                when.all([client.close(), aaa_1.close()]).then(function () {
                    expect(gottenMessage).to.satisfy(checkMessage);
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
                client.task("bbb", "unRoutable", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).then(function (r) {
                    expect(r).to.equal(undefined);
                }).catch(done);
            }, 300);
            var gottenMessage;
            client.on("unroutableMessage", function (message) {
                gottenMessage = message;
            });
            setTimeout(function () {
                when.all([client.close(), aaa_1.close()]).then(function () {
                    expect(gottenMessage).to.satisfy(checkMessageUnroutable);
                    done();
                }, done);

            }, 1000);

        }).catch(done);
    });


});