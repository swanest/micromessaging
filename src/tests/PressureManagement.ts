import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { random } from 'lodash';
import { Election } from '../Election';
import { isNullOrUndefined } from 'util';
import { CustomError } from 'sw-logger';

describe('Pressure Message Management', () => {

    it('should not increase the parallelism', async function () {
        this.timeout(60000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        const c = new Messaging('client');

        s.handle('test-low-bp', (m) => {
            expect(s.getMaxParallelism()).to.be.below(2);
            setTimeout(() => {
                m.reply();
            }, 5);
        }, {maxParallel: 1});

        s2.handle('test-low-bp', (m) => {
            expect(s2.getMaxParallelism()).to.be.below(2);
            setTimeout(() => {
                m.reply();
            }, 5);
        }, {maxParallel: 1});

        await Promise.all(Messaging.instances.map(s => s.connect()));

        const proms = [];
        for (let i = 0; i < 1000; i++) {
            proms.push(c.request('server', 'test-low-bp'));
        }
        await Promise.all(proms);
    });

    it('should increase the parallelism', async function () {
        this.timeout(60000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        const c = new Messaging('client');

        let latestBP1 = 0,
            latestBP2 = 0;

        s.handle('test', (m) => {
            latestBP1 = s.getMaxParallelism();
            m.reply();
        });

        s.handle('test-low-bp', (m) => {
            latestBP1 = s.getMaxParallelism();
            setTimeout(() => {
                m.reply();
            }, 5);
        }, {maxParallel: 1});

        s2.handle('test', (m) => {
            latestBP2 = s2.getMaxParallelism();
            setTimeout(() => {
                m.reply();
            }, 2);
        });

        s2.handle('test-low-bp', (m) => {
            latestBP2 = s2.getMaxParallelism();
            setTimeout(() => {
                m.reply();
            }, 5);
        }, {maxParallel: 1});

        await Promise.all(Messaging.instances.map(s => s.connect()));

        const proms = [];
        for (let i = 0; i < 1000; i++) {
            proms.push(c.request('server', 'test'));
            proms.push(c.request('server', 'test-low-bp'));
        }
        await Promise.all(proms);
        expect(latestBP1).to.be.above(10);
        expect(latestBP2).to.be.above(10);
    });

    it('should stabilise parallelism', async function () {
        this.timeout(60000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        const c = new Messaging('client');

        let latestBP1 = 0,
            latestBP2 = 0;

        s.handle('test', (m) => {
            latestBP1 = s.getMaxParallelism();
            m.reply();
        });

        s2.handle('test', (m) => {
            latestBP2 = s2.getMaxParallelism();
            m.reply();
        });


        await Promise.all(Messaging.instances.map(s => s.connect()));

        let proms = [];
        for (let i = 0; i < 300; i++) {
            proms.push(c.request('server', 'test'));
            if (proms.length === 40) {
                await Promise.all(proms);
                await new Promise(resolve => setTimeout(() => resolve(), 500));
                proms = [];
            }
        }
        await Promise.all(proms);
        expect(latestBP1).to.equal(21);
        expect(latestBP2).to.equal(21);
    });

    it('should stop receiving messages when under pressure', async function () {
        this.timeout(60000 * 5);
        const s = new Messaging('server');
        // s.maxParallelism(1);
        const s2 = new Messaging('server');
        const c = new Messaging('client');
        let messageCount1 = 0,
            messageCount2 = 0;
        s.handle('test', async m => {
            messageCount1++;
            // setImmediate(async () => {
            await m.reply({c: messageCount1});
            // });
        });
        s2.handle('test', async m => {
            messageCount2++;
            // setImmediate(async () => {
            await m.reply({c: messageCount2});
            // });
        });
        await Promise.all([s.connect(), s2.connect(), c.connect()]);

        const proms: any[] = [];
        let responsesCount = 0;
        for (let j = 0; j < 100; j++) {
            // proms.push(new Promise(resolve => {
            //     const proms2: any[] = [];
            //     setTimeout(async () => {
            //         for (let i = 0; i < 1000; i++) {
            proms.push(c.request('server', 'test', undefined, undefined, {timeout: 60000 * 5}).then(function (r) {
                responsesCount++;
            }));
            //     }
            //     await Promise.all(proms2);
            //     resolve();
            // }, j * 100);
            // }));
        }
        await Promise.all(proms);
        // await new Promise((resolve, reject) => {
        //     setTimeout(async () => {
        //         s2.on('leader', (m) => {
        //             console.log('leader event', m);
        //             try {
        //                 expect((m as any).leaderId).to.equal(s.election().id());
        //                 resolve();
        //             } catch (e) {
        //                 reject(e);
        //             }
        //         });
        //         await s2.connect();
        //     }, Election.DEFAULT_TEMPO * 2);
        // });
        // await new Promise(resolve => {
        //     setTimeout(resolve, 30000);
        // });
        await Promise.all([s.close(), s2.close(), c.close()]);
    });
});
