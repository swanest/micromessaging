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
        const ids = servers.map(s => s.serviceId());
        // ids.sort();
        // const winner = ids[ids.length - 1];
        const winners: Array<number> = [];
        await Promise.all(servers.map((s) => {
            return new Promise((resolve, reject) => {
                s.on('leader', o => {
                    try {
                        console.log('leader on ' + s.serviceId() + ' is ' + (o as any).leaderId);
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
                ids.sort();
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
            ids.sort();
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
            // await voteLoop(i).then(console.log);
        }
        await Promise.all(proms).then(console.log);
        console.log('how many instances', instances);
    });

    it('should be able to vote alone', async function () {
        const s = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                resolve();
            });
        });
    });

    it('should maintain leader when someone joining later', async function () {
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                s2.on('leader', (m) => {
                    console.log('leader event', m);
                    try {
                        expect((m as any).leaderId).to.equal(s.serviceId());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s2.connect().catch(reject);
            });
        });
        await Promise.all([s.close(), s2.close()]);
    });
    it('should elect a new leader when the actual one seems offline', async function () {
        this.timeout(10000);
        Election.DEFAULT_TIMEOUT = 100;
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        const s3 = new Messaging('server1');
        await Promise.all([s.connect(), s3.connect()]);
        await new Promise((resolve, reject) => {
            s.once('leader', (lM) => {
                console.log('leader event on 1', lM);
                const originalLeader = (lM as any).leaderId;
                s2.on('leader', (m) => {
                    console.log('leader event on 2', m);
                    try {
                        expect((m as any).leaderId).to.not.equal(originalLeader);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s3.close().then(() => new Promise((res, rej) => {
                    console.log('wait 1000');
                    setTimeout(() => {
                        res();
                        console.log('resolve');
                    }, 1000);
                })).then(() => {
                    console.log('going to connect s2');
                    return s2.connect()
                });
            });

            s3.on('leader', (m) => {
                console.log('leader event on 3', m);
            });
        });
        // await Promise.all(Messaging.instances.map(i => i.close(true)));
    });
});
