var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;


describe("When electing", function () {


    let n = require('uuid').v4();
    it("elects correctly", function (done) {

        this.timeout(20000);

        var electedCalls = 0;

        function newInstance() {
            var s = new Service("abc" + n, {discoverable: {electionTimeout: 50, intervalCheck: 200}});
            s.on("elected", function () {
                electedCalls++;
            });
            return s.connect().then(function () {
                return s;
            });
        }

        var first, second;
        newInstance().then(function (i) {
            first = i;
            return newInstance();
        }).delay(1000).then(function (i) {
            second = i;
            //2 instances
            expect(first.isElected).to.be.true;
            expect(second.isElected).to.be.false;
            return newInstance();
        }).delay(1000).then(function () {
            expect(second.isElected).to.be.false;
            return first.close();
        }).delay(2000).then(function () {
            expect(second.isElected).to.be.true;
            return second.close().then(function () {
                done();
            });
        });


    });


});