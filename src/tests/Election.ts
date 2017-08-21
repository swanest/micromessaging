import {expect} from "chai";
import {Messaging} from '../Messaging';
import {random} from 'lodash';
import {Election} from '../Election';
import {isNullOrUndefined} from 'util';
import {CustomError} from 'sw-logger';

describe('Leader Election', () => {

    let instances = 0;

    async function voteLoop(i: number) {
        const servers = [];
        const howManyServers = random(1, 6);
        // const howManyServers = 5;
        instances += howManyServers;
        for (let j = 0; j < howManyServers; j++) {
            servers.push(new Messaging('server' + i))
        }
        await Promise.all(servers.map(s => s.connect()));
        const ids = servers.map(s => s.election().id());
        // ids.sort();
        // const winner = ids[ids.length - 1];
        const winners: Array<number> = [];
        await Promise.all(servers.map(s => {
            return new Promise((resolve, reject) => {
                s.on('leader', o => {
                    try {
                        winners.push((o as any).leaderId);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            })
        }));
        const winner = winners[0];
        winners.forEach(id => {
            try {
                expect(id).to.equal(winner);
            } catch (e) {
                ids.sort((a, b) => a - b);
                console.log({
                    low: ids[0],
                    high: ids[ids.length - 1],
                    elected: winner,
                    ids
                });
                throw e;
            }
        });
        return await Promise.all(servers.map(s => s.close())).then(() => {
            ids.sort((a, b) => a - b);
            return {
                low: ids[0],
                high: ids[ids.length - 1],
                elected: winner
            }
        });
    }

    it('should find consensus on leadership', async function () {
        this.timeout(20000);
        const proms = [];
        for (let i = 0; i < 5; i++) {
            proms.push(voteLoop(i));
        }
        await Promise.all(proms).then(console.log);
        console.log('how many instances', instances);
    });

    it('should maintain leader when someone joining later', async function () {
        this.timeout(20000);
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            setTimeout(async () => {
                s2.on('leader', (m) => {
                    console.log('leader event', m);
                    try {
                        expect((m as any).leaderId).to.equal(s.election().id());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                await s2.connect();
            }, Election.DEFAULT_TEMPO * 2);
        });
        await Promise.all([s.close(), s2.close()]);
    });
    it('should elect a new leader when the actual one is offline', async function () {
        Election.DEFAULT_TEMPO = 500;
        Election.DEFAULT_TIMEOUT = 1000;
        this.timeout(Election.DEFAULT_TIMEOUT + 10000);
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            setTimeout(async () => {
                s2.on('leader', (m) => {
                    console.log('leader event', m);
                    try {
                        expect((m as any).leaderId).to.equal(s2.election().id());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                await s.close();
                await s2.connect();
            }, Election.DEFAULT_TEMPO * 2);
        });
        await Promise.all(Messaging.instances.map(i => i.close(true)));
        Election.DEFAULT_TEMPO = Election.DEFAULT_TEMPO;
        Election.DEFAULT_TIMEOUT = Election.DEFAULT_TIMEOUT;
    });

    it('reducing timeout and tempo should keep the same behaviour on election', async function () {
        Election.DEFAULT_TEMPO = 500;
        Election.DEFAULT_TIMEOUT = 1000;
        this.timeout(Election.DEFAULT_TIMEOUT + 2000);
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        const waiter = new Promise(async (resolve, reject) => {
            s2.on('leader', (m) => {
                try {
                    expect((m as any).leaderId).to.equal(s2.election().id());
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });

        await Promise.all([s.connect(),
            s2.connect()]);
        await waiter;
        await Promise.all(Messaging.instances.map(i => i.close(true)));
        Election.DEFAULT_TEMPO = Election.DEFAULT_TEMPO;
        Election.DEFAULT_TIMEOUT = Election.DEFAULT_TIMEOUT;
    });
});
