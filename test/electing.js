var expect = require("chai").expect;
var Service = require("../lib").Service;
var when = require("when");
var moment = require("moment");
var _ = require("lodash");
var CustomError = require("sw-logger").CustomError;



describe("When electing", function () {


    it("elects correctly", function (done) {

        this.timeout(20000);

        var electedCalls = 0;

        function newInstance() {
            var s = new Service("abc", {discoverable: {electionTimeout:50, intervalCheck:500}});
            s.on("elected", function () {
                electedCalls++;
            });
            return s.connect().then(function () {
                return s;
            });
        }


        var first, second, third, currentElectedUniqueID;
        newInstance().then(function (i) {
            first = i;
            return newInstance();
        }).delay(300).then(function (i) {
            second = i;
            //2 instances
            expect(first.replications).to.have.lengthOf(2);
            expect(second.replications).to.have.lengthOf(2);
            expect(first.isElected).to.be.true;
            currentElectedUniqueID = _.find(first.replications, {isElected: true, isCurrent: true}).uniqueID;
            return newInstance();
        }).delay(300).then(function (i) {
            third = i;
            expect(first.replications).to.have.lengthOf(3);
            expect(second.replications).to.have.lengthOf(3);
            expect(third.replications).to.have.lengthOf(3);
            //3 instances
            return third.close();
        }).delay(300).then(function () {
            expect(first.replications).to.have.lengthOf(2);
            expect(second.replications).to.have.lengthOf(2);
            expect(currentElectedUniqueID).to.equal(_.find(second.replications, {
                isElected: true
            }).uniqueID);
        }).then(function () {
            return first.close();
        }).delay(600).then(function () {
            expect(second.replications).to.have.lengthOf(1);
            expect(electedCalls).to.equal(2);
            return second.close().then(function(){
                done();
            });
        });


    });


});