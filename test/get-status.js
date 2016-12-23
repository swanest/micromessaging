var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;


describe("When asking status", function () {


    it("should get status false (x1)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        when.all([client.connect()]).then(function () {
            return client.subscribe();
        }).then(function () {
            return client.getStatus("blabla").then(function (status) {
                expect(status.isReady).to.be.false;
                done();
            }).finally(function () {
                return client.close();
            });
        }).catch(done);
    });

    it("should get status false (x2)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(false), client.subscribe()]);
        }).then(function () {
            return client.getStatus(server.name).then(function (status) {
                expect(status.isReady).to.be.false;
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            });
        }).catch(done);
    });

    it("should get status true (x1)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(), client.subscribe()]);
        }).then(function () {
            return client.getStatus(server.name).then(function (status) {
                expect(status.isReady).to.be.true;
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            });
        }).catch(done);
    });

    it("should get status false (x3)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(), client.subscribe()]);
        }).delay(1000).then(function () {
            return client.getStatus(server.name, {isElected: false}).then(function (status) {
                expect(status.isReady).to.be.false;
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            });
        }).catch(done);
    });

    it("should get status false (x4)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server");
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(), client.subscribe()]);
        }).then(function () {
            return client.getStatus(server.name, {isElected: true}).then(function (status) {
                expect(status.isReady).to.be.false;
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            });
        }).catch(done);
    });


    it("should get status true (x2)", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        var server2 = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect(), server2.connect()]).then(function () {
            return when.all([server.subscribe(false), client.subscribe(), server2.subscribe(false)]);
        }).then(function () {
            server2.setAsReady();
            return client.getStatus(server.name).then(function (status) {
                done();
            }).finally(function () {
                return when.all([client.close(), server.close(), server2.close()]);
            });
        }).catch(done);
    });

    it("should wait for service", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(false), client.subscribe()]);
        }).then(function () {
            when().delay(1000).then(function () {
                server.setAsReady();
            });
            return client.waitForService(server.name).then(function (status) {
                expect(status.attempts).to.be.above(2);
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            })
        }).catch(done);
    });

    it("should fail to wait for service", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var server = new Service("server", {discoverable: true});
        when.all([client.connect(), server.connect()]).then(function () {
            return when.all([server.subscribe(false), client.subscribe()]);
        }).then(function () {
            return client.waitForService(server.name, {timeout: 2000}).catch(function (err) {
                expect(err.info.status.attempts).to.be.above(2);
                done();
            }).finally(function () {
                return when.all([client.close(), server.close()]);
            })
        }).catch(done);
    });


});