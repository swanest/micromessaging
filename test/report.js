var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("logger").CustomError;

process.on("unhandledRejection", function (e) {
    console.log(e.stack, e.options, e.channel);
});

describe("When requesting a report", function () {


    it("gets a report", function (done) {

        this.timeout(40000);
        var client = new Service("client");
        var abc_1 = new Service("abc");

        when.all([client.connect(), abc_1.connect()]).then(function () {
            //return abc_1.subscribe();
        }).then(function () {
            for (var i = 0; i < 300; i++)
                client.request("abc", "foo", null, null, {expiresAfter: 5000, replyTimeout: 5000}).then(_.noop, _.noop);

            setTimeout(function () {
                client.getRequestsReport("abc").then(function (r) {
                    expect(r.queueSize).to.equal(300);
                    done();
                })
            }, 500)


        }).catch(done);
    });

});