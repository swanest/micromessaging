import {expect} from "chai";
import {Messaging} from '../Messaging';
import uuid = require('uuid');

describe('Requests Report', () => {

    it('should fail properly if the queue doest exists', async function () {
        const s = new Messaging('aService');
        const c = new Messaging('client');

        await Promise.all([s.connect(), c.connect()]);
        try {
            await c.getRequestsReport('aService');
            expect(true, 'This line should not have been reached.').to.be.false;
        } catch (e) {
            expect(e).to.have.property('codeString');
            expect(e.codeString).to.contain('notFound');
        }
        await Promise.all(Messaging.instances.map(i => i.close(true)));
    });

    it('should get a request report on a targetService', async function () {
        const serviceName = 'aService' + uuid.v4();
        const s = new Messaging(serviceName);
        const c = new Messaging('client');
        s.handle('whathever', (m) => {
            m.ack();
        });

        await Promise.all([s.connect(), c.connect()]);
        const report = await c.getRequestsReport(serviceName);
        expect(report).to.deep.equal({
            queueSize: 0,
            queueName: 'q.requests.' + serviceName,
            consumers: 1
        });
        await Promise.all(Messaging.instances.map(i => i.close(true)));
    });
});
