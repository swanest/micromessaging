var expect = require("chai").expect;
var Service = require("../lib");
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("logger").CustomError;

process.on("unhandledRejection", function (e) {
    console.log(e.stack, e.options, e.channel);
});

describe("When prefetching", function () {


    it.skip("prefetchs correctly", function (done) {

        this.timeout(20000);
        var client = new Service("client");
        var abc_1 = new Service("abc");

        when.all([client.connect(), abc_1.connect()]).then(function () {
            return abc_1.subscribe();
        }).then(function () {

            abc_1.handle("test", function (message) {
                message.reply();
            });

            var results = [];

            function stats(p, isPaused) {
                var reqs = 0, n, t = 0, i = 0;

                function req() {
                    return when().then(function () {
                        return client.request("abc", "test", reqs, null, {expiresAfter: 3000, replyTimeout:1000}).then(function () {
                            reqs++;
                            t = moment.utc().unix() - n;
                            if (t < 2)
                                return req();
                        });
                    }).catch(function (err) {
                        console.log(++i);
                        if (!isPaused)
                            throw err;
                    });
                };

                return abc_1.prefetch(p).then(function () {
                }).then(function () {
                    n = moment.utc().unix();
                    return req().then(function () {
                        results.push(reqs == 0 ? 0 : (reqs / t));
                    });
                });
            };

            //todo : fix bug error channel ended no reply will be forthcoming sometimes happening
            return stats(null).then(function () {
                return stats(0, true);
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

                console.log(results);
                for (var i = 0; i < results.length; i++) {
                    if (i == 1)
                        expect(results[i]).to.equal(0);
                    else if (i % 2 == 0)
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