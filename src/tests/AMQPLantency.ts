import {expect} from "chai";
import {Messaging} from '../Messaging';
import {AMQPLatency} from '../AMQPLatency';

describe('AMQPLatency', () => {
    it('should write multiple messages to answer a single request', async function () {
        const s = new Messaging('aService');
        await Promise.all(Messaging.instances.map(i => i.connect()));
        const latency = new AMQPLatency(s);
        const latencyMS = await latency.benchmark();
        expect(latencyMS).to.be.a('number');
        expect(latencyMS).to.be.below(2000);
    });
});