import { CustomError } from 'sw-logger';
import { expect } from 'chai';
import { Messaging } from '../Messaging';

describe('AMQPLatency', () => {
    it('should write multiple messages to answer a single request', async function () {
        const s = new Messaging('aService');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        const latency = s.amqpLatency;
        const latencyMS = await latency.benchmark();
        expect(latencyMS).to.be.a('number');
        expect(latencyMS).to.be.below(2000);
    });

    it('should throw when benchmarking a messaging service not connected', async () => {
        const s = new Messaging('serviceNameHere');
        const latency = s.amqpLatency;
        let threw = false;
        try {
            const latencyMS = await latency.benchmark();
        } catch (er) {
            threw = !threw;
            expect(er).to.be.instanceof(CustomError);
        }
        expect(threw).to.be.true;
    });

    it('should return the same promise when two benchmarks are issued at the same time', async () => {
        const s = new Messaging('serviceNameHere');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        const latency = s.amqpLatency;
        const firstCall = latency.benchmark();
        const secondCall = latency.benchmark();
        const firstResult = await firstCall;
        const secondResult = await secondCall;
        expect(firstResult).to.be.equal(secondResult);
    });
});
