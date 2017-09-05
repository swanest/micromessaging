import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { random } from 'lodash';
import { Election } from '../Election';

describe('Leader Election', () => {

    let instances = 0;

    async function voteLoop(i: number, serversCounts: number = random(1, 3)) {
        const servers = [];
        const howManyServers = serversCounts;
        // const howManyServers = 5;
        instances += howManyServers;
        for (let j = 0; j < howManyServers; j++) {
            servers.push(new Messaging('server' + i))
        }
        await Promise.all(servers.map(s => s.connect()));
        const ids = servers.map(s => s.getServiceId());
        // ids.sort();
        // const winner = ids[ids.length - 1];
        const winners: Array<number> = [];
        await Promise.all(servers.map((s) => {
            return new Promise((resolve, reject) => {
                s.on('leader', o => {
                    try {
                        // console.log('leader on ' + s.getServiceId() + ' is ' + (o as any).leaderId);
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
                // console.log({
                //     low: ids[0],
                //     high: ids[ids.length - 1],
                //     elected: winner,
                //     ids
                // });
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

    it('should find consensus on leadership (random)', async function () {
        this.timeout(20000);
        const proms = [];
        for (let i = 0; i < 10; i++) {
            // proms.push(voteLoop(i));
            await voteLoop(i);
            // .then(console.log);
        }
        // await Promise.all(proms).then(console.log);
        // console.log('how many instances', instances);
    });

    it('should find consensus on leadership (10 instances)', async function () {
        this.timeout(10000);
        await voteLoop(1, 6)
        // .then(console.log);
        // console.log('how many instances', instances);
    });

    it('should find consensus on leadership (2 instances)', async function () {
        await voteLoop(1, 2)
        // .then(console.log);
        // console.log('how many instances', instances);
    });

    it('should be able to vote alone', async function () {
        const s = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                try {
                    expect((lM as any).leaderId).to.equal(s.getServiceId());
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    });

    it('should not emit multiple times the leader', async function () {
        this.timeout(10000);
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        let leaderKnown1 = false,
            leaderKnown2 = false,
            rejected = false;
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                if (leaderKnown1) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (lM as any).leaderId));
                    rejected = true;
                    return;
                }
                // console.log('leader event on 1', lM);
                leaderKnown1 = true;
            });
            s2.on('leader', (m) => {
                // console.log('leader event on 2', m);
                if (leaderKnown2) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (m as any).leaderId));
                    rejected = true;
                    return;
                }
                leaderKnown2 = true;
            });
            setTimeout(() => {
                if (!rejected) {
                    resolve();
                } else if (!leaderKnown1 || !leaderKnown2) {
                    reject(new Error('Unknown leader'));
                }
            }, 1000);
        });
        await new Promise((resolve, reject) => {
            setTimeout(() => resolve(), 1000);
        });
        await Promise.all([s.close(), s2.close()]);
    });

    it('should maintain leader when someone joining later', async function () {
        this.timeout(5000);
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (lM) => {
                // console.log('leader event on 1', lM);
                s2.on('leader', (m) => {
                    // console.log('leader event on 2', m);
                    try {
                        expect((m as any).leaderId).to.equal(s.getServiceId());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s2.connect().catch(reject);
            });
        });
        await new Promise((resolve, reject) => {
            setTimeout(() => resolve(), 1000);
        });
        await Promise.all([s.close(), s2.close()]);
    });
    it('should elect a new leader when the actual one seems offline', async function () {
        this.timeout(20000);
        Election.DEFAULT_TIMEOUT = 2000;
        const s = new Messaging('server1');
        const s2 = new Messaging('server1');
        const s3 = new Messaging('server1');
        await s3.connect();
        await s.connect();
        await new Promise((resolve, reject) => {
            s.once('leader', (lM) => {
                expect(lM).to.deep.equal({leaderId: s3.getServiceId()});
                // console.log('leader event on 1', lM);
                const originalLeader = (lM as any).leaderId;
                s2.once('leader', (m) => {
                    // console.log('leader event on 2', m);
                    try {
                        expect((m as any).leaderId).to.not.equal(s3.getServiceId());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
                s3.close().then(() => new Promise((res, rej) => {
                    // console.log('wait 1000');
                    setTimeout(() => {
                        res();
                        // console.log('resolve');
                    }, 2000);
                })).then(() => {
                    // console.log('going to connect s2');
                    return s2.connect()
                });
            });

            s3.once('leader', (m) => {
                // console.log('leader event on 3', m);
                expect(m).to.deep.equal({leaderId: s3.getServiceId()});
            });
        });
    });
});
