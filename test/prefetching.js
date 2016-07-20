var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("logger").CustomError;

process.on("unhandledRejection", function(e){
    console.log(e.stack, e.options,e.channel);
});

describe("When prefetching", function () {


    it("prefetchs correctly", function (done) {

        this.timeout(500000);
        var client = new Service("client");
        var abc_1 = new Service("abc");


        when.all([client.connect(), abc_1.connect()]).then(function () {

            client.subscribe();
            abc_1.subscribe();

            abc_1.handle("test", function (message) {
                message.reply();
            });

            var results = [];

            function stats(p) {
                var reqs = 0, n = moment.utc().unix(), t = 0;

                function req() {
                    return client.request("abc", "test", reqs, null, {expiresAfter: 3000}).then(function () {
                        reqs++;
                        t = moment.utc().unix() - n;
                        if (t < 2)
                            return req();
                    });
                };

                return abc_1.prefetch(p).then(function () {
                    return req().then(function () {
                        results.push(reqs / t);
                    });
                });
            };


            return stats(null).then(function () {
                return stats(1);
            }).then(function () {
                return stats(null);
            }).then(function () {
                return stats(1);
            }).then(function () {
                return stats(null);
            }).then(function () {
                return stats(1);
            }).then(function () {
                return stats(null);
            }).then(function () {
                return stats(1);
            }).then(function () {

                for (var i = 0; i < results.length; i++) {
                    if (i % 2 == 0)
                        expect(results[i]).to.be.above(150);
                    else
                        expect(results[i]).to.be.below(10);
                }

                when.all([client.close(), abc_1.close()]).then(function () {
                    done();
                }, done);

            });


        }).catch(done);


    });


});