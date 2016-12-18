///<reference path="../node_modules/@types/node/index.d.ts"/>
import * as Micromessaging from "../lib";
import * as When from 'when';
import {CustomError} from "sw-logger";

const tx = new Micromessaging.Service('sender'),
    rx = new Micromessaging.Service('abc', {
        discoverable: false
    });

async function test() {
    await When.all([tx.connect(), rx.connect()]);

    await rx.listen('stock.aapl.split', function (message: Micromessaging.Message) {
        console.log('stock.aapl.split', message.body);
    }).promise;

    await rx.listen('stock.msft.*', function (message: Micromessaging.Message) {
        console.log('stock.msft.*', message.body);
    }).promise;

    await rx.listen('stock.msft.*', function (message: Micromessaging.Message) {
        console.log('stock.msft.*', message.body);
    }).promise;

    await rx.exclusively.listen("stock.msft.*", function (mesage: Micromessaging.Message) {
        console.log(mesage.body);
    }).promise;

    await rx.subscribe();

    await tx.emit('abc', 'stock.aapl.split', {ratio: '7:1'}, {headerAppInfo: 'test'}, {
        timeout: 300,
        expiresAfter: 4000
    });
    await tx.emit('abc', 'stock.msft.split', {ratio: '3:1'});
    await tx.emit('abc', 'stock.msft.cashDiv', {amount: 0.72});

    await rx.handle('test', function (message: Micromessaging.Message) {
        message.write("a"), message.write("b"), message.end();
    }).onError(function (err:CustomError, message) {
        (message.reply || message.reject)(err.info);
    }).promise;

    await tx.request("abc", "test", "lala").progress(function (upd) {
        console.log("progress", upd.body)
    }).then(function (res) {
        console.log("finished", res.body)
    })

    await When.all([tx.close(), rx.close()]);
}


tx.on('unreachable', () => {
    console.warn(tx.name + ' failed to reach rabbit server');
});
tx.on('unroutableMessage', (message: Micromessaging.SimpleMessage) => {
    console.warn(tx.name + ' encountered an unroutable message', message);
});
tx.on('unhandledMessage', (message: Micromessaging.SimpleMessage) => {
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