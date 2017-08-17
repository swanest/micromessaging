import {expect} from "chai";
import {Messaging} from '../Messaging';
import {CustomError} from 'sw-logger';

describe.only('Messaging', () => {
    it('should connect to Rabbit', async () => {
        const c = new Messaging('client');
        await c.connect();
        await c.close();
    });
    // it('should have the reply queue existing before sending a request', async () => {
    //     const s = new Messaging('server');
    //     s.handle('request1', (message) => {
    //
    //         message.reply({hello: 'world'});
    //     });
    //     const c = new Messaging('client');
    //     await Promise.all([
    //         c.connect(),
    //         s.connect()
    //     ]);
    //     const response = await c.request('server', 'request1', {how: {are: 'you?'}});
    // });
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
        await Promise.all([c.close(), s.close()]);
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
            const response = await c.request('server', 'request1', {how: {are: 'you?'}});
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.equal('test');
            return;
        }
        expect(true, 'This line should not be reached.').to.be.false;
    });
    it.only('should be notified when a message is not routable', async () => {
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
            expect(message.isTask(), 'Message is expected to be a task').to.be.true;
            message.ack();
            Promise.all([c.close(), s.close()]).then(() => done()).catch(done);
        });
        const c = new Messaging('client');
        Promise.all([
            c.connect(),
            s.connect()
        ]).then(() => c.task('server', 'task1', {how: {are: 'task1?'}}, null, {noAck: true}));
    });
    it('should handle tasks with ack (interpreted as requests.)', (done) => {
        const s = new Messaging('server');
        s.handle('task2', (message) => {
            expect(message.isRequest(), 'Task should have been interpreted like a request.').to.be.true;
            message.reply({hello: 'world'}).then(() => Promise.all([c.close(), s.close()]).then(() => done()).catch(done));
        });
        const c = new Messaging('client');
        Promise.all([
            c.connect(),
            s.connect()
        ]).then(() => c.task('server', 'task2', {how: {are: 'task2?'}}));
    });
    it('should emit/receive', function (done) {
        this.timeout(50000);
        const s = new Messaging('server');
        s.listen('routingKey1', (message) => {
            expect(message.isEvent(), 'Task should be an event.').to.be.true;
            expect(message.isRequest(), 'Task should be an event.').to.be.false;
            expect(message.isTask(), 'Task should be an event.').to.be.false;
            message.ack();
            Promise.all([c.close(), s.close()]).then(() => done()).catch(done);
        });
        const c = new Messaging('client');
        Promise.all([
            c.connect(),
            s.connect()
        ]).then(() => {
            c.emit('server', 'routingKey1', {how: {are: 'pubSub1?'}})
        });
    });
});
