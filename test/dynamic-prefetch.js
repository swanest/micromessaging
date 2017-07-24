const expect = require('chai').expect,
    Service = require('../lib').Service,
    when = require('when'),
    moment = require('moment'),
    _ = require('lodash'),
    logLib = require('sw-logger'),
    CustomError = logLib.CustomError,
    tracer = new logLib.Logger({ namespace: 'tests' }),
    fs = require('fs'),
    uuid = require('uuid');


describe('Dynamic Prefetch', function () {

    function readFile(path) {
        let d = when.defer();
        fs.readFile(path, function (err, contents) {
            if (err != void 0)
                d.reject(err);
            else
                d.resolve(JSON.parse(contents));
        });
        return d.promise;
    };

    it('should gradually increase prefetchCount', function () {
        this.timeout(60 * 5 * 1000);
        const www_1 = new Service('www-' + uuid.v4(), {
                memoryPressureHandled: {
                    memoryThreshold: 850 * 1000000,
                    interval: 300,
                    consecutiveGrowths: 3
                }
            }),
            client = new Service('client-' + uuid.v4());

        return when
            .all([www_1.connect(), client.connect()])
            .then(function () {
                www_1.handle('test', function (msg) {
                    msg.reply();
                });
            })
            .then(function () {
                return when.all([www_1.subscribe(), client.subscribe()]);
            })
            .then(function () {
                const reqs = [];
                for (let i = 0; i < 5000; i++) {
                    reqs.push(client.request(www_1.name, 'test'));
                }
                reqs.push(new Promise(function (resolve, reject) {
                    const reqs2 = [];
                    setTimeout(() => {
                        for (let i = 0; i < 1000; i++) {
                            reqs2.push(client.request(www_1.name, 'test'));
                        }
                        when.all(reqs2).then(resolve, reject);
                    }, 10000);
                }));
                reqs.push(new Promise(function (resolve, reject) {
                    const reqs2 = [];
                    setTimeout(() => {
                        for (let i = 0; i < 1000; i++) {
                            reqs2.push(client.request(www_1.name, 'test'));
                        }
                        when.all(reqs2).then(resolve, reject);
                    }, 20000);
                }));
                reqs.push(new Promise(function (resolve, reject) {
                    const reqs2 = [];
                    setTimeout(() => {
                        for (let i = 0; i < 1000; i++) {
                            reqs2.push(client.request(www_1.name, 'test'));
                        }
                        when.all(reqs2).then(resolve, reject);
                    }, 20000);
                }));

                let buff = [];
                setTimeout(() => {
                    for (let i = 0; i < 1000; i++) {
                        readFile(__dirname + '/data.json').then(function (doc) {
                            buff.push(doc);
                        });
                    }
                }, 1000);
                setTimeout(() => {
                    buff = null;
                }, 30000);
                return when.all(reqs);
            })
            .then(function () {
                console.log('here', www_1.prefetch());
                expect(www_1.prefetch()).to.be.above(10);
            })
            .catch(function (e) {
                tracer.err(e);
                throw e;
            })
            .finally(function () {
                return when.all([www_1.close(), client.close()]);
            });
    });

    // it('pauses due to memory pressure', function (done) {
    //     this.timeout(120000);
    //     let sname = 'memory-' + uuid.v4();
    //     var www_1 = new Service(sname, {
    //             entities: {
    //                 Q_REQUESTS: {
    //                     limit: 1
    //                 }
    //             },
    //             memoryPressureHandled: false
    //         }),
    //         www_2 = new Service(sname, {
    //             entities: {
    //                 Q_REQUESTS: {
    //                     limit: 1
    //                 }
    //             },
    //             memoryPressureHandled: {
    //                 memoryThreshold: 50 * 1000000,
    //                 interval: 300,
    //                 consecutiveGrowths: 3
    //             }
    //         }),
    //         client = new Service('clientMem', { memoryPressureHandled: false });
    //
    //     www_2.memoryPressureHandler.on('underPressure', (mem) => {
    //         mem.ack();
    //     });
    //
    //     when.all([www_1.connect(), www_2.connect(), client.connect()]).then(function () {
    //         return when.all([client.subscribe(), www_1.subscribe(), www_2.subscribe()]);
    //     }).then(function () {
    //         var www_1_i = 0, www_2_i = 0, buff = [];
    //         www_1.handle('test', function (msg) {
    //             www_1_i++;
    //             msg.reply({ response: true });
    //         });
    //         www_2.handle('test', function (msg) {
    //             www_2_i++;
    //             for (let i = 0; i < 10; i++) {
    //                 readFile(__dirname + '/data.json').then(function (doc) {
    //                     buff.push(doc);
    //                 });
    //             }
    //             msg.reply({ response: true });
    //         });
    //         var i = 0;
    //
    //         function req() {
    //             return when().then(function () {
    //                 client.request(www_1.name, 'test');
    //             }).delay(300).then(function (r) {
    //                 i++;
    //                 if (i < 1000)
    //                     return req();
    //             });
    //         };
    //         req();
    //         return when().delay(10000).then(function () {
    //             buff = [];
    //             expect(www_1_i > 2 * www_2_i).to.be.ok;
    //             when.all([www_1.close(), www_2.close(), client.close()]).then(function () {
    //                 done();
    //             });
    //         }).catch(function (e) {
    //             done(e);
    //         });
    //     });
    // });


});