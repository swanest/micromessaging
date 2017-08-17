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
    it('should handle tasks with ack (interpreted as requests.)', (done) => {
        const s = new Messaging('server');
        s.handle('task2', (message) => {
            try {
                expect(message.isRequest(), 'Task should have been interpreted like a request.').to.be.true;
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
        ]).then(() => c.task('server', 'task2', {how: {are: 'task2?'}}, undefined, {noAck: false}));
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
});
