var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var _ = require("lodash");

describe("When tasking something", function () {

    function checkReceivedMessage(message, body, headers) {
        return message.type == "task" &&
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
            _.isUndefined(message.properties.replyTo) &&
            _.isFunction(message.ack) &&
            _.isFunction(message.nack) &&
            _.isFunction(message.reject) &&
            _.isUndefined(message.write) &&
            _.isUndefined(message.end) &&
            _.isUndefined(message.reply) &&
            _.isEqual(message.headers, headers);
    };

    function checkUnroutableMessage(message, body, headers) {
        return message.type == "task" &&
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
                client.task("aaa", "redelivering", 1, {myH: true}, {expiresAfter: 4000}).catch(done);
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
                expect(checkReceivedMessage(gottenMessage, 1, {myH: true})).to.be.ok;
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
                client.task("bbb", "unRoutable", {needsToBeRedelivered: true}, {myH: true}, {expiresAfter: 4000}).catch(function(e){
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


    it("should handle double nacking", function (done) {
        this.timeout(5000);
        var client = new Service("client");
        var alone = new Service("hey", {
            config: {
                Q_REQUESTS: {
                    noBatch: true
                }
            }
        });
        when.all([client.connect(), alone.connect()]).then(function () {
            client.subscribe();
            alone.subscribe();
            let receivedMsg;
            alone.handle("again", function (msg) {
                receivedMsg = msg;
                msg.ack();
            });
            alone.handle("hello", function (msg) {
                msg.ack();
                msg.status = "PENDING";
                return alone.prefetch(0).then(function () {
                    return alone.prefetch(null);
                }).then(function () {
                    msg.ack();
                    setTimeout(function () {
                        client.task(alone.name, "again", {double: true}, {myH: true}, {expiresAfter: 1000})
                    }, 10000);
                });
            }).promise.then(function () {
                    client.task(alone.name, "hello", {double: true}, {myH: true}, {expiresAfter: 50});
                });
            setTimeout(function () {
                when.all([client.close(), alone.close()]).then(function () {
                    expect(receivedMsg).to.be.defined;
                    done();
                }, done);
            }, 1300);
        }).catch(done);
    });


});