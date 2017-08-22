import {expect} from "chai";
import {Messaging} from '../Messaging';
import {CustomError} from 'sw-logger';
import {Message} from '../Message';

process.on('unhandledRejection', (reason) => {
    console.error(reason);
});
describe('Messaging', () => {
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
            s.connect()
        ]);
        const response = await c.request('server', 'request1', {how: {are: 'you?'}});
        expect(response.body).to.deep.equal({hello: 'world'});
    });

    it('should properly get back errors', async () => {
        const s = new Messaging('server');
        s.handle('request1', (message) => {
            message.reject(new CustomError('test', 'Test Error'));
        });
        const c = new Messaging('client');
        await Promise.all([
            c.connect(),
            s.connect()
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
            s.connect()
        ]).then(() => c.task('server', 'task1', {how: {are: 'task1?'}})).catch(done);
    });
    it('should handle tasks with ack (interpreted as requests.)', async () => {
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.handle('task2', (message) => {
                try {
                    expect(message.isRequest(), 'Task should have been interpreted like a request.').to.be.true;
                    message.reply();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        const c = new Messaging('client');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await c.task('server', 'task2', {how: {are: 'task2?'}}, undefined, {noAck: false})
        await p;
    });
    it('should emit/receive', function (done) {
        const s = new Messaging('server');
        s.listen('routingKey1', (message) => {
            try {
                expect(message.isEvent(), 'Task should be an event.').to.be.true;
                expect(message.isRequest(), 'Task should be an event.').to.be.false;
                expect(message.isTask(), 'Task should be an event.').to.be.false;
                message.ack();
                done();
            } catch (e) {
                done(e);
            }
        });
        const c = new Messaging('client');
        Promise.all([
            c.connect(),
            s.connect()
        ]).then(() => {
            c.emit('server', 'routingKey1', {how: {are: 'pubSub1?'}})
        });
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
    it('should timeout getting a reply and not crash because the response arrived later', async () => {
        const c = new Messaging('client');
        const s = new Messaging('server');
        const p = new Promise((resolve, reject) => {
            s.handle('bla', (m: Message) => {
                // Do not answer
                setTimeout(() => {
                    m.reply();
                }, 100);
            });
            c.on('unhandledMessage', (m) => {
                resolve();
            })
        });
        await Promise.all(Messaging.instances.map(i => i.connect()));
        try {
            await c.request('server', 'bla', undefined, undefined, {timeout: 100});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('timeout');
            await p;
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
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
    // it.only('should stop listening', async () => {
    //     const c = new Messaging('client');
    //     const s = new Messaging('server');
    //     const p = new Promise(async (resolve, reject) => {
    //         let stopped = false;
    //         s.on('unhandledMessage', () => {
    //             resolve();
    //         });
    //         const stopper = await s.handle('bla', async (m: Message) => {
    //             // Do not answer
    //             if (stopped) {
    //                 reject(new Error('Should not have received a request'));
    //             }
    //             await m.reply();
    //             stopper.stop();
    //             stopped = true;
    //         });
    //     });
    //     await Promise.all(Messaging.instances.map(i => i.connect()));
    //     await c.request('server', 'bla');
    //     try {
    //         await c.request('server', 'bla', {message: 'content'}, undefined, {timeout: 1000});
    //     } catch (e) {
    //         console.log(e);
    //         expect(e).to.have.property('codeString');
    //         expect(e.codeString).to.equal('timeout');
    //         await p;
    //         return;
    //     }
    //     expect(true, 'This line should not be reached.').to.be.false;
    // });
});
