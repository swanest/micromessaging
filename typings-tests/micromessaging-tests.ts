///<reference path="../node_modules/@types/node/index.d.ts"/>
import {Service, Message} from "../lib";
import * as When from 'when';

const tx = new Service('sender'),
    rx = new Service('abc', {
        discoverable: false
    });

async function test() {
    await When.all([tx.connect(), rx.connect()]);

    rx.listen('stock.aapl.split', function (message: Message) {
        console.log('stock.aapl.split', message.body);
    });

    rx.listen('stock.msft.*', function (message: Message) {
        console.log('stock.msft.*', message.body);
    });

    rx.exclusively.listen("stock.msft.*", function (mesage: Message) {
        console.log(mesage.body);
    });

    await rx.subscribe();

    await tx.emit('abc', 'stock.aapl.split', {ratio: '7:1'}, {headerAppInfo: 'test'}, {
        timeout: 300,
        expiresAfter: 4000
    });
    await tx.emit('abc', 'stock.msft.split', {ratio: '3:1'});
    await tx.emit('abc', 'stock.msft.cashDiv', {amount: 0.72});

    await When.all([tx.close(), rx.close()]);
}


tx.on('unreachable', () => {
    console.warn(tx.name + ' failed to reach rabbit server');
});
tx.on('unroutableMessage', (message: Message) => {
    console.warn(tx.name + ' encountered an unroutable message', message);
});
tx.on('unhandledMessage', (message: Message) => {
    console.warn(tx.name + ' encountered an unhandled message', message);
});
tx.on('closed', () => {
    console.warn(tx.name + ' closed its connection');
    process.exit(0);
});
tx.on('failed', () => {
    console.warn(tx.name + ' failed to connect. going to reconnect');
});

test();