///<reference path="./lib/index.d.ts"/>
/// <reference path='./node_modules/@types/when/index.d.ts' />
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments)).next());
    });
};
var when = require("when"), Bus = require('./lib'), tx = new Bus('sender'), rx = new Bus('abc');
function test() {
    return __awaiter(this, void 0, void 0, function* () {
        yield when.all([tx.connect(), rx.connect()]);
        rx.listen("stock.aapl.split", function (message) {
            console.log("stock.aapl.split", message);
        });
        rx.listen("stock.msft.*", function (message) {
            console.log("stock.msft.*", message);
        });
        yield rx.subscribe();
        yield tx.emit("abc", "stock.aapl.split", { ratio: "7:1" }, { headerAppInfo: "test" }, { timeout: 300, expiresAfter: 4000 });
        yield tx.emit("abc", "stock.msft.split", { ratio: "3:1" });
        yield tx.emit("abc", "stock.msft.cashDiv", { amount: 0.72 });
        yield when.all([tx.close(), rx.close()]);
    });
}
tx.on("unreachable", function () {
    console.warn(tx.name + " failed to reach rabbit server");
});
tx.on("unroutableMessage", function (message) {
    console.warn(tx.name + " encountered an unroutable message", message);
});
tx.on("unhandledMessage", function (message) {
    console.warn(tx.name + " encountered an unhandled message", message);
});
tx.on("closed", function () {
    console.warn(tx.name + " closed its connection");
    process.exit(0);
});
tx.on("failed", function () {
    console.warn(tx.name + " failed to connect. going to reconnect");
});
test();
