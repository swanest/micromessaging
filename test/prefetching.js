var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;
var fs = require("fs");


describe("When prefetching", function () {

    it("pauses due to memory pressure", function (done) {
        this.timeout(120000);
        var www_1 = new Service("www", {memoryPressureHandled: false}),
            www_2 = new Service("www", {
                memoryPressureHandled: {
                    memoryThreshold: 100 * 1000000,
                    interval: 500,
                    stillUnderPressure: 20,
                    consecutiveGrowths: 5
                }
            }),
            client = new Service("client", {memoryPressureHandled: false});
        when.all([www_1.connect(), www_2.connect(), client.connect()]).then(function () {
            return when.all([www_1.subscribe(), www_2.subscribe()]);
        }).then(function () {
            var www_1_i = 0, www_2_i = 0, buff = [];
            www_1.handle("test", function (msg) {
                www_1_i++;
                msg.reply();
            });
            www_2.handle("test", function (msg) {
                www_2_i++;
                for (let i = 0; i < 10; i++)
                    buff.push(JSON.parse(fs.readFileSync(__dirname + "/data.json")));
                msg.reply();
            });
            var i = 0;

            function req() {
                return when().then(function () {
                    return client.request("www", "test");
                }).then(function () {
                    i++;
                    if (i < 1000)
                        return req();
                });
            };
            return req().then(function () {
                buff = [];
                expect(www_1_i > 2 * www_2_i).to.be.ok;
                expect(www_1_i + www_2_i).to.equal(1000);
                when.all([www_1.close(), www_2.close(), client.close()]).then(function () {
                    done();
                });
            }).catch(function (e) {
                done(e);
            });
        });
    });


    it("pauses correctly with two consumers", function (done) {
        this.timeout(10000);
        var www_1 = new Service("www"), www_2 = new Service("www"), client = new Service("client");
        when.all([www_1.connect(), www_2.connect(), client.connect()]).then(function () {
            return when.all([www_1.subscribe(), www_2.subscribe()]);
        }).then(function () {
            var www_1_i = 0, www_2_i = 0;
            www_1.handle("test", function (msg) {
                www_1_i++;
                msg.reply();
            });
            www_2.handle("test", function (msg) {
                www_2_i++;
                msg.reply();
            });

            var i = 0;

            function req() {
                return when().then(function () {
                    if (i == 250)
                        return www_2.prefetch(0);
                }).then(function () {
                    return client.request("www", "test");
                }).then(function () {
                    i++;
                    if (i < 1000)
                        return req();
                });
            };

            return req().then(function () {
                expect([www_1_i, www_2_i]).to.deep.equal([875, 125]);
                when.all([www_1.close(), www_2.close(), client.close()]).then(function () {
                    done();
                });
            }).catch(done);
        });
    });


    it("prefetches correctly with one consumer", function (done) {

        this.timeout(40000);
        var client = new Service("client-prefetch");
        var abc_1 = new Service("server-prefetch");

        when.all([client.connect(), abc_1.connect()]).then(function () {
            return abc_1.subscribe();
        }).then(function () {

            try {
                abc_1.subscribe();
            } catch (e) {
                expect(e).to.match(/already/);
            }

            abc_1.handle("test", function (message) {
                message.reply();
            });

            var results = [];

            function stats(p, isPaused) {
                var reqs = 0, n, t = 0, i = 0;


                function req() {
                    return when().then(function () {
                        return client.request("server-prefetch", "test", reqs, null, {
                            expiresAfter: 5000,
                            replyTimeout: 1000
                        }).then(function () {
                            if (isPaused)
                                throw new CustomError("notSupposedToReceiveResponse", 500, "fatal");
                            reqs++;
                            t = moment.utc().unix() - n;
                            if (t < 1)
                                return req();
                        }, function (err) {
                            if (!isPaused) {
                                throw err;
                            }
                        });
                    }).catch(function (err) {
                        console.log(err, p, isPaused);
                    });
                };

                return abc_1.prefetch(p).delay(1000).then(function () {
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
                for (var i = 0; i < results.length; i++) {
                    if (i == 1)
                        expect(results[i]).to.equal(0);
                    else if (i % 2 == 0)
                        expect(results[i]).to.be.above(80);
                    else
                        expect(results[i]).to.be.below(10);
                }
                when.all([client.close(), abc_1.close()]).then(function () {
                    done();
                }, done);

            });
        }).catch(done);
    });

    it("should handle channel disruption due to prefetching", function (done) {
        this.timeout(6000000);
        var client = new Service("client");
        var abc_1 = new Service("autoDelete", {
            config: {
                Q_REQUESTS: {
                    noBatch: true, //ack,nack,reject do not take place immediately
                    noAck: true, //acks are required
                    autoDelete: true
                }
            }
        });
        when.all([client.connect(), abc_1.connect()]).then(function () {
            return when.all([abc_1.subscribe(), client.subscribe()]);
        }).then(function () {
            let receivedMessages = [];
            when().then(function () {
                return abc_1.handle("ok", function (msg) {
                    receivedMessages.push(msg);
                    msg.ack(); //First call will raise an error because it's not the proprietary channel due to prefetch
                }).promise;
            }).then(function () {
                return abc_1.prefetch(0).then(function () {
                    return abc_1.prefetch(1)
                })
            }).then(function () {
                return client.task("autoDelete", "ok", "test");
            }).delay(1000).then(function () {
                return client.task("autoDelete", "ok", "test");
            }).then(function(){
                expect(receivedMessages).to.have.lengthOf(2);
                when.all([client.close(), abc_1.close()]).then(function () {
                    done();
                }, done);
            });
        }).catch(done);
    });

    it("should update prefetches sequentially", function (done) {
        this.timeout(6000000);
        var client = new Service("client");
        var abc_1 = new Service("test4", {
            config: {
                Q_REQUESTS: {
                    noBatch: true, //ack,nack,reject do not take place immediately
                    noAck: true,
                    autoDelete:true
                }
            }
        });
        when.all([client.connect(), abc_1.connect()]).then(function () {
            return when.all([abc_1.subscribe(), client.subscribe()]);
        }).delay(3000).then(function () {
            return abc_1.prefetch(0).then(function () {
                return abc_1.prefetch(1)
            }).then(function () {
                return abc_1.prefetch(0)
            }).then(function () {
                return abc_1.prefetch(1)
            }).then(function () {
                return abc_1.prefetch(0);
            }).then(function () {
                return when.all([client.close(), abc_1.close()]).then(function () {
                    done();
                });
            }).catch(done);
        });
    });


});