import * as _ from 'lodash';
import { expect } from 'chai';
import { Messaging } from '../Messaging';
import { wait } from '../Utils';
import { PeerStatus } from '../PeerStatus';
import { Election } from '../Election';
import { beforeEach } from 'mocha';

describe('Leader Election', () => {
    beforeEach(() => {
        // Makes test faster by keeping a faster keepAlive heartbeat
        // and less time without leader
        PeerStatus.HEARTBEAT = 500;
        Election.TIMEOUT = 1500;
    });

    afterEach(() => {
        PeerStatus.HEARTBEAT = 10 * 1000;
        Election.TIMEOUT = Election.DEFAULT_TIMEOUT;
    });

    /**
     * Checks that there are at least serviceCount votes and the last
     * ones agree on the leader
     * @param winners
     * @param serviceCount
     */
    function consensus(winners: Array<string>, serviceCount: number) {
        expect(winners.length).to.be.gte(serviceCount);
        const elected = _.takeRight(winners, serviceCount);
        const allEqual = elected.every((e) => e === elected[0]);
        expect(allEqual).to.be.true;
    }

    /**
     * Returns an array of Messaging services of size serviceCount
     * @param serviceCount
     */
    function getServices(serviceCount: number): Array<Messaging> {
        return new Array(serviceCount).fill(0).map(d => new Messaging('service'));
    }

    /**
     * Connects the services passed as argument if not already
     * connected and every time one of them emits a leader event, it
     * saves it to an array, waits for the election to have finished
     * (hopefully) and returns the array.
     * @param services
     */
    async function voteLoop(services: Array<Messaging>): Promise<Array<string>> {
        const winners: Array<string> = [];
        // When connected, the services will vote among themselves and
        // push who they think the leader is to `winners`.
        services.map((s) => {
            s.on('leader', obj => {
                winners.push((obj as any).leaderId);
            });
        });

        await Promise.all(services.map(s => s.connect()));
        // Vote for a certain amount of time and try to find consensus
        await wait(PeerStatus.HEARTBEAT + Election.TIMEOUT + 500);

        // Remove listener
        services.map((s) => {
            s.on('leader', () => undefined);
        });

        return winners;
    }

    it('should have an election TIMEOUT greater than HEARTBEAT', async function () {
        // Otherwise, the leader PeerStat message will not get fast
        // enough to the peers and these will unnecessarily try to
        // perform an election thinking the leader is dead.
        expect(Election.DEFAULT_TIMEOUT).to.be.greaterThan(PeerStatus.HEARTBEAT);
        expect(Election.TIMEOUT).to.be.greaterThan(PeerStatus.HEARTBEAT);
    });

    it('should find consensus on leadership (2 instances)', async function () {
        this.timeout(30000);
        const services = getServices(2);
        const winners = await voteLoop(services);
        consensus(winners, 2);
        await Promise.all(services.map(s => s.close()));
    });

    it('should find consensus on leadership (10 instances)', async function () {
        this.timeout(30000);
        const services = getServices(10);
        const winners = await voteLoop(services);
        consensus(winners, 10);
        await Promise.all(services.map(s => s.close()));
    });

    it('should find consensus on leadership (random number of instances)', async function () {
        this.timeout(30000);
        const serviceCount = _.random(2, 15);
        const services = getServices(serviceCount);
        const winners = await voteLoop(services);
        consensus(winners, serviceCount);
        await Promise.all(services.map(s => s.close()));
    });


    it('should find consensus on leadership and keep a consistent one after leader dies', async function () {
        this.timeout(600000);
        const serviceCount = 4;
        const services = getServices(serviceCount);
        const winners = await voteLoop(services);
        consensus(winners, serviceCount);

        const successiveLeaders = [_.last(winners)];

        for (var i = 0; i < serviceCount - 1; i++) {
            const remaining = services.filter(serv => !successiveLeaders.includes(serv.getServiceId()));
            const leadersToKill = services.filter(serv => successiveLeaders.includes(serv.getServiceId()));
            await Promise.all(leadersToKill.map(s => s.close())); // simulate leader death
            const successiveWinners = await voteLoop(remaining);
            consensus(successiveWinners, remaining.length);
            successiveLeaders.push(_.last(successiveWinners));
        }

        await Promise.all(services.map(s => s.close()));
        expect(successiveLeaders).to.have.lengthOf(services.length);
        expect(_.uniq(successiveLeaders)).to.have.lengthOf(services.length);
    });

    it('should be able to vote alone', async function () {
        this.timeout(2000);
        const s = new Messaging('service');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (obj) => {
                try {
                    expect((obj as any).leaderId).to.equal(s.getServiceId());
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    });

    it('should not emit multiple times the leader', async function () {
        this.timeout(30000);
        const s = new Messaging('server');
        const s2 = new Messaging('server');
        let leaderKnown1 = false,
            leaderKnown2 = false,
            rejected = false;
        const test = new Promise((resolve, reject) => {
            s.on('leader', (obj) => {
                if (leaderKnown1) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (obj as any).leaderId));
                    rejected = true;
                    return;
                }
                // console.log('leader event on 1', obj);
                leaderKnown1 = true;
            });
            s2.on('leader', (obj) => {
                // console.log('leader event on 2', obj);
                if (leaderKnown2) {
                    reject(new Error('Leader was already known but we got the event again with a vote for ' + (obj as any).leaderId));
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
        await Promise.all(Messaging.instances.map(i => i.connect()));
        await test;

        await wait(1000);
        await Promise.all([s.close(), s2.close()]);
    });

    it('should maintain leader when someone joining later', async function () {
        this.timeout(30000);
        const s = new Messaging('service');
        const s2 = new Messaging('service');
        await s.connect();
        await new Promise((resolve, reject) => {
            s.on('leader', (obj) => {
                expect((obj as any).leaderId).to.equal(s.getServiceId());
                s2.on('leader', (obj) => {
                    try {
                        expect((obj as any).leaderId).to.equal(s.getServiceId());
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });

                // When s becomes leader, boot s2
                s2.connect().catch(reject);
            });
        });

        await wait(1000);
        await Promise.all([s.close(), s2.close()]);
    });
});
