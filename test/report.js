var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;


describe("When getting a report", function () {


    it("should get it", function (done) {
        this.timeout(40000);
        var client = new Service("client");
        var abc_1 = new Service("serverRep");
        when.all([client.connect(), abc_1.connect()]).then(function () {
            return client.subscribe();
        }).then(function () {
            for (var i = 0; i < 300; i++)
                client.task(abc_1.name, "foo", null, null, {
                    expiresAfter: 5000
                }).then(_.noop, done);
            setTimeout(function () {
                client.getRequestsReport(abc_1.name).then(function (r) {
                    expect(r.queueSize).to.equal(300);
                    when.all([client.close(), abc_1.close()]).then(() => done());
                })
            }, 500)


        }).catch(done);
    });

});