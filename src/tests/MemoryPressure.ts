import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { PressureEvent } from '../Qos';

describe('MemoryPressure', () => {
    it('should notify when memory is under pressure', function (done) {
        this.timeout(10000);
        const c = new Messaging('test', {
            memorySoftLimit: 10,
        });
        let stop = false;
        c.once('pressure', async (event: PressureEvent) => {
            try {
                expect(event.type).to.equal('memory');
                await c.close();
                done();
                stop = true;
            } catch (e) {
                done(e);
            }
        });

        let memFiller: Array<Array<number>> = [];

        function fill() {
            if (stop) {
                memFiller = null;
                global.gc();
                return;
            }
            memFiller.push(new Array(1e7));
            setTimeout(fill, 300);
        }

        fill();

    });

    it('should notify when memory is not under pressure anymore', function (done) {
        this.timeout(10000);
        const c = new Messaging('test', {
            memorySoftLimit: 150,
        });
        global.gc();
        let stop = false;
        c.on('pressure', (event: PressureEvent) => {
            stop = true;
        });
        c.once('pressureReleased', async (event: PressureEvent) => {
            try {
                expect(event.type).to.equal('memory');
                await c.close();
                done();
            } catch (e) {
                done(e);
            }
        });

        let memFiller: Array<Array<number>> = [];

        function fill() {
            if (stop) {
                memFiller = null;
                global.gc();
                return;
            }
            memFiller.push(new Array(1e7));
            setTimeout(fill, 300);
        }
        fill();
    });
});
