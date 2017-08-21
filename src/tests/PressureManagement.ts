import {expect} from "chai";
import {Messaging} from '../Messaging';
import {random} from 'lodash';
import {Election} from '../Election';
import {isNullOrUndefined} from 'util';
import {CustomError} from 'sw-logger';

describe('Pressure Message Management', () => {

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

        setInterval(() => console.log('test'), 1000);
        const proms: any[] = [];
        let responsesCount = 0;
        for (let j = 0; j < 100; j++) {
            // proms.push(new Promise(resolve => {
            //     const proms2: any[] = [];
            //     setTimeout(async () => {
            //         for (let i = 0; i < 1000; i++) {
                        proms.push(c.request('server', 'test').then(function (r) {
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
