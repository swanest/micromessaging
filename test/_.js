//var _ = require("lodash"),
//    spawn = require("child_process").spawn;
//
//logger = require("logger");

before(function (done) {
    this.timeout(4000)

    //var analysisServerA = spawn("node", ["tests/server.js, analysis"], {env: _.extend(process.env, {DEBUG: "micromessaging"})}),
    //    analysisServerB = spawn("node", ["tests/server.js, analysis"], {env: _.extend(process.env, {DEBUG: "micromessaging"})}),
    //    analysisServerB = spawn("node", ["tests/server.js, analysis"], {env: _.extend(process.env, {DEBUG: "micromessaging"})});
    //
    //
    //
    //s1.stdout.once('data', function (data) {
    //    console.log(`res: ${data}`);
    //    done();
    //});
    //
    //s1.stderr.on('data', (data) => {
    //    console.log(`stderr: ${data}`);
    //});
    //
    //s1.on('close', (code) => {
    //    console.log(`child process exited with code ${code}`);
    //});

    done();

});

after(function (done) {
    done();
});