import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { Message } from '../Message';

describe('Stream', () => {

    it('should write multiple messages to answer a single request', async function () {
        const s = new Messaging('aService');
        const c = new Messaging('client');
        const limit = 100;
        s.handle('something', async (m) => {
            for (let i = 0; i < limit - 1; i++) {
                await m.write({});
            }
            await m.end({});
        });
        await Promise.all([s.connect(), c.connect()]);
        let received = 0;
        await c.request('aService', 'something',
            undefined,
            undefined,
            undefined,
            (message: Message) => {
                received++;
            });
        received++;
        expect(received).to.equal(limit);
    });

    it('should not accept writing multiple messages on a replied message', async function () {
        const s = new Messaging('aService');
        const c = new Messaging('client');
        const limit = 100;
        const awaiter = new Promise((resolve, reject) => {
            s.handle('something', async m => {
                try {
                    await m.reply();
                    try {
                        await m.write();
                    } catch (e) {
                        expect(e).to.have.property('codeString');
                        expect(e.codeString).to.contain('forbidden');
                        return resolve();
                    }
                    expect(true, 'This line should not have been reached.').to.be.false;
                } catch (e) {
                    reject(e);
                }
            });
        });
        await Promise.all([s.connect(), c.connect()]);
        await c.request('aService', 'something',
            undefined,
            undefined,
            undefined,
            (m: Message) => {
            });
        await awaiter;
    });
});
