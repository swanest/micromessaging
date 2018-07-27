import { expect } from 'chai';
import { CustomError } from 'sw-logger';
import { ReturnHandler } from '../Interfaces';
import { Message } from '../Message';
import { Messaging } from '../Messaging';

process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection', reason);
});
describe('Messaging', () => {
    it('expect to have a getURI method returning a string', async () => {
        const c = new Messaging('client');
        await c.connect();
        expect(c.getURI()).to.be.a('string');
    });
    it('should connect to Rabbit', async () => {
        const c = new Messaging('client');
        await c.connect();
        await c.close();
    });
    it('should handle requests', async () => {
        const s = new Messaging('server');
        s.handle('request1', (message) => {
            message.reply({hello: 'world'});
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        const response = await c.request('server', 'request1', {how: {are: 'you?'}});
        expect(response.body).to.deep.equal({hello: 'world'});
    });

    it('should raise a message.timeout event when a message was not answered within 100ms', async () => {
        const s = new Messaging('server');
        s.handle('request1', (message) => {
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        c.request('server', 'request1',
            {how: {are: 'you?'}},
            undefined,
            {timeout: 100},
        ).catch(() => {
        });
        await new Promise((resolve, reject) => {
            s.on('message.timeout', (e, m) => {
                try {
                    expect(e).to.be.instanceof(CustomError);
                    expect(m).to.be.instanceof(Message);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    });

    it('should discard messages that are in ready state for too long', async function () {
        this.timeout(20000);
        const s = new Messaging('server');
        s.handle('auto-discard-request', (message) => {
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        await s.close();
        c.request('server', 'auto-discard-request',
            {how: {are: 'you?'}},
            undefined,
            {timeout: 500},
        ).catch((e) => {
            expect(e.codeString).to.equal('timeout');
            // Swallow error because it's not going to be answered on time
        });


        await new Promise(resolve => {
            let met1 = false;

            function report() {
                c.getRequestsReport('server', 'auto-discard-request').then(r => {
                    if (r.queueSize === 1) {
                        met1 = true;
                    }
                    if (met1 && r.queueSize === 0) {
                        return resolve();
                    }
                    setTimeout(report, 100);
                });
            }

            report();
        });
    });

    it('should discard requests that expired', async function () {
        this.timeout(120000);
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.handle('request1', (message) => {
                try {
                    expect((message as any)._isExpired).to.be.false;
                } catch (e) {
                    reject(e);
                }
                setTimeout(() => {
                    try {
                        expect((message as any)._isExpired).to.be.true;
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }, 100);
            });
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        try {
            await c.request('server', 'request1', {how: {are: 'you?'}}, undefined, {timeout: 50});
        } catch (e) {
            expect(e.codeString).to.equal('timeout');
            await p;
        }
    });

    // it.only('should handle loads of requests', async function () {
    //     this.timeout(120000);
    //     const hep = require('heapdump');
    //     console.log(process.memoryUsage());
    //     const s = new Messaging('server');
    //     s.handle('request1', (message) => {
    //         message.reply({hello: 'world'});
    //     });
    //     const c = new Messaging('client');
    //     await Promise.all([
    //         c.connect(),
    //         s.connect()
    //     ]);
    //     let ps: Promise<Message>[] = [];
    //     hep.writeSnapshot('/Users/Youri/Downloads/Temp/micro-' + Date.now() + '.heapsnapshot');
    //     global.gc();
    //     for (let i = 0; i < 10; i++) {
    //         await new Promise(resolve => {
    //             setImmediate(() => {
    //                 for (let j = 0; j < 1000; j++) {
    //                     ps.push(c.request('server', 'request1', {how: {are: 'you?'}}, undefined, {timeout: 60 * 60 * 1000}));
    //                 }
    //                 resolve();
    //             });
    //         });
    //     }
    //     await Promise.all(ps);
    //     ps = null;
    //     console.log(process.memoryUsage());
    //     hep.writeSnapshot('/Users/Youri/Downloads/Temp/micro-' + Date.now() + '.heapsnapshot');
    //     global.gc();
    //     console.log(process.memoryUsage());
    //     hep.writeSnapshot('/Users/Youri/Downloads/Temp/micro-' + Date.now() + '.heapsnapshot');
    //     ps = [];
    //     global.gc();
    //     for (let i = 0; i < 10; i++) {
    //         await new Promise(resolve => {
    //             setImmediate(() => {
    //                 for (let j = 0; j < 1000; j++) {
    //                     ps.push(c.request('server', 'request1', {how: {are: 'you?'}}, undefined, {timeout: 60 * 60 * 1000}));
    //                 }
    //                 resolve();
    //             });
    //         });
    //     }
    //     await Promise.all(ps);
    //     ps = null;
    //     console.log(process.memoryUsage());
    //     hep.writeSnapshot('/Users/Youri/Downloads/Temp/micro-' + Date.now() + '.heapsnapshot');
    //     global.gc();
    //     console.log(process.memoryUsage());
    //     hep.writeSnapshot('/Users/Youri/Downloads/Temp/micro-' + Date.now() + '.heapsnapshot');
    // });

    it('should properly compress requests', async () => {
        const s = new Messaging('server');
        const textThatWillCompress = Buffer.alloc(1e6 + 100, 'A', 'utf8');
        const reply = `reply:${textThatWillCompress.toString()}`;
        const p = new Promise((resolve, reject) => {
            s.handle('request1', (message) => {
                message.reply(reply).then(() => {
                    try {
                        expect(message.originalMessage().content.length).to.be.below(Buffer.byteLength(reply, 'utf8'));
                        expect(message.body).to.equal(textThatWillCompress.toString());
                        expect(message.originalMessage().properties.contentEncoding).to.equal('gzip');
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        const response = await c.request('server', 'request1', textThatWillCompress.toString());
        await p;
        expect(response.body).to.deep.equal(reply);
        expect(response.originalMessage().properties.contentEncoding).to.equal('gzip');
    });

    it('should properly send/receive JSON encoded buffers', async () => {
        const s = new Messaging('server');
        const buffer = Buffer.from('{"test":1}');
        const bufferToStr = buffer.toString();
        const p = new Promise((resolve, reject) => {
            s.handle('request1', (message) => {
                message.reply(buffer).then(() => {
                    try {
                        expect(message.body).to.deep.equal(JSON.parse(bufferToStr));
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        const response = await c.request('server', 'request1', buffer);
        await p;
        expect(response.body).to.deep.equal(JSON.parse(bufferToStr));
    });

    it('should properly get back errors', async () => {
        const s = new Messaging('server');
        s.handle('request1', (message) => {
            message.reject(new CustomError('test', 'Test Error'));
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]);
        try {
            await c.request('server', 'request1', {how: {are: 'you?'}});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('test');
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it('should be notified when a message is not routable', async () => {
        const c = new Messaging('client');
        await c.connect();
        try {
            await c.request('bla', 'bla');
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('unroutable');
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it('should handle tasks (no-ack)', (done) => {
        const s = new Messaging('server');
        s.handle('task1', (message) => {
            try {
                expect(message.isTask(), 'Message is expected to be a task').to.be.true;
                message.ack();
                done();
            } catch (e) {
                done(e);
            }
        });
        const c = new Messaging('client');
        Promise.all([
            c.connect(),
            s.connect(),
        ]).then(() => c.task('server', 'task1', {how: {are: 'task1?'}})).catch(done);
    });
    it('should handle tasks with ack (interpreted as requests.)', async () => {
        const c = new Messaging('client');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        try {
            await c.task('server', 'task2', {how: {are: 'task2?'}}, undefined, {noAck: false});
        } catch (e) {
            expect(1).to.equal(1);
            return;
        }
        expect(1).to.equal(2, 'Expected task to throw');
    });
    it('should emit/receive', async function () {
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.listen('routingKey1', (message) => {
                try {
                    expect(message.isEvent(), 'Task should be an event.').to.be.true;
                    expect(message.isRequest(), 'Task should be an event.').to.be.false;
                    expect(message.isTask(), 'Task should be an event.').to.be.false;
                    message.ack();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
        const c = new Messaging('client');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.emit('server', 'routingKey1', {how: {are: 'pubSub1?'}});
        await p;
    });
    it('should multiple emit/receive', async function () {
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.listen('routingKey1', (message) => {
                try {
                    expect(message.isEvent(), 'Task should be an event.').to.be.true;
                    expect(message.isRequest(), 'Task should be an event.').to.be.false;
                    expect(message.isTask(), 'Task should be an event.').to.be.false;
                    expect(message.body).to.equal('pubSub1');
                    message.ack();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
        const p2 = new Promise((resolve, reject) => {
            s.listen('routingKey2', (message) => {
                try {
                    expect(message.isEvent(), 'Task should be an event.').to.be.true;
                    expect(message.isRequest(), 'Task should be an event.').to.be.false;
                    expect(message.isTask(), 'Task should be an event.').to.be.false;
                    expect(message.body).to.equal('pubSub2');
                    message.ack();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }).catch(reject);
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect(),
        ]).then(() => {
            c.emit('server', 'routingKey1', 'pubSub1');
            c.emit('server', 'routingKey2', 'pubSub2');
        });
        await p;
        await p2;
    });
    it('should timeout getting a reply', async () => {
        const c = new Messaging('client');
        const s = new Messaging('server');
        s.handle('bla', (m: Message) => {
            // Do not answer
            m.ack();
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        try {
            await c.request('server', 'bla', undefined, {}, {timeout: 500});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('timeout');
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;

    });
    it('should timeout getting a reply and still get an unroutable message as a process event', async () => {
        const c = new Messaging('client');
        // const s = new Messaging('server');
        // s.handle('!!!', () => {});
        const p = new Promise((resolve, reject) => {
            c.on('unroutableMessage', async (m) => {
                resolve();
            });
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        try {
            await c.request('server', 'bla', undefined, undefined, {timeout: 0});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('timeout');
            await p;
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    // This test can't work anymore as we introduced discard of timed out requests.
    // it('should timeout getting a reply and not crash because the response arrived later', async () => {
    //     const c = new Messaging('client');
    //     const s = new Messaging('server');
    //     const p = new Promise((resolve, reject) => {
    //         s.handle('bla', (m: Message) => {
    //             // Do not answer
    //             setTimeout(() => {
    //                 m.reply();
    //             }, 100);
    //         });
    //         c.on('unhandledMessage', (m) => {
    //             resolve();
    //         })
    //     });
    //     await Promise.all(Messaging.instances.map(i => i.connect()));
    //     try {
    //         await c.request('server', 'bla', undefined, undefined, {timeout: 100});
    //     } catch (e) {
    //         expect(e).to.have.property('codeString');
    //         expect(e.codeString).to.equal('timeout');
    //         await p;
    //         return;
    //     }
    //     expect(true, 'This line should not be reached.').to.be.false;
    // });
    it('should not error when replying to a task', async () => {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.handle('task', (m) => {
                m.reply().catch(reject);
                resolve();
            }).catch(reject);
        });

        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.task('server', 'task');
        await p;
    });
    it('should handle multiple request and tasks', async function () {
        this.timeout(60000);
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            let i = 0,
                expect = 5;

            s.handle('bla', (m) => {
                m.reply().catch(reject);
                if (++i === expect) {
                    resolve();
                }
            }).catch(reject);
            s.handle('bla2', (m) => {
                m.reply().catch(reject);
                if (++i === expect) {
                    resolve();
                }
            }).catch(reject);
            s.handle('task', (m) => {
                m.ack();
                if (++i === expect) {
                    resolve();
                }
            }).catch(reject);
            s.listen('bla3', () => {
                if (++i === expect) {
                    resolve();
                }
            }).catch(reject);
            s.listen('bla4', () => {
                if (++i === expect) {
                    resolve();
                }
            }).catch(reject);
        });

        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.request('server', 'bla');
        await c.request('server', 'bla2');
        await c.task('server', 'task');
        await c.emit('server', 'bla3');
        await c.emit('server', 'bla4');
        await p;
    });
    it('should properly route requests to their corresponding handler', async function () {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const howMany = 100;
        const p = new Promise((resolve, reject) => {
            let i = 0;
            s.handle('bla', (m) => {
                try {
                    expect(m.originalMessage().properties.headers.__mms.route).to.equal('bla');
                } catch (e) {
                    return reject(e);
                }
                m.reply().then(() => {
                    if (++i === 2 * howMany) {
                        resolve();
                    }
                }).catch(reject);
            }).catch(reject);
            s.handle('bla2', (m) => {
                try {
                    expect(m.originalMessage().properties.headers.__mms.route).to.equal('bla2');
                } catch (e) {
                    return reject(e);
                }
                m.reply().then(() => {
                    if (++i === 2 * howMany) {
                        resolve();
                    }
                }).catch(reject);
            }).catch(reject);
        });

        await Promise.all(Messaging.instances.map(i => i.connect()));
        const proms: any[] = [];
        for (let i = 0; i < howMany; i++) {
            proms.push(c.task('server', 'bla2'));
            proms.push(c.task('server', 'bla'));
        }
        await p;
        await Promise.all(proms);
    });
    it('should stop listening', async () => {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise(async (resolve, reject) => {
            let stopped = false;
            const stopper = await s.handle('bla', async (m: Message) => {
                // Do not answer
                if (stopped) {
                    reject(new Error('Should not have received a request'));
                }
                stopped = true;
                m.reply().then(() => stopper.stop()).then(() => resolve());
            });
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.request('server', 'bla');
        await p;
        try {
            await c.request('server', 'bla', {message: 'content'});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('unroutable');
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it('stop listening should stay individual', async () => {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            let stopper: ReturnHandler;
            s.handle('bla', (m: Message) => {
                m.reply().then(() => stopper.stop()).then(() => resolve());
            }).then(s => stopper = s).catch(reject);

            s.handle('bla2', (m: Message) => {
                m.reply().catch(reject);
            }).catch(reject);
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.request('server', 'bla');
        await p;
        try {
            await c.request('server', 'bla', {message: 'content'});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('unroutable');
            const r = await c.request('server', 'bla2', {message: 'content'});
            expect(r).to.include.keys('body');
            expect(r.body).to.not.be.undefined;
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it('should let user re-listen after a stop', async function () {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            let stopped = false;
            let stopper: ReturnHandler;
            s.handle('bla', (m: Message) => {
                // Do not answer
                if (stopped) {
                    reject(new Error('Should not have received a request'));
                }
                m.reply().then(() => {
                    return stopper.stop();
                }).then(() => resolve());
            }).then(s => stopper = s).catch(reject);
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.request('server', 'bla');
        await p;
        try {
            await c.request('server', 'bla', {message: 'content'}, undefined, {timeout: 500});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('unroutable');
            await new Promise((resolve, reject) => {
                s.handle('bla', (m) => {
                    m.reply().catch(reject);
                }).then(() => resolve()).catch(reject);
            });
            const r = await c.request('server', 'bla', {message: 'content2'});
            expect(r).to.include.keys('body');
            expect(r.body).to.not.be.undefined;

            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it('should not delete the queue if someone else listens on it', async function () {
        this.timeout(30000);
        const c = new Messaging('client');
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        let stopper: ReturnHandler;
        const p = new Promise((resolve, reject) => {
            s.handle('bla', (m: Message) => {
                m.reply()
                    .then(() => {
                        return s2.handle('bla', (m: Message) => {
                            m.reply().catch(reject);
                        });
                    })
                    .then(() => stopper.stop())
                    .then(() => resolve());
            }).then(s => stopper = s).catch(reject);
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        let r = await c.request('server', 'bla', {message: 'content'});
        await p;
        r = await c.request('server', 'bla', {message: 'content'});

        expect(r).to.include.keys('body');
        expect(r.body).to.not.be.undefined;

    });

    it('should throw when trying to listen to the same route', async () => {
        const s = new Messaging('s');
        let threw = false;
        try {
            await s.listen('s', 'queue', () => {
            });
            await s.listen('s', 'queue', () => {
            });
        } catch (err) {
            threw = true;
            expect(err).to.be.instanceof(Error);
        }
        expect(threw).to.be.true;
    });

    it('should throw when not able to connect', async () => {
        const s = new Messaging('s');
        let threw = false;
        try {
            await Promise.all(Messaging.instances.map(i => i.connect('wrong-instance-uri')));
        } catch (err) {
            threw = true;
            expect(err).to.be.instanceof(Error);
        }
        expect(threw).to.be.true;
    });

    it('should work when trying to connect an already connected instance', async () => {
        const s = new Messaging('s');
        await s.connect();
        let res = await s.connect('wrong-url'); // Question: is this the behavior we want?
        expect(res).to.be.undefined;
    });

});
