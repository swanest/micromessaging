/// <reference path="../micromessaging.d.ts" />
const when = require('when'),
    Service = require('../lib'),
    tx = new Service('sender'),
    rx = new Service('abc');

async function test() {
    await when.all([tx.connect(), rx.connect()]);

    rx.listen('stock.aapl.split', function (message: Object) {
        console.log('stock.aapl.split', message);
    });

    rx.listen('stock.msft.*', function (message: Object) {
        console.log('stock.msft.*', message);
    });

    await rx.subscribe();

    await tx.emit('abc', 'stock.aapl.split', {ratio: '7:1'}, {headerAppInfo: 'test'}, {timeout:300, expiresAfter:4000});
    await tx.emit('abc', 'stock.msft.split', {ratio: '3:1'});
    await tx.emit('abc', 'stock.msft.cashDiv', {amount: 0.72});

    await when.all([tx.close(), rx.close()]);
}

tx.on('unreachable', () => {
    console.warn(tx.name + ' failed to reach rabbit server');
});
tx.on('unroutableMessage', (message: Object) => {
    console.warn(tx.name + ' encountered an unroutable message', message);
});
tx.on('unhandledMessage', (message: Object) => {
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