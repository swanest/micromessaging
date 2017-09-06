import { Messaging } from '../src/Messaging';
import { Utils } from '../src/Utils';
import { Message } from '../src/Message';
import * as Messages from './Messages';
import { getHeapStatistics } from 'v8';
import { random } from 'lodash';

process.on('message', async ({type, serverName, queueName, messageRef, count}) => {
    if (type === 'fill') {
        prepareQueue(serverName, queueName, messageRef, count);
    } else {
        const server = new Messaging(serverName);
        // server.on('pressure', (e) => console.log('pressure', e));
        // server.on('pressureReleased', (e) => console.log('pressureReleased', e));
        let counter = 0;
        if (serverName !== 'election-hell') {
            setInterval(() => {
                process.send({cmd: 'notifyTotal', value: counter});
            }, 100);
        } else {
            console.log('\nelection hell process ' + serverName);
            setTimeout(() => {
                console.log(`\n${process.pid} exiting.`);
                process.exit(1)
            }, random(5000, 50000));
        }

        if (serverName === 'memory') {
            const {heap_size_limit} = getHeapStatistics();
            const limits = {
                soft: ~~(heap_size_limit / 2),
                target: ~~(heap_size_limit / 5 * 4),
                hard: ~~(heap_size_limit / 5 * 3)
            };
            const arrs = [];
            while (process.memoryUsage().heapUsed < limits.soft) {
                arrs.push(new Array(1e3));
            }
            setInterval(() => {
                if (process.memoryUsage().heapUsed > limits.target) {
                    // console.log(`\nHeap used ${process.memoryUsage().heapUsed} above limit ${limits.target}`)
                    arrs.splice(0, 1);
                }
            }, 200);
            // console.log(`\nMemory filled to: ${process.memoryUsage().heapUsed}. softLimit=${limits.soft}, hardLimit=${limits.hard}`);
        }

        await server.handle(queueName, async (m: Message) => {
            switch (serverName) {
                case 'elDelay':
                    const now = new Date().getTime();
                    while (new Date().getTime() - now < 5) {
                    }
                    m.reply().then(() => {
                        counter++;
                    });
                    return;
                case 'io':
                    setTimeout(() => {
                        m.reply().then(() => {
                            counter++;
                        });
                    }, 10);
                    return;
                default:
                    m.reply().then(() => {
                        counter++;
                    });
                    return;
            }
        });
        await server.connect();
    }
});

async function prepareQueue(serverName: string, queueName: string, messageRef: string, count: number) {
    const m = new Messaging(serverName, {enableQos: false});
    await m.handle(queueName, () => {
    });
    await m.connect();
    // console.log(`\nWorker is connected to ${serverName}`);
    await m.setMaxParallelism(0);
    let proms = [];
    // console.log(`\nSending ${count} messages to the queue.`);
    for (let i = 0; i < count; i += 10) {
        for (let j = 0; j < 10 && j < count; j++) {
            proms.push(m.task(serverName, queueName, Messages[messageRef]));
        }
        await Promise.all(proms);
        proms = [];
    }
    const report = await m.getRequestsReport(serverName, queueName);
    // console.log(`\nSent ${count} messages to the queue.`);
    // console.log(`\nQueue size is now ${report.queueSize} and there are ${report.consumers} consumers on it.`);
    await m.close();
    process.exit(0);
}
