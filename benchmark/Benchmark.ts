import * as cluster from 'cluster';
import * as os from 'os';
import {Messaging} from '../src/Messaging';
import {Message} from '../src/Message';
import {Utils} from '../src/Utils';

const numCPUs = os.cpus().length;

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    // Count requests
    let numReqs = {},
        lastCount = 0,
        ts = process.hrtime();

    function messageHandler(msg, id) {
        if (msg.cmd && msg.cmd === 'notifyTotal') {
            numReqs[id] = msg.value;
            // lastCount = msg.value;
            // ts = process.hrtime();
        }
    }

    setInterval(() => {
        let totalReqs = 0;
        for (let p in numReqs) {
            totalReqs += numReqs[p];
        }
        console.log(`numReqs = ${totalReqs}, rate = ${Math.round(totalReqs / (Utils.hrtimeToMS(process.hrtime(ts)) / 1000) / (numCPUs - 1))}/s/instance`);
    }, 1000);

    // Fork workers.
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    const onlineWorkers: cluster.Worker[] = [];
    cluster.on('online', (worker: cluster.Worker) => {
        onlineWorkers.push(worker);
        if (onlineWorkers.length === numCPUs) {
            // Dispatch one client and multiple servers.
            const rand = Math.round(Math.random() * 1000);
            onlineWorkers.forEach((w, i) => {
                if (i === onlineWorkers.length - 1) {
                    onlineWorkers[i].send({serverName: 'server-' + rand, type: 'client'});
                } else {
                    onlineWorkers[i].send({type: 'server', name: 'server-' + rand});
                }
            });
        }
    });

    for (const id in cluster.workers) {
        cluster.workers[id].on('message', (msg) => {
            messageHandler(msg, id);
        });
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`worker ${worker.process.pid} died`);
    });
} else {
    process.on('unhandledRejection', reason => {
        console.error(reason);
    });
    process.on('message', (details) => {
        if (details.type === 'client') {
            const client = new Messaging('client');
            client.connect().then(() => benchmark(client, details.serverName));
        } else {
            const server = new Messaging(details.name);
            server.on('error', e => console.error('received an error', e));
            server.on('closed', e => console.error('Connectin closed', e));
            server.on('pressure', () => {
                console.log('pressure detected', arguments);
            })
            server.on('pressureReleased', () => {
                console.log('pressure released', arguments);
            })
            let parallel = 0;
            let now = process.hrtime();
            let counter = 0;
            setInterval(() => {
                const diff = Utils.hrtimeToMS(process.hrtime(now));
                if (diff > (1000 + 70)) {
                    console.log(`${process.pid} is under pressure by ${diff}`);
                }
                now = process.hrtime();
                process.send({cmd: 'notifyTotal', value: counter});
            }, 1000);
            server.handle('req', async (m: Message) => {
                parallel++;
                const now = new Date().getTime();
                // while (new Date().getTime() - now < 5) {}
                m.reply().then(() => {
                    counter++;
                })
                // setTimeout(() => m.reply().then(() => {
                //     counter++;
                // }), 1000);
                parallel--;
            });
            server.connect();
        }
    });
}
const smallMessage = {
    hey: {
        it: {is: 'me'}
    }
};
const bigMessage = [];
for (let i = 0; i < 10000; i++) {
    bigMessage.push({
        "_id": "5890b292f8b4d200079474aa",
        "schemaName": "X_close_V1",
        "contents": {
            "iid": "xrate:USD:SEK",
            "date": "1999-01-07T17:00:00Z",
            "value": 7.896681,
            "from": "USD",
            "to": "SEK"
        },
        "source": "5890b09fde3a2f665be8e9ad",
        "hash": "lS/UyOS4sXrtEv+vdaeuqCV++Rs=",
        "insertedAt": "2017-01-31T15:51:46.355Z",
        "screened": {"date": "2017-07-31T08:34:21.750Z", "useful": true}
    });
}

async function benchmark(messaging: Messaging, serverName: string, init = 1) {
    const history = [];
    let parallel = 128000,
        sendPromise;
    setInterval(async () => {
        const report = await messaging.getRequestsReport(serverName, 'req');
        if (report.queueSize === 0 && sendPromise == void 0) {
            // Empty, send more
            sendPromise = send(parallel = parallel * 2);
        }
        history.push(report.queueSize);
        if (history.length === 5) {
            let decreased = true;
            history.forEach((v, i) => {
                if (i > 0 && v > history[i - 1]) {
                    decreased = false;
                }
            });
            if (decreased && sendPromise == void 0) {
                sendPromise = send(parallel = parallel * 2);
            }
            history.splice(0, 1);
        }
    }, 1000);

    async function send(n) {
        console.log('sending: ' + n);
        let proms = [];
        for (let i = 0; i < n; i += 1000) {
            for (let j = 0; j < 1000 && j < n; j++) {
                // proms.push(messaging.task(serverName, 'req', j % 2 === 0 ? smallMessage : bigMessage));
                proms.push(messaging.task(serverName, 'req'));
            }
            await Promise.all(proms);
            proms = [];
        }
        console.log('sent: ' + n);
        sendPromise = null;
    }

    sendPromise = send(parallel);
}