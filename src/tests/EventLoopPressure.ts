import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { PressureEvent } from '../Qos';

describe('EventLoopPressure', () => {
    it('should notify when event-loop is under pressure', (done) => {
        const c = new Messaging('test');
        c.once('pressure', async (event: PressureEvent) => {
            expect(event.type).to.equal('eventLoop');
            await c.close();
            done();
        });

        // Put some pressure on the process
        const curDate = new Date().getTime();
        while (new Date().getTime() - curDate < 1000) {
            ((): void => undefined)();
        }
    });

    it('should notify when event-loop is not under pressure anymore', (done) => {
        const c = new Messaging('test');
        c.on('pressureReleased', async (event: PressureEvent) => {
            expect(event.type).to.equal('eventLoop');
            await c.close();
            done();
        });
        // Put some pressure on the process
        const curDate = new Date().getTime();
        while (new Date().getTime() - curDate < 1000) {
            ((): void => undefined)();
        }
    });
});
