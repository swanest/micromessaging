import { Messaging } from '../src/Messaging';
import * as cluster from 'cluster';
import * as os from 'os';
import { Utils } from '../src/Utils';
import * as Messages from './Messages';

const numCPUs = os.cpus().length;
console.log(`\nMaster ${process.pid} is running`);

// Fork workers.
async function execTest() {
    const results = []
    await launch('Election hell', 'election-hell', 'req', 'ITEM', 0)
    // results.push(await launch('Simple test with no treatment on the counterpart', 'basic', 'req', 'ITEM', 10000));
    // results.push(await launch('Simple message with 2ms event-loop delay behind', 'elDelay', 'req', 'ITEM', 10000));
    // results.push(await launch('Simple message with I/O behind', 'io', 'req', 'ITEM', 10000));
    // results.push(await launch('Simple message with filled memory', 'memory', 'req', 'ITEM', 10000));
    //
    // results.push(await launch('Medium message test with no treatment on the counterpart', 'basic', 'req', 'MEDIUM_MESSAGE', 10000));
    // results.push(await launch('Medium message with 2ms event-loop delay behind', 'elDelay', 'req', 'ITEM', 10000));
    // results.push(await launch('Medium message with I/O behind', 'io', 'req', 'ITEM', 10000));
    // results.push(await launch('Medium message with filled memory', 'memory', 'req', 'ITEM', 10000));
    //
    // results.push(await launch('Big message test with no treatment on the counterpart', 'basic', 'req', 'BIG_MESSAGE', 100));
    // results.push(await launch('Big message with 2ms event-loop delay behind', 'elDelay', 'req', 'ITEM', 100));
    // results.push(await launch('Big message with I/O behind', 'io', 'req', 'ITEM', 100));
    // results.push(await launch('Big message with filled memory', 'memory', 'req', 'ITEM', 100));
    console.log();
    console.log(results);
}

execTest();
let hellLaunches = 0;

async function launch(testName: string, serverName: string, queueName: string, messageRef: string, count: number) {
    console.log(`\nLaunching test: ${testName}. Filling queue.`);
    await prepareQueue(serverName, queueName, messageRef, count);
    console.log(`Queue filled. Creating workers and sending job.`);
    const workers = await createWorkers(serverName, queueName);
    return await new Promise((resolve, reject) => {

        let exited = 0,
            numReqs = {},
            totalReqs = 0,
            ts = process.hrtime(),
            elapsed;

        workers.forEach((w, id) => {
            w.on('message', (msg) => {
                messageHandler(msg, id);
            });
            w.on('exit', () => {
                if (serverName === 'election-hell') {
                    if (++hellLaunches < 4) {
                        launch(testName, serverName, queueName, messageRef, count);
                    }
                    return;
                }
                exited++;
                if (exited === numCPUs) {
                    resolve({
                        testName,
                        totalRequests: totalReqs,
                        elapsedMs: elapsed,
                        workers: numCPUs,
                        requestsPerInstancePerSecond: totalReqs / (elapsed / 1000) / numCPUs
                    });
                }
            });
            w.send({serverName, queueName});
        });

        const reporter = setInterval(() => {
            const stdout: any = process.stdout;
            stdout.clearLine();  // clear current text
            stdout.cursorTo(0);  // move cursor to beginning of line
            process.stdout.write(`[${testName}]: numReqs = ${totalReqs}, rate = ${Math.round(totalReqs / (Utils.hrtimeToMS(process.hrtime(ts)) / 1000) / (numCPUs - 1))}/s/instance`);
        }, 1000);

        function messageHandler(msg, id) {
            if (msg.cmd && msg.cmd === 'notifyTotal') {
                numReqs[id] = msg.value;

                totalReqs = 0;
                for (let p in numReqs) {
                    totalReqs += numReqs[p];
                }

                if (totalReqs >= count) {
                    elapsed = Utils.hrtimeToMS(process.hrtime(ts));
                    console.log('\nTest finished, killing children.');
                    clearInterval(reporter);
                    workers.forEach((w) => {
                        w.kill();
                    });
                }
            }
        }
    });
}

async function createWorkers(serverName: string, queueName: string): Promise<cluster.Worker[]> {
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }
    return new Promise<cluster.Worker[]>(((resolve, reject) => {
        const onlineWorkers: cluster.Worker[] = [];
        cluster.on('online', (worker: cluster.Worker) => {
            onlineWorkers.push(worker);
            if (onlineWorkers.length === numCPUs) {
                resolve(onlineWorkers);
            }
        });
    }));
}

async function prepareQueue(serverName: string, queueName: string, messageRef: string, count: number) {
    const workers = await createWorkers(serverName, queueName);
    await new Promise((resolve, reject) => {
        let exited = 0;
        workers.forEach((w) => {
            w.send({type: 'fill', serverName, queueName, messageRef, count: Math.round(count / numCPUs)});
            w.on('exit', () => {
                exited++;
                if (exited === numCPUs) {
                    resolve();
                }
            });
        });
    });

}
